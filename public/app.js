'use strict';

// Rozhranie pre osobu, ktorá prišla cez pozvánku.
const state = { tab: 'outfit', data: null, offer: new Set(), offerCat: null, wardCat: null, wardQuery: '', offerDirty: false, seq: 0 };

async function load() {
  state.data = await api('GET', '/api/me');
  const n = state.data.user.tokens;
  const pill = $('#tokens');
  const text = `${n} ${tokenWord(n)}`;
  if (pill.textContent !== text) { if (pill.dataset.ready) bump(pill); pill.textContent = text; pill.dataset.ready = '1'; }
  if (!state.offerDirty) state.offer = new Set(state.data.tomorrow?.offer || []);
  render();
}

function render() {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  // Kreslí sa do odpojeného elementu, aby pomalšie async záložky neprepísali novšiu.
  const view = h('main', { id: 'view' });
  // Voliteľné sekcie (null/false) sa jednoducho vynechajú, nie vypíšu ako text.
  view.append = (...nodes) => Element.prototype.append.apply(view, nodes.filter((n) => n != null && n !== false));
  const renderer = { outfit: renderOutfit, wardrobe: renderWardrobe, history: renderHistory, tasks: renderTasks, tokens: renderTokens }[state.tab];
  const seq = ++state.seq;
  const done = startProgress();
  Promise.resolve(renderer(view)).then(() => {
    if (seq !== state.seq) return;
    swapView(view, state.tab);
    $('.fab')?.remove();
    if (state.tab === 'wardrobe') document.body.append(h('button.fab', { 'aria-label': 'Pridať oblečenie', onclick: addItemSheet }, icon('plus')));
  }).finally(done).catch((e) => toast(e.message, true));
}

function goTab(tab) { state.tab = tab; render(); scrollTo({ top: 0, behavior: 'smooth' }); }
$$('.tab').forEach((t) => t.addEventListener('click', () => goTab(t.dataset.tab)));
$('#tokens').addEventListener('click', () => goTab('tokens'));
$('#tokens').style.cursor = 'pointer';

// ---------------------------------------------------------------------------
// Outfit – domovská obrazovka
// ---------------------------------------------------------------------------
function outfitView(day, user, items, title) {
  const byId = new Map(items.map((i) => [i.id, i]));
  let side = 'front';
  const holder = h('div', { style: { width: '100%' } });
  const draw = () => {
    const layers = day.outfit[side];
    holder.replaceChildren(layers.length
      ? renderStage(side === 'front' ? user.front_photo : user.back_photo, layers, byId)
      : h('div.stage', { style: { aspectRatio: '3/4', display: 'grid', placeItems: 'center' } }, h('span.small.muted', {}, 'Bez náhľadu z tejto strany')));
  };
  const toggle = h('div.segmented', {}, ['front', 'back'].map((s) => h('button.chip' + (s === side ? '.active' : ''), {
    type: 'button',
    onclick: (ev) => { side = s; $$('.chip', toggle).forEach((c) => c.classList.remove('active')); ev.currentTarget.classList.add('active'); draw(); },
  }, s === 'front' ? 'Spredu' : 'Zozadu')));
  draw();
  const pieces = day.outfit.items.map((id) => byId.get(id)).filter(Boolean);
  return h('div.card.outfit-card', {}, [
    h('div.section-head', {}, [h('div', {}, [h('div.eyebrow', {}, title), h('h2', { style: { marginTop: '4px' } }, fmtDate(day.date))]),
      h('span.badge.accent', {}, [icon('sparkles'), `${pieces.length} ${pieces.length === 1 ? 'kúsok' : pieces.length < 5 ? 'kúsky' : 'kúskov'}`])]),
    day.outfit_note ? h('div.note-bubble', {}, h('div', {}, [h('span.who', {}, 'Poznámka od admina'), day.outfit_note])) : null,
    h('div.outfit-layout', {}, [
      h('div', { style: { display: 'grid', justifyItems: 'center' } }, [toggle, holder]),
      h('div', {}, [h('h3', {}, 'Čo si oblečieš'), h('div.item-grid', {}, pieces.map((i) => itemTile(i)))]),
    ]),
  ]);
}

