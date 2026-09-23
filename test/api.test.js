'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'style-picker-'));
process.env.ADMIN_PASSWORD = 'tajne-heslo';
delete process.env.BLOB_READ_WRITE_TOKEN;
const { app, db, ready } = require('../src/app');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const img = () => new Blob([PNG], { type: 'image/png' });

let server, base;
test.before(async () => { await ready(); await new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }); });
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

function client() {
  const jar = {};
  return async (method, url, body) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
}
async function upload(call, blob, name, kind, invite) {
  const fd = new FormData();
  fd.append('file', blob, name);
  const qs = new URLSearchParams({ kind, ...(invite ? { invite } : {}) });
  return call('POST', `/api/upload?${qs}`, fd);
}

test('celý tok: pozvánka → registrácia → ponuka → outfit → úloha', async () => {
  const admin = client();
  const user = client();

  assert.equal((await admin('POST', '/api/admin/login', { password: 'zle' })).status, 401);
  assert.equal((await admin('POST', '/api/admin/login', { password: 'tajne-heslo' })).status, 200);
  assert.equal((await user('GET', '/api/admin/overview')).status, 401);

  const { data: inv } = await admin('POST', '/api/admin/invites', { label: 'Test' });
  const code = inv.url.split('/').pop();

  // bez pozvánky ani prihlásenia sa nahrávať nedá
  assert.equal((await upload(client(), img(), 'f.png', 'image')).status, 401);
  assert.equal((await user('POST', `/api/join/${code}`, { name: 'Lucka' })).status, 400);
  // video cez pozvánku nie, obrázok áno
  assert.equal((await upload(user, img(), 'f.png', 'video', code)).status, 401);
  const front = (await upload(user, img(), 'front.png', 'image', code)).data.url;
  const back = (await upload(user, img(), 'back.png', 'image', code)).data.url;
  assert.match(front, /^\/uploads\//);
  // cudzie URL sa neprijmú
  assert.equal((await user('POST', `/api/join/${code}`, { name: 'Lucka', front: 'https://evil.example/x.png', back })).status, 400);
  assert.equal((await user('POST', `/api/join/${code}`, { name: 'Lucka', front, back })).status, 200);
  // pozvánka je jednorazová
  assert.equal((await client()('POST', `/api/join/${code}`, { name: 'X', front, back })).status, 410);
  assert.equal((await fetch(base + front)).status, 200);

  let me = (await user('GET', '/api/me')).data;
  assert.equal(me.user.tokens, 5);

  const { data: cats } = await user('GET', '/api/categories');
  const tricko = cats.find((c) => c.name === 'Tričko');
  const photo = (await upload(user, img(), 'tricko.png', 'image')).data.url;
  assert.equal((await user('POST', '/api/me/items', { name: 'Biele tričko', category_id: tricko.id, photo })).status, 200);
  me = (await user('GET', '/api/me')).data;
  const itemId = me.items[0].id;
  assert.equal(me.items[0].category, 'Tričko');

  // pred deadlinom
  await admin('PUT', '/api/admin/settings', { deadline: '23:59' });
  assert.equal((await user('POST', '/api/me/submit', { item_ids: [itemId] })).data.status, 'submitted');

  // admin vyberie outfit
  const target = me.cycle.target;
  const userId = me.user.id;
  assert.equal((await admin('PUT', `/api/admin/users/${userId}/outfit/${target}`, {
    items: [itemId], front: [{ item_id: itemId, x: 50, y: 35, w: 40, rot: 0 }], back: [], note: 'Pekne',
  })).status, 200);
  me = (await user('GET', '/api/me')).data;
  assert.deepEqual(me.tomorrow.outfit.items, [itemId]);
  assert.equal(me.tomorrow.outfit_note, 'Pekne');
  assert.equal((await user('POST', '/api/me/submit', { item_ids: [itemId] })).status, 400);

  // po deadline: bez ponuky treba tokeny
  await admin('DELETE', `/api/admin/users/${userId}/outfit/${target}`);
  await db.run('DELETE FROM days');
  await admin('PUT', '/api/admin/settings', { deadline: '00:00' });
  assert.equal((await user('POST', '/api/me/submit', { item_ids: [itemId] })).status, 409);
  const paid = await user('POST', '/api/me/submit', { item_ids: [itemId], use_tokens: true });
  assert.equal(paid.data.status, 'late_token');
  assert.equal((await user('GET', '/api/me')).data.user.tokens, 4);

  // bez tokenov to nejde
  await admin('POST', `/api/admin/users/${userId}/tokens`, { amount: -4 });
  await db.run('DELETE FROM days');
  assert.equal((await user('POST', '/api/me/submit', { item_ids: [itemId], use_tokens: true })).status, 402);
  assert.equal((await user('POST', '/api/me/self')).status, 200);
  assert.equal((await user('GET', '/api/me')).data.tomorrow.status, 'self');

  // úloha s videom → výnimka + extra kredity
  await admin('POST', '/api/admin/tasks', { title: '20 drepov', reward: 2 });
  const { data: t } = await user('GET', '/api/me/tasks');
  const video = (await upload(user, new Blob([Buffer.from('x')], { type: 'video/mp4' }), 'v.mp4', 'video')).data.url;
  assert.equal((await user('POST', `/api/me/tasks/${t.tasks[0].id}/submit`, { video })).status, 200);
  const { data: at } = await admin('GET', '/api/admin/tasks');
  const r = await admin('POST', `/api/admin/submissions/${at.submissions[0].id}/review`, { decision: 'exception', bonus: 3 });
  assert.equal(r.data.granted, 5);
  // druhé vyhodnotenie (dvojklik) už nič nepripíše
  assert.equal((await admin('POST', `/api/admin/submissions/${at.submissions[0].id}/review`, { decision: 'approved' })).status, 400);
  assert.equal((await user('GET', '/api/me')).data.user.tokens, 5);
});

test('týždenné tokeny sa pripíšu za každý zmeškaný pondelok', async () => {
  const u = await db.get('SELECT id, tokens FROM users LIMIT 1');
  await db.run("UPDATE users SET last_grant_week = date(last_grant_week, '-14 days') WHERE id = ?", u.id);
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'tajne-heslo' });
  const { data } = await admin('GET', `/api/admin/users/${u.id}`);
  assert.equal(data.user.tokens, u.tokens + 10);
});
