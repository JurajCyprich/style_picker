'use strict';

// Rozhranie admina: prehľad ľudí, výber outfitov (drag & drop na postavu), pozvánky, úlohy, nastavenia.
const state = { tab: 'people', userId: null, date: null, seq: 0 };

function render() {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  const view = h('main', { id: 'view' });
  // Voliteľné sekcie (null/false) sa jednoducho vynechajú, nie vypíšu ako text.
  view.append = (...nodes) => Element.prototype.append.apply(view, nodes.filter((n) => n != null && n !== false));
  const renderer = state.tab === 'people' && state.userId ? renderPerson
    : { people: renderPeople, invites: renderInvites, tasks: renderTasks, settings: renderSettings }[state.tab];
  const seq = ++state.seq;
  const done = startProgress();
  Promise.resolve(renderer(view)).then(() => { if (seq === state.seq) swapView(view, `${state.tab}:${state.userId || ''}:${state.date || ''}`); }).finally(done)
    .catch((e) => { if (e.status === 401) location.href = '/'; else toast(e.message, true); });
}
$$('.tab').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; state.userId = null; render(); }));

function setPendingBadge(n) {
  const b = $('#pending-badge');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

// ---------------------------------------------------------------------------
// Prehľad ľudí
// ---------------------------------------------------------------------------
async function renderPeople(view) {
  const { cycle, users, pending_tasks: pending } = await api('GET', '/api/admin/overview');
  const { storage } = await whoami();
  // Bez úložiska na Verceli sa nedajú nahrávať fotky – admin to musí vidieť hneď.
  if (storage === 'none') view.append(h('div.notice.danger', { style: { marginBottom: '16px' } }, [
    h('b', {}, 'Nahrávanie fotiek nefunguje. '),
    'Vo Verceli otvor projekt → Storage → Create → Blob, pripoj ho k projektu a potom Deployments → ⋯ → Redeploy.',
  ]));
  setPendingBadge(pending);
  const active = users.filter((u) => u.active);
  const waiting = active.filter((u) => u.tomorrow && !u.tomorrow.outfit && u.tomorrow.status !== 'self');
  const chosen = active.filter((u) => u.tomorrow?.outfit);
  const stat = (value, label, onclick) => h('div.stat', { onclick, style: onclick ? { cursor: 'pointer' } : undefined }, [h('b', {}, value), h('span', {}, label)]);
  view.append(
    h('div.section-head', {}, [
      h('div', {}, [h('h1', { style: { margin: 0 } }, 'Ľudia'),
        h('div.muted.small', {}, `Outfity na ${fmtDate(cycle.target)} · ${cycle.passed ? `deadline ${cycle.deadlineLabel} prešiel` : `ponuky do ${cycle.deadlineLabel}`}`)]),
      h('button.btn.primary', { onclick: () => { state.tab = 'invites'; render(); } }, '+ Pozvať'),
    ]),
    h('div.stat-row', {}, [
      stat(active.length, 'aktívnych ľudí'),
      stat(waiting.length, 'čaká na tvoj výber'),
      stat(chosen.length, 'outfitov na zajtra'),
      stat(pending, 'videí na vyhodnotenie', () => { state.tab = 'tasks'; render(); }),
    ]),
  );
  if (!users.length) {
    view.append(h('div.card', { style: { textAlign: 'center', padding: '40px 20px', marginTop: '16px' } }, [
      h('h2', {}, 'Zatiaľ tu nikto nie je'),
      h('p.muted', {}, 'Vytvor pozvánku a pošli odkaz osobe, ktorej chceš vyberať oblečenie.'),
      h('button.btn.primary', { onclick: () => { state.tab = 'invites'; render(); } }, 'Vytvoriť pozvánku')]));
    return;
  }
  view.append(h('div.grid.cols-2', { style: { marginTop: '16px' } }, users.map((u) => h('div.card.person-card', {
    style: { opacity: u.active ? 1 : 0.55 },
    onclick: () => { state.userId = u.id; state.date = cycle.target; render(); scrollTo(0, 0); },
  }, [
    h('div.avatar', { style: { backgroundImage: `url("${u.front_photo}")` } }),
    h('div', { style: { flex: 1, minWidth: 0 } }, [
      h('div.row.between', {}, [h('b', {}, u.name), h('span.token-pill.small', {}, `${u.tokens} ${tokenWord(u.tokens)}`)]),
      h('div.small.muted', {}, `${u.item_count} kúskov v šatníku${u.active ? '' : ' · deaktivovaný'}`),
      h('div.row', { style: { marginTop: '8px', gap: '6px' } }, [h('span.small.muted', {}, 'Zajtra'), statusBadge(u.tomorrow, cycle, true)]),
    ]),
    h('span.chev', {}, '›'),
  ]))));
}

// ---------------------------------------------------------------------------
// Detail osoby + editor outfitu
// ---------------------------------------------------------------------------
async function renderPerson(view) {
  const data = await api('GET', `/api/admin/users/${state.userId}`);
  const { user, cycle, items, days, transactions } = data;
  const reload = () => render();

  view.append(h('div.row', { style: { marginBottom: '14px' } }, [
    h('button.btn.small', { onclick: () => { state.userId = null; render(); } }, '← Všetci ľudia'),
  ]));

  // Hlavička
  const link = location.origin + user.personal_link;
  view.append(h('div.card', {}, [
    h('div.person-head', {}, [
      h('div.avatars', {}, [
        h('div.avatar', { style: { backgroundImage: `url("${user.front_photo}")` }, title: 'Spredu' }),
        h('div.avatar', { style: { backgroundImage: `url("${user.back_photo}")` }, title: 'Zozadu' }),
      ]),
      h('div', { style: { flex: 1, minWidth: '160px' } }, [
        h('h1', { style: { marginBottom: '6px' } }, user.name),
        h('div.row', {}, [h('span.token-pill', {}, `${user.tokens} ${tokenWord(user.tokens)}`),
          user.active ? null : h('span.badge.danger', {}, 'deaktivovaný')]),
      ]),
    ]),
    h('div.actions', {}, [
      h('button.btn.small', { onclick: () => tokenDialog(user, reload) }, '± Tokeny'),
      h('button.btn.small', { onclick: () => { navigator.clipboard.writeText(link); toast('Osobný odkaz skopírovaný'); } }, 'Kopírovať odkaz'),
      h('button.btn.small', {
        onclick: guarded(async () => {
          if (!confirm('Vytvoriť nový osobný odkaz? Starý prestane fungovať (osoba sa odhlási).')) return;
          await api('PATCH', `/api/admin/users/${user.id}`, { regenerate_link: true }); toast('Nový odkaz vytvorený'); reload();
        }),
      }, 'Nový odkaz'),
      h('button.btn.small', {
        onclick: guarded(async () => { await api('PATCH', `/api/admin/users/${user.id}`, { active: !user.active }); reload(); }),
      }, user.active ? 'Deaktivovať' : 'Aktivovať'),
      h('button.btn.small.danger', {
        onclick: guarded(async () => {
          if (!confirm(`Natrvalo zmazať ${user.name} aj s celým šatníkom?`)) return;
          await api('DELETE', `/api/admin/users/${user.id}`); state.userId = null; render();
        }),
      }, 'Zmazať'),
    ]),
  ]));

  // Editor
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const date = state.date || cycle.target;
  const day = dayMap.get(date) || null;
  const dateIn = h('input', { type: 'date', value: date, style: { width: 'auto' }, onchange: (e) => { state.date = e.target.value; render(); } });
  view.append(h('div.card', {}, [
    h('div.section-head', {}, [
      h('h2', {}, 'Vybrať outfit'),
      h('div.row', { style: { gap: '6px' } }, [
        h('button.chip' + (date === cycle.today ? '.active' : ''), { onclick: () => { state.date = cycle.today; render(); } }, 'Dnes'),
        h('button.chip' + (date === cycle.target ? '.active' : ''), { onclick: () => { state.date = cycle.target; render(); } }, 'Zajtra'),
        dateIn,
      ]),
    ]),
    h('div.row', { style: { margin: '-4px 0 16px', gap: '8px' } }, [h('span.muted', {}, fmtDate(date)), statusBadge(day, cycle, date === cycle.target),
      day?.offer?.length ? h('span.small.muted', {}, `Ponúknutých kúskov: ${day.offer.length}`) : null]),
    day?.status === 'self' && !day.outfit ? h('div.notice.warn', { style: { marginBottom: '12px' } }, 'Osoba zvolila, že si tento deň vyberie sama. Môžeš jej outfit aj tak vybrať.') : null,
    items.some((i) => !i.archived) ? outfitEditor(user, items, day, date, reload) : h('p.muted', {}, 'Osoba zatiaľ nenahrala žiadne oblečenie.'),
  ]));

  // Šatník
  const active = items.filter((i) => !i.archived);
  view.append(h('div.card', {}, [
    h('h2', {}, `Šatník (${active.length})`),
    h('div.item-grid', {}, active.map((i) => itemTile(i))),
  ]));

  // História
  view.append(h('div.grid.cols-2', { style: { marginTop: '16px' } }, [
    h('div.card', {}, [h('h3', {}, 'Posledné dni'), days.length ? h('div.list', {}, days.map((d) => h('div.row.between', {}, [
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); state.date = d.date; render(); scrollTo(0, 0); } }, fmtDate(d.date)),
      statusBadge(d, cycle, false),
    ]))) : h('p.muted', {}, 'Zatiaľ nič.')]),
    h('div.card', {}, [h('h3', {}, 'Tokeny'), transactions.length ? h('div.list', {}, transactions.map((t) => h('div.row.between', {}, [
      h('div', {}, [h('div.small', {}, t.reason), h('div.small.muted', {}, fmtDateTime(t.created_at))]),
      h('b', { style: { color: t.amount > 0 ? 'var(--ok)' : 'var(--danger)' } }, (t.amount > 0 ? '+' : '') + t.amount),
    ]))) : h('p.muted', {}, 'Zatiaľ nič.')]),
  ]));
}