// „Mám to na sebe“ – odfotenie sa v dnešnom outfite
function proofCard(day) {
  const st = day.proof_status;
  const info = { pending: ['Čaká na kontrolu admina', 'warn'], approved: ['Schválené ✓', 'ok'], rejected: ['Neschválené', 'danger'] }[st];
  const upload = () => {
    const picker = photoPicker({ hint: 'Odfoť sa celá/ý v dnešnom outfite (napr. v zrkadle)', captureMode: 'user' });
    const status = h('div');
    openSheet('Fotka v outfite', [
      picker.el, status,
      h('button.btn.primary.block', {
        style: { marginTop: '14px' },
        onclick: guarded(async () => {
          if (!picker.file()) throw new Error('Najprv sa odfoť.');
          const prog = uploadProgress('Nahrávam fotku');
          status.replaceChildren(prog.el);
          try {
            const photo = await uploadFile(await resizeImage(picker.file()), 'image', { onProgress: prog.set });
            await api('POST', '/api/me/proof', { photo, date: day.date });
          } finally { status.replaceChildren(); }
          closeSheet(); toast('Odoslané adminovi ✓'); await load();
        }),
      }, 'Poslať adminovi'),
    ]);
  };
  return h('div.card', {}, [
    h('div.section-head', {}, [h('div', {}, [h('h2', {}, 'Mám to na sebe'), h('div.small.muted', {}, 'Odfoť sa v outfite, nech admin vidí, že sedí.')]),
      info ? h('span.badge.' + info[1], {}, info[0]) : null]),
    day.proof_photo ? h('div.proof', {}, [
      h('img', { src: day.proof_photo, alt: 'Fotka v outfite' }),
      h('div', {}, [
        day.proof_note ? h('div.note-bubble', { style: { marginBottom: '10px' } }, h('div', {}, [h('span.who', {}, 'Admin'), day.proof_note])) : null,
        st !== 'approved' ? h('button.btn', { onclick: upload }, [icon('camera'), 'Odfotiť znova']) : null,
      ]),
    ]) : h('button.btn.primary', { onclick: upload }, [icon('camera'), 'Odfotiť sa v outfite']),
  ]);
}

function dayComments(date) {
  const list = (state.data.comments || []).filter((c) => c.date === date);
  return commentsCard(list, {
    who: 'user',
    title: `Správy k outfitu · ${fmtDate(date)}`,
    hint: 'Chceš niečo zmeniť alebo sa niečo spýtať? Napíš adminovi.',
    send: (text) => api('POST', `/api/me/comments/${date}`, { text }),
    reload: load,
  });
}

// Jednorazová ponuka zapnúť upozornenia (kým ich osoba nezapne alebo neodmietne)
async function pushBanner() {
  let dismissed = false;
  try { dismissed = !!localStorage.getItem('push-asked'); } catch { /* bez úložiska */ }
  if (dismissed) return null;
  const st = await pushState().catch(() => ({ supported: false }));
  if (!st.supported || st.permission !== 'default') return null;
  const card = h('div.card', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' } }, [
    h('div.empty-icon', { style: { margin: 0, width: '44px', height: '44px' } }, icon('sparkles')),
    h('div', { style: { flex: 1, minWidth: '180px' } }, [h('b', {}, 'Zapni si upozornenia'), h('div.small.muted', {}, 'Dáme ti vedieť, keď bude outfit vybraný, a pripomenieme ponuku pred uzávierkou.')]),
    h('div.row', { style: { gap: '6px' } }, [
      h('button.btn.primary.small', { onclick: guarded(async () => { await enablePush('user'); toast('Upozornenia zapnuté ✓'); card.remove(); }) }, 'Zapnúť'),
      h('button.btn.small.ghost', { onclick: () => { try { localStorage.setItem('push-asked', '1'); } catch { /* */ } card.remove(); } }, 'Teraz nie'),
    ]),
  ]);
  return card;
}

function stepper(stage) {
  const labels = ['Ponuka', 'Admin vyberá', 'Outfit hotový'];
  return h('div.stepper', {}, labels.map((l, i) => h('div.st' + (i < stage ? '.done' : i === stage ? '.now' : ''), {}, l)));
}

function deadlineBox(cycle, kind) {
  const deadline = new Date(cycle.deadline).getTime();
  const dayStart = new Date(deadline); dayStart.setHours(0, 0, 0, 0);
  const ring = h('div.ring', {}, icon(kind === 'done' ? 'check' : kind === 'late' ? 'alert' : 'clock'));
  const big = h('div.big');
  const sub = h('div.sub');
  const box = h('div.deadline' + (kind ? `.${kind}` : ''), {}, [ring, h('div', {}, [big, sub])]);
  if (kind === 'done') { big.textContent = 'Ponuka odoslaná'; sub.textContent = `Do ${cycle.deadlineLabel} ju ešte môžeš upraviť.`; return box; }
  if (kind === 'late') { big.textContent = 'Uzávierka prešla'; sub.textContent = `Ponuka sa odovzdáva do ${cycle.deadlineLabel}.`; return box; }
  const tick = () => {
    const left = deadline - Date.now();
    big.textContent = fmtCountdown(left);
    sub.textContent = `zostáva do uzávierky o ${cycle.deadlineLabel}`;
    ring.style.setProperty('--p', Math.max(0, Math.min(100, ((Date.now() - dayStart) / (deadline - dayStart)) * 100)));
    if (left <= 0) { clearInterval(state.timer); load(); }
  };
  clearInterval(state.timer);
  tick();
  state.timer = setInterval(tick, 1000);
  return box;
}

