'use strict';

// Časové pásmo musí byť nastavené pred prvým použitím Date – deadline 19:00 je miestny čas.
process.env.TZ = process.env.TZ || 'Europe/Bratislava';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Databáza
// ---------------------------------------------------------------------------
const db = new DatabaseSync(path.join(DATA_DIR, 'style_picker.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY, label TEXT, created_at TEXT NOT NULL,
    used_by INTEGER, revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    front_photo TEXT NOT NULL, back_photo TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0, last_grant_week TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    photo TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS days (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    status TEXT NOT NULL,              -- submitted | late_token | self
    offer TEXT NOT NULL DEFAULT '[]',  -- id kúskov, ktoré osoba ponúkla na výber
    submitted_at TEXT,
    outfit TEXT,                       -- JSON {front:[layer], back:[layer]}
    outfit_note TEXT,
    outfit_at TEXT,
    PRIMARY KEY (user_id, date)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    reward INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | exception
    admin_note TEXT NOT NULL DEFAULT '', granted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, reviewed_at TEXT
  );
`);

const DEFAULT_SETTINGS = { deadline: '19:00', weekly_tokens: '5', late_cost: '1' };
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const defaults = ['Tričko', 'Košeľa', 'Top', 'Mikina', 'Sveter', 'Sako', 'Bunda / kabát',
    'Nohavice', 'Rifle', 'Kraťasy', 'Sukňa', 'Šaty', 'Topánky', 'Ponožky', 'Spodná bielizeň',
    'Doplnky', 'Iné'];
  const ins = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
  defaults.forEach((name, i) => ins.run(name, i));
}

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

// Heslo admina: ADMIN_PASSWORD z prostredia má prednosť, inak sa pri prvom štarte vygeneruje.
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}
if (process.env.ADMIN_PASSWORD) {
  setSetting('admin_password', hashPassword(process.env.ADMIN_PASSWORD));
} else if (!getSetting('admin_password')) {
  const pw = crypto.randomBytes(6).toString('base64url');
  setSetting('admin_password', hashPassword(pw));
  console.log(`\n  Vygenerované admin heslo: ${pw}\n  (zmeníš ho v Nastaveniach alebo cez ADMIN_PASSWORD)\n`);
}

// ---------------------------------------------------------------------------
// Čas, deadline a tokeny
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowIso = () => new Date().toISOString();
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function mondayOf(d) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
}

// Aktuálny cyklus: osoba ponúka oblečenie na ZAJTRA a musí to stihnúť dnes do deadlinu.
function currentCycle(now = new Date()) {
  const [h, m] = getSetting('deadline').split(':').map(Number);
  const deadline = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  return {
    today: dateStr(now),
    target: dateStr(addDays(now, 1)),
    deadline: deadline.toISOString(),
    deadlineLabel: getSetting('deadline'),
    passed: now >= deadline,
  };
}

function addTransaction(userId, amount, reason) {
  db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(amount, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, amount, reason, nowIso());
}

// Každý pondelok sa pripíše týždenná dávka tokenov (dopočítava sa lenivo pri načítaní).
function grantWeeklyTokens(user) {
  const thisWeek = mondayOf(new Date());
  let last = new Date(`${user.last_grant_week}T00:00:00`);
  let weeks = 0;
  while (addDays(last, 7) <= thisWeek) { last = addDays(last, 7); weeks++; }
  if (weeks > 0) {
    const perWeek = Number(getSetting('weekly_tokens')) || 0;
    db.prepare('UPDATE users SET last_grant_week = ? WHERE id = ?').run(dateStr(last), user.id);
    if (perWeek > 0) addTransaction(user.id, perWeek * weeks, weeks > 1 ? `Týždenné tokeny (${weeks}×)` : 'Týždenné tokeny');
  }
}

function loadUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return null;
  grantWeeklyTokens(u);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// Pomocné funkcie
// ---------------------------------------------------------------------------
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const uploadUrl = (file) => (file ? `/uploads/${file}` : null);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeDays = 365) {
  res.append('Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}`);
}
function clearCookie(res, name) { res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

function publicUser(u, { withToken = false } = {}) {
  const out = {
    id: u.id, name: u.name, tokens: u.tokens, active: !!u.active, created_at: u.created_at,
    front_photo: uploadUrl(u.front_photo), back_photo: uploadUrl(u.back_photo),
  };
  if (withToken) out.personal_link = `/me/${u.token}`;
  return out;
}
function publicItem(i) {
  return { id: i.id, name: i.name, category_id: i.category_id, category: i.category_name || null,
    photo: uploadUrl(i.photo), archived: !!i.archived, created_at: i.created_at };
}
function publicDay(d) {
  if (!d) return null;
  return { date: d.date, status: d.status, offer: JSON.parse(d.offer), submitted_at: d.submitted_at,
    outfit: d.outfit ? JSON.parse(d.outfit) : null, outfit_note: d.outfit_note, outfit_at: d.outfit_at };
}
const itemsOf = (userId, includeArchived = false) => db.prepare(`
  SELECT i.*, c.name AS category_name FROM items i LEFT JOIN categories c ON c.id = i.category_id
  WHERE i.user_id = ? ${includeArchived ? '' : 'AND i.archived = 0'} ORDER BY c.sort, i.created_at DESC`)
  .all(userId).map(publicItem);
const getDay = (userId, date) => db.prepare('SELECT * FROM days WHERE user_id = ? AND date = ?').get(userId, date);

// ---------------------------------------------------------------------------
// Upload súborov
// ---------------------------------------------------------------------------
function uploader(kind, maxMb) {
  return multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename: (_req, file, cb) => {
        const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
        cb(null, `${randomToken(18)}${ext}`);
      },
    }),
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith(`${kind}/`)) cb(null, true);
      else cb(bad(kind === 'image' ? 'Súbor musí byť obrázok.' : 'Súbor musí byť video.'));
    },
  });
}
const imageUpload = uploader('image', 15);
const videoUpload = uploader('video', 300);
function removeUpload(file) { if (file) fs.rm(path.join(UPLOAD_DIR, path.basename(file)), { force: true }, () => {}); }

