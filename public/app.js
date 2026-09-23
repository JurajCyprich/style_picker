'use strict';

// Rozhranie pre osobu, ktorá prišla cez pozvánku.
const state = { tab: 'outfit', data: null, offer: new Set(), offerCat: null, wardCat: null, offerDirty: false };

async function load() {
  state.data = await api('GET', '/api/me');
  const n = state.data.user.tokens;
  const pill = $('#tokens');
  const text = `${n} ${tokenWord(n)}`;
  if (pill.textContent !== text) { if (pill.dataset.ready) bump(pill); pill.textContent = text; pill.dataset.ready = '1'; }
  const day = state.data.tomorrow;
  if (!state.offerDirty) state.offer = new Set(day?.offer || []);
  render();
}

function render() {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  // Kreslí sa do odpojeného elementu, aby pomalšie async záložky neprepísali novšiu.
  const view = h('main', { id: 'view' });
  const renderer = { outfit: renderOutfit, wardrobe: renderWardrobe, tasks: renderTasks, tokens: renderTokens }[state.tab];
  const seq = (state.seq = (state.seq || 0) + 1);
  const done = startProgress();
  Promise.resolve(renderer(view)).then(() => { if (seq === state.seq) swapView(view, state.tab); }).finally(done)
    .catch((e) => toast(e.message, true));
}

$$('.tab').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; render(); }));

// ---------------------------------------------------------------------------
// Outfit – dnes a zajtra
// ---------------------------------------------------------------------------
function outfitView(day, user, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  let side = 'front';
  const holder = h('div');
  const draw = () => {
    const layers = day.outfit[side];
    holder.replaceChildren(
      layers.length ? renderStage(side === 'front' ? user.front_photo : user.back_photo, layers, byId)
        : h('p.muted.small', {}, side === 'front' ? 'Bez náhľadu spredu.' : 'Bez náhľadu zozadu.'));
  };
  const toggle = h('div.chips', {}, ['front', 'back'].map((s) => h('button.chip' + (s === side ? '.active' : ''), {
    type: 'button',
    onclick: (ev) => { side = s; $$('.chip', toggle).forEach((c) => c.classList.remove('active')); ev.currentTarget.classList.add('active'); draw(); },
  }, s === 'front' ? 'Spredu' : 'Zozadu')));
  draw();
  return h('div.stack', {}, [
    day.outfit_note ? h('div.notice', {}, ['💬 ', day.outfit_note]) : null,
    h('div.grid.cols-2', {}, [
      h('div', {}, [toggle, holder]),
      h('div', {}, [h('h3', {}, 'Čo si oblečieš'), h('div.item-grid', {}, day.outfit.items.map((id) => byId.get(id)).filter(Boolean).map((i) => itemTile(i)))]),
    ]),
  ]);
}

