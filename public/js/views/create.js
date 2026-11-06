// Create a Split: a six-step wizard with live calculations. Project -> People -> Allocation -> Validation -> Review -> Publish & invite.
import { h, icon, copyButton, abs, act, naira, pct, debounce, confirmDialog } from '../ui.js';
import { api } from '../api.js';
import { current } from '../auth.js';
import { createPot } from '../pot.js';
import { parseNairaToKobo, parsePercentToBps, splitEvenlyBps, calcFee } from '/shared/money.js';

export const title = 'Create a Split';
const STEPS = ['Project', 'People', 'Allocation', 'Validation', 'Review', 'Publish'];
const KEYS = ['project', 'people', 'allocation', 'validation', 'review'];

/** Turn naira amounts into basis points that sum to exactly 10,000 (largest remainder, integers only). */
export function proportionalBps(kobos, total) {
  if (!(total > 0)) return kobos.map(() => null);
  const rows = kobos.map((k, i) => { const n = Math.max(0, k ?? 0) * 10000; return { i, base: Math.floor(n / total), rem: n % total }; });
  let left = 10000 - rows.reduce((a, r) => a + r.base, 0);
  for (const r of [...rows].sort((a, b) => b.rem - a.rem || a.i - b.i)) { if (left <= 0) break; r.base += 1; left -= 1; }
  return rows.map((r) => r.base);
}

