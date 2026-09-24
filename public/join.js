'use strict';

// Registrácia cez pozvánku – sprievodca po krokoch.
const code = new URLSearchParams(location.search).get('code') || location.pathname.split('/').filter(Boolean).pop();
const data = { name: '', front: null, back: null };
const STEPS = ['welcome', 'name', 'front', 'back', 'review'];
let stepIdx = 0;
let goingBack = false;

$('#back').append(icon('arrowLeft'));
$('#back').addEventListener('click', () => go(stepIdx - 1));

function go(i) {
  goingBack = i < stepIdx;
  stepIdx = Math.max(0, Math.min(STEPS.length - 1, i));
  draw();
  scrollTo(0, 0);
}

function draw() {
  const name = STEPS[stepIdx];
  $('#back').classList.toggle('show', stepIdx > 0 && name !== 'done');
  $('#progress-dots').replaceChildren(...STEPS.map((_, i) => h('i' + (i <= stepIdx ? '.on' : ''))));
  const el = h('div.wizard-step' + (goingBack ? '.back-anim' : ''));
  ({ welcome, name: nameStep, front: (e) => photoStep(e, 'front'), back: (e) => photoStep(e, 'back'), review, done })[name](el);
  $('#step').replaceChildren(el);
}

// Ilustrácia T-pózy
function tposeSvg(back) {
  const svg = `<svg viewBox="0 0 120 150" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="60" cy="20" r="11"/>
    <path d="M60 31v52"/><path d="M12 44h96"/>
    <path d="M60 83 44 138M60 83l16 55"/>
    ${back ? '<path d="M52 40h16" stroke-width="2" opacity=".5"/>' : '<path d="M56 18h.01M64 18h.01" stroke-width="4"/>'}
    <path d="M6 44h6M108 44h6" opacity=".4"/></svg>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = svg;
  return wrap.firstChild;
}

function welcome(el) {
  el.append(
    h('img.hero-mark', { src: '/icon.svg', alt: '' }),
    h('div.eyebrow', {}, 'Pozvánka'),
    h('h1', {}, 'Vitaj v Style Picker'),
    h('p.lead', {}, 'Niekto ti bude vyberať, čo si oblečieš. Ty len nahráš svoje oblečenie – zvyšok je na ňom.'),
    h('div.how', {}, [
      ['Nahráš svoje oblečenie', 'Odfotíš kúsok, pomenuješ ho a vyberieš kategóriu. Všetko sa uloží.'],
      ['Každý deň pošleš ponuku', 'Do večera označíš, z čoho sa má na ďalší deň vyberať.'],
      ['Dostaneš outfit', 'Uvidíš ho rovno nasadený na svojej postave.'],
    ].map(([t, d], i) => h('div.h-item', {}, [h('div.h-num', {}, i + 1), h('div', {}, [h('b', {}, t), h('span', {}, d)])]))),
    h('div.wizard-foot', {}, [
      h('button.btn.primary.lg.block', { onclick: () => go(1) }, ['Začať', icon('arrowRight')]),
      h('p.small.muted', { style: { textAlign: 'center', margin: 0 } }, 'Registrácia trvá asi 2 minúty.'),
    ]),
  );
}

function nameStep(el) {
  const input = h('input.big-input', { type: 'text', value: data.name, maxLength: 60, placeholder: 'napr. Lucka', autocomplete: 'given-name', enterKeyHint: 'next' });
  const next = () => {
    data.name = input.value.trim();
    if (!data.name) { toast('Napíš, ako ťa máme volať.', true); input.focus(); return; }
    go(2);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
  el.append(
    h('div.eyebrow', {}, 'Krok 1 z 3'),
    h('h1', {}, 'Ako ťa máme volať?'),
    h('p.lead', {}, 'Meno alebo prezývka, pod ktorou ťa uvidí admin.'),
    h('div', { style: { marginTop: '18px' } }, input),
    h('div.wizard-foot', {}, h('button.btn.primary.lg.block', { onclick: next }, ['Pokračovať', icon('arrowRight')])),
  );
  setTimeout(() => input.focus(), 350);
}

function photoStep(el, side) {
  const isFront = side === 'front';
  const shot = h('div.shot');
  const cont = h('button.btn.primary.lg.block', { onclick: () => go(stepIdx + 1), disabled: !data[side] }, ['Pokračovať', icon('arrowRight')]);
  const pick = (capture) => h('input', { type: 'file', accept: 'image/*', ...(capture ? { capture: 'environment' } : {}), style: { display: 'none' },
    onchange: (e) => { const f = e.target.files[0]; if (f) { data[side] = f; drawShot(); } } });
  const cam = pick(true);
  const gal = pick(false);
  const buttons = h('div.row');
  function drawShot() {
    const has = !!data[side];
    cont.disabled = !has;
    shot.classList.toggle('hidden', !has);
    if (has) shot.replaceChildren(h('img', { src: URL.createObjectURL(data[side]), alt: '' }),
      h('button.btn.small.retake', { onclick: () => gal.click() }, 'Vymeniť'));
    buttons.replaceChildren(
      h('button.btn' + (has ? '' : '.primary') + '.lg', { style: { flex: 1 }, onclick: () => cam.click() }, [icon('camera'), has ? 'Odfotiť znova' : 'Odfotiť']),
      h('button.btn.lg', { style: { flex: 1 }, onclick: () => gal.click() }, [icon('image'), 'Z galérie']),
    );
  }
  el.append(
    h('div.eyebrow', {}, `Krok ${isFront ? 2 : 3} z 3`),
    h('h1', {}, isFront ? 'Fotka spredu' : 'Fotka zozadu'),
    h('p.lead', {}, isFront ? 'Na túto fotku ti bude admin skúšať oblečenie. Postav sa do T-pózy.' : 'Teraz to isté, len otočená chrbtom.'),
    h('div.pose', {}, [tposeSvg(!isFront), h('ul', {}, [
      h('li', {}, 'Celé telo v zábere, od hlavy po chodidlá'),
      h('li', {}, 'Ruky vodorovne do strán'),
      h('li', {}, 'Jednoduché, svetlé pozadie'),
      h('li', {}, 'Tesnejšie oblečenie'),
      h('li', {}, 'Nech ťa odfotí niekto iný, alebo použi samospúšť'),
    ])]),
    shot, cam, gal,
    h('div.wizard-foot', {}, [buttons, cont]),
  );
  drawShot();
}

function review(el) {
  const status = h('div');
  const submit = h('button.btn.primary.lg.block', {
    onclick: guarded(async () => {
      const prog = uploadProgress('Nahrávam fotky');
      status.replaceChildren(prog.el);
      const front = await uploadFile(await resizeImage(data.front, 2000), 'image', { invite: code, onProgress: (p) => prog.set(Math.round(p / 2)) });
      const back = await uploadFile(await resizeImage(data.back, 2000), 'image', { invite: code, onProgress: (p) => prog.set(50 + Math.round(p / 2)) });
      prog.set(100);
      const res = await api('POST', `/api/join/${code}`, { name: data.name, front, back });
      data.link = location.origin + res.personal_link;
      stepIdx = STEPS.length;
      const d = h('div.wizard-step');
      done(d);
      $('#back').classList.remove('show');
      $('#progress-dots').replaceChildren(...STEPS.map(() => h('i.on')));
      $('#step').replaceChildren(d);
    }),
  }, 'Dokončiť registráciu');
  el.append(
    h('div.eyebrow', {}, 'Skontroluj'),
    h('h1', {}, `Všetko sedí, ${data.name}?`),
    h('p.lead', {}, 'Fotky vidí len admin. Kedykoľvek ich vie vymeniť.'),
    h('div.review', {}, [
      h('figure', {}, [h('img', { src: URL.createObjectURL(data.front), alt: 'Spredu' }), h('figcaption', {}, 'Spredu')]),
      h('figure', {}, [h('img', { src: URL.createObjectURL(data.back), alt: 'Zozadu' }), h('figcaption', {}, 'Zozadu')]),
    ]),
    status,
    h('div.wizard-foot', {}, submit),
  );
}

function done(el) {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  el.append(
    h('div.success-check', {}, icon('check')),
    h('h1', {}, `Hotovo, ${data.name}!`),
    h('p.lead', {}, 'Si zaregistrovaná/ý. Teraz si nahraj oblečenie, z ktorého sa bude vyberať.'),
    h('div.card', { style: { margin: '18px 0 12px' } }, [
      h('b', {}, 'Tvoj osobný odkaz'),
      h('p.small.muted', { style: { margin: '4px 0 10px' } }, 'Cez neho sa vrátiš do appky aj z iného zariadenia. Ulož si ho a nikomu ho neposielaj.'),
      h('div.kbd-link', {}, [h('input', { type: 'text', readOnly: true, value: data.link }),
        h('button.btn', { onclick: () => { navigator.clipboard.writeText(data.link); toast('Skopírované'); } }, 'Kopírovať')]),
    ]),
    h('div.tip', {}, [icon('phone'), h('div', {}, [h('b', {}, 'Tip: pridaj si appku na plochu. '),
      isIOS ? 'V Safari ťukni na Zdieľať → Pridať na plochu.' : 'V prehliadači otvor menu ⋮ → Pridať na plochu.'])]),
    h('div.wizard-foot', {}, h('a.btn.primary.lg.block', { href: '/app' }, ['Otvoriť môj šatník', icon('arrowRight')])),
  );
}

function invalid() {
  $('#back').classList.remove('show');
  $('#progress-dots').replaceChildren();
  $('#step').replaceChildren(h('div.wizard-step', {}, [
    h('div.success-check', { style: { background: 'var(--danger-soft)', color: 'var(--danger)' } }, icon('alert')),
    h('h1', {}, 'Odkaz už neplatí'),
    h('p.lead', {}, 'Pozvánka bola použitá, zrušená alebo neexistuje. Požiadaj o nový odkaz.'),
    h('div.wizard-foot', {}, h('a.btn.lg.block', { href: '/' }, 'Späť na úvod')),
  ]));
}

(async () => {
  try {
    const w = await whoami();
    // Ak je človek už prihlásený, pozvánku nepotrebuje.
    if (w.user) { location.replace('/app'); return; }
    if (!code) throw new Error('bez kódu');
    await api('GET', `/api/invite/${encodeURIComponent(code)}`);
    draw();
  } catch {
    invalid();
  } finally {
    hideSplash();
  }
})();