async function renderOutfit(view) {
  const { user, cycle, today, tomorrow, items, late_cost: lateCost } = state.data;
  const active = items.filter((i) => !i.archived);
  clearInterval(state.timer);

  const hour = new Date().getHours();
  const greet = hour < 10 ? 'Dobré ráno' : hour < 18 ? 'Ahoj' : 'Dobrý večer';
  view.append(h('div.hello', {}, [h('div', {}, [h('div.eyebrow', {}, fmtDate(cycle.today)), h('h1', {}, `${greet}, ${user.name}`)])]));
  view.append(await pushBanner());

  // Dnešný outfit má prednosť – to je to, čo osoba práve potrebuje vidieť.
  if (today?.outfit) {
    view.append(outfitView(today, user, items, 'Dnes máš na sebe'), proofCard(today), dayComments(today.date));
  }

  if (tomorrow?.outfit) {
    view.append(outfitView(tomorrow, user, items, 'Zajtra si oblečieš'), dayComments(tomorrow.date));
    return;
  }

  const card = h('div.card');
  view.append(card);
  const hasOffer = tomorrow && tomorrow.status !== 'self';
  const isSelf = tomorrow?.status === 'self';
  const lateNoOffer = cycle.passed && !hasOffer;

  card.append(
    h('div.section-head', {}, [h('div', {}, [h('div.eyebrow', {}, 'Zajtra'), h('h2', { style: { marginTop: '4px' } }, fmtDate(cycle.target))]), statusBadge(tomorrow, cycle, true)]),
    stepper(hasOffer ? 1 : 0),
  );

  if (isSelf) {
    card.append(h('div.notice', {}, [h('b', {}, 'Zajtra si outfit vyberáš sama/sám. '), 'Ak chceš, aby vyberal admin, môžeš ešte zaplatiť tokenmi.']));
  } else if (hasOffer && cycle.passed) {
    card.append(deadlineBox(cycle, 'done'), h('p.muted', { style: { margin: 0 } }, 'Admin teraz vyberá. Keď bude outfit hotový, uvidíš ho tu.'));
    $('.sub', card).textContent = 'Uzávierka prešla – admin vyberá outfit.';
    return;
  } else {
    card.append(deadlineBox(cycle, hasOffer ? 'done' : lateNoOffer ? 'late' : null));
  }

  if (active.length === 0) {
    card.append(h('div.empty', {}, [
      h('div.empty-icon', {}, icon('hanger')),
      h('h2', {}, 'Tvoj šatník je prázdny'),
      h('p', {}, 'Najprv nahraj oblečenie, ktoré máš. Potom z neho budeš posielať ponuku.'),
      h('button.btn.primary', { onclick: () => { goTab('wardrobe'); setTimeout(addItemSheet, 300); } }, [icon('plus'), 'Pridať prvý kúsok']),
    ]));
    if (lateNoOffer && !isSelf) card.append(lateChoices(user, lateCost, false));
    return;
  }

  if (lateNoOffer) card.append(lateChoices(user, lateCost, true, isSelf));

  // Výber kúskov do ponuky – kúsky v prádle / požičané sa ponúknuť nedajú
  const unavailable = active.filter((i) => i.status && i.status !== 'ok');
  const offerable = active.filter((i) => !i.status || i.status === 'ok');
  for (const i of unavailable) state.offer.delete(i.id);
  const shown = filterByCategory(offerable, state.offerCat);
  const counts = countByCategory(offerable);
  card.append(
    h('div.section-head', { style: { marginTop: '20px' } }, [
      h('div', {}, [h('h3', { style: { margin: 0 } }, 'Z čoho sa má vyberať?'), h('div.small.muted', {}, 'Označ čisté kúsky, ktoré máš zajtra k dispozícii.')]),
      h('div.row', { style: { gap: '6px' } }, [
        h('button.btn.small', { onclick: () => { offerable.forEach((i) => state.offer.add(i.id)); state.offerDirty = true; render(); } }, 'Všetko'),
        h('button.btn.small.ghost', { onclick: () => { state.offer.clear(); state.offerDirty = true; render(); } }, 'Nič'),
      ]),
    ]),
    categoryChipsCounted(counts, state.offerCat, (c) => { state.offerCat = c; render(); }),
    h('div.item-grid', {}, shown.map((i) => itemTile(i, {
      selected: state.offer.has(i.id),
      onclick: (e) => {
        state.offer.has(i.id) ? state.offer.delete(i.id) : state.offer.add(i.id);
        state.offerDirty = true;
        // Bez prekreslenia celej stránky – len prepni dlaždicu a lištu.
        e.currentTarget.classList.toggle('selected', state.offer.has(i.id));
        updateBar();
      },
    }))),
    unavailable.length ? h('p.small.muted', { style: { marginTop: '10px' } },
      `${unavailable.length} ${unavailable.length === 1 ? 'kúsok je' : 'kúsky sú'} v prádle alebo požičané – v šatníku ich vieš vrátiť medzi dostupné.`) : null,
  );

  // Plávajúca lišta s počtom a odoslaním
  const countEl = h('div.count');
  const submitBtn = h('button.btn.primary');
  const bar = h('div.actionbar', {}, [countEl, submitBtn]);
  function updateBar() {
    const n = state.offer.size;
    countEl.replaceChildren(h('b', {}, n), ` ${n === 1 ? 'kúsok označený' : n >= 2 && n <= 4 ? 'kúsky označené' : 'kúskov označených'}`);
    submitBtn.disabled = n === 0 || (lateNoOffer && user.tokens < lateCost);
    submitBtn.textContent = lateNoOffer ? `Zaplatiť ${lateCost} ${tokenWord(lateCost)} a odoslať` : hasOffer ? 'Uložiť zmeny' : 'Odoslať ponuku';
  }
  submitBtn.addEventListener('click', guarded(async () => {
    await api('POST', '/api/me/submit', { item_ids: [...state.offer], use_tokens: lateNoOffer });
    state.offerDirty = false;
    toast(lateNoOffer ? 'Zaplatené, ponuka odoslaná ✓' : hasOffer ? 'Ponuka upravená ✓' : 'Ponuka odoslaná ✓');
    await load();
  }));
  updateBar();
  card.append(bar);
}

