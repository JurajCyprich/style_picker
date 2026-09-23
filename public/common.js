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

function itemTile(item, { selected, dim, offered, onclick, draggable } = {}) {
  const tile = h('div.tile' + (selected ? '.selected' : '') + (dim ? '.dim' : '') + (offered ? '.offered' : ''), {
    onclick, draggable: draggable ? 'true' : undefined, 'data-id': item.id,
  }, [
    h('div.img', {}, h('img', { src: item.photo, alt: item.name, loading: 'lazy', draggable: false,
      onload: (e) => e.currentTarget.classList.add('loaded'), onerror: (e) => e.currentTarget.classList.add('loaded') })),
    h('div.meta', {}, [h('b', {}, item.name), h('small', {}, item.category || 'Bez kategórie')]),
  ]);
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
  return { el, file: () => file, reset: () => { file = null; preview.classList.remove('has'); preview.replaceChildren(h('div', {}, [icon('image'), h('div.small', {}, hint)])); } };
}

async function shareOrCopy(url, title = 'Style Picker') {
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  await navigator.clipboard.writeText(url);
  toast('Skopírované');
}