export function mount({ main, config, navigate }) {
  const feeBps = config.feeBps ?? 150;
  // Deep links may open Project, People or Allocation only; later steps need entered data.
  const startKey = new URLSearchParams(location.search).get('step');
  const st = { step: Math.min(2, Math.max(0, KEYS.indexOf(startKey))), mode: 'percent', title: '', client: '', email: '', team: [{ name: current()?.name ?? '', role: '', pct: '', amt: '' }, { name: '', role: '', pct: '', amt: '' }], ms: [{ title: '', amt: '', crit: '' }] };
  const potHost = h('div', { class: 'create__pot', 'data-pot': '' }); const pot = createPot(potHost, { compact: true, label: 'Your pot, drawn from the shares and milestones you enter' });
  const sums = h('div', { class: 'create__sums', 'aria-live': 'polite' }); const panel = h('div', {}); const stepsEl = h('ol', { class: 'steps', 'aria-label': 'Progress' });
  const errBox = h('p', { class: 'err', role: 'alert' });

  // ---------- numbers
  const calc = () => {
    const amts = st.ms.map((m) => parseNairaToKobo(m.amt)); const total = amts.reduce((a, b) => a + (b ?? 0), 0);
    let bps; let sumBps; let personKobo = null; let sumK = null;
    if (st.mode === 'amount') {
      personKobo = st.team.map((t) => parseNairaToKobo(t.amt)); sumK = personKobo.reduce((a, b) => a + (b ?? 0), 0);
      bps = proportionalBps(personKobo, sumK === total ? total : 0); sumBps = sumK === total && total > 0 ? 10000 : total ? Math.round((sumK / total) * 10000) : 0;
    } else { bps = st.team.map((t) => parsePercentToBps(t.pct)); sumBps = bps.reduce((a, b) => a + (b ?? 0), 0); }
    const fee = total ? calcFee(total, feeBps) : 0;
    return { amts, total, bps, sumBps, personKobo, sumK, fee };
  };
  const problems = () => {
    const c = calc(); const out = [];
    if (st.title.trim().length < 3) out.push(['project', 'Give the project a title (at least 3 characters).']);
    if (!st.client.trim()) out.push(['project', 'Add the client’s name.']);
    if (st.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(st.email.trim())) out.push(['project', 'The client email does not look right. Fix it or clear it.']);
    st.ms.forEach((m, i) => { if (!m.title.trim()) out.push(['project', `Milestone ${i + 1} needs a title.`]); if (!(c.amts[i] > 0)) out.push(['project', `Milestone ${i + 1} needs an amount above ₦0.`]); if (!m.crit.split('\n').some((x) => x.trim())) out.push(['project', `Milestone ${i + 1} needs at least one written acceptance criterion.`]); });
    st.team.forEach((t, i) => { if (!t.name.trim()) out.push(['people', `Person ${i + 1} needs a name.`]); if (!t.role.trim()) out.push(['people', `Person ${i + 1} needs a role.`]); });
    if (st.mode === 'percent') { st.team.forEach((t, i) => { if (!(c.bps[i] > 0)) out.push(['allocation', `Person ${i + 1} needs a share above 0%.`]); }); if (c.sumBps !== 10000) out.push(['allocation', c.sumBps < 10000 ? `${pct(10000 - c.sumBps)} of the project is still unassigned.` : `Shares are ${pct(c.sumBps - 10000)} over 100%.`]); }
    else { st.team.forEach((t, i) => { if (!(c.personKobo[i] > 0)) out.push(['allocation', `Person ${i + 1} needs an amount above ₦0.`]); }); if (c.total && c.sumK !== c.total) out.push(['allocation', c.sumK < c.total ? `${naira(c.total - c.sumK)} of the project is still unassigned.` : `Amounts are ${naira(c.sumK - c.total)} over the project total.`]); }
    return out;
  };

  // ---------- live summary + pot
  const refresh = () => {
    const c = calc(); const left = 10000 - c.sumBps;
    sums.replaceChildren(
      h('div', { class: `sumrow ${left === 0 ? 'ok' : 'warn'}` }, h('span', {}, 'Shares total'), h('strong', { class: 'num' }, pct(Math.max(0, c.sumBps))), h('span', { class: 'sumrow__note' }, left === 0 ? 'Exactly 100%. Ready.' : left > 0 ? `${pct(left)} still to give out` : `${pct(-left)} over 100%`)),
      h('div', { class: 'sumrow' }, h('span', {}, 'Project total'), h('strong', { class: 'num' }, naira(c.total))),
      h('div', { class: 'sumrow' }, h('span', {}, `Platform fee ${pct(feeBps)}`), h('strong', { class: 'num' }, naira(c.fee)), h('span', { class: 'sumrow__note' }, 'Assumption, charged on top, not refunded')),
      h('div', { class: 'sumrow sumrow--big' }, h('span', {}, 'Client pays once'), h('strong', { class: 'num' }, naira(c.total + c.fee))));
    hintUpdaters.forEach((f) => f());
    drawPot();
  };
  const drawPot = debounce(() => {
    const c = calc(); const t = c.total || 100000; const none = c.bps.every((b) => !b);
    const channels = st.team.map((m, i) => ({ id: `c${i + 1}`, name: m.name.trim() || `Person ${i + 1}`, role: m.role, bps: none ? Math.floor(10000 / st.team.length) : Math.max(1, c.bps[i] ?? 0), state: 'idle', plannedKobo: Math.round(t * ((c.bps[i] ?? 0) / 10000)) }));
    const bands = st.ms.map((m, i) => ({ id: `m${i + 1}`, title: m.title.trim() || `Milestone ${i + 1}`, amountKobo: c.amts[i] || t / st.ms.length, state: 'waiting' }));
    pot.update({ totalKobo: bands.reduce((a, b) => a + b.amountKobo, 0), funded: !!c.total, bands, channels }, { animate: true });
  }, 120);

  const bind = (obj, key, el, after = refresh) => { el.value = obj[key]; el.addEventListener('input', () => { obj[key] = el.value; after(); }); return el; };
  const field = (label, id, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), el, hint ? (hint instanceof Node ? hint : h('p', { class: 'hint' }, hint)) : null);
  let hintUpdaters = [];
  const liveHint = (fn) => { const el = h('p', { class: 'hint', 'aria-live': 'polite' }); const f = () => { el.textContent = fn() ?? ''; }; hintUpdaters.push(f); f(); return el; };

  // ---------- step panels
  function msBlock() {
    return h('div', {}, ...st.ms.map((m, i) => h('div', { class: 'rowcard' }, h('div', { class: 'rowcard__n' }, `Milestone ${i + 1}`),
      h('div', { class: 'grid2' }, field('What is delivered', `mt${i}`, bind(m, 'title', h('input', { class: 'input', id: `mt${i}`, maxlength: 100, placeholder: 'e.g. Rough cut', autocomplete: 'off' }))), field('Amount in naira', `ma${i}`, bind(m, 'amt', h('input', { class: 'input input--num', id: `ma${i}`, inputmode: 'decimal', placeholder: '200,000', autocomplete: 'off' })))),
      field('Written acceptance criteria, one per line', `mc${i}`, bind(m, 'crit', h('textarea', { class: 'textarea', id: `mc${i}`, placeholder: 'Runs 3 to 4 minutes\nColour graded\nDelivered as an MP4' })), 'A client can only dispute by pointing at one of these. Keep them checkable.'),
      st.ms.length > 1 ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { st.ms.splice(i, 1); show(); refresh(); } }, icon('cross'), `Remove milestone ${i + 1}`) : null)),
      h('div', { class: 'btnrow' }, h('button', { class: 'btn btn--line btn--sm', type: 'button', onclick: () => { st.ms.push({ title: '', amt: '', crit: '' }); show(); refresh(); } }, 'Add a milestone')));
  }
  const pProject = () => h('div', {}, h('h2', {}, '1. Project details'),
    field('Project title', 'pt', bind(st, 'title', h('input', { class: 'input', id: 'pt', maxlength: 120, placeholder: 'e.g. Brand shoot for Lagos Fashion Week', autocomplete: 'off' }), () => {})),
    h('div', { class: 'grid2' }, field('Client name', 'pc', bind(st, 'client', h('input', { class: 'input', id: 'pc', maxlength: 80, autocomplete: 'off' }), () => {})), field('Client email (optional)', 'pe', bind(st, 'email', h('input', { class: 'input', id: 'pe', type: 'email', maxlength: 120, autocomplete: 'off' }), () => {}), 'No email is sent in this prototype. You share the client link yourself.')),
    h('h3', { class: 'mini-h' }, 'Milestones and the total'), h('p', { class: 'hint' }, 'The project total is the sum of the milestones.'), msBlock());
  const pPeople = () => h('div', {}, h('h2', {}, '2. Participants'), h('p', { class: 'hint' }, 'You are the first person. Add everyone who gets paid. Each person gets their own link to accept or decline their share.'),
    ...st.team.map((t, i) => h('div', { class: 'rowcard' }, h('div', { class: 'rowcard__n' }, i === 0 ? 'You (team lead)' : `Person ${i + 1}`),
      h('div', { class: 'grid2' }, field('Name', `tn${i}`, bind(t, 'name', h('input', { class: 'input', id: `tn${i}`, maxlength: 60, autocomplete: 'off' }))), field('Role', `tr${i}`, bind(t, 'role', h('input', { class: 'input', id: `tr${i}`, maxlength: 60, placeholder: 'e.g. Editor', autocomplete: 'off' })))),
      i > 0 ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { st.team.splice(i, 1); show(); refresh(); } }, icon('cross'), `Remove person ${i + 1}`) : null)),
    h('div', { class: 'btnrow' }, h('button', { class: 'btn btn--line btn--sm', type: 'button', onclick: () => { if (st.team.length >= 20) return; st.team.push({ name: '', role: '', pct: '', amt: '' }); show(); refresh(); } }, 'Add a person')));
  const pAlloc = () => {
    const c = calc(); const tabs = [['percent', 'By percent'], ['amount', 'By amount (₦)']].map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(st.mode === k), onclick: () => { if (st.mode === k) return; if (k === 'amount') { const cc = calc(); st.team.forEach((x, i) => { if (cc.total && cc.bps[i]) x.amt = String(Math.round((cc.total * cc.bps[i]) / 10000) / 100); }); } else { const cc = calc(); st.team.forEach((x, i) => { if (cc.bps[i]) x.pct = String(cc.bps[i] / 100); }); } st.mode = k; show(); refresh(); } }, t));
    return h('div', {}, h('h2', {}, '3. Allocation'), h('p', { class: 'hint' }, 'Agree this now. Everything must add up before the split can be published.'), h('div', { class: 'modeswitch' }, h('div', { class: 'seg-tabs', role: 'group', 'aria-label': 'Allocate by' }, ...tabs)),
      ...st.team.map((t, i) => h('div', { class: 'rowcard' }, h('div', { class: 'rowcard__n' }, `${t.name.trim() || `Person ${i + 1}`}${t.role.trim() ? `, ${t.role.trim()}` : ''}`),
        st.mode === 'percent' ? field('Share, in percent', `tp${i}`, bind(t, 'pct', h('input', { class: 'input input--num', id: `tp${i}`, inputmode: 'decimal', placeholder: '25', autocomplete: 'off' })), liveHint(() => { const k = calc(); return k.bps[i] && k.total ? `= ${naira(Math.round((k.total * k.bps[i]) / 10000))} of the project` : null; })) : field('Amount in naira', `ta${i}`, bind(t, 'amt', h('input', { class: 'input input--num', id: `ta${i}`, inputmode: 'decimal', placeholder: '100,000', autocomplete: 'off' })), liveHint(() => { const k = calc(); return k.bps[i] ? `= ${pct(k.bps[i])} of the project` : null; })))),
      h('div', { class: 'btnrow' }, h('button', { class: 'btn btn--line btn--sm', type: 'button', onclick: () => { if (st.mode === 'percent') { const v = splitEvenlyBps(st.team.length); st.team.forEach((t, i) => { t.pct = String(v[i] / 100); }); } else { const total = calc().total; const each = Math.floor(total / st.team.length); const rem = total - each * st.team.length; st.team.forEach((t, i) => { t.amt = String((each + (i < rem ? 1 : 0)) / 100); }); } show(); refresh(); } }, 'Split evenly')),
      st.mode === 'amount' ? h('p', { class: 'hint' }, 'Amounts are converted to whole hundredths of a percent, and payouts are always calculated in whole kobo.') : null);
  };
  const pValidate = () => {
    const ps = problems(); const total = calc().total;
    const checks = [['Project details complete', !ps.some((p) => p[0] === 'project')], ['Everyone has a name and role', !ps.some((p) => p[0] === 'people')], ['Shares add up to exactly 100%', !ps.some((p) => p[0] === 'allocation')], ['Project total above ₦0', total > 0]];
    return h('div', {}, h('h2', {}, '4. Validation'), h('ul', { class: 'plain', 'data-checks': '' }, ...checks.map(([t, ok]) => h('li', {}, ok ? icon('check') : icon('cross'), ' ', h('strong', {}, t), ' ', h('span', { class: ok ? 'resolved' : 'err' }, ok ? 'OK' : 'Needs attention')))),
      ps.length ? h('div', { class: 'notice', role: 'alert' }, h('strong', {}, 'Fix these before continuing'), h('ul', { class: 'plain' }, ...ps.map(([k, t]) => h('li', {}, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => go(KEYS.indexOf(k)) }, t))))) : h('p', { class: 'resolved' }, icon('check'), ' Everything checks out.'));
  };
  const pReview = () => {
    const c = calc();
    return h('div', {}, h('h2', {}, '5. Review'), h('p', { class: 'hint' }, 'This is exactly what gets written to the ledger and sent to each person.'),
      h('div', { class: 'doc' }, h('div', { class: 'doc__body' }, h('h3', { class: 'mini-h' }, st.title), h('p', { class: 'hint' }, `Client: ${st.client}`),
        h('div', { class: 'tbl-scroll' }, h('table', { class: 'tbl tbl--tight' }, h('caption', { class: 'vh' }, 'Agreed split'), h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Person'), h('th', { scope: 'col', class: 'r' }, 'Share'), h('th', { scope: 'col', class: 'r' }, 'Amount'))), h('tbody', {}, ...st.team.map((t, i) => h('tr', {}, h('td', {}, h('strong', {}, t.name), h('div', { class: 'hint' }, t.role)), h('td', { class: 'r' }, pct(c.bps[i])), h('td', { class: 'r num' }, naira(Math.round((c.total * (c.bps[i] ?? 0)) / 10000))))))),),
        h('h3', { class: 'mini-h' }, 'Milestones'), h('ul', { class: 'plain' }, ...st.ms.map((m, i) => h('li', {}, h('strong', {}, `${i + 1}. ${m.title}`), ` ${naira(c.amts[i])}`, h('div', { class: 'hint' }, m.crit.split('\n').map((x) => x.trim()).filter(Boolean).join(' · '))))),
        h('dl', { class: 'kv' }, h('dt', {}, 'Project total'), h('dd', { class: 'num' }, naira(c.total)), h('dt', {}, `Platform fee ${pct(feeBps)} (assumption)`), h('dd', { class: 'num' }, naira(c.fee)), h('dt', {}, h('strong', {}, 'Client pays once')), h('dd', { class: 'num' }, h('strong', {}, naira(c.total + c.fee)))))));
  };
  const pPublish = () => h('div', {}, h('h2', {}, '6. Publish and invite'), h('p', {}, 'Publishing creates the pot and one private link for each person and the client. Nothing moves until everyone confirms.'), current() ? h('p', { class: 'hint' }, 'It will be added to your dashboard automatically.') : h('p', { class: 'hint' }, h('a', { href: '/login?next=/new', 'data-link': '' }, 'Log in'), ' first to keep it on a dashboard. You can still publish without an account.'), errBox);

  const panels = [pProject, pPeople, pAlloc, pValidate, pReview, pPublish];
  const back = h('button', { class: 'btn btn--line', type: 'button', onclick: () => go(st.step - 1) }, 'Back');
  const next = h('button', { class: 'btn btn--amber', type: 'button', 'data-next': '', onclick: () => advance() }, 'Continue');
  const publish = h('button', { class: 'btn btn--amber', type: 'button', 'data-publish': '' }, 'Publish the split');

  function stepProblems(i) { const key = KEYS[i]; if (key === 'validation' || key === 'review') return problems(); return problems().filter(([k]) => k === key || (key === 'allocation' && k === 'allocation')); }
  function advance() { const ps = st.step < 3 ? stepProblems(st.step) : problems(); if (ps.length && st.step !== 3) { errBox.textContent = ''; flash(ps); return; } if (st.step === 3 && ps.length) { flash(ps); return; } go(st.step + 1); }
  function flash(ps) { const n = h('div', { class: 'notice', role: 'alert', 'data-step-errors': '' }, h('strong', {}, 'Before you continue'), h('ul', { class: 'plain' }, ...ps.slice(0, 5).map(([, t]) => h('li', {}, t)))); panel.querySelector('[data-step-errors]')?.remove(); panel.append(n); n.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  function go(i) { st.step = Math.max(0, Math.min(5, i)); show(); window.scrollTo({ top: 0 }); }
  function show() {
    stepsEl.replaceChildren(...STEPS.map((t, i) => h('li', { class: i < st.step ? 'is-done' : '', ...(i === st.step ? { 'aria-current': 'step' } : {}) }, `${i + 1}. ${t}`)));
    hintUpdaters = [];
    panel.replaceChildren(panels[st.step](), h('div', { class: 'wiz-nav' }, st.step > 0 ? back : h('span'), st.step < 5 ? next : publish));
    next.textContent = st.step === 4 ? 'Looks right, continue' : 'Continue';
    refresh();
  }
  publish.onclick = async () => {
    const ps = problems(); if (ps.length) { go(3); return; }
    if (!(await confirmDialog({ title: 'Publish this split?', body: 'The shares and milestones are written to the ledger. People can accept or decline, and you can revise the split until the client pays.', confirmLabel: 'Publish the split' }))) return;
    errBox.textContent = ''; const c = calc();
    const body = { title: st.title, clientName: st.client, clientEmail: st.email, collaborators: st.team.map((t, i) => ({ name: t.name, role: t.role, bps: c.bps[i] })), milestones: st.ms.map((m, i) => ({ title: m.title, amountKobo: c.amts[i], criteria: m.crit.split('\n').map((x) => x.trim()).filter(Boolean) })) };
    const r = await act(publish, () => api('POST', '/api/projects', body).catch((e) => { errBox.textContent = e.message; throw e; }));
    if (r) done(r, body);
  };

  function done(r, body) {
    const links = [{ who: 'You, the team lead', sub: 'Your project page. Keep it private.', path: r.links.lead }, { who: `Client: ${body.clientName}`, sub: 'Send this to the client so they can pay and approve.', path: r.links.client },
      ...r.links.collaborators.map((cl) => ({ who: cl.name, sub: cl.id === 'c1' ? 'Your own share: open it to confirm.' : 'Invite link. They can accept or decline their share.', path: cl.path })), { who: 'Public ledger', sub: 'Safe to share. It never shows account numbers or private links.', path: r.links.ledger }];
    main.replaceChildren(h('div', { class: 'wrap page page--narrow' }, h('p', { class: 'sec__kicker' }, 'Split published'), h('h1', { class: 'page-h' }, 'Invite your team'),
      h('p', { class: 'sec__lead' }, current() ? 'It is on your dashboard. Copy each link and send it to the right person. Each person’s status shows as invited, viewed, accepted or declined.' : 'Anyone with a link can act in that role, and a lost link cannot be recovered. Copy them now, or log in and add the project to a dashboard.'),
      h('div', { class: 'doc', style: { marginTop: '26px' } }, h('div', { class: 'doc__body' }, ...links.map((l) => h('div', { class: 'copyrow' }, h('div', {}, h('div', { class: 'copyrow__who' }, l.who), h('div', { class: 'hint' }, l.sub)), copyButton(() => abs(l.path)))))),
      h('div', { class: 'btnrow', style: { marginTop: '24px' } }, h('a', { class: 'btn btn--amber', href: r.links.lead, 'data-link': '' }, 'Open my project', icon('arrow')), h('a', { class: 'btn btn--line', href: r.links.collaborators[0].path, 'data-link': '' }, 'Confirm my own share first'), current() ? h('a', { class: 'btn btn--line', href: '/dashboard', 'data-link': '' }, 'Go to dashboard') : null)));
    window.scrollTo(0, 0);
  }

  main.append(h('div', { class: 'wrap page' }, h('p', { class: 'sec__kicker' }, 'Create a Split'), h('h1', { class: 'page-h' }, 'Agree the split before the work starts'),
    h('div', { class: 'create' }, h('div', {}, stepsEl, panel, sums), h('aside', { class: 'create__aside' }, h('div', { class: 'on-dark create__stage' }, potHost, h('p', { class: 'hint', style: { padding: '0 6px 6px' } }, 'Your pot, drawn from what you enter.'))))));
  pot.update({ totalKobo: 100000, funded: false, bands: [{ id: 'm1', title: 'Milestone 1', amountKobo: 100000, state: 'waiting' }], channels: [{ id: 'c1', name: 'Person 1', bps: 5000, state: 'idle', plannedKobo: 50000 }, { id: 'c2', name: 'Person 2', bps: 5000, state: 'idle', plannedKobo: 50000 }] }, { animate: false });
  show();
  return () => pot.destroy();
}
