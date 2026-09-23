'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Malý pomocník na tvorbu elementov: h('div.card', {onclick}, [children])
function h(tag, attrs = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Chyba (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  $('.toast')?.remove();
  const el = h('div.toast' + (isError ? '.error' : ''), {}, msg);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), isError ? 5000 : 2500);
}
// Obalí async handler – chyby zobrazí ako toast a počas behu zablokuje tlačidlo.
function guarded(fn) {
  return async function (ev) {
    const btn = ev?.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : ev?.submitter;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    try { await fn.call(this, ev); } catch (e) { toast(e.message, true); } finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); } }
  };
}

const fmtDate = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'numeric' });
const fmtDateTime = (s) => new Date(s).toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
function fmtCountdown(ms) {
  if (ms <= 0) return '0:00:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function tokenWord(n) {
  const a = Math.abs(n);
  return a === 1 ? 'token' : a >= 2 && a <= 4 ? 'tokeny' : 'tokenov';
}

const STATUS = {
  submitted: ['Ponuka odovzdaná včas', 'ok'],
  late_token: ['Neskoro – zaplatené tokenom', 'warn'],
  self: ['Vyberá si sama/sám', 'danger'],
  admin: ['Vybrané adminom', 'accent'],
};
function statusBadge(day, cycle, isTarget) {
  if (day?.outfit) return h('span.badge.accent', {}, 'Outfit vybraný');
  if (day) { const [t, c] = STATUS[day.status] || [day.status, '']; return h('span.badge' + (c ? '.' + c : ''), {}, t); }
  if (isTarget && cycle && !cycle.passed) return h('span.badge', {}, 'Čaká sa na ponuku');
  return h('span.badge.danger', {}, 'Nestihnuté');
}

// Zmenší fotku v prehliadači pred nahratím (rýchlejší upload, menej miesta).
async function resizeImage(file, max = 1600) {
  if (!file || !file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const keepAlpha = file.type === 'image/png' || file.type === 'image/webp';
    const type = keepAlpha ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise((r) => canvas.toBlob(r, type, 0.88));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + (keepAlpha ? '.webp' : '.jpg'), { type });
  } catch {
    return file;
  }
}

// Náhľad fotky pri výbere súboru v <label class="photo-drop">
function bindPhotoPreview(label) {
  const input = $('input[type=file]', label);
  input.addEventListener('change', () => {
    const f = input.files[0];
    $('img', label)?.remove();
    if (f) label.prepend(h('img', { src: URL.createObjectURL(f), alt: '' }));
  });
}

// Pozícia vrstvy je v percentách šírky/výšky scény, aby vyzerala rovnako na každej obrazovke.
function placeLayer(el, l) {
  el.style.left = `${l.x}%`;
  el.style.top = `${l.y}%`;
  el.style.width = `${l.w}%`;
  el.style.transform = `translate(-50%, -50%) rotate(${l.rot || 0}deg)`;
  el.classList.toggle('blend', !!l.blend);
  el.classList.toggle('flip', !!l.flip);
}

// Iba na zobrazenie hotového outfitu na postave.
function renderStage(personPhoto, layers, itemsById) {
  const stage = h('div.stage.readonly', {}, [h('img.person', { src: personPhoto, alt: 'Postava' })]);
  for (const l of layers || []) {
    const item = itemsById.get(l.item_id);
    if (!item) continue;
    const el = h('div.layer', {}, [h('img', { src: item.photo, alt: item.name })]);
    placeLayer(el, l);
    stage.append(el);
  }
  return stage;
}

const ITEM_STATUS = { ok: 'Dostupné', laundry: 'V prádle', lent: 'Požičané' };

function itemTile(item, { selected, dim, offered, onclick, draggable } = {}) {
  const tile = h('div.tile' + (selected ? '.selected' : '') + (dim ? '.dim' : '') + (offered ? '.offered' : ''), {
    onclick, draggable: draggable ? 'true' : undefined, 'data-id': item.id,
  }, [
    h('div.img', {}, h('img', { src: item.photo, alt: item.name, loading: 'lazy', draggable: false,
      onload: (e) => e.currentTarget.classList.add('loaded'), onerror: (e) => e.currentTarget.classList.add('loaded') })),
    h('div.meta', {}, [h('b', {}, item.name), h('small', {}, item.category || 'Bez kategórie')]),
  ]);
  // Kúsok v prádle / požičaný – viditeľný štítok
  if (item.status && item.status !== 'ok') {
    tile.classList.add('unavail');
    $('.img', tile).append(h('span.state-label', {}, ITEM_STATUS[item.status]));
  }
  // Obrázok z cache je hneď hotový – bez zbytočného prelínania pri prekreslení.
  const img = $('img', tile);
  if (img.complete && img.naturalWidth) img.classList.add('loaded');
  return tile;
}