function tokenDialog(user, done) {
  const dlg = $('#dlg');
  const amount = h('input', { type: 'number', value: 5, step: 1 });
  const reason = h('input', { type: 'text', placeholder: 'Dôvod (napr. bonus, výnimka…)', maxLength: 120 });
  const send = (sign) => guarded(async () => {
    await api('POST', `/api/admin/users/${user.id}/tokens`, { amount: sign * Math.abs(Number(amount.value)), reason: reason.value });
    dlg.close(); toast('Uložené'); done();
  });
  dlg.replaceChildren(h('div.card', {}, [
    h('h2', {}, `Tokeny – ${user.name}`),
    h('label.field', {}, [h('span', {}, 'Počet'), amount]),
    h('label.field', {}, [h('span', {}, 'Dôvod'), reason]),
    h('div.row.between', {}, [h('button.btn', { onclick: () => dlg.close() }, 'Zavrieť'),
      h('div.row', {}, [h('button.btn.danger', { onclick: send(-1) }, 'Odobrať'), h('button.btn.primary', { onclick: send(1) }, 'Pridať')])]),
  ]));
  dlg.showModal();
}

// Predvolená výška na postave podľa kategórie (v % výšky fotky).
function defaultY(item) {
  const c = (item.category || '').toLowerCase();
  if (/topán|obuv|ponož/.test(c)) return 90;
  if (/nohav|rifle|kraťas|sukň/.test(c)) return 62;
  if (/šaty/.test(c)) return 50;
  if (/doplnk/.test(c)) return 20;
  return 35;
}
function defaultW(item) {
  const c = (item.category || '').toLowerCase();
  if (/topán|obuv|ponož|doplnk/.test(c)) return 22;
  if (/nohav|rifle|šaty/.test(c)) return 34;
  return 45;
}

