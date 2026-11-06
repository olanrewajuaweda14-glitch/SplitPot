import { h, s, icon, pill, naira, rollNaira, setRoll, fmtDate, act, toast, confirmDialog, statusText } from '../ui.js';
import { api, syncClock } from '../api.js';
import { current } from '../auth.js';
import { subnav, loadInto, head } from './appnav.js';

export const title = 'Dashboard';

const SEG = [['paid', 'Paid out'], ['waiting', 'Waiting for release'], ['frozen', 'Frozen: disputed'], ['unfunded', 'Not funded yet']];

function metric(label, kobo, sub, kind, { count = false } = {}) {
  const v = h('div', { class: 'metric__v num' });
  setRoll(v, count ? String(kobo) : naira(kobo), { animate: true });
  return h('div', { class: `metric metric--${kind}` }, h('div', { class: 'metric__l' }, label), v, sub ? h('div', { class: 'metric__s' }, sub) : null);
}

function barChart(projects) {
  const rows = projects.filter((p) => p.bars.paid + p.bars.waiting + p.bars.frozen + p.bars.unfunded > 0).slice(0, 8);
  if (!rows.length) return h('p', { class: 'hint' }, 'Nothing to chart yet.');
  const W = 560; const L = 150; const rowH = 34; const H = rows.length * rowH + 8;
  const max = Math.max(...rows.map((p) => p.bars.paid + p.bars.waiting + p.bars.frozen + p.bars.unfunded));
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Money by project: ${rows.map((p) => `${p.title}, ${naira(p.bars.paid)} paid, ${naira(p.bars.waiting)} waiting, ${naira(p.bars.frozen)} frozen, ${naira(p.bars.unfunded)} not funded`).join('; ')}` });
  rows.forEach((p, i) => {
    const y = i * rowH + 4; let x = L; const t = p.bars.paid + p.bars.waiting + p.bars.frozen + p.bars.unfunded;
    svg.append(s('text', { x: 0, y: y + 17 }, p.title.length > 20 ? `${p.title.slice(0, 19)}…` : p.title));
    for (const [k] of SEG) { const w = Math.round(((p.bars[k] / max) * (W - L - 88)) * 10) / 10; if (w <= 0) continue; svg.append(s('rect', { class: `seg--${k}`, x, y, width: Math.max(w, 2), height: 22, rx: 2 }, s('title', {}, `${p.title}: ${SEG.find((q) => q[0] === k)[1]} ${naira(p.bars[k])}`))); x += w; }
    svg.append(s('text', { class: 'val', x: x + 6, y: y + 16 }, naira(t)));
  });
  return svg;
}

function donut(pot) {
  const parts = [['paid', 'Paid out', pot.paid], ['waiting', 'Waiting for release', pot.waiting + pot.delivered], ['frozen', 'Frozen: disputed', pot.frozen], ['refunded', 'Refunded (simulated)', pot.refunded]].filter((p) => p[2] > 0);
  const total = parts.reduce((a, p) => a + p[2], 0);
  if (!total) return h('p', { class: 'hint' }, 'The pot chart appears once a client has funded a project.');
  const R = 70; const C = 2 * Math.PI * R; let off = 0;
  const svg = s('svg', { class: 'chart', viewBox: '0 0 180 180', role: 'img', 'aria-label': `Pot composition: ${parts.map((p) => `${p[1]} ${naira(p[2])}`).join(', ')}` });
  svg.append(s('circle', { cx: 90, cy: 90, r: R, fill: 'none', stroke: '#E3EAE6', 'stroke-width': 26 }));
  for (const [k, , v] of parts) { const len = (v / total) * C; svg.append(s('circle', { class: `arc arc--${k}`, cx: 90, cy: 90, r: R, 'stroke-width': 26, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': String(-off), transform: 'rotate(-90 90 90)' }, s('title', {}, `${k}: ${naira(v)}`))); off += len; }
  svg.append(s('text', { x: 90, y: 86, 'text-anchor': 'middle', style: { fontSize: '11px' } }, 'In the pot'), s('text', { class: 'val', x: 90, y: 104, 'text-anchor': 'middle', style: { fontSize: '13px' } }, naira(total)));
  return h('div', { class: 'donutwrap' }, svg, h('ul', { class: 'chart-legend' }, ...parts.map(([k, t, v]) => h('li', {}, h('i', { class: `sw arc-bg--${k}`, 'aria-hidden': 'true' }), `${t}: ${naira(v)}`))));
}

export function mount({ main, config, navigate }) {
  return loadInto(main, () => api('GET', '/api/me/dashboard'), (d, root, reload) => {
    syncClock(d.serverNow); const m = d.metrics;
    const first = d.user.name.split(' ')[0];
    const demoBtn = config.demoMode ? h('button', { class: 'btn btn--line', type: 'button', 'data-add-demo': '' }, 'Add the demo project to my dashboard') : null;
    if (demoBtn) demoBtn.onclick = async () => {
      const r = await act(demoBtn, async () => { const st = await api('POST', '/api/demo/stage', { stage: 'funded' }); const tok = String(st.links.lead).split('/').pop(); return api('POST', '/api/me/claim', { token: tok }); }, { ok: 'Demo project added. It is synthetic data.' });
      if (r) reload();
    };
    const quick = h('div', { class: 'quick' }, h('a', { class: 'btn btn--amber', href: '/new', 'data-link': '' }, 'Create a Split'), h('a', { class: 'btn btn--line', href: '/new?step=people', 'data-link': '' }, 'Invite Collaborators'), h('a', { class: 'btn btn--line', href: '/payouts', 'data-link': '' }, 'View Payments'), h('a', { class: 'btn btn--line', href: '/activity', 'data-link': '' }, 'Open Ledger'), demoBtn);
    root.append(h('div', { class: 'wrap page' }, head('Dashboard', `Hello, ${first}`), subnav('dashboard'), quick));
    const page = root.firstChild;
    if (!d.projects.length) {
      page.append(h('div', { class: 'empty' }, h('h2', {}, 'No splits yet'), h('p', {}, 'Create your first split to agree shares up front, collect one payment and pay everyone from the pot. Or open a link someone sent you and add it to your dashboard.'), h('div', { class: 'btnrow', style: { justifyContent: 'center' } }, h('a', { class: 'btn btn--amber', href: '/new', 'data-link': '' }, 'Create a Split'), h('a', { class: 'btn btn--line', href: '/enter', 'data-link': '' }, 'Open a link I was sent'))));
      return;
    }
    page.append(h('div', { class: 'metrics', 'aria-label': 'Key numbers' },
      metric('Total project value', m.totalValueKobo, `Across ${d.projects.filter((p) => p.role === 'lead').length} split(s) you lead`, 'ink'),
      metric('Active projects', m.activeProjects, 'Funded and in progress', 'paid', { count: true }),
      metric('Pending confirmations', m.pendingConfirmations, 'People who have not confirmed a share', 'waiting', { count: true }),
      metric('Awaiting settlement', m.awaitingSettlementKobo, 'Funded, not yet released', 'waiting'),
      metric('Completed payouts', m.completedPayoutsKobo, 'Sent to bank accounts', 'paid')));
    page.append(h('div', { class: 'dgrid' },
      h('section', { class: 'panel' }, h('h2', {}, 'Money by project'), h('p', { class: 'hint' }, 'Colour and label both say where each naira is.'), barChart(d.projects), h('ul', { class: 'chart-legend' }, ...SEG.map(([k, t]) => h('li', {}, h('i', { class: `sw seg--${k}`, 'aria-hidden': 'true' }), t)))),
      h('section', { class: 'panel' }, h('h2', {}, 'Pot composition'), h('p', { class: 'hint' }, 'All funded projects together.'), donut(d.pot))));
    page.append(h('section', { class: 'panel', style: { marginBottom: '18px' } }, h('h2', {}, 'Your projects'), h('ul', { class: 'plist' }, ...d.projects.map((p) => {
      const t = p.bars.paid + p.bars.waiting + p.bars.frozen + p.bars.unfunded || 1;
      return h('li', { class: 'prow', 'data-project': p.id },
        h('div', {}, h('div', { class: 'prow__t' }, p.title, p.origin === 'seed' ? h('span', { class: 'stamp stamp--amber demo-flag' }, 'Synthetic demo') : null),
          h('div', { class: 'prow__m' }, pill(p.status), h('span', {}, p.role === 'lead' ? 'You lead this' : `Your share ${naira(p.shareKobo ?? 0)}`), h('span', { class: 'num' }, naira(p.totalKobo)), h('span', {}, `${p.confirmedCount}/${p.collaboratorCount} confirmed`)),
          p.attention ? h('div', { class: 'prow__a' }, p.attention) : null),
        h('div', { class: 'btnrow' }, h('a', { class: 'btn btn--line btn--sm', href: p.path, 'data-link': '' }, 'Open'), h('a', { class: 'btn btn--ghost btn--sm', href: p.ledgerPath, 'data-link': '' }, 'Ledger')),
        h('div', { class: 'pbar', role: 'img', 'aria-label': `${naira(p.bars.paid)} paid, ${naira(p.bars.waiting)} waiting, ${naira(p.bars.frozen)} frozen` }, ...SEG.map(([k]) => h('i', { class: `seg--${k}`, style: { width: `${(p.bars[k] / t) * 100}%` } }))));
    }))));
    page.append(h('div', { class: 'dgrid' },
      h('section', { class: 'panel' }, h('h2', {}, 'Recent transactions'), d.recentTransactions.length ? h('div', { class: 'rowtable' }, h('div', { class: 'tbl-scroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...['When', 'What', 'Project', 'Status'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col', class: 'r' }, 'Amount'))), h('tbody', {}, ...d.recentTransactions.map((t) => h('tr', {}, h('td', { 'data-l': 'When' }, fmtDate(t.ts)), h('td', { 'data-l': 'What' }, t.title), h('td', { 'data-l': 'Project' }, t.project), h('td', { 'data-l': 'Status' }, pill(t.status)), h('td', { class: 'r num' }, naira(t.amountKobo)))))))) : h('p', { class: 'hint' }, 'Payments and payouts appear here once a project is funded.')),
      h('section', { class: 'panel' }, h('h2', {}, 'Activity'), h('p', { class: 'hint' }, 'Shown according to your notification filters in Settings.'), d.activity.length ? h('ul', { class: 'feed' }, ...d.activity.slice(0, 8).map((a) => h('li', {}, h('strong', {}, a.title), h('span', {}, a.project), h('small', {}, fmtDate(a.ts))))) : h('p', { class: 'hint' }, 'Nothing yet.'), h('a', { class: 'btn btn--line btn--sm', href: '/activity', 'data-link': '' }, 'See all activity'))));
  });
}