function categoryChips(items, current, onPick) {
  const cats = [...new Set(items.map((i) => i.category || 'Bez kategórie'))];
  const wrap = h('div.chips');
  const add = (label, value) => wrap.append(h('button.chip' + (current === value ? '.active' : ''), { type: 'button', onclick: () => onPick(value) }, label));
  add('Všetko', null);
  cats.forEach((c) => add(c, c));
  return wrap;
}
const filterByCategory = (items, cat) => (cat ? items.filter((i) => (i.category || 'Bez kategórie') === cat) : items);

async function logout() {
  await api('POST', '/api/logout');
  location.href = '/';
}

// ---------------------------------------------------------------------------
// Nahrávanie súborov: na Verceli priamo do Vercel Blob, lokálne na server.
// ---------------------------------------------------------------------------
let whoamiCache;
const whoami = () => (whoamiCache ||= api('GET', '/api/whoami'));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Nepodarilo sa načítať nahrávanie.'));
    document.head.append(s);
  });
}

// kind: 'image' | 'video'; invite: kód pozvánky (pri registrácii); onProgress(0–100)
async function uploadFile(file, kind, { invite, onProgress } = {}) {
  if (!file) throw new Error('Vyber súbor.');
  const { storage, max_mb: maxMb, blob_access: blobAccess, blob_error: blobError, blob_mode: blobMode } = await whoami();
  if (blobError) throw new Error(blobError);
  if (storage === 'none') throw new Error('Nahrávanie fotiek ešte nie je nastavené. Daj vedieť adminovi.');
  if (file.size > maxMb[kind] * 1024 * 1024) throw new Error(`Súbor je príliš veľký (max ${maxMb[kind]} MB).`);

  if (storage === 'blob') {
    if (!window.VercelBlob) await loadScript('/vendor/vercel-blob-client.js');
    const safeName = (file.name || 'subor').toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(-60);
    // S kľúčom klientský token, bez kľúča (OIDC) podpísaná adresa – server vie, ktorý režim platí.
    const doUpload = blobMode === 'oidc' ? window.VercelBlob.uploadPresigned : window.VercelBlob.upload;
    const blob = await doUpload(`${kind}s/${safeName}`, file, {
      access: blobAccess || 'public',
      handleUploadUrl: '/api/blob-upload',
      clientPayload: JSON.stringify({ kind, invite }),
      contentType: file.type,
      multipart: blobMode !== 'oidc' && file.size > 20 * 1024 * 1024,
      onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
    });
    return blob.url;
  }

  // Lokálny server – XHR kvôli priebehu nahrávania.
  const qs = new URLSearchParams({ kind, ...(invite ? { invite } : {}) });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?${qs}`);
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* nie je JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.url);
      else reject(new Error(data.error || `Nahrávanie zlyhalo (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Nahrávanie zlyhalo – skontroluj pripojenie.'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

// Zobrazí priebeh nahrávania v toaste.
const progressToast = (label) => (p) => toast(`${label} ${p} %`);

// ---------------------------------------------------------------------------
// Načítavanie a animácie
// ---------------------------------------------------------------------------
function hideSplash() {
  const s = $('#splash');
  if (!s || s.classList.contains('gone')) return;
  s.classList.add('gone');
  setTimeout(() => s.remove(), 600);
}
// Poistka – úvodná obrazovka nikdy neostane visieť.
setTimeout(hideSplash, 8000);

// Horný pásik počas načítavania; vracia funkciu na ukončenie.
function startProgress() {
  let bar = $('#progress');
  if (!bar) { bar = h('div', { id: 'progress' }); document.body.append(bar); }
  bar.className = '';
  void bar.offsetWidth;
  bar.classList.add('on');
  return () => { bar.classList.remove('on'); bar.classList.add('done'); };
}

// Vymení obsah <main id="view"> a skryje úvodnú obrazovku.
// Animuje sa len pri zmene obrazovky (key), nie pri prekreslení tej istej (napr. klik na kúsok).
let lastViewKey;
function swapView(view, key) {
  if (key !== lastViewKey) view.classList.add('view-enter');
  lastViewKey = key;
  $('#view').replaceWith(view);
  hideSplash();
}

// Krátke „nadskočenie“ prvku (napr. pri zmene počtu tokenov).
function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

// ---------------------------------------------------------------------------
// Ikony (inline SVG, farba podľa textu)
// ---------------------------------------------------------------------------
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  video: '<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  shirt: '<path d="M20.4 3.5 16 2a4 4 0 0 1-8 0L3.6 3.5a2 2 0 0 0-1.3 2.2l.6 3.5a1 1 0 0 0 1 .8H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.1a1 1 0 0 0 1-.8l.6-3.5a2 2 0 0 0-1.3-2.2z"/>',
  hanger: '<path d="M12 8a2.5 2.5 0 1 1 2.5-2.5"/><path d="M12 8 2.8 15.2A1.1 1.1 0 0 0 3.5 17h17a1.1 1.1 0 0 0 .7-1.8L12 8z"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2A3 3 0 0 0 12 8c-1.7 0-3 .9-3 2s1.3 1.6 3 2 3 .9 3 2-1.3 2-3 2a3 3 0 0 1-2.8-1.2M12 6.5V8m0 8v1.5"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
};
function icon(name, cls = 'ico') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span.firstChild;
}

