'use strict';

// Časové pásmo pre deadline. Nastavuje sa napevno, lebo serverless prostredia majú TZ=UTC.
process.env.TZ = process.env.APP_TIMEZONE || 'Europe/Bratislava';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const ON_VERCEL = !!process.env.VERCEL;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Úložisko súborov: Vercel Blob (keď je nastavený token), inak lokálny disk.
const STORAGE = process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local';
const MAX_MB = { image: 15, video: 300 };

// ---------------------------------------------------------------------------
// Databáza (libSQL: lokálny SQLite súbor alebo Turso v cloude)
// ---------------------------------------------------------------------------
const DB_URL = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL
  || (ON_VERCEL ? null : `file:${path.join(DATA_DIR, 'style_picker.db')}`);
const DB_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN;

let client;
function dbClient() {
  if (!DB_URL) throw new HttpError(500, 'Chýba databáza. Na Verceli pripoj Turso (Storage → Turso) alebo nastav TURSO_DATABASE_URL a TURSO_AUTH_TOKEN.');
  if (!client) {
    const local = DB_URL.startsWith('file:');
    if (local) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Pre vzdialenú databázu stačí HTTP klient bez natívnych modulov (menšia serverless funkcia).
    const { createClient } = require(local ? '@libsql/client' : '@libsql/client/web');
    client = createClient({ url: DB_URL, authToken: DB_TOKEN });
  }
  return client;
}
const rowsOf = (res) => res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])));
const db = {
  all: async (sql, ...args) => rowsOf(await dbClient().execute({ sql, args })),
  get: async (sql, ...args) => (await db.all(sql, ...args))[0],
  run: (sql, ...args) => dbClient().execute({ sql, args }),
  batch: (stmts) => dbClient().batch(stmts.map(([sql, ...args]) => ({ sql, args })), 'write'),
};

const SCHEMA = `
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    name TEXT NOT NULL, category_id INTEGER,
    photo TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_user ON items (user_id);
  CREATE TABLE IF NOT EXISTS days (
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL,              -- submitted | late_token | self | admin
    offer TEXT NOT NULL DEFAULT '[]',  -- id kúskov, ktoré osoba ponúkla na výber
    submitted_at TEXT,
    outfit TEXT,                       -- JSON {items, front:[layer], back:[layer]}
    outfit_note TEXT,
    outfit_at TEXT,
    PRIMARY KEY (user_id, date)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transactions_user ON transactions (user_id);
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    reward INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    video TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | exception
    admin_note TEXT NOT NULL DEFAULT '', granted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, reviewed_at TEXT
  );
`;

const DEFAULT_SETTINGS = { deadline: '19:00', weekly_tokens: '5', late_cost: '1' };
const DEFAULT_CATEGORIES = ['Tričko', 'Košeľa', 'Top', 'Mikina', 'Sveter', 'Sako', 'Bunda / kabát',
  'Nohavice', 'Rifle', 'Kraťasy', 'Sukňa', 'Šaty', 'Topánky', 'Ponožky', 'Spodná bielizeň', 'Doplnky', 'Iné'];

