import { h, s, icon, staticSvg, reduceMotion, naira, pct, $, $$ } from '../ui.js';
import { mountNetwork } from '../bg.js';
import { createPot } from '../pot.js';
import { allocateByShares } from '/shared/money.js';

export const title = null;

const TEAM = [{ id: 'c1', name: 'Videographer', bps: 4000 }, { id: 'c2', name: 'Photographer', bps: 2000 }, { id: 'c3', name: 'Editor', bps: 2000 }, { id: 'c4', name: 'Makeup artist', bps: 1000 }, { id: 'c5', name: 'Creative director', bps: 1000 }];
const MS = [{ id: 'm1', title: 'Rough cut', amountKobo: 20000000 }, { id: 'm2', title: 'Final', amountKobo: 30000000 }];
const TOTAL = 50000000;
const planned = (cid) => MS.reduce((a, m) => a + allocateByShares(m.amountKobo, TEAM).find((x) => x.id === cid).amountKobo, 0);
const releasedTo = (cid, ids) => ids.reduce((a, mid) => a + allocateByShares(MS.find((m) => m.id === mid).amountKobo, TEAM).find((x) => x.id === cid).amountKobo, 0);

async function sha(text) { try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); } catch { return null; } }

function demoModel(st) {
  return {
    totalKobo: TOTAL, funded: st.funded, payLabel: st.paying ? 'processing' : '',
    bands: MS.map((m) => ({ ...m, state: !st.funded ? 'unfunded' : st.band[m.id] })),
    channels: TEAM.map((c) => {
      const paidIds = MS.filter((m) => st.band[m.id] === 'paid').map((m) => m.id);
      const sending = MS.some((m) => st.band[m.id] === 'releasing');
      const allDone = paidIds.length === MS.length;
      return { ...c, role: c.name, plannedKobo: planned(c.id), paidKobo: releasedTo(c.id, paidIds), state: sending ? 'paying' : allDone ? 'paid' : paidIds.length ? 'partial' : 'idle' };
    }),
  };
}