// ---------------------------------------------------------------------------
// Vysúvacie okno (na mobile zospodu, na počítači v strede)
// ---------------------------------------------------------------------------
function openSheet(title, body) {
  const dlg = $('#dlg');
  dlg.replaceChildren(h('div.card', {}, [
    h('div.sheet-head', {}, [h('h2', {}, title), h('button.close-x', { type: 'button', 'aria-label': 'Zavrieť', onclick: closeSheet }, icon('x'))]),
    ...[].concat(body),
  ]));
  if (!dlg.dataset.bound) {
    // Klik mimo obsahu okno zavrie.
    dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); });
    dlg.dataset.bound = '1';
  }
  dlg.showModal();
  return dlg;
}
function closeSheet() { const d = $('#dlg'); if (d.open) d.close(); }

// Pásik priebehu nahrávania: el = element, set(p) = percentá
function uploadProgress(label) {
  const bar = h('i');
  const text = h('span', {}, `${label}…`);
  const el = h('div.upload-state', {}, [text, h('div.upbar', {}, bar)]);
  return { el, set: (p) => { bar.style.width = `${p}%`; text.textContent = `${label}… ${p} %`; } };
}

// Výber fotky: tlačidlá „Odfotiť“ a „Z galérie“ s náhľadom. Vráti { el, file() }.
function photoPicker({ hint = 'Zatiaľ žiadna fotka', captureMode = 'environment', onChange } = {}) {
  let file = null;
  const preview = h('div.preview', {}, [h('div', {}, [icon('image'), h('div.small', {}, hint)])]);
  const mkInput = (capture) => h('input', { type: 'file', accept: 'image/*', ...(capture ? { capture: captureMode } : {}),
    onchange: (e) => {
      const f = e.target.files[0];
      if (!f) return;
      file = f;
      preview.classList.add('has');
      preview.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '' }));
      onChange?.(f);
    } });
  const cam = mkInput(true);
  const gal = mkInput(false);
  const el = h('div.photo-pick', {}, [preview, h('div.row', {}, [
    h('button.btn', { type: 'button', onclick: () => cam.click() }, [icon('camera'), 'Odfotiť']),
    h('button.btn', { type: 'button', onclick: () => gal.click() }, [icon('image'), 'Z galérie']),
  ]), cam, gal]);
  // set: nahradí fotku (napr. výsledkom odstránenia pozadia) – na šachovnici vidno priehľadnosť
  const set = (f) => { file = f; preview.classList.add('has', 'checker'); preview.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '' })); };
  return { el, file: () => file, set, reset: () => { file = null; preview.classList.remove('has', 'checker'); preview.replaceChildren(h('div', {}, [icon('image'), h('div.small', {}, hint)])); } };
}

async function shareOrCopy(url, title = 'Style Picker') {
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  await navigator.clipboard.writeText(url);
  toast('Skopírované');
}

// ---------------------------------------------------------------------------
// Push notifikácie
// ---------------------------------------------------------------------------
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let swReg;
async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { swReg = swReg || (await navigator.serviceWorker.register('/sw.js')); } catch { swReg = null; }
  return swReg;
}
registerSW();

// supported: false s dôvodom (napr. iPhone bez pridania na plochu)
async function pushState() {
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    return { supported: false, reason: isIOS && !isStandalone()
      ? 'Na iPhone fungujú upozornenia až keď si appku pridáš na plochu (Zdieľať → Pridať na plochu) a otvoríš ju odtiaľ.'
      : 'Tento prehliadač upozornenia nepodporuje.' };
  }
  const reg = await registerSW();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return { supported: true, permission: Notification.permission, subscribed: !!sub };
}

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// as: 'admin' | 'user'
async function enablePush(as) {
  const st = await pushState();
  if (!st.supported) throw new Error(st.reason);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Upozornenia sú zablokované. Povoľ ich v nastaveniach prehliadača.');
  const reg = await registerSW();
  await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), as });
  try { localStorage.setItem('push-asked', '1'); } catch { /* bez úložiska */ }
}
async function disablePush() {
  const reg = await registerSW();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
}