async function init() {
  await dbClient().executeMultiple(SCHEMA);
  await db.batch(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => ['INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v]));
  if ((await db.get('SELECT COUNT(*) AS n FROM categories')).n === 0) {
    await db.batch(DEFAULT_CATEGORIES.map((name, i) => ['INSERT OR IGNORE INTO categories (name, sort) VALUES (?, ?)', name, i]));
  }
  // Heslo admina: ADMIN_PASSWORD má prednosť, inak sa pri prvom štarte vygeneruje (len lokálne).
  const stored = await getSetting('admin_password');
  if (process.env.ADMIN_PASSWORD) {
    if (!stored || !checkPassword(process.env.ADMIN_PASSWORD, stored)) await setSetting('admin_password', hashPassword(process.env.ADMIN_PASSWORD));
  } else if (!stored && !ON_VERCEL) {
    const pw = crypto.randomBytes(6).toString('base64url');
    await setSetting('admin_password', hashPassword(pw));
    console.log(`\n  Vygenerované admin heslo: ${pw}\n  (zmeníš ho v Nastaveniach alebo cez ADMIN_PASSWORD)\n`);
  }
}
let readyPromise;
function ready() {
  if (!readyPromise) readyPromise = init().catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}

const getSetting = async (key) => (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value;
const setSetting = (key, value) =>
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(hash, 'hex'));
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
async function currentCycle(now = new Date()) {
  const label = await getSetting('deadline');
  const [h, m] = label.split(':').map(Number);
  const deadline = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  return {
    today: dateStr(now), target: dateStr(addDays(now, 1)),
    deadline: deadline.toISOString(), deadlineLabel: label, passed: now >= deadline,
  };
}

const txStatements = (userId, amount, reason) => [
  ['UPDATE users SET tokens = tokens + ? WHERE id = ?', amount, userId],
  ['INSERT INTO transactions (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)', userId, amount, reason, nowIso()],
];
const addTransaction = (userId, amount, reason) => db.batch(txStatements(userId, amount, reason));

// Každý pondelok sa pripíše týždenná dávka tokenov (dopočítava sa lenivo pri načítaní).
async function grantWeeklyTokens(user) {
  const thisWeek = mondayOf(new Date());
  let last = new Date(`${user.last_grant_week}T00:00:00`);
  let weeks = 0;
  while (addDays(last, 7) <= thisWeek) { last = addDays(last, 7); weeks++; }
  if (weeks === 0) return;
  const perWeek = Number(await getSetting('weekly_tokens')) || 0;
  // Podmienka na starú hodnotu zabráni dvojitému pripísaniu pri súbežných požiadavkách.
  const res = await db.run('UPDATE users SET last_grant_week = ? WHERE id = ? AND last_grant_week = ?', dateStr(last), user.id, user.last_grant_week);
  if (res.rowsAffected && perWeek > 0) {
    await addTransaction(user.id, perWeek * weeks, weeks > 1 ? `Týždenné tokeny (${weeks}×)` : 'Týždenné tokeny');
  }
}

async function loadUser(id) {
  const u = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) return null;
  await grantWeeklyTokens(u);
  return db.get('SELECT * FROM users WHERE id = ?', id);
}

// ---------------------------------------------------------------------------
// Pomocné funkcie
// ---------------------------------------------------------------------------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const notFound = (msg) => new HttpError(404, msg);
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';
function setCookie(req, res, name, value, maxAgeDays = 365) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}${isHttps(req) ? '; Secure' : ''}`);
}
function clearCookie(res, name) { res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

// Prijímame len súbory nahraté do nášho úložiska.
const LOCAL_FILE = /^\/uploads\/[A-Za-z0-9_-]+(\.[a-z0-9]{1,6})?$/;
const BLOB_FILE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/[^\s"'<>]+$/i;
function fileUrl(v) {
  const s = String(v || '');
  return (STORAGE === 'blob' ? BLOB_FILE : LOCAL_FILE).test(s) ? s : null;
}
async function removeFile(url) {
  if (!url) return;
  if (LOCAL_FILE.test(url)) fs.rm(path.join(UPLOAD_DIR, path.basename(url)), { force: true }, () => {});
  else if (BLOB_FILE.test(url) && STORAGE === 'blob') await require('@vercel/blob').del(url).catch(() => {});
}

function publicUser(u, { withToken = false } = {}) {
  const out = {
    id: u.id, name: u.name, tokens: u.tokens, active: !!u.active, created_at: u.created_at,
    front_photo: u.front_photo, back_photo: u.back_photo,
  };
  if (withToken) out.personal_link = `/me/${u.token}`;
  return out;
}
const publicItem = (i) => ({ id: i.id, name: i.name, category_id: i.category_id, category: i.category_name || null,
  photo: i.photo, archived: !!i.archived, created_at: i.created_at });
function publicDay(d) {
  if (!d) return null;
  return { date: d.date, status: d.status, offer: JSON.parse(d.offer), submitted_at: d.submitted_at,
    outfit: d.outfit ? JSON.parse(d.outfit) : null, outfit_note: d.outfit_note, outfit_at: d.outfit_at };
}
const itemsOf = async (userId, includeArchived = false) => (await db.all(`
  SELECT i.*, c.name AS category_name FROM items i LEFT JOIN categories c ON c.id = i.category_id
  WHERE i.user_id = ? ${includeArchived ? '' : 'AND i.archived = 0'} ORDER BY c.sort, i.created_at DESC`, userId)).map(publicItem);
const getDay = (userId, date) => db.get('SELECT * FROM days WHERE user_id = ? AND date = ?', userId, date);
const validInvite = async (code) => {
  const inv = code ? await db.get('SELECT * FROM invites WHERE code = ?', String(code)) : null;
  return inv && !inv.revoked && !inv.used_by ? inv : null;
};

// ---------------------------------------------------------------------------
// Aplikácia
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
if (STORAGE === 'local') app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));
app.use(async (_req, _res, next) => { await ready(); next(); });

async function adminSession(req) {
  const t = parseCookies(req).admin;
  return t && (await db.get('SELECT token FROM sessions WHERE token = ?', t)) ? t : null;
}
async function currentUser(req) {
  const t = parseCookies(req).user;
  if (!t) return null;
  const u = await db.get('SELECT id FROM users WHERE token = ? AND active = 1', t);
  return u ? loadUser(u.id) : null;
}
async function requireAdmin(req, _res, next) {
  if (!(await adminSession(req))) throw new HttpError(401, 'Prihlás sa ako admin.');
  next();
}
async function requireUser(req, _res, next) {
  req.user = await currentUser(req);
  if (!req.user) throw new HttpError(401, 'Neplatný alebo chýbajúci prístup. Použi svoj osobný odkaz.');
  next();
}

// ---- stránky (HTML je statické, tu sú len odkazy s tokenom) ----
app.get('/join/:code', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'join.html')));
app.get('/me/:token', async (req, res) => {
  const u = await db.get('SELECT id FROM users WHERE token = ? AND active = 1', req.params.token);
  if (!u) return res.redirect('/?neplatny=1');
  setCookie(req, res, 'user', req.params.token);
  res.redirect('/app');
});

// ---- prihlásenie ----
app.get('/api/whoami', async (req, res) => {
  res.json({ admin: !!(await adminSession(req)), user: !!(await currentUser(req)), storage: STORAGE, max_mb: MAX_MB,
    admin_password_missing: !(await getSetting('admin_password')) });
});
app.post('/api/admin/login', async (req, res) => {
  const stored = await getSetting('admin_password');
  if (!stored) throw new HttpError(401, 'Admin heslo nie je nastavené – pridaj premennú ADMIN_PASSWORD a nasaď znova.');
  if (!checkPassword(String(req.body?.password || ''), stored)) throw new HttpError(401, 'Nesprávne heslo.');
  const token = randomToken();
  await db.run('INSERT INTO sessions (token, created_at) VALUES (?, ?)', token, nowIso());
  setCookie(req, res, 'admin', token, 30);
  res.json({ ok: true });
});
app.post('/api/logout', async (req, res) => {
  const t = parseCookies(req).admin;
  if (t) await db.run('DELETE FROM sessions WHERE token = ?', t);
  clearCookie(res, 'admin');
  clearCookie(res, 'user');
  res.json({ ok: true });
});

// ---- nahrávanie súborov ----
// Kto smie nahrávať: admin, prihlásená osoba, alebo niekto s platnou pozvánkou (len fotky pri registrácii).
async function mayUpload(req, kind, invite) {
  if (!MAX_MB[kind]) throw bad('Neznámy typ súboru.');
  if ((await currentUser(req)) || (await adminSession(req))) return;
  if (kind === 'image' && (await validInvite(invite))) return;
  throw new HttpError(401, 'Nemáš oprávnenie nahrávať.');
}

// Vercel Blob: prehliadač nahráva priamo do úložiska, server len vydá krátkodobý token.
app.post('/api/blob-upload', async (req, res) => {
  if (STORAGE !== 'blob') throw notFound('Blob úložisko nie je zapnuté.');
  const { handleUpload } = require('@vercel/blob/client');
  const result = await handleUpload({
    request: req,
    body: req.body,
    onBeforeGenerateToken: async (_pathname, clientPayload) => {
      let payload = {};
      try { payload = JSON.parse(clientPayload || '{}'); } catch { /* prázdny payload */ }
      await mayUpload(req, payload.kind, payload.invite);
      return {
        allowedContentTypes: [`${payload.kind}/*`],
        maximumSizeInBytes: MAX_MB[payload.kind] * 1024 * 1024,
        addRandomSuffix: true,
      };
    },
  });
  res.json(result);
});

// Lokálny disk (vývoj alebo vlastný server).
const localUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); cb(null, UPLOAD_DIR); },
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 7);
      cb(null, `${randomToken(18)}${ext}`);
    },
  }),
  limits: { fileSize: MAX_MB.video * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith(`${req.query.kind}/`)) cb(null, true);
    else cb(bad(req.query.kind === 'image' ? 'Súbor musí byť obrázok.' : 'Súbor musí byť video.'));
  },
});
app.post('/api/upload', async (req, _res, next) => {
  if (STORAGE !== 'local') throw notFound('Použi Blob úložisko.');
  await mayUpload(req, req.query.kind, req.query.invite);
  next();
}, localUpload.single('file'), (req, res) => {
  if (!req.file) throw bad('Chýba súbor.');
  if (req.file.size > MAX_MB[req.query.kind] * 1024 * 1024) {
    fs.rm(req.file.path, { force: true }, () => {});
    throw bad('Súbor je príliš veľký.');
  }
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ---- verejné ----
app.get('/api/categories', async (_req, res) => {
  res.json(await db.all('SELECT id, name FROM categories ORDER BY sort, name'));
});
app.get('/api/invite/:code', async (req, res) => {
  const inv = await validInvite(req.params.code);
  if (!inv) throw new HttpError(410, 'Pozvánka je neplatná alebo už bola použitá.');
  res.json({ label: inv.label });
});
app.post('/api/join/:code', async (req, res) => {
  const inv = await validInvite(req.params.code);
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const front = fileUrl(req.body?.front);
  const back = fileUrl(req.body?.back);
  if (!inv) throw new HttpError(410, 'Pozvánka je neplatná alebo už bola použitá.');
  if (!name) throw bad('Zadaj meno.');
  if (!front || !back) throw bad('Nahraj fotku spredu aj zozadu v T-póze.');

  // Pozvánku si najprv „zaberieme“, aby ju nemohli použiť dvaja naraz.
  const claim = await db.run('UPDATE invites SET used_by = -1 WHERE code = ? AND used_by IS NULL AND revoked = 0', inv.code);
  if (!claim.rowsAffected) throw new HttpError(410, 'Pozvánka už bola použitá.');
  const token = randomToken();
  let ins;
  try {
    ins = await db.run(`INSERT INTO users (name, token, front_photo, back_photo, tokens, last_grant_week, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)`, name, token, front, back, dateStr(mondayOf(new Date())), nowIso());
  } catch (e) {
    await db.run('UPDATE invites SET used_by = NULL WHERE code = ?', inv.code);
    throw e;
  }
  const userId = Number(ins.lastInsertRowid);
  const start = Number(await getSetting('weekly_tokens')) || 0;
  await db.batch([
    ['UPDATE invites SET used_by = ? WHERE code = ?', userId, inv.code],
    ...(start > 0 ? txStatements(userId, start, 'Úvodné tokeny') : []),
  ]);
  setCookie(req, res, 'user', token);
  res.json({ ok: true, personal_link: `/me/${token}` });
});

// ---------------------------------------------------------------------------
// API pre osobu (používateľa)
// ---------------------------------------------------------------------------
const me = express.Router();
me.use(requireUser);

me.get('/', async (req, res) => {
  const cycle = await currentCycle();
  res.json({
    user: publicUser(req.user, { withToken: true }),
    cycle,
    late_cost: Number(await getSetting('late_cost')),
    weekly_tokens: Number(await getSetting('weekly_tokens')),
    today: publicDay(await getDay(req.user.id, cycle.today)),
    tomorrow: publicDay(await getDay(req.user.id, cycle.target)),
    items: await itemsOf(req.user.id, true),
  });
});

const validCategory = async (id) => (id && (await db.get('SELECT id FROM categories WHERE id = ?', id)) ? id : null);

me.post('/items', async (req, res) => {
  const photo = fileUrl(req.body?.photo);
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const categoryId = await validCategory(Number(req.body?.category_id));
  if (!photo) throw bad('Chýba fotka.');
  if (!name) throw bad('Pomenuj oblečenie.');
  if (!categoryId) throw bad('Vyber kategóriu.');
  await db.run('INSERT INTO items (user_id, name, category_id, photo, created_at) VALUES (?, ?, ?, ?, ?)',
    req.user.id, name, categoryId, photo, nowIso());
  res.json({ ok: true });
});

me.patch('/items/:id', async (req, res) => {
  const item = await db.get('SELECT * FROM items WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  if (!item) throw notFound('Kúsok neexistuje.');
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) : item.name;
  const categoryId = b.category_id !== undefined ? await validCategory(Number(b.category_id)) : item.category_id;
  const archived = b.archived !== undefined ? (b.archived ? 1 : 0) : item.archived;
  if (!name) throw bad('Názov nemôže byť prázdny.');
  await db.run('UPDATE items SET name = ?, category_id = ?, archived = ? WHERE id = ?', name, categoryId, archived, item.id);
  res.json({ ok: true });
});

// Odovzdanie ponuky na zajtra. Po deadline len za tokeny.
me.post('/submit', async (req, res) => {
  const cycle = await currentCycle();
  const ids = [...new Set((req.body?.item_ids || []).map(Number))];
  if (ids.length === 0) throw bad('Označ aspoň jeden kúsok, z ktorého sa má vyberať.');
  const owned = new Set((await db.all('SELECT id FROM items WHERE user_id = ? AND archived = 0', req.user.id)).map((r) => r.id));
  if (!ids.every((id) => owned.has(id))) throw bad('Niektorý z vybraných kúskov neexistuje.');

  const existing = await getDay(req.user.id, cycle.target);
  if (existing?.outfit) throw bad('Outfit na zajtra je už vybraný – ponuku už nemôžeš meniť.');

  const hasOffer = existing && existing.status !== 'self';
  let status = hasOffer ? existing.status : 'submitted'; // úprava ponuky – stav (včas / za token) sa zachováva
  const extra = [];
  if (cycle.passed && !hasOffer) {
    // Po deadline a ešte nič platné neodovzdané -> treba zaplatiť tokenmi.
    const cost = Number(await getSetting('late_cost')) || 0;
    if (!req.body?.use_tokens) throw new HttpError(409, `Deadline ${cycle.deadlineLabel} už prešiel. Môžeš použiť tokeny (${cost}) alebo si vybrať sama/sám.`);
    if (req.user.tokens < cost) throw new HttpError(402, 'Nemáš dosť tokenov. Zarob si ich splnením úlohy v záložke Úlohy.');
    if (cost > 0) extra.push(...txStatements(req.user.id, -cost, `Oneskorená ponuka na ${cycle.target}`));
    status = 'late_token';
  }
  await db.batch([
    ...extra,
    [`INSERT INTO days (user_id, date, status, offer, submitted_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET status = excluded.status, offer = excluded.offer, submitted_at = excluded.submitted_at`,
    req.user.id, cycle.target, status, JSON.stringify(ids), nowIso()],
  ]);
  res.json({ ok: true, status });
});

// Po deadline sa osoba môže rozhodnúť, že si zajtra vyberie sama.
me.post('/self', async (req, res) => {
  const cycle = await currentCycle();
  if (!cycle.passed) throw bad(`Do ${cycle.deadlineLabel} ešte stihneš odovzdať ponuku.`);
  const existing = await getDay(req.user.id, cycle.target);
  if (existing && existing.status !== 'self') throw bad('Ponuku na zajtra už máš odovzdanú.');
  await db.run(`INSERT INTO days (user_id, date, status, submitted_at) VALUES (?, ?, 'self', ?)
    ON CONFLICT(user_id, date) DO NOTHING`, req.user.id, cycle.target, nowIso());
  res.json({ ok: true });
});

me.get('/tasks', async (req, res) => {
  res.json({
    tasks: await db.all('SELECT id, title, description, reward FROM tasks WHERE active = 1 ORDER BY created_at DESC'),
    submissions: await db.all(`SELECT s.*, t.title FROM task_submissions s JOIN tasks t ON t.id = s.task_id
      WHERE s.user_id = ? ORDER BY s.created_at DESC`, req.user.id),
  });
});

me.post('/tasks/:id/submit', async (req, res) => {
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND active = 1', Number(req.params.id));
  const video = fileUrl(req.body?.video);
  if (!task) throw notFound('Úloha neexistuje.');
  if (!video) throw bad('Nahraj video, na ktorom je vidieť, ako úlohu robíš.');
  await db.run('INSERT INTO task_submissions (task_id, user_id, video, note, created_at) VALUES (?, ?, ?, ?, ?)',
    task.id, req.user.id, video, String(req.body?.note || '').slice(0, 500), nowIso());
  res.json({ ok: true });
});

me.get('/transactions', async (req, res) => {
  res.json(await db.all('SELECT amount, reason, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200', req.user.id));
});

app.use('/api/me', me);

// ---------------------------------------------------------------------------
// API pre admina
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/overview', async (_req, res) => {
  const cycle = await currentCycle();
  const ids = await db.all('SELECT id FROM users ORDER BY active DESC, name');
  const counts = new Map((await db.all('SELECT user_id, COUNT(*) AS n FROM items WHERE archived = 0 GROUP BY user_id')).map((r) => [r.user_id, r.n]));
  const days = await db.all('SELECT * FROM days WHERE date IN (?, ?)', cycle.today, cycle.target);
  const dayOf = (id, date) => publicDay(days.find((d) => d.user_id === id && d.date === date));
  const users = [];
  for (const { id } of ids) {
    const u = await loadUser(id);
    users.push({ ...publicUser(u, { withToken: true }), item_count: counts.get(id) || 0,
      tomorrow: dayOf(id, cycle.target), today: dayOf(id, cycle.today) });
  }
  const pending = (await db.get("SELECT COUNT(*) AS n FROM task_submissions WHERE status = 'pending'")).n;
  res.json({ cycle, users, pending_tasks: pending });
});

async function userOr404(id) {
  const u = await loadUser(Number(id));
  if (!u) throw notFound('Osoba neexistuje.');
  return u;
}

admin.get('/users/:id', async (req, res) => {
  const u = await userOr404(req.params.id);
  res.json({
    user: publicUser(u, { withToken: true }),
    cycle: await currentCycle(),
    items: await itemsOf(u.id, true),
    days: (await db.all('SELECT * FROM days WHERE user_id = ? ORDER BY date DESC LIMIT 30', u.id)).map(publicDay),
    transactions: await db.all('SELECT amount, reason, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100', u.id),
  });
});

admin.patch('/users/:id', async (req, res) => {
  const u = await userOr404(req.params.id);
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = String(b.name).trim().slice(0, 60);
    if (!name) throw bad('Meno nemôže byť prázdne.');
    await db.run('UPDATE users SET name = ? WHERE id = ?', name, u.id);
  }
  if (b.active !== undefined) await db.run('UPDATE users SET active = ? WHERE id = ?', b.active ? 1 : 0, u.id);
  if (b.regenerate_link) await db.run('UPDATE users SET token = ? WHERE id = ?', randomToken(), u.id);
  res.json({ ok: true });
});

admin.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Osoba neexistuje.');
  const files = [u.front_photo, u.back_photo,
    ...(await db.all('SELECT photo FROM items WHERE user_id = ?', id)).map((r) => r.photo),
    ...(await db.all('SELECT video FROM task_submissions WHERE user_id = ?', id)).map((r) => r.video)];
  await db.batch([
    ['DELETE FROM items WHERE user_id = ?', id],
    ['DELETE FROM days WHERE user_id = ?', id],
    ['DELETE FROM transactions WHERE user_id = ?', id],
    ['DELETE FROM task_submissions WHERE user_id = ?', id],
    ['DELETE FROM users WHERE id = ?', id],
    ['UPDATE invites SET used_by = NULL, revoked = 1 WHERE used_by = ?', id],
  ]);
  await Promise.all(files.map(removeFile));
  res.json({ ok: true });
});

admin.post('/users/:id/tokens', async (req, res) => {
  const u = await userOr404(req.params.id);
  const amount = Math.trunc(Number(req.body?.amount));
  if (!amount) throw bad('Zadaj počet tokenov (kladný alebo záporný).');
  await addTransaction(u.id, amount, String(req.body?.reason || '').trim().slice(0, 120) || (amount > 0 ? 'Bonus od admina' : 'Odobraté adminom'));
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
admin.put('/users/:id/outfit/:date', async (req, res) => {
  const u = await userOr404(req.params.id);
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Neplatný dátum.');
  const valid = new Set((await db.all('SELECT id FROM items WHERE user_id = ?', u.id)).map((r) => r.id));
  const items = [...new Set((req.body?.items || []).map(Number))].filter((id) => valid.has(id));
  if (items.length === 0) throw bad('Outfit musí obsahovať aspoň jeden kúsok.');
  const outfit = { items, front: sanitizeLayers(req.body?.front, valid), back: sanitizeLayers(req.body?.back, valid) };
  await db.run(`INSERT INTO days (user_id, date, status, outfit, outfit_note, outfit_at) VALUES (?, ?, 'admin', ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET outfit = excluded.outfit, outfit_note = excluded.outfit_note, outfit_at = excluded.outfit_at`,
  u.id, date, JSON.stringify(outfit), String(req.body?.note || '').slice(0, 500), nowIso());
  res.json({ ok: true });
});

admin.delete('/users/:id/outfit/:date', async (req, res) => {
  const id = Number(req.params.id);
  const day = await getDay(id, req.params.date);
  if (day?.status === 'admin') await db.run('DELETE FROM days WHERE user_id = ? AND date = ?', id, req.params.date);
  else await db.run('UPDATE days SET outfit = NULL, outfit_note = NULL, outfit_at = NULL WHERE user_id = ? AND date = ?', id, req.params.date);
  res.json({ ok: true });
});

// ---- pozvánky ----
admin.get('/invites', async (_req, res) => {
  res.json(await db.all(`SELECT i.code, i.label, i.created_at, i.revoked, u.name AS used_by_name FROM invites i
    LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC`));
});
admin.post('/invites', async (req, res) => {
  const code = randomToken(12);
  await db.run('INSERT INTO invites (code, label, created_at) VALUES (?, ?, ?)', code, String(req.body?.label || '').trim().slice(0, 60), nowIso());
  res.json({ code, url: `/join/${code}` });
});
admin.delete('/invites/:code', async (req, res) => {
  await db.run('UPDATE invites SET revoked = 1 WHERE code = ?', req.params.code);
  res.json({ ok: true });
});

// ---- úlohy ----
admin.get('/tasks', async (_req, res) => {
  res.json({
    tasks: await db.all('SELECT * FROM tasks ORDER BY active DESC, created_at DESC'),
    submissions: await db.all(`SELECT s.*, t.title, t.reward, u.name AS user_name FROM task_submissions s
      JOIN tasks t ON t.id = s.task_id JOIN users u ON u.id = s.user_id
      ORDER BY (s.status = 'pending') DESC, s.created_at DESC LIMIT 200`),
  });
});
admin.post('/tasks', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) throw bad('Zadaj názov úlohy.');
  const reward = Math.max(0, Math.trunc(Number(req.body?.reward) || 0));
  await db.run('INSERT INTO tasks (title, description, reward, created_at) VALUES (?, ?, ?, ?)',
    title, String(req.body?.description || '').slice(0, 2000), reward, nowIso());
  res.json({ ok: true });
});
admin.patch('/tasks/:id', async (req, res) => {
  const t = await db.get('SELECT * FROM tasks WHERE id = ?', Number(req.params.id));
  if (!t) throw notFound('Úloha neexistuje.');
  const b = req.body || {};
  await db.run('UPDATE tasks SET title = ?, description = ?, reward = ?, active = ? WHERE id = ?',
    b.title !== undefined ? String(b.title).trim().slice(0, 120) || t.title : t.title,
    b.description !== undefined ? String(b.description).slice(0, 2000) : t.description,
    b.reward !== undefined ? Math.max(0, Math.trunc(Number(b.reward) || 0)) : t.reward,
    b.active !== undefined ? (b.active ? 1 : 0) : t.active, t.id);
  res.json({ ok: true });
});

// Vyhodnotenie videa: approved = splnené, exception = výnimka (uznané aj keď nie dokonalé), rejected = nesplnené.
admin.post('/submissions/:id/review', async (req, res) => {
  const s = await db.get('SELECT s.*, t.reward, t.title FROM task_submissions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?', Number(req.params.id));
  if (!s) throw notFound('Odovzdanie neexistuje.');
  if (s.status !== 'pending') throw bad('Toto už bolo vyhodnotené.');
  const decision = req.body?.decision;
  if (!['approved', 'rejected', 'exception'].includes(decision)) throw bad('Neplatné rozhodnutie.');
  const bonus = Math.max(0, Math.trunc(Number(req.body?.bonus) || 0));
  const granted = decision === 'rejected' ? 0 : s.reward + bonus;
  // Podmienka na status zabráni dvojitému pripísaniu pri dvojkliku.
  const upd = await db.run(`UPDATE task_submissions SET status = ?, admin_note = ?, granted = ?, reviewed_at = ?
    WHERE id = ? AND status = 'pending'`, decision, String(req.body?.admin_note || '').slice(0, 500), granted, nowIso(), s.id);
  if (!upd.rowsAffected) throw bad('Toto už bolo vyhodnotené.');
  if (granted > 0) {
    const label = decision === 'exception' ? 'Výnimka' : 'Splnená úloha';
    await addTransaction(s.user_id, granted, `${label}: ${s.title}${bonus ? ` (+${bonus} extra)` : ''}`);
  }
  res.json({ ok: true, granted });
});

// ---- nastavenia ----
admin.get('/settings', async (_req, res) => {
  res.json({
    deadline: await getSetting('deadline'), weekly_tokens: Number(await getSetting('weekly_tokens')),
    late_cost: Number(await getSetting('late_cost')), password_from_env: !!process.env.ADMIN_PASSWORD,
    categories: await db.all(`SELECT c.id, c.name, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS used
      FROM categories c ORDER BY c.sort, c.name`),
  });
});
admin.put('/settings', async (req, res) => {
  const b = req.body || {};
  if (b.deadline !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.deadline)) throw bad('Deadline musí byť v tvare HH:MM.');
    await setSetting('deadline', b.deadline);
  }
  if (b.weekly_tokens !== undefined) await setSetting('weekly_tokens', Math.max(0, Math.trunc(Number(b.weekly_tokens) || 0)));
  if (b.late_cost !== undefined) await setSetting('late_cost', Math.max(0, Math.trunc(Number(b.late_cost) || 0)));
  if (b.new_password) {
    if (process.env.ADMIN_PASSWORD) throw bad('Heslo je nastavené cez ADMIN_PASSWORD – zmeň ho tam.');
    if (String(b.new_password).length < 6) throw bad('Heslo musí mať aspoň 6 znakov.');
    await setSetting('admin_password', hashPassword(String(b.new_password)));
  }
  res.json({ ok: true });
});
admin.post('/categories', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) throw bad('Zadaj názov kategórie.');
  if (await db.get('SELECT id FROM categories WHERE name = ?', name)) throw bad('Taká kategória už existuje.');
  const { s } = await db.get('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories');
  await db.run('INSERT INTO categories (name, sort) VALUES (?, ?)', name, s);
  res.json({ ok: true });
});
admin.delete('/categories/:id', async (req, res) => {
  const id = Number(req.params.id);
  await db.batch([['UPDATE items SET category_id = NULL WHERE category_id = ?', id], ['DELETE FROM categories WHERE id = ?', id]]);
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// ---- chyby ----
app.use('/api', () => { throw notFound('Nenájdené.'); });
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Súbor je príliš veľký.' : 'Chyba pri nahrávaní.' });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Chyba servera.' : err.message });
});

module.exports = { app, db, ready, currentCycle };