function renderOutfit(view) {
  const { user, cycle, today, tomorrow, items, late_cost: lateCost } = state.data;
  const active = items.filter((i) => !i.archived);

  // Dnes
  view.append(h('div.card', {}, [
    h('div.row.between', {}, [h('h2', {}, `Dnes · ${fmtDate(cycle.today)}`), today ? statusBadge(today, cycle, false) : null]),
    today?.outfit ? outfitView(today, user, items)
      : h('p.muted', {}, today?.status === 'self' ? 'Dnes si outfit vyberáš sama/sám.' : 'Na dnes nemáš vybraný outfit.'),
  ]));

  // Zajtra
  const card = h('div.card');
  view.append(card);
  const deadlineMs = new Date(cycle.deadline).getTime();
  const cd = h('span.countdown');
  const tick = () => {
    const left = deadlineMs - Date.now();
    cd.textContent = fmtCountdown(left);
    if (left <= 0 && !cycle.passed) { clearInterval(state.timer); load(); }
  };
  clearInterval(state.timer);
  if (!cycle.passed) { tick(); state.timer = setInterval(tick, 1000); }

  card.append(h('div.row.between', {}, [h('h2', {}, `Zajtra · ${fmtDate(cycle.target)}`), statusBadge(tomorrow, cycle, true)]));

  if (tomorrow?.outfit) {
    card.append(h('p.muted', {}, 'Admin ti už vybral outfit na zajtra:'), outfitView(tomorrow, user, items));
    return;
  }

  const hasOffer = tomorrow && tomorrow.status !== 'self';
  const lateNoOffer = cycle.passed && !hasOffer;

  if (!cycle.passed) {
    card.append(h('div.notice' + (hasOffer ? '.ok' : ''), {}, hasOffer
      ? ['Ponuka je odovzdaná ✓ Admin vyberie outfit. Do ', h('b', {}, cycle.deadlineLabel), ' ju ešte môžeš upraviť (zostáva ', cd, ').']
      : ['Označ kúsky, z ktorých môže admin vyberať (čisté, dostupné), a odošli ponuku do ', h('b', {}, cycle.deadlineLabel), '. Zostáva ', cd, '.']));
  } else if (hasOffer) {
    card.append(h('div.notice.ok', {}, 'Ponuka je odovzdaná ✓ Čaká sa, kým admin vyberie outfit.'));
  } else {
    const enough = user.tokens >= lateCost;
    card.append(h('div.notice.danger', {}, [
      h('b', {}, `Deadline ${cycle.deadlineLabel} prešiel. `),
      tomorrow?.status === 'self'
        ? 'Zvolil/a si, že si zajtra vyberieš sama/sám. Ak chceš, aby vyberal admin, môžeš ešte zaplatiť tokenmi.'
        : `Buď si zajtra vyberieš outfit sama/sám, alebo zaplatíš ${lateCost} ${tokenWord(lateCost)} a admin ti vyberie.`,
      !enough ? h('div', { style: { marginTop: '6px' } }, ['Nemáš dosť tokenov – zarob si ich v záložke ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); state.tab = 'tasks'; render(); } }, 'Úlohy'), '.']) : null,
    ]));
  }

  if (active.length === 0) {
    card.append(h('p', {}, ['Zatiaľ nemáš v šatníku žiadne oblečenie. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); state.tab = 'wardrobe'; render(); } }, 'Pridaj ho tu.')]));
    if (lateNoOffer && tomorrow?.status !== 'self') card.append(selfButton());
    return;
  }

  // Výber kúskov do ponuky
  const shown = filterByCategory(active, state.offerCat);
  card.append(
    h('div.row.between', { style: { margin: '16px 0 8px' } }, [
      h('h3', { style: { margin: 0 } }, `Ponuka (${state.offer.size} označených)`),
      h('div.row', {}, [
        h('button.btn.small', { onclick: () => { active.forEach((i) => state.offer.add(i.id)); state.offerDirty = true; render(); } }, 'Označiť všetko'),
        h('button.btn.small', { onclick: () => { state.offer.clear(); state.offerDirty = true; render(); } }, 'Zrušiť'),
      ]),
    ]),
    categoryChips(active, state.offerCat, (c) => { state.offerCat = c; render(); }),
    h('div.item-grid', {}, shown.map((i) => itemTile(i, {
      selected: state.offer.has(i.id),
      onclick: () => { state.offer.has(i.id) ? state.offer.delete(i.id) : state.offer.add(i.id); state.offerDirty = true; render(); },
    }))),
  );

  const submit = (useTokens) => guarded(async () => {
    await api('POST', '/api/me/submit', { item_ids: [...state.offer], use_tokens: useTokens });
    state.offerDirty = false;
    toast(useTokens ? 'Zaplatené, ponuka odoslaná' : 'Ponuka odoslaná');
    await load();
  });

  const actions = h('div.row', { style: { marginTop: '16px' } });
  if (!lateNoOffer) {
    actions.append(h('button.btn.primary', { onclick: submit(false) }, hasOffer ? 'Uložiť zmeny ponuky' : 'Odoslať ponuku'));
  } else {
    actions.append(h('button.btn.primary', { onclick: submit(true), disabled: user.tokens < lateCost },
      `Zaplatiť ${lateCost} ${tokenWord(lateCost)} a odoslať`));
    if (tomorrow?.status !== 'self') actions.append(selfButton());
  }
  card.append(actions);
}

function selfButton() {
  return h('button.btn', {
    onclick: guarded(async () => {
      if (!confirm('Naozaj si zajtra vyberieš outfit sama/sám?')) return;
      await api('POST', '/api/me/self');
      await load();
    }),
  }, 'Vyberiem si sama/sám');
}

// ---------------------------------------------------------------------------
// Šatník
// ---------------------------------------------------------------------------
let categories = [];
async function ensureCategories() { if (!categories.length) categories = await api('GET', '/api/categories'); }

function categorySelect(value) {
  return h('select', { name: 'category_id', required: true }, [
    h('option', { value: '' }, '– vyber kategóriu –'),
    ...categories.map((c) => h('option', { value: c.id, selected: c.id === value }, c.name)),
  ]);
}

async function renderWardrobe(view) {
  await ensureCategories();
  const { items } = state.data;
  const active = items.filter((i) => !i.archived);
  const archived = items.filter((i) => i.archived);

  const drop = h('label.photo-drop', {}, [h('div.tpose', {}, '📸'), h('b', {}, 'Odfoť kúsok'),
    h('div.small.muted', {}, 'Najlepšie rozložený na jednoduchom (bielom) pozadí'),
    h('input', { type: 'file', name: 'photo', accept: 'image/*', required: true })]);
  bindPhotoPreview(drop);
  const form = h('form', {
    onsubmit: guarded(async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      if (!f.name.value.trim()) throw new Error('Pomenuj oblečenie.');
      if (!f.category_id.value) throw new Error('Vyber kategóriu.');
      const photo = await uploadFile(await resizeImage(f.photo.files[0]), 'image', { onProgress: progressToast('Nahrávam fotku') });
      await api('POST', '/api/me/items', { photo, name: f.name.value, category_id: f.category_id.value });
      toast('Pridané do šatníka');
      await load();
    }),
  }, [
    h('div.grid.cols-2', {}, [
      drop,
      h('div', {}, [
        h('label.field', {}, [h('span', {}, 'Názov'), h('input', { type: 'text', name: 'name', maxLength: 80, required: true, placeholder: 'napr. Biele tričko Nike' })]),
        h('label.field', {}, [h('span', {}, 'Kategória'), categorySelect()]),
        h('button.btn.primary.block', {}, 'Pridať do šatníka'),
      ]),
    ]),
  ]);

  view.append(
    h('div.card', {}, [h('h2', {}, 'Pridať oblečenie'), form]),
    h('div.card', {}, [
      h('h2', {}, `Môj šatník (${active.length})`),
      active.length ? categoryChips(active, state.wardCat, (c) => { state.wardCat = c; render(); }) : h('p.muted', {}, 'Zatiaľ prázdny.'),
      h('div.item-grid', {}, filterByCategory(active, state.wardCat).map((i) => itemTile(i, { onclick: () => editItem(i) }))),
    ]),
    archived.length ? h('div.card', {}, [
      h('h3', {}, `Odložené (${archived.length})`),
      h('p.muted.small', {}, 'Tieto kúsky sa nezobrazujú v ponuke. Kliknutím ich vrátiš.'),
      h('div.item-grid', {}, archived.map((i) => itemTile(i, { dim: true, onclick: () => editItem(i) }))),
    ]) : null,
  );
}

function editItem(item) {
  const dlg = $('#dlg');
  const close = () => dlg.close();
  const save = (patch) => guarded(async () => { await api('PATCH', `/api/me/items/${item.id}`, patch()); close(); await load(); });
  const nameIn = h('input', { type: 'text', value: item.name, maxLength: 80 });
  const catSel = categorySelect(item.category_id);
  dlg.replaceChildren(h('div.card', {}, [
    h('img', { src: item.photo, alt: '', style: { maxWidth: '100%', maxHeight: '260px', display: 'block', margin: '0 auto 12px', borderRadius: '10px' } }),
    h('label.field', {}, [h('span', {}, 'Názov'), nameIn]),
    h('label.field', {}, [h('span', {}, 'Kategória'), catSel]),
    h('div.row.between', {}, [
      h('button.btn.danger', { onclick: save(() => ({ archived: !item.archived })) }, item.archived ? 'Vrátiť do šatníka' : 'Odložiť (nemám už)'),
      h('div.row', {}, [h('button.btn', { onclick: close }, 'Zavrieť'),
        h('button.btn.primary', { onclick: save(() => ({ name: nameIn.value, category_id: Number(catSel.value) || null })) }, 'Uložiť')]),
    ]),
  ]));
  dlg.showModal();
}

// ---------------------------------------------------------------------------
// Úlohy
// ---------------------------------------------------------------------------
const SUB_STATUS = { pending: ['Čaká na vyhodnotenie', 'warn'], approved: ['Splnené', 'ok'], exception: ['Uznané ako výnimka', 'accent'], rejected: ['Nesplnené', 'danger'] };

async function renderTasks(view) {
  const { tasks, submissions } = await api('GET', '/api/me/tasks');
  view.append(h('div.notice', {}, 'Keď ti dôjdu tokeny, zarobíš si ich splnením úlohy. Natoč sa, ako úlohu robíš, a nahraj video – admin ho vyhodnotí a pripíše tokeny.'));
  const list = h('div.stack', { style: { marginTop: '16px' } });
  if (!tasks.length) list.append(h('div.card', {}, h('p.muted', {}, 'Momentálne nie sú žiadne úlohy.')));
  for (const t of tasks) {
    const fileIn = h('input', { type: 'file', accept: 'video/*', required: true });
    const noteIn = h('input', { type: 'text', placeholder: 'Poznámka (nepovinné)', maxLength: 500 });
    list.append(h('div.card', {}, [
      h('div.row.between', {}, [h('h3', { style: { margin: 0 } }, t.title), h('span.badge.accent', {}, `+${t.reward} ${tokenWord(t.reward)}`)]),
      t.description ? h('p', { style: { whiteSpace: 'pre-wrap' } }, t.description) : null,
      h('form', {
        onsubmit: guarded(async (ev) => {
          ev.preventDefault();
          const video = await uploadFile(fileIn.files[0], 'video', { onProgress: progressToast('Nahrávam video') });
          await api('POST', `/api/me/tasks/${t.id}/submit`, { video, note: noteIn.value });
          toast('Video odoslané na vyhodnotenie');
          render();
        }),
      }, [h('div.grid.cols-2', {}, [h('label.field', {}, [h('span', {}, 'Video s dôkazom'), fileIn]), h('label.field', {}, [h('span', {}, 'Poznámka'), noteIn])]),
        h('button.btn.primary', {}, 'Odoslať video')]),
    ]));
  }
  view.append(list);
  if (submissions.length) {
    view.append(h('div.card', { style: { marginTop: '16px' } }, [h('h2', {}, 'Moje odovzdania'), h('div.list', {}, submissions.map((s) => {
      const [label, cls] = SUB_STATUS[s.status];
      return h('div', {}, [
        h('div.row.between', {}, [h('b', {}, s.title), h('span.badge.' + cls, {}, label)]),
        h('div.small.muted', {}, [fmtDateTime(s.created_at), s.granted ? ` · +${s.granted} ${tokenWord(s.granted)}` : '']),
        s.admin_note ? h('div.small', {}, ['💬 ', s.admin_note]) : null,
      ]);
    }))]));
  }
}

// ---------------------------------------------------------------------------
// Tokeny
// ---------------------------------------------------------------------------
async function renderTokens(view) {
  const tx = await api('GET', '/api/me/transactions');
  const { user, cycle, late_cost: lateCost } = state.data;
  const link = location.origin + user.personal_link;
  view.append(
    h('div.card', {}, [
      h('h2', {}, `Máš ${user.tokens} ${tokenWord(user.tokens)}`),
      h('ul', {}, [
        h('li', {}, 'Každý pondelok dostaneš nové tokeny.'),
        h('li', {}, `Ponuku oblečenia na ďalší deň odovzdávaš do ${cycle.deadlineLabel}. Keď to nestihneš, buď si vyberieš sama/sám, alebo zaplatíš ${lateCost} ${tokenWord(lateCost)}.`),
        h('li', {}, 'Keď tokeny dôjdu, zarobíš si ich úlohami (video dôkaz).'),
      ]),
    ]),
    h('div.card', {}, [h('h3', {}, 'História'), tx.length ? h('div.list', {}, tx.map((t) => h('div.row.between', {}, [
      h('div', {}, [h('div', {}, t.reason), h('div.small.muted', {}, fmtDateTime(t.created_at))]),
      h('b', { style: { color: t.amount > 0 ? 'var(--ok)' : 'var(--danger)' } }, (t.amount > 0 ? '+' : '') + t.amount),
    ]))) : h('p.muted', {}, 'Zatiaľ nič.')]),
    h('div.card', {}, [
      h('h3', {}, 'Môj osobný odkaz'),
      h('p.small.muted', {}, 'Cez tento odkaz sa prihlásiš na inom zariadení. Nikomu ho neposielaj.'),
      h('div.row', {}, [h('input', { type: 'text', readOnly: true, value: link, style: { flex: 1 } }),
        h('button.btn', { onclick: () => { navigator.clipboard.writeText(link); toast('Skopírované'); } }, 'Kopírovať')]),
    ]),
  );
}

load().catch((e) => {
  if (e.status === 401) location.href = '/';
  else toast(e.message, true);
});
// Obnov údaje, keď sa používateľ vráti do appky (napr. admin medzitým vybral outfit).
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#dlg').open) load().catch(() => {}); });