// Karta s nastavením upozornení (pre admina aj osobu)
function pushCard(as, description) {
  const body = h('div', {}, h('p.muted.small', {}, 'Načítavam…'));
  const card = h('div.card', {}, [h('h2', {}, 'Upozornenia'), h('p.small.muted', {}, description), body]);
  const draw = async () => {
    const st = await pushState();
    if (!st.supported) { body.replaceChildren(h('div.tip', {}, [icon('phone'), h('div', {}, st.reason)])); return; }
    if (st.subscribed && st.permission === 'granted') {
      body.replaceChildren(h('div.row', {}, [
        h('span.badge.ok', {}, [icon('check'), 'Zapnuté na tomto zariadení']),
        h('button.btn.small', { onclick: guarded(async () => { const r = await api('POST', '/api/push/test', { as }); toast(r.sent ? 'Skúšobné upozornenie odoslané' : 'Nepodarilo sa odoslať'); }) }, 'Poslať skúšobné'),
        h('button.btn.small.ghost', { onclick: guarded(async () => { await disablePush(); toast('Upozornenia vypnuté'); draw(); }) }, 'Vypnúť'),
      ]));
    } else if (st.permission === 'denied') {
      body.replaceChildren(h('div.notice.warn', {}, 'Upozornenia sú v prehliadači zablokované. Povoľ ich v nastaveniach stránky (ikona zámku vedľa adresy).'));
    } else {
      body.replaceChildren(h('button.btn.primary', { onclick: guarded(async () => { await enablePush(as); toast('Upozornenia zapnuté ✓'); draw(); }) }, [icon('sparkles'), 'Zapnúť upozornenia']));
    }
  };
  draw();
  return card;
}

