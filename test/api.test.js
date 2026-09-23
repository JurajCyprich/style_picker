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

test('nové funkcie: stav kúsku, fotka v outfite, šablóny, komentáre, úlohy, štatistiky, záloha', async () => {
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'tajne-heslo' });
  const { data: inv } = await admin('POST', '/api/admin/invites', {});
  const user = client();
  const code = inv.url.split('/').pop();
  const photo = async (who, inviteCode) => (await upload(who, img(), 'x.png', 'image', inviteCode)).data.url;
  const f = await photo(user, code);
  await user('POST', `/api/join/${code}`, { name: 'Zuzka', front: f, back: f });
  let me = (await user('GET', '/api/me')).data;
  const uid = me.user.id;
  const { data: cats } = await user('GET', '/api/categories');
  for (const name of ['Tričko A', 'Rifle B']) await user('POST', '/api/me/items', { name, category_id: cats[0].id, photo: await photo(user) });
  me = (await user('GET', '/api/me')).data;
  const [a, b] = me.items.map((i) => i.id);

  // kúsok v prádle sa nedá ponúknuť
  await admin('PUT', '/api/admin/settings', { deadline: '23:59' });
  assert.equal((await user('PATCH', `/api/me/items/${a}`, { status: 'laundry' })).status, 200);
  assert.equal((await user('POST', '/api/me/submit', { item_ids: [a] })).status, 400);
  await user('PATCH', `/api/me/items/${a}`, { status: 'ok' });
  assert.equal((await user('POST', '/api/me/submit', { item_ids: [a, b] })).status, 200);

  // šablóna a outfit na dnes + fotka v outfite
  const layers = { items: [a, b], front: [{ item_id: a, x: 50, y: 30, w: 40 }], back: [] };
  assert.equal((await admin('POST', `/api/admin/users/${uid}/templates`, { name: 'Obľúbený', ...layers })).status, 200);
  const { data: tpl } = await admin('GET', `/api/admin/users/${uid}/templates`);
  assert.equal(tpl[0].name, 'Obľúbený');
  assert.deepEqual(tpl[0].outfit.items, [a, b]);
  await admin('PUT', `/api/admin/users/${uid}/outfit/${me.cycle.today}`, tpl[0].outfit);
  assert.equal((await user('POST', '/api/me/proof', { photo: await photo(user) })).status, 200);
  let ov = (await admin('GET', '/api/admin/overview')).data;
  assert.equal(ov.proofs.length, 1);
  assert.equal((await admin('POST', `/api/admin/users/${uid}/proof/${me.cycle.today}`, { decision: 'rejected', penalty: 2, note: 'Iné topánky' })).status, 200);
  me = (await user('GET', '/api/me')).data;
  assert.equal(me.today.proof_status, 'rejected');
  assert.equal(me.user.tokens, 3);

  // komentáre a výnimka za token
  await user('POST', `/api/me/comments/${me.cycle.today}`, { text: 'Môžem iné topánky?' });
  await admin('POST', `/api/admin/users/${uid}/comments/${me.cycle.today}`, { text: 'ok', charge: 1 });
  me = (await user('GET', '/api/me')).data;
  assert.equal(me.comments.length, 2);
  assert.match(me.comments[1].text, /Výnimka povolená/);
  assert.equal(me.user.tokens, 2);

  // história a štatistiky
  assert.equal((await user('GET', '/api/me/history')).data.length, 1);
  const { data: st } = await admin('GET', `/api/admin/users/${uid}/stats`);
  assert.equal(st.outfits, 1);
  assert.equal(st.proofs_bad, 1);
  assert.equal(st.top.length, 2);

  // úloha len pre inú osobu sa nezobrazí; úloha „raz“ sa dá splniť raz
  await admin('POST', '/api/admin/tasks', { title: 'Len pre iných', reward: 1, assignees: [99999] });
  await admin('POST', '/api/admin/tasks', { title: 'Raz', reward: 1, repeat: 'once', assignees: [uid] });
  let { data: t } = await user('GET', '/api/me/tasks');
  assert.ok(!t.tasks.some((x) => x.title === 'Len pre iných'));
  const once = t.tasks.find((x) => x.title === 'Raz');
  const video = async () => (await upload(user, new Blob([Buffer.from('x')], { type: 'video/mp4' }), 'v.mp4', 'video')).data.url;
  assert.equal((await user('POST', `/api/me/tasks/${once.id}/submit`, { video: await video() })).status, 200);
  assert.equal((await user('POST', `/api/me/tasks/${once.id}/submit`, { video: await video() })).status, 400);
  const { data: at } = await admin('GET', '/api/admin/tasks');
  await admin('POST', `/api/admin/submissions/${at.submissions.find((x) => x.title === 'Raz').id}/review`, { decision: 'approved' });
  ({ data: t } = await user('GET', '/api/me/tasks'));
  assert.equal(t.tasks.find((x) => x.title === 'Raz').available, false);

  // záloha neobsahuje heslo; cron bez oprávnenia neprejde
  const { data: exp } = await admin('GET', '/api/admin/export');
  assert.ok(exp.users.length >= 1 && !('admin_password' in exp.settings) && !('vapid_private' in exp.settings));
  assert.equal((await client()('GET', '/api/cron/evening')).status, 401);
  assert.equal((await admin('GET', '/api/cron/morning')).status, 200);
  assert.ok((await user('GET', '/api/push/key')).data.key.length > 40);
});