function outfitEditor(user, items, day, date, reload) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const offer = new Set(day?.offer || []);
  const ed = {
    side: 'front',
    items: new Set(day?.outfit?.items || []),
    front: structuredClone(day?.outfit?.front || []),
    back: structuredClone(day?.outfit?.back || []),
    sel: null,              // index vybranej vrstvy na aktuálnej strane
    onlyOffer: offer.size > 0,
    cat: null,
  };
  const note = h('textarea', { placeholder: 'Poznámka pre osobu (nepovinné) – napr. „rukávy vyhrnúť“', maxLength: 500 }, day?.outfit_note || '');

  const stage = h('div.stage');
  const person = h('img.person', { alt: 'Postava' });
  const tools = h('div.tools');
  const palette = h('div');
  const sideChips = h('div.segmented');
  let layerEls = [];

  const layers = () => ed[ed.side];

  function addLayer(item, x, y) {
    ed.items.add(item.id);
    layers().push({ item_id: item.id, x: x ?? 50, y: y ?? defaultY(item), w: defaultW(item), rot: 0, blend: false, flip: false });
    ed.sel = layers().length - 1;
  }
  function removeItem(id) {
    ed.items.delete(id);
    ed.front = ed.front.filter((l) => l.item_id !== id);
    ed.back = ed.back.filter((l) => l.item_id !== id);
    ed.sel = null;
  }
  // Pri prvom prepnutí na druhú stranu sa kúsky prenesú zrkadlovo.
  function switchSide(side) {
    ed.side = side;
    ed.sel = null;
    const other = ed[side === 'front' ? 'back' : 'front'];
    if (ed[side].length === 0 && other.length) ed[side] = other.map((l) => ({ ...l, x: 100 - l.x, rot: -l.rot }));
    drawAll();
  }

  function drawStage() {
    person.src = ed.side === 'front' ? user.front_photo : user.back_photo;
    stage.replaceChildren(person);
    layerEls = [];
    layers().forEach((l, idx) => {
      const item = byId.get(l.item_id);
      if (!item) return;
      const el = h('div.layer' + (idx === ed.sel ? '.sel' : ''), { 'data-idx': idx }, [h('img', { src: item.photo, alt: item.name, draggable: false })]);
      placeLayer(el, l);
      el.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        l.w = Math.min(200, Math.max(2, l.w * (ev.deltaY < 0 ? 1.06 : 1 / 1.06)));
        placeLayer(el, l);
        if (ed.sel === idx) drawTools();
      }, { passive: false });
      layerEls[idx] = el;
      stage.append(el);
    });
    if (!layers().length) stage.append(h('div.empty-hint', {}, 'Pridaj oblečenie z ponuky'));
  }

  function selectLayer(idx) {
    if (ed.sel === idx) return;
    ed.sel = idx;
    layerEls.forEach((n, i) => n?.classList.toggle('sel', i === idx));
    drawTools();
  }

  // Gestá na postave: 1 prst/myš = posun, 2 prsty = zväčšenie a otočenie vybraného kúsku.
  const pts = new Map();
  let gesture = null;
  const pctX = (dx) => (dx / stage.getBoundingClientRect().width) * 100;
  const pctY = (dy) => (dy / stage.getBoundingClientRect().height) * 100;
  function beginGesture(target) {
    const l = ed.sel !== null ? layers()[ed.sel] : null;
    const p = [...pts.values()];
    if (p.length >= 2 && l) {
      const [a, b] = p;
      gesture = { type: 'pinch', d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x),
        m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, w0: l.w, r0: l.rot, x0: l.x, y0: l.y };
    } else if (p.length === 1) {
      const layerEl = target?.closest?.('.layer');
      if (layerEl) selectLayer(Number(layerEl.dataset.idx));
      const cur = ed.sel !== null ? layers()[ed.sel] : null;
      gesture = layerEl && cur ? { type: 'drag', sx: p[0].x, sy: p[0].y, x0: cur.x, y0: cur.y } : { type: 'tap', sx: p[0].x, sy: p[0].y };
    } else gesture = null;
  }
  stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    beginGesture(e.target);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const l = ed.sel !== null ? layers()[ed.sel] : null;
    const el = layerEls[ed.sel];
    if (!gesture || !l || !el) return;
    if (gesture.type === 'drag') {
      l.x = gesture.x0 + pctX(e.clientX - gesture.sx);
      l.y = gesture.y0 + pctY(e.clientY - gesture.sy);
    } else if (gesture.type === 'pinch') {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      let rot = gesture.r0 + ((ang - gesture.a0) * 180) / Math.PI;
      rot = ((rot + 540) % 360) - 180;
      l.w = Math.min(200, Math.max(2, gesture.w0 * (d / gesture.d0)));
      l.rot = Math.round(rot);
      l.x = gesture.x0 + pctX((a.x + b.x) / 2 - gesture.m0.x);
      l.y = gesture.y0 + pctY((a.y + b.y) / 2 - gesture.m0.y);
    } else return;
    el.classList.add('sel');
    placeLayer(el, l);
  });
  const endPointer = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    // Ťuknutie mimo oblečenia zruší výber.
    if (gesture?.type === 'tap' && pts.size === 0 && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < 6) {
      ed.sel = null; drawStage(); drawTools();
    } else if (gesture?.type === 'pinch' || gesture?.type === 'drag') drawTools();
    beginGesture(null);
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  // HTML5 drag & drop z palety na postavu
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragover');
    const item = byId.get(Number(e.dataTransfer.getData('text/plain')));
    if (!item) return;
    const r = stage.getBoundingClientRect();
    addLayer(item, ((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100);
    drawAll();
  });

  function drawTools() {
    const l = ed.sel !== null ? layers()[ed.sel] : null;
    if (!l) {
      tools.replaceChildren(h('p.small.muted', { style: { margin: 0 } }, matchMedia('(pointer: coarse)').matches
        ? 'Ťukni na kúsok na postave. Ťahaj ho prstom, dvoma prstami ho zväčšíš a otočíš.'
        : 'Klikni na kúsok na postave. Ťahaj ho myšou, kolieskom ho zväčšíš, posuvníkmi otočíš.'));
      return;
    }
    const item = byId.get(l.item_id);
    const upd = () => drawStage();
    const slider = (label, key, min, max, step) => [h('span', {}, label), h('input', {
      type: 'range', min, max, step, value: l[key], oninput: (e) => { l[key] = Number(e.target.value); upd(); },
    })];
    tools.replaceChildren(h('div.stack', {}, [
      h('b', {}, item?.name || ''),
      h('div.layer-tools', {}, [...slider('Veľkosť', 'w', 5, 150, 0.5), ...slider('Otočenie', 'rot', -180, 180, 1)]),
      h('div.row', {}, [
        h('button.btn.small', { onclick: () => { const [x] = layers().splice(ed.sel, 1); layers().push(x); ed.sel = layers().length - 1; upd(); } }, 'Dopredu'),
        h('button.btn.small', { onclick: () => { const [x] = layers().splice(ed.sel, 1); layers().unshift(x); ed.sel = 0; upd(); } }, 'Dozadu'),
        h('button.btn.small', { onclick: () => { l.flip = !l.flip; upd(); } }, 'Zrkadliť'),
        h('button.btn.small' + (l.blend ? '.primary' : ''), { title: 'Skryje biele pozadie fotky', onclick: () => { l.blend = !l.blend; upd(); drawTools(); } }, 'Bez bieleho pozadia'),
        h('button.btn.small.danger', { onclick: () => { layers().splice(ed.sel, 1); ed.sel = null; drawAll(); } }, 'Zložiť'),
      ]),
    ]));
  }

  function drawPalette() {
    const pool = items.filter((i) => !i.archived && (!ed.onlyOffer || offer.has(i.id) || ed.items.has(i.id)));
    palette.replaceChildren(
      offer.size ? h('label.row.small', { style: { marginBottom: '8px' } }, [
        h('input', { type: 'checkbox', checked: ed.onlyOffer, onchange: (e) => { ed.onlyOffer = e.target.checked; drawPalette(); } }),
        'Len kúsky z ponuky osoby',
      ]) : h('p.small.muted', {}, 'Osoba na tento deň neposlala ponuku – vyberáš z celého šatníka.'),
      categoryChips(pool, ed.cat, (c) => { ed.cat = c; drawPalette(); }),
      h('div.item-grid.palette', {}, filterByCategory(pool, ed.cat).map((i) => {
        const tile = itemTile(i, {
          selected: ed.items.has(i.id), offered: offer.has(i.id), draggable: true,
          onclick: () => {
            if (!ed.items.has(i.id)) addLayer(i);
            else if (!layers().some((l) => l.item_id === i.id)) addLayer(i);
            else removeItem(i.id);
            drawAll();
          },
        });
        tile.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i.id)));
        return tile;
      })),
    );
  }

  function drawSide() {
    sideChips.replaceChildren(...['front', 'back'].map((s) => h('button.chip' + (ed.side === s ? '.active' : ''), {
      type: 'button', onclick: () => switchSide(s),
    }, `${s === 'front' ? 'Spredu' : 'Zozadu'} (${ed[s].length})`)));
  }

  function drawAll() { drawSide(); drawStage(); drawTools(); drawPalette(); }
  drawAll();

  const save = guarded(async () => {
    await api('PUT', `/api/admin/users/${user.id}/outfit/${date}`, {
      items: [...ed.items], front: ed.front, back: ed.back, note: note.value,
    });
    toast('Outfit uložený ✓');
    reload();
  });
  const clear = guarded(async () => {
    if (!confirm('Zrušiť vybraný outfit na tento deň?')) return;
    await api('DELETE', `/api/admin/users/${user.id}/outfit/${date}`);
    reload();
  });

  return h('div.editor', {}, [
    h('div.stage-wrap', {}, [sideChips, stage, tools]),
    h('div.editor-side', {}, [
      h('h3', {}, 'Oblečenie'),
      h('p.small.muted', {}, 'Ťukni na kúsok alebo ho potiahni na postavu. Druhým ťuknutím ho z outfitu odstrániš.'),
      palette,
      h('label.field', { style: { marginTop: '16px' } }, [h('span', {}, 'Poznámka pre osobu'), note]),
      h('div.row', {}, [
        h('button.btn.primary', { onclick: save }, day?.outfit ? 'Uložiť zmeny' : 'Potvrdiť outfit'),
        day?.outfit ? h('button.btn.danger', { onclick: clear }, 'Zrušiť outfit') : null,
      ]),
      day?.outfit ? h('p.small.muted', { style: { marginTop: '8px' } }, `Vybrané ${fmtDateTime(day.outfit_at)}`) : null,
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Pozvánky
// ---------------------------------------------------------------------------
async function renderInvites(view) {
  const invites = await api('GET', '/api/admin/invites');
  const label = h('input', { type: 'text', placeholder: 'Pre koho (napr. Lucka) – nepovinné', maxLength: 60 });
  view.append(h('div.card', {}, [
    h('h2', {}, 'Nová pozvánka'),
    h('p.muted.small', {}, 'Každý odkaz sa dá použiť na jednu registráciu. Osoba pri nej nahrá fotky v T-póze spredu a zozadu.'),
    h('div.row', {}, [h('div', { style: { flex: 1, minWidth: '200px' } }, label), h('button.btn.primary', {
      onclick: guarded(async () => {
        const { url } = await api('POST', '/api/admin/invites', { label: label.value });
        const full = location.origin + url;
        try { await navigator.clipboard.writeText(full); toast('Odkaz vytvorený a skopírovaný'); } catch { toast('Odkaz vytvorený'); }
        render();
      }),
    }, 'Vytvoriť odkaz')]),
  ]));
  view.append(h('div.card', {}, [h('h2', {}, 'Odkazy'), invites.length ? h('div.list', {}, invites.map((inv) => {
    const full = `${location.origin}/join/${inv.code}`;
    const open = !inv.used_by_name && !inv.revoked;
    return h('div', {}, [
      h('div.row.between', {}, [
        h('b', {}, inv.label || 'Bez mena'),
        inv.used_by_name ? h('span.badge.ok', {}, `Použil/a: ${inv.used_by_name}`) : inv.revoked ? h('span.badge', {}, 'Zrušená') : h('span.badge.warn', {}, 'Čaká'),
      ]),
      open ? h('div.row', { style: { marginTop: '6px' } }, [
        h('input', { type: 'text', readOnly: true, value: full, style: { flex: 1, minWidth: '200px' } }),
        h('button.btn.small', { onclick: () => { navigator.clipboard.writeText(full); toast('Skopírované'); } }, 'Kopírovať'),
        navigator.share ? h('button.btn.small', { onclick: () => navigator.share({ title: 'Style Picker', url: full }).catch(() => {}) }, 'Zdieľať') : null,
        h('button.btn.small.danger', { onclick: guarded(async () => { await api('DELETE', `/api/admin/invites/${inv.code}`); render(); }) }, 'Zrušiť'),
      ]) : null,
      h('div.small.muted', {}, fmtDateTime(inv.created_at)),
    ]);
  })) : h('p.muted', {}, 'Zatiaľ žiadne.')]));
}

// ---------------------------------------------------------------------------
// Úlohy a vyhodnocovanie videí
// ---------------------------------------------------------------------------
const SUB_STATUS = { pending: ['Čaká', 'warn'], approved: ['Splnené', 'ok'], exception: ['Výnimka', 'accent'], rejected: ['Nesplnené', 'danger'] };

async function renderTasks(view) {
  const { tasks, submissions } = await api('GET', '/api/admin/tasks');
  const pending = submissions.filter((s) => s.status === 'pending');
  setPendingBadge(pending.length);

  // Na vyhodnotenie
  view.append(h('div.card', {}, [
    h('h2', {}, `Na vyhodnotenie (${pending.length})`),
    pending.length ? h('div.stack', {}, pending.map((s) => {
      const bonus = h('input', { type: 'number', min: 0, value: 0, style: { width: '90px' } });
      const note = h('input', { type: 'text', placeholder: 'Komentár pre osobu', maxLength: 500, style: { flex: 1, minWidth: '160px' } });
      const decide = (decision) => guarded(async () => {
        const r = await api('POST', `/api/admin/submissions/${s.id}/review`, { decision, bonus: bonus.value, admin_note: note.value });
        toast(r.granted ? `Pripísané +${r.granted}` : 'Uložené');
        render();
      });
      return h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '12px' } }, [
        h('div.row.between', {}, [h('b', {}, `${s.user_name} · ${s.title}`), h('span.small.muted', {}, fmtDateTime(s.created_at))]),
        s.note ? h('p.small', {}, ['💬 ', s.note]) : null,
        h('video', { src: s.video, controls: true, preload: 'metadata', playsInline: true }),
        h('div.row', { style: { marginTop: '8px' } }, [h('span.small', {}, `Odmena ${s.reward} + extra:`), bonus, note]),
        h('div.row', { style: { marginTop: '8px' } }, [
          h('button.btn.ok', { onclick: decide('approved') }, '✓ Splnené'),
          h('button.btn', { onclick: decide('exception'), title: 'Nebolo to celkom podľa zadania, ale uznáš to' }, 'Výnimka – uznať'),
          h('button.btn.danger', { onclick: decide('rejected') }, '✗ Nesplnené'),
        ]),
      ]);
    })) : h('p.muted', {}, 'Nič nečaká.'),
  ]));

  // Nová úloha
  const title = h('input', { type: 'text', maxLength: 120, required: true, placeholder: 'napr. 30 drepov' });
  const desc = h('textarea', { maxLength: 2000, placeholder: 'Presné zadanie – čo musí byť na videu vidieť' });
  const reward = h('input', { type: 'number', min: 0, value: 1 });
  view.append(h('div.card', {}, [
    h('h2', {}, 'Nová úloha'),
    h('form', {
      onsubmit: guarded(async (ev) => {
        ev.preventDefault();
        await api('POST', '/api/admin/tasks', { title: title.value, description: desc.value, reward: reward.value });
        toast('Úloha pridaná'); render();
      }),
    }, [
      h('label.field', {}, [h('span', {}, 'Názov'), title]),
      h('label.field', {}, [h('span', {}, 'Popis'), desc]),
      h('label.field', {}, [h('span', {}, 'Odmena (tokeny)'), reward]),
      h('button.btn.primary', {}, 'Pridať úlohu'),
    ]),
  ]));

  // Zoznam úloh
  view.append(h('div.card', {}, [h('h2', {}, 'Úlohy'), tasks.length ? h('div.list', {}, tasks.map((t) => h('div', {}, [
    h('div.row.between', {}, [
      h('div', {}, [h('b', { style: { opacity: t.active ? 1 : 0.5 } }, t.title), ' ', h('span.badge.accent', {}, `+${t.reward}`), t.active ? null : h('span.badge', { style: { marginLeft: '4px' } }, 'skrytá')]),
      h('div.row', {}, [
        h('button.btn.small', { onclick: () => editTask(t) }, 'Upraviť'),
        h('button.btn.small', { onclick: guarded(async () => { await api('PATCH', `/api/admin/tasks/${t.id}`, { active: !t.active }); render(); }) }, t.active ? 'Skryť' : 'Zobraziť'),
      ]),
    ]),
    t.description ? h('div.small.muted', { style: { whiteSpace: 'pre-wrap' } }, t.description) : null,
  ]))) : h('p.muted', {}, 'Zatiaľ žiadne úlohy.')]));

  // História
  const done = submissions.filter((s) => s.status !== 'pending');
  if (done.length) {
    view.append(h('div.card', {}, [h('h2', {}, 'Vyhodnotené'), h('div.list', {}, done.map((s) => {
      const [label, cls] = SUB_STATUS[s.status];
      return h('div', {}, [
        h('div.row.between', {}, [h('span', {}, `${s.user_name} · ${s.title}`), h('span.badge.' + cls, {}, label + (s.granted ? ` +${s.granted}` : ''))]),
        h('div.small.muted', {}, [fmtDateTime(s.created_at), ' · ', h('a', { href: s.video, target: '_blank' }, 'video')]),
      ]);
    }))]));
  }
}

function editTask(t) {
  const dlg = $('#dlg');
  const title = h('input', { type: 'text', value: t.title, maxLength: 120 });
  const desc = h('textarea', { maxLength: 2000 }, t.description);
  const reward = h('input', { type: 'number', min: 0, value: t.reward });
  dlg.replaceChildren(h('div.card', {}, [
    h('h2', {}, 'Upraviť úlohu'),
    h('label.field', {}, [h('span', {}, 'Názov'), title]),
    h('label.field', {}, [h('span', {}, 'Popis'), desc]),
    h('label.field', {}, [h('span', {}, 'Odmena'), reward]),
    h('div.row', {}, [h('button.btn', { onclick: () => dlg.close() }, 'Zavrieť'), h('button.btn.primary', {
      onclick: guarded(async () => {
        await api('PATCH', `/api/admin/tasks/${t.id}`, { title: title.value, description: desc.value, reward: reward.value });
        dlg.close(); render();
      }),
    }, 'Uložiť')]),
  ]));
  dlg.showModal();
}

// ---------------------------------------------------------------------------
// Nastavenia
// ---------------------------------------------------------------------------
async function renderSettings(view) {
  const s = await api('GET', '/api/admin/settings');
  const diag = await api('GET', '/api/admin/diagnostics').catch(() => null);
  const deadline = h('input', { type: 'time', value: s.deadline, required: true });
  const weekly = h('input', { type: 'number', min: 0, value: s.weekly_tokens });
  const late = h('input', { type: 'number', min: 0, value: s.late_cost });
  view.append(h('div.card', {}, [
    h('h2', {}, 'Pravidlá'),
    h('form', {
      onsubmit: guarded(async (ev) => {
        ev.preventDefault();
        await api('PUT', '/api/admin/settings', { deadline: deadline.value, weekly_tokens: weekly.value, late_cost: late.value });
        toast('Uložené');
      }),
    }, [
      h('div.grid.cols-2', {}, [
        h('label.field', {}, [h('span', {}, 'Deadline na odovzdanie ponuky (na ďalší deň)'), deadline]),
        h('label.field', {}, [h('span', {}, 'Tokeny každý týždeň (pondelok)'), weekly]),
        h('label.field', {}, [h('span', {}, 'Cena za oneskorenú ponuku (tokeny)'), late]),
      ]),
      h('button.btn.primary', {}, 'Uložiť pravidlá'),
    ]),
  ]));

  const pw = h('input', { type: 'password', minLength: 6, autocomplete: 'new-password' });
  view.append(h('div.card', {}, [
    h('h2', {}, 'Admin heslo'),
    s.password_from_env ? h('p.muted', {}, 'Heslo je nastavené cez premennú prostredia ADMIN_PASSWORD.') : h('form', {
      onsubmit: guarded(async (ev) => { ev.preventDefault(); await api('PUT', '/api/admin/settings', { new_password: pw.value }); pw.value = ''; toast('Heslo zmenené'); }),
    }, [h('label.field', {}, [h('span', {}, 'Nové heslo'), pw]), h('button.btn', {}, 'Zmeniť heslo')]),
  ]));

  const catName = h('input', { type: 'text', maxLength: 40, placeholder: 'Nová kategória', required: true });
  view.append(h('div.card', {}, [
    h('h2', {}, 'Kategórie oblečenia'),
    h('form.row', {
      onsubmit: guarded(async (ev) => { ev.preventDefault(); await api('POST', '/api/admin/categories', { name: catName.value }); render(); }),
    }, [h('div', { style: { flex: 1, minWidth: '180px' } }, catName), h('button.btn.primary', {}, 'Pridať')]),
    h('div.chips', { style: { marginTop: '12px' } }, s.categories.map((c) => h('span.chip', {}, [
      c.name, c.used ? h('span.muted', {}, ` (${c.used})`) : null, ' ',
      h('a', {
        href: '#', title: 'Zmazať',
        onclick: guarded(async (e) => {
          e.preventDefault();
          if (c.used && !confirm(`Kategóriu „${c.name}“ používa ${c.used} kúskov – ostanú bez kategórie. Zmazať?`)) return;
          await api('DELETE', `/api/admin/categories/${c.id}`); render();
        }),
      }, '×'),
    ]))),
  ]));
  if (diag) {
    const ok = diag.storage === 'local' || diag.blob?.ok;
    const row = (k, v) => h('div.row.between', {}, [h('span.muted', {}, k), h('b', {}, v)]);
    view.append(h('div.card', {}, [
      h('h2', {}, 'Diagnostika'),
      h('div.notice' + (ok ? '.ok' : '.danger'), { style: { marginBottom: '12px' } }, ok
        ? 'Úložisko na fotky a videá funguje.'
        : diag.storage === 'none'
          ? 'Appka nevidí žiadne Blob úložisko. Pripoj Blob k projektu a daj Redeploy.'
          : `Blob hlási chybu: ${diag.blob?.error || 'neznáma'}`),
      h('div.list', {}, [
        row('Prostredie', diag.vercel ? 'Vercel' : 'vlastný server'),
        row('Databáza', diag.database || 'chýba'),
        row('Úložisko súborov', diag.storage === 'blob' ? `Vercel Blob (${diag.blob_mode === 'oidc' ? 'bez kľúča, OIDC' : 'kľúč'})` : diag.storage === 'local' ? 'lokálny disk' : 'chýba'),
        diag.blob?.access ? row('Typ Blobu', diag.blob.access === 'private' ? 'súkromný' : 'verejný') : null,
        h('div', {}, [h('div.muted.small', { style: { marginBottom: '6px' } }, 'Nastavené premenné (len názvy):'),
          h('div.chips', { style: { flexWrap: 'wrap' } }, diag.env.length ? diag.env.map((n) => h('span.chip', {}, n)) : [h('span.muted.small', {}, 'žiadne')])]),
      ]),
    ]));
  }
}

render();
