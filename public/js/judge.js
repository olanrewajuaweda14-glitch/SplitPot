import { h, act, toast, icon, session } from './ui.js';
import { api, nudge } from './api.js';
export function mountJudge({ navigate }) {
  const host = document.getElementById('judge'); if (!host) return;
  const open = session.get('sp-judge') === '1';
  const panel = h('div', { class: 'judge__panel', hidden: !open });
  const toggle = h('button', { class: 'judge__toggle', type: 'button', 'aria-expanded': String(open), onclick: () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); session.set('sp-judge', panel.hidden ? '0' : '1'); } }, 'Judge Mode');
  const run = (label, fn, ok) => { const b = h('button', { class: 'btn btn--line-dark btn--sm', type: 'button' }, label); b.onclick = async () => { if (await act(b, fn, { ok })) nudge(); }; return b; };
  const stageBtn = (label, st, role) => { const b = h('button', { class: 'btn btn--line-dark btn--sm', type: 'button' }, label); b.onclick = async () => { const r = await act(b, () => api('POST', '/api/demo/stage', { stage: st })); if (r) navigate(r.links[role] ?? r.links.lead); }; return b; };
  panel.append(h('p', { class: 'judge__t' }, 'Judge Mode ', h('span', { class: 'stamp' }, 'Demo')), h('p', { class: 'hint' }, 'Real engine commands on SYNTHETIC DEMO DATA.'),
    h('div', { class: 'judge__g' }, stageBtn('Fund it', 'funded', 'client'), stageBtn('Delivered', 'delivered', 'client'), stageBtn('Dispute', 'disputed', 'lead'), stageBtn('Reset', 'created', 'lead')),
    h('div', { class: 'judge__g' }, run('+72 hours', () => api('POST', '/api/demo/fast-forward', { hours: 72 }), 'Demo clock moved forward 72 hours'), run('Next payout fails', () => api('POST', '/api/demo/failing-account', {}), 'The next payout will fail once, so you can retry it'), run('Tamper ledger', () => api('POST', '/api/demo/tamper', {}), 'Ledger entry altered'), run('Restore ledger', () => api('POST', '/api/demo/restore', {}), 'Ledger restored')));
  host.append(toggle, panel);
}