// ---------------------------------------------------------------------------
// Aplikácia
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const page = (name) => (_req, res) => res.sendFile(path.join(__dirname, 'public', `${name}.html`));

function adminSession(req) {
  const t = parseCookies(req).admin;
  return t && db.prepare('SELECT token FROM sessions WHERE token = ?').get(t) ? t : null;
}
function currentUser(req) {
  const t = parseCookies(req).user;
  if (!t) return null;
  const u = db.prepare('SELECT id FROM users WHERE token = ? AND active = 1').get(t);
  return u ? loadUser(u.id) : null;
}
function requireAdmin(req, _res, next) { adminSession(req) ? next() : next(new HttpError(401, 'Prihlás sa ako admin.')); }
function requireUser(req, _res, next) {
  const u = currentUser(req);
  if (!u) return next(new HttpError(401, 'Neplatný alebo chýbajúci prístup. Použi svoj osobný odkaz.'));
  req.user = u;
  next();
}

// ---- stránky ----
app.get('/', (req, res) => {
  if (adminSession(req)) return res.redirect('/admin');
  if (currentUser(req)) return res.redirect('/app');
  page('login')(req, res);
});
app.get('/admin', (req, res) => (adminSession(req) ? page('admin')(req, res) : res.redirect('/')));
app.get('/app', (req, res) => (currentUser(req) ? page('app')(req, res) : res.redirect('/')));
app.get('/join/:code', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(req.params.code);
  if (!inv || inv.revoked || inv.used_by) return res.status(410).sendFile(path.join(__dirname, 'public', 'invalid.html'));
  page('join')(req, res);
});
app.get('/me/:token', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE token = ? AND active = 1').get(req.params.token);
  if (!u) return res.status(404).sendFile(path.join(__dirname, 'public', 'invalid.html'));
  setCookie(res, 'user', req.params.token);
  res.redirect('/app');
});

// ---- admin prihlásenie ----
app.post('/api/admin/login', (req, res) => {
  if (!checkPassword(String(req.body?.password || ''), getSetting('admin_password'))) {
    throw new HttpError(401, 'Nesprávne heslo.');
  }
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').run(token, nowIso());
  setCookie(res, 'admin', token, 30);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const t = parseCookies(req).admin;
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  clearCookie(res, 'admin');
  clearCookie(res, 'user');
  res.json({ ok: true });
});