function lateChoices(user, lateCost, canPay, isSelf = false) {
  const enough = user.tokens >= lateCost;
  return h('div.choices', {}, [
    canPay ? h('div.choice.primary', { style: { cursor: 'default' } }, [
      h('b', {}, `Zaplatiť ${lateCost} ${tokenWord(lateCost)}`),
      h('span', {}, enough ? `Označ kúsky nižšie a odošli. Máš ${user.tokens} ${tokenWord(user.tokens)}.` : 'Nemáš dosť tokenov – zarob si ich splnením úlohy.'),
    ]) : null,
    isSelf ? null : h('button.choice', {
      onclick: guarded(async () => {
        if (!confirm('Naozaj si zajtra vyberieš outfit sama/sám?')) return;
        await api('POST', '/api/me/self');
        await load();
      }),
    }, [h('b', {}, 'Vyberiem si sama/sám'), h('span', {}, 'Zajtra sa oblečieš podľa seba, bez tokenov.')]),
    !enough ? h('button.choice', { onclick: () => goTab('tasks') }, [h('b', {}, 'Zarobiť tokeny →'), h('span', {}, 'Splň úlohu, nahraj video a admin ti ich pripíše.')]) : null,
  ].filter(Boolean));
}

function countByCategory(items) {
  const m = new Map();
  for (const i of items) { const c = i.category || 'Bez kategórie'; m.set(c, (m.get(c) || 0) + 1); }
  return m;
}
function categoryChipsCounted(counts, current, onPick) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const wrap = h('div.chips');
  const add = (label, value, n) => wrap.append(h('button.chip' + (current === value ? '.active' : ''), { type: 'button', onclick: () => onPick(value) }, [label, h('span.n', {}, n)]));
  add('Všetko', null, total);
  for (const [c, n] of counts) add(c, c, n);
  return wrap;
}

// ---------------------------------------------------------------------------
// Šatník
// ---------------------------------------------------------------------------
let categories = [];
async function ensureCategories() { if (!categories.length) categories = await api('GET', '/api/categories'); }

function categoryPicker(value) {
  let selected = value || null;
  const wrap = h('div.cat-pick');
  const draw = () => wrap.replaceChildren(...categories.map((c) => h('button.chip' + (c.id === selected ? '.active' : ''), {
    type: 'button', onclick: () => { selected = c.id; draw(); },
  }, c.name)));
  draw();
  return { el: wrap, value: () => selected, reset: () => { selected = null; draw(); } };
}

const fieldLabel = (text) => h('span', { style: { display: 'block', fontWeight: 600, fontSize: '.82rem', marginBottom: '8px' } }, text);
const kusky = (n) => `${n} ${n === 1 ? 'kúsok' : n >= 2 && n <= 4 ? 'kúsky' : 'kúskov'}`;