// ---------------------------------------------------------------------------
// Správy k outfitu (admin ↔ osoba)
// ---------------------------------------------------------------------------
// who: kto sa pozerá ('admin' | 'user') – jeho správy sú vpravo
function commentsCard(comments, { send, reload, who, allowCharge = false, title = 'Správy k outfitu', hint }) {
  const text = h('textarea', { rows: 2, maxLength: 1000, placeholder: who === 'admin' ? 'Napíš správu…' : 'Napíš adminovi – napr. „môžem si dať iné topánky?“' });
  const list = comments.length ? h('div.thread', {}, comments.map((c) => h('div.msg' + (c.author === who ? '.mine' : ''), {}, [
    h('div.bubble', {}, c.text),
    h('div.meta', {}, `${c.author === 'admin' ? 'Admin' : 'Osoba'} · ${fmtDateTime(c.created_at)}`),
  ]))) : h('p.small.muted', {}, hint || 'Zatiaľ žiadne správy.');
  const charge = h('input', { type: 'number', min: 1, value: 1, style: { width: '72px' } });
  const go = (withCharge) => guarded(async () => {
    if (!withCharge && !text.value.trim()) throw new Error('Napíš správu.');
    await send(text.value, withCharge ? Number(charge.value) : 0);
    toast(withCharge ? 'Výnimka povolená ✓' : 'Odoslané');
    reload();
  });
  return h('div.card', {}, [
    h('h2', {}, title),
    list,
    h('div.stack', { style: { marginTop: '12px' } }, [
      text,
      h('div.row', { style: { gap: '6px' } }, [
        h('button.btn.primary', { onclick: go(false) }, 'Odoslať'),
        allowCharge ? h('span.small.muted', { style: { marginLeft: 'auto' } }, 'alebo') : null,
        allowCharge ? h('button.btn', { onclick: go(true), title: 'Osoba smie outfit zmeniť, strhne sa jej zadaný počet tokenov' }, 'Povoliť výnimku za') : null,
        allowCharge ? charge : null,
        allowCharge ? h('span.small.muted', {}, 'tok.') : null,
      ]),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Odstránenie pozadia z fotky oblečenia (priamo v prehliadači, bez servera)
// Funguje na jednoduchom pozadí: farba pozadia sa odhadne z okrajov fotky a
// od okrajov sa „vyleje“ všetko, čo sa jej podobá. Výsledok sa oreže a okraje zjemnia.
// tolerance: 10 (jemné) – 80 (agresívne)
// ---------------------------------------------------------------------------
async function removeBackground(file, tolerance = 36) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * scale);
  const H = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;

  // Farba pozadia = medián pixelov na okraji
  const border = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) border.push(y * W, y * W + W - 1);
  const med = [0, 1, 2].map((c) => { const v = border.map((i) => px[i * 4 + c]).sort((a, b) => a - b); return v[v.length >> 1]; });
  // Vzdialenosť od farby pozadia: rozdiel jasu a farebného odtieňa zvlášť. Tmavší odtieň
  // tej istej farby (tieň pod oblečením) sa počíta ako bližší – tiene tak zmiznú s pozadím.
  const bgL = (med[0] + med[1] + med[2]) / 3;
  const dist = (i) => {
    const r = px[i * 4]; const g = px[i * 4 + 1]; const b = px[i * 4 + 2];
    const dl = (r + g + b) / 3 - bgL;
    const chroma = Math.hypot(r - med[0] - dl, g - med[1] - dl, b - med[2] - dl);
    return Math.hypot(chroma * 1.2, dl < 0 ? dl * 0.5 : dl);
  };

  // Vylievanie od okrajov (BFS) – odstráni len pozadie spojené s okrajom, nie svetlé miesta vo vnútri kúsku
  const removed = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0; let tail = 0;
  for (const i of border) if (!removed[i] && dist(i) < tolerance) { removed[i] = 1; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++];
    const x = i % W; const y = (i / W) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const n of nb) if (n >= 0 && !removed[n] && dist(n) < tolerance) { removed[n] = 1; queue[tail++] = n; }
  }
  const kept = W * H - tail;
  if (kept < W * H * 0.02) throw new Error('Pozadie sa nepodarilo oddeliť – skús slabšie nastavenie alebo fotku na jednoduchšom pozadí.');

  // Mäkké okraje: priehľadnosť podľa podielu zachovaných susedov (3×3)
  let minX = W; let minY = H; let maxX = 0; let maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (removed[i]) { px[i * 4 + 3] = 0; continue; }
      let k = 0; let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        n++; if (!removed[yy * W + xx]) k++;
      }
      px[i * 4 + 3] = Math.round(255 * Math.min(1, (k / n) * 1.15));
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Orezanie na kúsok s malým okrajom
  const padX = Math.round((maxX - minX) * 0.03); const padY = Math.round((maxY - minY) * 0.03);
  const cx = Math.max(0, minX - padX); const cy = Math.max(0, minY - padY);
  const cw = Math.min(W, maxX + padX + 1) - cx; const ch = Math.min(H, maxY + padY + 1) - cy;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
  // WebP s priehľadnosťou (menší súbor), Safari vráti PNG
  let blob = await new Promise((r) => out.toBlob(r, 'image/webp', 0.9));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const ext = blob.type === 'image/webp' ? 'webp' : 'png';
  return new File([blob], `${(file.name || 'kusok').replace(/\.[^.]+$/, '')}-bez-pozadia.${ext}`, { type: blob.type });
}

// Tlačidlá na odstránenie pozadia s voľbou sily; onDone(file) dostane výsledok
function bgRemoveControls(getFile, onDone) {
  let original = null;
  const strength = { Jemne: 22, Normálne: 36, Silno: 60 };
  let level = 'Normálne';
  const levels = h('div.segmented', { style: { margin: 0 } });
  const drawLevels = () => levels.replaceChildren(...Object.keys(strength).map((k) => h('button.chip' + (k === level ? '.active' : ''), {
    type: 'button', onclick: () => { level = k; drawLevels(); if (original) run(); },
  }, k)));
  const btn = h('button.btn', { type: 'button' }, [icon('sparkles'), 'Odstrániť pozadie']);
  const run = guarded(async () => {
    const src = original || (await getFile()); // getFile môže byť aj async (stiahnutie existujúcej fotky)
    if (!src) throw new Error('Najprv odfoť alebo vyber fotku.');
    original = src;
    btn.classList.add('busy');
    try { onDone(await removeBackground(src, strength[level])); } finally { btn.classList.remove('busy'); }
    levels.classList.remove('hidden');
  });
  btn.addEventListener('click', run);
  drawLevels();
  levels.classList.add('hidden');
  const el = h('div.stack', {}, [h('div.row', { style: { gap: '8px' } }, [btn, levels]),
    h('div.bg-note', {}, 'Najlepšie funguje na jednoduchom svetlom pozadí. Keď sa odstráni aj kus oblečenia, daj „Jemne“.')]);
  return { el, reset: () => { original = null; levels.classList.add('hidden'); } };
}