// ---- verejné ----
app.get('/api/categories', (_req, res) => {
  res.json(db.prepare('SELECT id, name FROM categories ORDER BY sort, name').all());
});
app.get('/api/invite/:code', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(req.params.code);
  if (!inv || inv.revoked || inv.used_by) throw new HttpError(410, 'Pozvánka je neplatná alebo už bola použitá.');
  res.json({ label: inv.label });
});
app.post('/api/join/:code',
  imageUpload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }]),
  (req, res) => {
    const front = req.files?.front?.[0]?.filename;
    const back = req.files?.back?.[0]?.filename;
    const cleanup = () => { removeUpload(front); removeUpload(back); };
    const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(req.params.code);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!inv || inv.revoked || inv.used_by) { cleanup(); throw new HttpError(410, 'Pozvánka je neplatná alebo už bola použitá.'); }
    if (!name) { cleanup(); throw bad('Zadaj meno.'); }
    if (!front || !back) { cleanup(); throw bad('Nahraj fotku spredu aj zozadu v T-póze.'); }

    const token = randomToken();
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (name, token, front_photo, back_photo, tokens, last_grant_week, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)`).run(name, token, front, back, dateStr(mondayOf(new Date())), nowIso());
    const userId = Number(lastInsertRowid);
    db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(userId, inv.code);
    const start = Number(getSetting('weekly_tokens')) || 0;
    if (start > 0) addTransaction(userId, start, 'Úvodné tokeny');
    setCookie(res, 'user', token);
    res.json({ ok: true, personal_link: `/me/${token}` });
  });

// ---------------------------------------------------------------------------
// API pre osobu (používateľa)
// ---------------------------------------------------------------------------
const me = express.Router();
me.use(requireUser);

me.get('/', (req, res) => {
  const cycle = currentCycle();
  res.json({
    user: publicUser(req.user, { withToken: true }),
    cycle,
    late_cost: Number(getSetting('late_cost')),
    today: publicDay(getDay(req.user.id, cycle.today)),
    tomorrow: publicDay(getDay(req.user.id, cycle.target)),
    items: itemsOf(req.user.id, true),
  });
});

me.post('/items', imageUpload.single('photo'), (req, res) => {
  const file = req.file?.filename;
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const categoryId = Number(req.body?.category_id) || null;
  if (!file) throw bad('Chýba fotka.');
  if (!name) { removeUpload(file); throw bad('Pomenuj oblečenie.'); }
  if (!categoryId || !db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) {
    removeUpload(file); throw bad('Vyber kategóriu.');
  }
  db.prepare('INSERT INTO items (user_id, name, category_id, photo, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, name, categoryId, file, nowIso());
  res.json({ ok: true });
});

me.patch('/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!item) throw new HttpError(404, 'Kúsok neexistuje.');
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : item.name;
  const categoryId = req.body?.category_id !== undefined ? Number(req.body.category_id) || null : item.category_id;
  const archived = req.body?.archived !== undefined ? (req.body.archived ? 1 : 0) : item.archived;
  if (!name) throw bad('Názov nemôže byť prázdny.');
  db.prepare('UPDATE items SET name = ?, category_id = ?, archived = ? WHERE id = ?').run(name, categoryId, archived, item.id);
  res.json({ ok: true });
});

// Odovzdanie ponuky na zajtra. Po deadline len za tokeny.
me.post('/submit', (req, res) => {
  const cycle = currentCycle();
  const ids = [...new Set((req.body?.item_ids || []).map(Number))];
  if (ids.length === 0) throw bad('Označ aspoň jeden kúsok, z ktorého sa má vyberať.');
  const owned = new Set(db.prepare('SELECT id FROM items WHERE user_id = ? AND archived = 0').all(req.user.id).map((r) => r.id));
  if (!ids.every((id) => owned.has(id))) throw bad('Niektorý z vybraných kúskov neexistuje.');

  const existing = getDay(req.user.id, cycle.target);
  if (existing?.outfit) throw bad('Outfit na zajtra je už vybraný – ponuku už nemôžeš meniť.');

  let status = 'submitted';
  if (cycle.passed && !(existing && existing.status !== 'self')) {
    // Po deadline a ešte nič platné neodovzdané -> treba zaplatiť tokenmi.
    const cost = Number(getSetting('late_cost')) || 0;
    if (!req.body?.use_tokens) throw new HttpError(409, `Deadline ${cycle.deadlineLabel} už prešiel. Môžeš použiť tokeny (${cost}) alebo si vybrať sama/sám.`);
    if (req.user.tokens < cost) throw new HttpError(402, 'Nemáš dosť tokenov. Zarob si ich splnením úlohy v záložke Úlohy.');
    if (cost > 0) addTransaction(req.user.id, -cost, `Oneskorená ponuka na ${cycle.target}`);
    status = 'late_token';
  } else if (existing && existing.status !== 'self') {
    status = existing.status; // úprava ponuky – stav (včas / za token) sa zachováva
  }

  db.prepare(`INSERT INTO days (user_id, date, status, offer, submitted_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET status = excluded.status, offer = excluded.offer, submitted_at = excluded.submitted_at`)
    .run(req.user.id, cycle.target, status, JSON.stringify(ids), nowIso());
  res.json({ ok: true, status });
});

// Po deadline sa osoba môže rozhodnúť, že si zajtra vyberie sama.
me.post('/self', (req, res) => {
  const cycle = currentCycle();
  if (!cycle.passed) throw bad(`Do ${cycle.deadlineLabel} ešte stihneš odovzdať ponuku.`);
  const existing = getDay(req.user.id, cycle.target);
  if (existing && existing.status !== 'self') throw bad('Ponuku na zajtra už máš odovzdanú.');
  db.prepare(`INSERT INTO days (user_id, date, status, submitted_at) VALUES (?, ?, 'self', ?)
    ON CONFLICT(user_id, date) DO NOTHING`).run(req.user.id, cycle.target, nowIso());
  res.json({ ok: true });
});

me.get('/tasks', (req, res) => {
  res.json({
    tasks: db.prepare('SELECT id, title, description, reward FROM tasks WHERE active = 1 ORDER BY created_at DESC').all(),
    submissions: db.prepare(`SELECT s.*, t.title FROM task_submissions s JOIN tasks t ON t.id = s.task_id
      WHERE s.user_id = ? ORDER BY s.created_at DESC`).all(req.user.id)
      .map((s) => ({ ...s, video: uploadUrl(s.video) })),
  });
});

me.post('/tasks/:id/submit', videoUpload.single('video'), (req, res) => {
  const file = req.file?.filename;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!task) { removeUpload(file); throw new HttpError(404, 'Úloha neexistuje.'); }
  if (!file) throw bad('Nahraj video, na ktorom je vidieť, ako úlohu robíš.');
  db.prepare('INSERT INTO task_submissions (task_id, user_id, video, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(task.id, req.user.id, file, String(req.body?.note || '').slice(0, 500), nowIso());
  res.json({ ok: true });
});

me.get('/transactions', (req, res) => {
  res.json(db.prepare('SELECT amount, reason, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id));
});

app.use('/api/me', me);

// ---------------------------------------------------------------------------
// API pre admina
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/overview', (_req, res) => {
  const cycle = currentCycle();
  const users = db.prepare('SELECT id FROM users ORDER BY active DESC, name').all().map(({ id }) => {
    const u = loadUser(id);
    return {
      ...publicUser(u, { withToken: true }),
      item_count: db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND archived = 0').get(id).n,
      tomorrow: publicDay(getDay(id, cycle.target)),
      today: publicDay(getDay(id, cycle.today)),
    };
  });
  const pendingTasks = db.prepare("SELECT COUNT(*) AS n FROM task_submissions WHERE status = 'pending'").get().n;
  res.json({ cycle, users, pending_tasks: pendingTasks });
});

admin.get('/users/:id', (req, res) => {
  const u = loadUser(Number(req.params.id));
  if (!u) throw new HttpError(404, 'Osoba neexistuje.');
  const cycle = currentCycle();
  const days = db.prepare('SELECT * FROM days WHERE user_id = ? ORDER BY date DESC LIMIT 30').all(u.id).map(publicDay);
  res.json({
    user: publicUser(u, { withToken: true }), cycle, items: itemsOf(u.id, true), days,
    transactions: db.prepare('SELECT amount, reason, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id),
  });
});

admin.patch('/users/:id', (req, res) => {
  const u = loadUser(Number(req.params.id));
  if (!u) throw new HttpError(404, 'Osoba neexistuje.');
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 60);
    if (!name) throw bad('Meno nemôže byť prázdne.');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, u.id);
  }
  if (req.body?.active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, u.id);
  if (req.body?.regenerate_link) db.prepare('UPDATE users SET token = ? WHERE id = ?').run(randomToken(), u.id);
  res.json({ ok: true });
});

admin.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Osoba neexistuje.');
  const files = [u.front_photo, u.back_photo,
    ...db.prepare('SELECT photo FROM items WHERE user_id = ?').all(id).map((r) => r.photo),
    ...db.prepare('SELECT video FROM task_submissions WHERE user_id = ?').all(id).map((r) => r.video)];
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.prepare('UPDATE invites SET used_by = NULL, revoked = 1 WHERE used_by = ?').run(id);
  files.forEach(removeUpload);
  res.json({ ok: true });
});

admin.post('/users/:id/tokens', (req, res) => {
  const u = loadUser(Number(req.params.id));
  if (!u) throw new HttpError(404, 'Osoba neexistuje.');
  const amount = Math.trunc(Number(req.body?.amount));
  if (!amount) throw bad('Zadaj počet tokenov (kladný alebo záporný).');
  addTransaction(u.id, amount, String(req.body?.reason || '').trim().slice(0, 120) || (amount > 0 ? 'Bonus od admina' : 'Odobraté adminom'));
  res.json({ ok: true });
});

function sanitizeLayers(layers, validItems) {
  if (!Array.isArray(layers)) return [];
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return layers.filter((l) => validItems.has(Number(l?.item_id))).slice(0, 40).map((l) => ({
    item_id: Number(l.item_id),
    x: num(l.x, -50, 150, 50), y: num(l.y, -50, 150, 50), w: num(l.w, 2, 200, 30),
    rot: num(l.rot, -180, 180, 0), blend: !!l.blend, flip: !!l.flip,
  }));
}

// Admin uloží vybraný outfit (s rozložením na postave spredu / zozadu).
admin.put('/users/:id/outfit/:date', (req, res) => {
  const u = loadUser(Number(req.params.id));
  if (!u) throw new HttpError(404, 'Osoba neexistuje.');
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Neplatný dátum.');
  const valid = new Set(db.prepare('SELECT id FROM items WHERE user_id = ?').all(u.id).map((r) => r.id));
  const items = [...new Set((req.body?.items || []).map(Number))].filter((id) => valid.has(id));
  if (items.length === 0) throw bad('Outfit musí obsahovať aspoň jeden kúsok.');
  const outfit = { items, front: sanitizeLayers(req.body?.front, valid), back: sanitizeLayers(req.body?.back, valid) };
  const note = String(req.body?.note || '').slice(0, 500);
  db.prepare(`INSERT INTO days (user_id, date, status, outfit, outfit_note, outfit_at) VALUES (?, ?, 'admin', ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET outfit = excluded.outfit, outfit_note = excluded.outfit_note, outfit_at = excluded.outfit_at`)
    .run(u.id, date, JSON.stringify(outfit), note, nowIso());
  res.json({ ok: true });
});

admin.delete('/users/:id/outfit/:date', (req, res) => {
  const id = Number(req.params.id);
  const day = getDay(id, req.params.date);
  if (day?.status === 'admin') db.prepare('DELETE FROM days WHERE user_id = ? AND date = ?').run(id, req.params.date);
  else db.prepare('UPDATE days SET outfit = NULL, outfit_note = NULL, outfit_at = NULL WHERE user_id = ? AND date = ?').run(id, req.params.date);
  res.json({ ok: true });
});

// ---- pozvánky ----
admin.get('/invites', (_req, res) => {
  res.json(db.prepare(`SELECT i.code, i.label, i.created_at, i.revoked, u.name AS used_by_name FROM invites i
    LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC`).all());
});
admin.post('/invites', (req, res) => {
  const code = randomToken(12);
  db.prepare('INSERT INTO invites (code, label, created_at) VALUES (?, ?, ?)')
    .run(code, String(req.body?.label || '').trim().slice(0, 60), nowIso());
  res.json({ code, url: `/join/${code}` });
});
admin.delete('/invites/:code', (req, res) => {
  db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// ---- úlohy ----
admin.get('/tasks', (_req, res) => {
  res.json({
    tasks: db.prepare('SELECT * FROM tasks ORDER BY active DESC, created_at DESC').all(),
    submissions: db.prepare(`SELECT s.*, t.title, t.reward, u.name AS user_name FROM task_submissions s
      JOIN tasks t ON t.id = s.task_id JOIN users u ON u.id = s.user_id
      ORDER BY (s.status = 'pending') DESC, s.created_at DESC LIMIT 200`).all()
      .map((s) => ({ ...s, video: uploadUrl(s.video) })),
  });
});
admin.post('/tasks', (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) throw bad('Zadaj názov úlohy.');
  const reward = Math.max(0, Math.trunc(Number(req.body?.reward) || 0));
  db.prepare('INSERT INTO tasks (title, description, reward, created_at) VALUES (?, ?, ?, ?)')
    .run(title, String(req.body?.description || '').slice(0, 2000), reward, nowIso());
  res.json({ ok: true });
});
admin.patch('/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!t) throw new HttpError(404, 'Úloha neexistuje.');
  const b = req.body || {};
  db.prepare('UPDATE tasks SET title = ?, description = ?, reward = ?, active = ? WHERE id = ?').run(
    b.title !== undefined ? String(b.title).trim().slice(0, 120) || t.title : t.title,
    b.description !== undefined ? String(b.description).slice(0, 2000) : t.description,
    b.reward !== undefined ? Math.max(0, Math.trunc(Number(b.reward) || 0)) : t.reward,
    b.active !== undefined ? (b.active ? 1 : 0) : t.active, t.id);
  res.json({ ok: true });
});

// Vyhodnotenie videa: approved = splnené, exception = výnimka (uznané aj keď nie dokonalé), rejected = nesplnené.
admin.post('/submissions/:id/review', (req, res) => {
  const s = db.prepare(`SELECT s.*, t.reward, t.title FROM task_submissions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`)
    .get(Number(req.params.id));
  if (!s) throw new HttpError(404, 'Odovzdanie neexistuje.');
  if (s.status !== 'pending') throw bad('Toto už bolo vyhodnotené.');
  const decision = req.body?.decision;
  if (!['approved', 'rejected', 'exception'].includes(decision)) throw bad('Neplatné rozhodnutie.');
  const bonus = Math.max(0, Math.trunc(Number(req.body?.bonus) || 0));
  const granted = decision === 'rejected' ? 0 : s.reward + bonus;
  if (granted > 0) {
    const label = decision === 'exception' ? 'Výnimka' : 'Splnená úloha';
    addTransaction(s.user_id, granted, `${label}: ${s.title}${bonus ? ` (+${bonus} extra)` : ''}`);
  }
  db.prepare('UPDATE task_submissions SET status = ?, admin_note = ?, granted = ?, reviewed_at = ? WHERE id = ?')
    .run(decision, String(req.body?.admin_note || '').slice(0, 500), granted, nowIso(), s.id);
  res.json({ ok: true, granted });
});

// ---- nastavenia ----
admin.get('/settings', (_req, res) => {
  res.json({
    deadline: getSetting('deadline'), weekly_tokens: Number(getSetting('weekly_tokens')),
    late_cost: Number(getSetting('late_cost')), password_from_env: !!process.env.ADMIN_PASSWORD,
    categories: db.prepare(`SELECT c.id, c.name, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS used
      FROM categories c ORDER BY c.sort, c.name`).all(),
  });
});
admin.put('/settings', (req, res) => {
  const b = req.body || {};
  if (b.deadline !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.deadline)) throw bad('Deadline musí byť v tvare HH:MM.');
    setSetting('deadline', b.deadline);
  }
  if (b.weekly_tokens !== undefined) setSetting('weekly_tokens', Math.max(0, Math.trunc(Number(b.weekly_tokens) || 0)));
  if (b.late_cost !== undefined) setSetting('late_cost', Math.max(0, Math.trunc(Number(b.late_cost) || 0)));
  if (b.new_password) {
    if (process.env.ADMIN_PASSWORD) throw bad('Heslo je nastavené cez ADMIN_PASSWORD – zmeň ho tam.');
    if (String(b.new_password).length < 6) throw bad('Heslo musí mať aspoň 6 znakov.');
    setSetting('admin_password', hashPassword(String(b.new_password)));
  }
  res.json({ ok: true });
});
admin.post('/categories', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) throw bad('Zadaj názov kategórie.');
  if (db.prepare('SELECT id FROM categories WHERE name = ?').get(name)) throw bad('Taká kategória už existuje.');
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories').get().s;
  db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)').run(name, sort);
  res.json({ ok: true });
});
admin.delete('/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// ---- chyby ----
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Nenájdené.')));
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Súbor je príliš veľký.' : 'Chyba pri nahrávaní.' });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Chyba servera.' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Style Picker beží na http://localhost:${PORT}`));
}

module.exports = { app, db, currentCycle };
