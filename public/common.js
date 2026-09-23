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
    if (btn) btn.disabled = true;
    try { await fn.call(this, ev); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
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
  return h('div.tile' + (selected ? '.selected' : '') + (dim ? '.dim' : '') + (offered ? '.offered' : ''), {
    onclick, draggable: draggable ? 'true' : undefined, 'data-id': item.id,
  }, [
    h('div.img', { style: { backgroundImage: `url("${item.photo}")` } }),
    h('div.meta', {}, [h('b', {}, item.name), h('small', {}, item.category || 'Bez kategórie')]),
  ]);
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