async function renderWardrobe(view) {
  await ensureCategories();
  const { items } = state.data;
  const active = items.filter((i) => !i.archived);
  const archived = items.filter((i) => i.archived);

  view.append(h('div.section-head', {}, [
    h('div', {}, [h('h1', { style: { margin: 0 } }, 'Môj šatník'), h('div.small.muted', {}, kusky(active.length))]),
    h('button.btn.primary.desktop-only', { onclick: addItemSheet }, [icon('plus'), 'Pridať oblečenie']),
  ]));

  if (!active.length) {
    view.append(h('div.card.empty', {}, [
      h('div.empty-icon', {}, icon('camera')),
      h('h2', {}, 'Začni prvým kúskom'),
      h('p', {}, 'Rozlož oblečenie na jednoduché svetlé pozadie, odfoť ho a pomenuj. Čím viac kúskov, tým lepšie outfity.'),
      h('button.btn.primary', { onclick: addItemSheet }, [icon('plus'), 'Pridať oblečenie']),
    ]));
  } else {
    const grid = h('div.item-grid');
    const drawGrid = () => {
      const q = state.wardQuery.trim().toLowerCase();
      const list = filterByCategory(active, state.wardCat).filter((i) => !q || i.name.toLowerCase().includes(q));
      grid.replaceChildren(...(list.length ? list.map((i) => itemTile(i, { onclick: () => editItem(i) }))
        : [h('p.muted', { style: { gridColumn: '1 / -1' } }, 'Nič sa nenašlo.')]));
    };
    const search = h('input', { type: 'search', placeholder: 'Hľadať v šatníku…', value: state.wardQuery,
      oninput: (e) => { state.wardQuery = e.target.value; drawGrid(); } });
    drawGrid();
    view.append(h('div.card', {}, [
      h('div.toolbar', {}, h('label.search', {}, [icon('search'), search])),
      categoryChipsCounted(countByCategory(active), state.wardCat, (c) => { state.wardCat = c; render(); }),
      grid,
    ]));
  }

  if (archived.length) {
    view.append(h('details.more', {}, [
      h('summary', {}, `Odložené kúsky (${archived.length})`),
      h('p.small.muted', {}, 'Tieto sa nezobrazujú v ponuke. Ťuknutím ich vrátiš späť.'),
      h('div.item-grid', {}, archived.map((i) => itemTile(i, { dim: true, onclick: () => editItem(i) }))),
    ]));
  }
}

async function addItemSheet() {
  await ensureCategories();
  let bg;
  const picker = photoPicker({ hint: 'Odfoť kúsok rozložený na svetlom pozadí', onChange: () => bg?.reset() });
  bg = bgRemoveControls(() => picker.file(), (f) => picker.set(f));
  const nameIn = h('input', { type: 'text', maxLength: 80, placeholder: 'napr. Biele tričko Nike' });
  const cats = categoryPicker();
  const status = h('div');
  const save = (again) => guarded(async () => {
    const file = picker.file();
    if (!file) throw new Error('Najprv odfoť alebo vyber fotku.');
    if (!nameIn.value.trim()) throw new Error('Pomenuj oblečenie.');
    if (!cats.value()) throw new Error('Vyber kategóriu.');
    const prog = uploadProgress('Nahrávam fotku');
    status.replaceChildren(prog.el);
    try {
      const photo = await uploadFile(await resizeImage(file), 'image', { onProgress: prog.set });
      await api('POST', '/api/me/items', { photo, name: nameIn.value, category_id: cats.value() });
    } finally { status.replaceChildren(); }
    toast(`„${nameIn.value.trim()}“ je v šatníku ✓`);
    state.data = await api('GET', '/api/me');
    if (again) { picker.reset(); bg.reset(); nameIn.value = ''; cats.reset(); } else closeSheet();
    render();
  });
  openSheet('Pridať oblečenie', [
    picker.el,
    h('div', { style: { marginTop: '10px' } }, bg.el),
    h('label.field', { style: { marginTop: '16px' } }, [h('span', {}, 'Názov'), nameIn]),
    h('div.field', {}, [fieldLabel('Kategória'), cats.el]),
    status,
    h('div.row', { style: { marginTop: '16px' } }, [
      h('button.btn.primary', { style: { flex: 1 }, onclick: save(false) }, 'Uložiť'),
      h('button.btn', { style: { flex: 1 }, onclick: save(true) }, 'Uložiť a ďalší'),
    ]),
  ]);
}

