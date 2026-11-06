import { h, naira, pct, pill, icon, fmtDateLong } from '../ui.js';
import { api, pollView } from '../api.js';
import { ledgerList, verification } from './shared.js';
export const title = 'Public ledger';
export function mount({ main, params }) {
  const [id] = params; let stopped = false; let timer; let sig = '';
  const root = h('div', { class: 'wrap page' }, h('div', { class: 'loader' }, h('span', {}, 'Loading')));
  main.append(root);
  async function load() {
    try {
      const d = await api('GET', `/api/ledger/${encodeURIComponent(id)}`); const k = JSON.stringify(d); if (k === sig) return; sig = k;
      const p = d.project;
      root.replaceChildren(
        h('p', { class: 'sec__kicker' }, 'Public ledger', p.origin === 'seed' ? ' ' : ''), h('h1', { class: 'page-h' }, p.title),
        h('div', { class: 'pmeta', style: { margin: '14px 0 22px' } }, pill(p.status, p.statusLabel), p.origin === 'seed' ? h('span', { class: 'stamp stamp--amber' }, 'Synthetic demo data') : null, d.provider?.isMock ? h('span', { class: 'pill pill--sim' }, 'Test mode') : null),
        verification(d.verification),
        h('p', { class: 'hint', style: { margin: '10px 0 26px', maxWidth: '62ch' } }, 'Each entry stores the hash of the entry before it. Change any past entry and every hash after it stops matching. This page never shows account numbers or private links.'),
        h('div', { class: 'ledger-grid' },
          h('section', { class: 'doc' }, h('div', { class: 'doc__head' }, h('h2', { class: 'doc__title' }, 'The agreement'), h('span', { class: 'doc__sub' }, p.clientName)), h('div', { class: 'doc__body' },
            h('dl', { class: 'kv' }, h('dt', {}, 'Project total'), h('dd', { class: 'num' }, naira(p.totalKobo)), h('dt', {}, `Fee ${pct(p.feeBps)}`), h('dd', { class: 'num' }, naira(p.feeKobo)), h('dt', {}, 'Client pays'), h('dd', { class: 'num' }, naira(p.clientPaysKobo))),
            h('h3', { class: 'mini-h' }, 'Split'), h('ul', { class: 'plain' }, ...p.collaborators.map((c) => h('li', {}, h('strong', {}, c.name), ` (${c.role}) ${pct(c.bps)}`))),
            h('h3', { class: 'mini-h' }, 'Milestones'), h('ul', { class: 'plain' }, ...p.milestones.map((m) => h('li', {}, `${m.title}: ${naira(m.amountKobo)} `, pill(m.frozen ? 'frozen' : m.status)))))),
          h('section', {}, h('h2', { class: 'mini-h' }, `${d.entries.length} entries`), ledgerList(d.entries))));
    } catch (e) { root.replaceChildren(h('h1', {}, 'Ledger not found'), h('p', { style: { margin: '14px 0 22px' } }, e.message), h('a', { class: 'btn', href: '/', 'data-link': '' }, 'Go to the start')); stopped = true; }
  }
  const loop = async () => { if (stopped) return; if (!document.hidden) await load(); timer = setTimeout(loop, 3000); }; loop();
  return () => { stopped = true; clearTimeout(timer); };
}