function Hero() {
  const st = { funded: false, paying: false, band: { m1: 'waiting', m2: 'waiting' } };
  const potHost = h('div', { class: 'potwrap', 'data-pot': '' }); const pot = createPot(potHost, { label: 'Illustration of a payment pot with two milestones and five team members' });
  const line = h('p', { class: 'demo-line', 'aria-live': 'polite' }, 'The client has not paid yet. Five people agreed their shares first.');
  const ledger = h('div', { class: 'demo-ledger', 'aria-label': 'Illustrative ledger entries' });
  const bFund = h('button', { class: 'btn btn--amber', type: 'button' }, 'Fund the pot');
  const bApprove = h('button', { class: 'btn btn--paid', type: 'button', disabled: true }, 'Approve a milestone');
  const bDispute = h('button', { class: 'btn btn--frozen', type: 'button', disabled: true }, 'Dispute one');
  const bReset = h('button', { class: 'btn btn--ghost', type: 'button', style: { color: 'var(--on-dark-muted)', textDecoration: 'underline', minHeight: '44px' }, hidden: true }, 'Start over');
  let seq = 0; let prev = '0'.repeat(64); const timers = [];
  const later = (fn, ms) => { timers.push(setTimeout(fn, reduceMotion() ? 0 : ms)); };
  const refresh = () => {
    const open = MS.filter((m) => st.band[m.id] === 'waiting');
    bFund.disabled = st.funded; bApprove.disabled = !st.funded || !open.length || st.paying; bDispute.disabled = !st.funded || !open.length || st.paying;
    bReset.hidden = !st.funded; pot.update(demoModel(st), { animate: true });
  };
  async function log(text) {
    seq += 1; const hash = await sha(`${prev}|${seq}|${text}`); prev = hash ?? prev;
    const row = h('span', {}, `#${seq} `, h('b', {}, hash ? hash.slice(0, 8) : '--------'), ` ${text}`);
    ledger.append(row); while (ledger.children.length > 3) ledger.firstChild.remove();
  }
  bFund.onclick = () => { st.paying = true; line.textContent = 'Verifying the payment against the amount the team agreed.'; refresh();
    later(() => { st.paying = false; st.funded = true; line.textContent = 'One payment. The whole project is now in the pot, and nothing is released yet.'; log('pot funded, amount and currency verified'); refresh(); }, 1100); };
  bApprove.onclick = () => { const m = MS.find((x) => st.band[x.id] === 'waiting'); if (!m) return; st.band[m.id] = 'releasing'; st.paying = true; line.textContent = `${m.title} approved. Each person is paid their own share, straight from the pot.`; refresh();
    later(() => { st.band[m.id] = 'paid'; st.paying = false; const frozen = MS.some((x) => st.band[x.id] === 'frozen'); line.textContent = frozen ? `${m.title} paid in full. The disputed milestone stays frozen.` : MS.every((x) => st.band[x.id] === 'paid') ? 'Everyone is paid. Nobody had to chase anyone.' : `${m.title} paid. The rest of the pot is untouched.`; log(`${m.title.toLowerCase()} released to 5 people`); refresh(); }, 1700); };
  bDispute.onclick = () => { const m = MS.find((x) => st.band[x.id] === 'waiting'); if (!m) return; st.band[m.id] = 'frozen'; line.textContent = `${m.title} is frozen while the client and team talk. Only this milestone is held.`; log(`${m.title.toLowerCase()} frozen: dispute opened`); refresh(); };
  bReset.onclick = () => { timers.forEach(clearTimeout); st.funded = false; st.paying = false; st.band = { m1: 'waiting', m2: 'waiting' }; seq = 0; prev = '0'.repeat(64); ledger.textContent = ''; line.textContent = 'The client has not paid yet. Five people agreed their shares first.'; refresh(); };
  pot.update(demoModel(st), { animate: false }); refresh();
  const el = h('div', {}, potHost,
    h('div', { class: 'potcap' }, h('strong', {}, 'Illustration, not real data.'), h('span', {}, 'Try it: the pot only draws what happened.')),
    h('div', { class: 'demo-ctl' }, bFund, bApprove, bDispute), line, ledger, bReset);
  return { el, destroy() { timers.forEach(clearTimeout); pot.destroy(); } };
}

const BA_BEFORE = `<svg viewBox="0 0 420 260" role="img" aria-label="Before: the client pays one person, who then chases to pay everyone else"><circle cx="50" cy="50" r="10" fill="currentColor"/><text x="70" y="55">Client</text><path d="M50 62 V120" class="ln-q"/><circle cx="50" cy="132" r="10" fill="currentColor"/><text x="70" y="137">One person gets all of it</text><path d="M60 140 C150 150 190 190 300 190" class="ln-q"/><path d="M60 140 C150 140 200 140 300 140" class="ln-q"/><path d="M60 140 C150 130 190 100 300 90" class="ln-q"/><g><circle cx="312" cy="90" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="312" cy="140" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="312" cy="190" r="8" fill="none" stroke="currentColor" stroke-width="2"/></g><text x="332" y="95" class="ba-s">asks</text><text x="332" y="145" class="ba-s">waits</text><text x="332" y="195" class="ba-s">hopes</text><text x="50" y="236" class="ba-s">Shares live in a chat. Nobody can check them.</text></svg>`;
const BA_AFTER = `<svg viewBox="0 0 420 260" role="img" aria-label="After: the client pays one pot, and the pot pays everyone by the agreed split"><circle cx="210" cy="30" r="10" fill="currentColor"/><text x="230" y="35">Client pays once</text><path d="M210 42 V84" class="ln-ok" pathLength="100"/><path d="M150 90 H270 L260 140 Q255 156 240 156 H180 Q165 156 160 140 Z" fill="#E9A23B" stroke="currentColor" stroke-width="2"/><path d="M185 156 C185 190 90 180 90 222" class="ln-ok" pathLength="100"/><path d="M200 156 C200 190 170 190 170 222" class="ln-ok" pathLength="100"/><path d="M220 156 C220 190 250 190 250 222" class="ln-ok" pathLength="100"/><path d="M235 156 C235 190 330 180 330 222" class="ln-ok" pathLength="100"/><g fill="currentColor"><circle cx="90" cy="230" r="8"/><circle cx="170" cy="230" r="8"/><circle cx="250" cy="230" r="8"/><circle cx="330" cy="230" r="8"/></g><text x="118" y="125" class="ba-s" fill="#0E2A23">the split is already agreed</text></svg>`;