async function editItem(item) {
  await ensureCategories();
  const nameIn = h('input', { type: 'text', value: item.name, maxLength: 80 });
  const cats = categoryPicker(item.category_id);
  let status = item.status || 'ok';
  const statusSeg = h('div.segmented.full');
  const drawStatus = () => statusSeg.replaceChildren(...Object.entries(ITEM_STATUS).map(([k, l]) => h('button.chip' + (k === status ? '.active' : ''), {
    type: 'button', onclick: () => { status = k; drawStatus(); },
  }, l)));
  drawStatus();
  let newPhoto = null;
  const imgBox = h('div', { style: { borderRadius: '14px', background: 'var(--tile-bg)', padding: '12px', marginBottom: '12px' } },
    h('img', { src: item.photo, alt: '', style: { display: 'block', width: '100%', maxHeight: '34vh', objectFit: 'contain' } }));
  // Pôvodnú fotku stiahneme a spracujeme; nová sa nahrá až pri uložení
  const bg = bgRemoveControls(async () => {
    const r = await fetch(item.photo);
    if (!r.ok) throw new Error('Fotku sa nepodarilo načítať.');
    return new File([await r.blob()], 'kusok', { type: r.headers.get('content-type') || 'image/jpeg' });
  }, (f) => {
    newPhoto = f;
    imgBox.classList.add('checker');
    imgBox.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '', style: { display: 'block', width: '100%', maxHeight: '34vh', objectFit: 'contain' } }));
  });
  const status$ = h('div');
  const save = (patch, msg) => guarded(async () => {
    const body = patch();
    if (newPhoto && !body.archived) {
      const prog = uploadProgress('Nahrávam fotku');
      status$.replaceChildren(prog.el);
      try { body.photo = await uploadFile(newPhoto, 'image', { onProgress: prog.set }); } finally { status$.replaceChildren(); }
    }
    await api('PATCH', `/api/me/items/${item.id}`, body);
    closeSheet(); toast(msg); await load();
  });
  openSheet(item.archived ? 'Odložený kúsok' : 'Upraviť kúsok', [
    imgBox,
    item.archived ? null : h('div', { style: { marginBottom: '16px' } }, bg.el),
    h('label.field', {}, [h('span', {}, 'Názov'), nameIn]),
    h('div.field', {}, [fieldLabel('Kategória'), cats.el]),
    item.archived ? null : h('div.field', {}, [fieldLabel('Je k dispozícii?'), statusSeg]),
    status$,
    h('div.row', { style: { marginTop: '8px' } }, [
      h('button.btn.primary', { style: { flex: 1 }, onclick: save(() => ({ name: nameIn.value, category_id: cats.value(), status }), 'Uložené ✓') }, 'Uložiť'),
      h('button.btn' + (item.archived ? '' : '.danger'), { style: { flex: 1 }, onclick: save(() => ({ archived: !item.archived }), item.archived ? 'Vrátené do šatníka' : 'Odložené') },
        item.archived ? 'Vrátiť do šatníka' : 'Už to nemám'),
    ]),
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------
// História outfitov (aj naplánované dopredu)
// ---------------------------------------------------------------------------
async function renderHistory(view) {
  const days = await api('GET', '/api/me/history');
  const { user, items, cycle } = state.data;
  const byId = new Map(items.map((i) => [i.id, i]));
  view.append(h('div.section-head', {}, [h('div', {}, [h('h1', { style: { margin: 0 } }, 'História outfitov'),
    h('div.small.muted', {}, days.length ? `${days.length} ${days.length === 1 ? 'outfit' : days.length < 5 ? 'outfity' : 'outfitov'}` : '')])]));
  if (!days.length) {
    view.append(h('div.card.empty', {}, [h('div.empty-icon', {}, icon('calendar')), h('h2', {}, 'Zatiaľ žiadne outfity'), h('p', {}, 'Keď ti admin vyberie prvý outfit, uvidíš ho tu.')]));
    return;
  }
  const PROOF = { approved: ['✓ sedí', 'ok'], rejected: ['✗ nesedí', 'danger'], pending: ['čaká', 'warn'] };
  view.append(h('div.hist', {}, days.map((d) => {
    const future = d.date > cycle.today;
    const layers = d.outfit.front.length ? d.outfit.front : d.outfit.back;
    const photo = d.outfit.front.length ? user.front_photo : user.back_photo;
    return h('div.hist-card' + (future ? '.future' : ''), { onclick: () => historySheet(d) }, [
      layers.length ? renderStage(photo, layers, byId)
        : h('div.stage', { style: { aspectRatio: '3/4', display: 'grid', placeItems: 'center' } }, h('span.small.muted', {}, `${d.outfit.items.length} kúskov`)),
      h('div.hc-meta', {}, [
        h('b', {}, new Date(`${d.date}T12:00:00`).toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric', weekday: 'short' })),
        future ? h('span.badge.accent', {}, 'naplánované') : d.proof_status ? h('span.badge.' + PROOF[d.proof_status][1], {}, PROOF[d.proof_status][0]) : null,
      ]),
    ]);
  })));
}

function historySheet(d) {
  const { user, items } = state.data;
  const byId = new Map(items.map((i) => [i.id, i]));
  const pieces = d.outfit.items.map((id) => byId.get(id)).filter(Boolean);
  openSheet(fmtDate(d.date), [
    d.outfit_note ? h('div.note-bubble', {}, h('div', {}, [h('span.who', {}, 'Poznámka od admina'), d.outfit_note])) : null,
    h('div.outfit-layout', {}, [
      d.outfit.front.length ? renderStage(user.front_photo, d.outfit.front, byId) : null,
      d.proof_photo ? h('div', {}, [h('h3', {}, 'Moja fotka'), h('img', { src: d.proof_photo, alt: '', style: { width: '100%', borderRadius: '14px' } })]) : null,
    ].filter(Boolean)),
    h('h3', { style: { marginTop: '16px' } }, 'Kúsky'),
    h('div.item-grid', {}, pieces.map((i) => itemTile(i))),
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------
// Úlohy
// ---------------------------------------------------------------------------
const SUB_STATUS = { pending: 'Čaká na vyhodnotenie', approved: 'Splnené', exception: 'Uznané ako výnimka', rejected: 'Nesplnené' };

async function renderTasks(view) {
  const { tasks, submissions } = await api('GET', '/api/me/tasks');
  const { user } = state.data;
  view.append(h('div.section-head', {}, [
    h('div', {}, [h('h1', { style: { margin: 0 } }, 'Úlohy'), h('div.small.muted', {}, 'Zarob si tokeny – natoč, ako úlohu robíš, a pošli video.')]),
    h('span.token-pill', {}, `Máš ${user.tokens} ${tokenWord(user.tokens)}`),
  ]));
  if (!tasks.length) {
    view.append(h('div.card.empty', {}, [h('div.empty-icon', {}, icon('video')), h('h2', {}, 'Zatiaľ žiadne úlohy'), h('p', {}, 'Keď admin pridá úlohu, objaví sa tu.')]));
  } else {
    view.append(h('div.grid.cols-2', {}, tasks.map((t) => {
      const REP = { once: 'len raz', weekly: 'raz týždenne' };
      return h('div.card.task', {}, [
        h('div.row.between', {}, [h('h3', { style: { margin: 0 } }, t.title), h('span.reward', {}, `+${t.reward} ${tokenWord(t.reward)}`)]),
        t.description ? h('p', {}, t.description) : null,
        REP[t.repeat] ? h('div', {}, h('span.badge', {}, REP[t.repeat])) : null,
        h('div', { style: { marginTop: '4px' } }, !t.available
          ? h('span.badge.warn', {}, t.reason)
          : h('button.btn.primary', { onclick: () => taskSheet(t) }, [icon('video'), 'Splniť úlohu'])),
      ].filter(Boolean));
    })));
  }
  if (submissions.length) {
    view.append(h('div.card', {}, [h('h2', {}, 'Moje videá'), h('div.list', {}, submissions.map((s) => h('div.sub-item', {}, [
      h('span.dot.' + s.status),
      h('div', { style: { flex: 1, minWidth: 0 } }, [
        h('div', {}, [h('b', {}, s.title), s.granted ? h('span.small', { style: { color: 'var(--ok)', fontWeight: 700 } }, `  +${s.granted}`) : null]),
        h('div.small.muted', {}, `${SUB_STATUS[s.status]} · ${fmtDateTime(s.created_at)}`),
        s.admin_note ? h('div.small', { style: { marginTop: '4px' } }, ['💬 ', s.admin_note]) : null,
      ]),
    ])))]));
  }
}

function taskSheet(t) {
  let file = null;
  const preview = h('div');
  const mk = (capture) => h('input', { type: 'file', accept: 'video/*', ...(capture ? { capture: 'user' } : {}), style: { display: 'none' },
    onchange: (e) => {
      file = e.target.files[0] || null;
      preview.replaceChildren(...(file ? [h('video', { src: URL.createObjectURL(file), controls: true, playsInline: true, style: { marginTop: '12px' } })] : []));
    } });
  const rec = mk(true);
  const gal = mk(false);
  const note = h('input', { type: 'text', maxLength: 500, placeholder: 'Poznámka (nepovinné)' });
  const status = h('div');
  openSheet(t.title, [
    h('div', { style: { marginBottom: '12px' } }, h('span.reward', {}, `Odmena +${t.reward} ${tokenWord(t.reward)}`)),
    t.description ? h('p', { style: { whiteSpace: 'pre-wrap' } }, t.description) : null,
    h('div.tip', { style: { marginBottom: '14px' } }, [icon('video'), h('div', {}, 'Na videu musí byť jasne vidieť, že úlohu robíš ty. Admin ho vyhodnotí a pripíše tokeny.')]),
    h('div.row', {}, [
      h('button.btn', { style: { flex: 1 }, onclick: () => rec.click() }, [icon('camera'), 'Natočiť']),
      h('button.btn', { style: { flex: 1 }, onclick: () => gal.click() }, [icon('image'), 'Z galérie']),
    ]),
    rec, gal, preview,
    h('label.field', { style: { marginTop: '14px' } }, [h('span', {}, 'Poznámka'), note]),
    status,
    h('button.btn.primary.block', {
      style: { marginTop: '12px' },
      onclick: guarded(async () => {
        if (!file) throw new Error('Najprv natoč alebo vyber video.');
        const prog = uploadProgress('Nahrávam video');
        status.replaceChildren(prog.el);
        try {
          const video = await uploadFile(file, 'video', { onProgress: prog.set });
          await api('POST', `/api/me/tasks/${t.id}/submit`, { video, note: note.value });
        } finally { status.replaceChildren(); }
        closeSheet();
        toast('Video odoslané na vyhodnotenie ✓');
        render();
      }),
    }, 'Odoslať video'),
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------
// Tokeny
// ---------------------------------------------------------------------------
async function renderTokens(view) {
  const tx = await api('GET', '/api/me/transactions');
  const { user, cycle, late_cost: lateCost, weekly_tokens: weekly } = state.data;
  const link = location.origin + user.personal_link;
  const daysToMonday = ((8 - new Date().getDay()) % 7) || 7;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

  view.append(
    h('div.balance', {}, [
      h('div.eyebrow', {}, 'Tvoj zostatok'),
      h('div.amount', {}, [String(user.tokens), h('small', {}, tokenWord(user.tokens))]),
      h('div.meta', {}, weekly > 0 ? `Ďalších +${weekly} ${daysToMonday === 1 ? 'zajtra' : `o ${daysToMonday} dní`} (v pondelok)` : 'Týždenné tokeny sú vypnuté'),
    ]),
    h('div.grid.cols-2', { style: { marginTop: '16px' } }, [
      h('div.card', {}, [h('h2', {}, 'Ako to funguje'), h('div.rules', {}, [
        [icon('calendar'), `+${weekly} každý týždeň`, 'Každý pondelok dostaneš nové tokeny.'],
        [icon('clock'), `Uzávierka o ${cycle.deadlineLabel}`, `Ponuku na ďalší deň pošli včas. Neskoro to stojí ${lateCost} ${tokenWord(lateCost)} – alebo si vyberieš sama/sám.`],
        [icon('video'), 'Úlohy', 'Keď tokeny dôjdu, zarobíš si ich úlohou s video dôkazom.'],
      ].map(([ic, t, d]) => h('div.rule', {}, [h('div.ri', {}, ic), h('div', {}, [h('b', {}, t), h('span', {}, d)])])))]),
      h('div.card', {}, [h('h2', {}, 'História'), tx.length ? h('div.list', {}, tx.slice(0, 30).map((t) => h('div.tx', {}, [
        h('div.ti.' + (t.amount > 0 ? 'plus' : 'minus'), {}, t.amount > 0 ? '+' : '−'),
        h('div.tx-main', {}, [h('div', {}, t.reason), h('div.small.muted', {}, fmtDateTime(t.created_at))]),
        h('b', { style: { color: t.amount > 0 ? 'var(--ok)' : 'var(--danger)' } }, (t.amount > 0 ? '+' : '') + t.amount),
      ]))) : h('p.muted', {}, 'Zatiaľ nič.')]),
    ]),
    pushCard('user', 'Príde ti upozornenie, keď admin vyberie outfit, odpovie na správu alebo vyhodnotí úlohu. A pripomenieme ti ponuku pred uzávierkou.'),
    h('div.card', { style: { marginTop: '16px' } }, [
      h('h2', {}, 'Prístup z iného zariadenia'),
      h('p.small.muted', {}, 'Toto je tvoj osobný odkaz. Otvor ho na inom mobile alebo počítači a si prihlásená/ý. Nikomu ho neposielaj.'),
      h('div.kbd-link', {}, [h('input', { type: 'text', readOnly: true, value: link }),
        h('button.btn', { onclick: () => { navigator.clipboard.writeText(link); toast('Skopírované'); } }, 'Kopírovať')]),
      h('div.tip', { style: { marginTop: '14px' } }, [icon('phone'), h('div', {}, [h('b', {}, 'Pridaj si appku na plochu. '),
        isIOS ? 'V Safari ťukni na Zdieľať → Pridať na plochu.' : 'V prehliadači otvor menu ⋮ → Pridať na plochu.'])]),
    ]),
  );
}

load().catch((e) => {
  if (e.status === 401) location.href = '/';
  else { hideSplash(); toast(e.message, true); }
});
// Obnov údaje, keď sa človek vráti do appky (napr. admin medzitým vybral outfit).
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#dlg').open) load().catch(() => {}); });