export function mount({ main, config }) {
  const cleanups = [];
  const stage = h('section', { class: 'stage hero', id: 'top' });
  const net = mountNetwork(stage, { seed: 11, focus: { x: 0.72, y: 0.5 } }); cleanups.push(() => net.destroy());
  const hero = Hero(); cleanups.push(() => hero.destroy());
  stage.append(h('div', { class: 'wrap hero__grid' },
    h('div', {}, h('p', { class: 'eyebrow' }, 'A shared payment pot for creative teams'),
      h('h1', { 'aria-label': 'One payment. Everyone paid.' }, h('span', { class: 'ln', 'aria-hidden': 'true' }, h('span', {}, 'One payment.')), h('span', { class: 'ln', 'aria-hidden': 'true' }, h('span', {}, 'Everyone paid.'))),
      h('p', { class: 'hero__lede' }, 'Your team does the work. SplitPot coordinates the money. Agree on every share, collect one payment, and distribute earnings transparently.'),
      h('div', { class: 'hero__cta' }, h('a', { class: 'btn btn--amber', href: '/new', 'data-link': '' }, 'Start a Split', icon('arrow')), h('a', { class: 'btn btn--line-dark', href: '/#how', 'data-link': '' }, 'See How It Works'), config.demoMode ? h('a', { class: 'btn btn--ghost', style: { color: 'var(--on-dark-muted)', textDecoration: 'underline' }, href: '/demo', 'data-link': '' }, 'Judge demo') : null)),
    hero.el));
  main.append(stage);

  // problem
  const ba = (t, sub, svg, cls) => h('div', { class: `ba ${cls}` }, h('h3', {}, t), h('p', { class: 'hint', style: cls ? { color: 'var(--on-dark-muted)' } : {} }, sub), staticSvg(svg));
  main.append(h('section', { class: 'sec' }, h('div', { class: 'wrap' },
    h('p', { class: 'sec__kicker' }, 'The problem'), h('h2', {}, 'Teams get paid like a group chat.'),
    h('p', { class: 'sec__lead' }, 'When a project is paid to one person, everyone else is trusting a promise. The split, the timing and the proof all live in someone’s head.'),
    h('div', { class: 'before-after', id: 'ba' }, ba('Today', 'One payment, then a chase.', BA_BEFORE, ''), ba('With SplitPot', 'One pot, agreed shares, visible release.', BA_AFTER, '')))));
  const baEls = $$('.ba', main); const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('in')), { threshold: 0.35 }); baEls.forEach((e) => io.observe(e)); cleanups.push(() => io.disconnect());

  // evidence
  main.append(h('section', { class: 'sec sec--paper' }, h('div', { class: 'wrap' },
    h('p', { class: 'sec__kicker' }, 'The evidence we have'),
    h('div', { class: 'stat' }, h('div', { class: 'stat__n', 'aria-label': '51 percent' }, '51', h('sup', {}, '%')),
      h('div', {}, h('p', { class: 'stat__note' }, 'of the 377 creatives in one NECLive survey named payment disputes as a problem they face.'),
        h('p', { class: 'stat__src' }, 'One survey, creatives only. It does not measure the whole market, and we have not tested whether SplitPot would reduce disputes.'))))));

  // how it works
  const steps = [
    ['01', 'Agree the split first', 'Shares add up to exactly 100% before anything can be funded. Each person sees their own share and confirms it.', { funded: false, band: { m1: 'waiting', m2: 'waiting' }, paying: false }],
    ['02', 'The client pays once', 'One payment into the pot. It only counts after the provider’s signed message is checked against the agreed amount.', { funded: true, band: { m1: 'waiting', m2: 'waiting' }, paying: false }],
    ['03', 'Release by milestone', 'When the client approves, or the 72-hour window passes after delivery, each person is paid their share and a receipt is issued.', { funded: true, band: { m1: 'paid', m2: 'waiting' }, paying: false }],
    ['04', 'A dispute freezes one milestone', 'Only the disputed milestone is held. Everything else keeps moving, and there is a written path to settle it.', { funded: true, band: { m1: 'paid', m2: 'frozen' }, paying: false }],
  ];
  const howPotHost = h('div', { class: 'how__pot', 'aria-hidden': 'false' }); const howPot = createPot(howPotHost, { compact: true, label: 'Pot showing the step being described' }); cleanups.push(() => howPot.destroy());
  howPot.update(demoModel({ funded: false, paying: false, band: { m1: 'waiting', m2: 'waiting' } }), { animate: false });
  const stepEls = steps.map(([n, t, p], i) => h('div', { class: `step${i === 0 ? ' is-on' : ''}`, 'data-i': i }, h('div', { class: 'step__n' }, `STEP ${n}`), h('h3', {}, t), h('p', {}, p)));
  main.append(h('section', { class: 'sec', id: 'how' }, h('div', { class: 'wrap' }, h('p', { class: 'sec__kicker' }, 'How it works'), h('h2', {}, 'Four moves. No chasing.'),
    h('div', { class: 'how' }, h('div', { class: 'how__steps' }, ...stepEls), howPotHost),
    h('p', { class: 'hint', style: { marginTop: '16px' } }, 'Illustration, not real data.'))));
  const io2 = new IntersectionObserver((es) => { const vis = es.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]; if (!vis) return; const i = Number(vis.target.dataset.i); stepEls.forEach((el, k) => el.classList.toggle('is-on', k === i)); howPot.update(demoModel(steps[i][3]), { animate: true }); }, { rootMargin: '-40% 0px -40% 0px', threshold: [0, 1] });
  stepEls.forEach((e) => io2.observe(e)); cleanups.push(() => io2.disconnect());

  // features and use cases (descriptions of what the prototype does; examples are illustrations, not customers or statistics)
  const feat = (t, p) => h('div', { class: 'feat' }, h('h3', {}, t), h('p', {}, p));
  main.append(h('section', { class: 'sec', id: 'features' }, h('div', { class: 'wrap' }, h('p', { class: 'sec__kicker' }, 'Features'), h('h2', {}, 'Built for the way creative teams actually work.'),
    h('div', { class: 'featgrid' },
      feat('Agree the split first', 'Percent or naira, with live totals. Nobody can fund until every share is confirmed.'),
      feat('One payment from the client', 'A single checkout. The amount is verified on the server before the pot counts as funded.'),
      feat('Milestone releases', 'Approve, or let the 72-hour window pass. Each person is paid their own share.'),
      feat('Disputes that freeze one milestone', 'Everything else keeps moving while the client and team settle it in writing.'),
      feat('A dashboard across projects', 'Every split you lead or join: what is waiting, frozen or paid, and what needs you.'),
      feat('A ledger you can verify', 'Hash-chained, exportable to CSV, and honest about what is simulated.'))),
    h('div', { class: 'wrap', style: { marginTop: '56px' } }, h('p', { class: 'sec__kicker' }, 'Use cases'), h('h3', { class: 'mini-h', style: { fontSize: '1.6rem' } }, 'Any team that is paid once and shares the money.'),
      h('ul', { class: 'usecases' }, ...[['Video and photo shoots', 'Videographer, photographer, editor, makeup artist and creative director paid from one client invoice.'], ['Music and event production', 'Producers, engineers and performers splitting a booking fee.'], ['Design and software sprints', 'A small studio splitting a project by role and milestone.'], ['Freelance collectives', 'Friends who take jobs together and want the split written down.']].map(([t, p]) => h('li', {}, h('strong', {}, t), h('span', {}, p)))), h('p', { class: 'hint' }, 'Examples of who it is for. They are not customers and not statistics.'))));

  // roles
  const role = (t, who, items) => h('div', { class: 'role' }, h('div', {}, h('p', { class: 'who' }, who), h('h3', {}, t)), h('ul', {}, ...items.map((x) => h('li', {}, x))));
  main.append(h('section', { class: 'sec sec--paper', id: 'roles' }, h('div', { class: 'wrap' }, h('p', { class: 'sec__kicker' }, 'Who sees what'), h('h2', {}, 'Everyone sees what they need. Nothing more.'),
    h('div', { class: 'roles' },
      role('Team lead', 'Creates the pot', ['Sets milestones, written criteria and each person’s share', 'Submits delivery and shares private links', 'Retries any payout that fails']),
      role('Collaborator', 'Gets paid a share', ['Sees their own share, in naira, before and after funding', 'Confirms the share and their bank account', 'Gets a receipt tied to the ledger']),
      role('Client', 'Pays once', ['Funds the pot with one payment', 'Approves a milestone, or opens a dispute citing a written criterion', 'Never needs an account, only a link']),
      role('Public ledger', 'Anyone', ['Shows amounts, states and hashes, never account numbers or private links', 'Says “Chain verified” only if every entry checks out'])))));

  // honesty
  const sim = (t) => h('li', {}, h('span', { class: 'stamp' }, 'Simulated'), h('span', {}, t));
  const real = (t) => h('li', {}, h('span', { class: 'pill pill--paid' }, 'Built'), h('span', {}, t));
  main.append(h('section', { class: 'sec', id: 'honesty' }, h('div', { class: 'wrap' }, h('p', { class: 'sec__kicker' }, 'What is real'), h('h2', {}, 'We label what is pretend.'),
    h('p', { class: 'sec__lead' }, 'No real money moves in this prototype. Holding real funds needs a licensed partner, and we have not engaged one.'),
    h('div', { class: 'honest' },
      h('div', {}, h('h3', {}, 'Built and tested'), h('ul', {}, real('Exact money maths in whole kobo, with no rounding drift'), real('Agreed shares that must total 100%'), real('Funding only after a signed webhook and a server-side amount check'), real('Per-milestone release, 72-hour window and per-milestone dispute freeze'), real('Payouts that cannot pay twice, with safe retry'), real('A hash-chained ledger that detects tampering'))),
      h('div', {}, h('h3', {}, 'Simulated in test mode'), h('ul', {}, sim('Custody of money'), sim('Identity verification'), sim('The dispute reviewer'), sim('Refunds to the client'), sim('Bank transfers and account-name lookup'), h('li', {}, h('span', { class: 'stamp stamp--amber' }, 'Assumption'), h('span', {}, 'The 1.5% fee, charged on top and not refunded')))))))); 

  main.append(h('section', { class: 'stage sec cta-end' }, h('div', { class: 'wrap' }, h('h2', {}, 'Agree it before you build it.'), h('div', { class: 'hero__cta' }, h('a', { class: 'btn btn--amber', href: '/new', 'data-link': '' }, 'Start a Split', icon('arrow')), h('a', { class: 'btn btn--line-dark', href: '/signup', 'data-link': '' }, 'Create an account')))));
  const net2 = mountNetwork($('.cta-end', main), { seed: 29, focus: { x: 0.8, y: 0.4 }, nodes: 20, particles: 5 }); cleanups.push(() => net2.destroy());
  return () => cleanups.forEach((f) => f());
}
