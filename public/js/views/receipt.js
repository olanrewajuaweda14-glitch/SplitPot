import { h, naira, icon, fmtDateLong, shortHash } from '../ui.js';
import { api } from '../api.js';
import { staticSvg } from '../ui.js';
export const title = 'Receipt';
export async function mount({ main, params }) {
  const [token, pid] = params;
  const root = h('div', { class: 'wrap page page--narrow' }, h('div', { class: 'loader' }, h('span', {}, 'Loading'))); main.append(root);
  try {
    const r = await api('GET', `/api/p/${encodeURIComponent(token)}/receipts/${encodeURIComponent(pid)}`);
    const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
    root.replaceChildren(
      h('article', { class: 'doc receipt' },
        h('div', { class: 'receipt__stamp', 'aria-hidden': 'true' }, r.simulated ? 'SIMULATED' : 'PAID'),
        h('div', { class: 'doc__head' }, h('div', {}, h('p', { class: 'doc__sub' }, 'Payment receipt'), h('h1', { class: 'doc__title', style: { fontSize: '1.6rem' } }, `No. ${r.receiptNo}`)), h('span', { class: 'doc__sub' }, r.simulated ? 'Test mode. No real money moved.' : r.provider)),
        h('div', { class: 'doc__body' },
          h('p', { class: 'receipt__amt num' }, naira(r.amountKobo)),
          h('dl', { class: 'kv kv--receipt' }, ...row('Paid to', `${r.recipient.name} (${r.recipient.role})`), ...row('Account', `${r.recipient.bankName} ${r.recipient.masked}, ${r.recipient.accountName}`), ...row('Project', r.project.title), ...row('Milestone', r.milestone.title), ...row('Client', r.project.clientName), ...row('Paid at', r.paidAt ? fmtDateLong(r.paidAt) : 'Pending'), ...row('Reference', h('code', {}, r.reference)), ...row('Attempt', String(r.attempt))),
          h('hr', { class: 'rule' }),
          h('p', { class: 'hint' }, 'Ledger proof'),
          h('dl', { class: 'kv kv--receipt' }, ...row('Entry', `#${r.ledger.seq}`), ...row('Entry hash', h('code', { class: 'hashwrap' }, r.ledger.hash)), ...row('Matches chain', r.ledger.matchesChain ? 'Yes' : 'No'), ...row('Whole ledger', r.chain.text))),
        h('div', { class: 'doc__body no-print', style: { borderTop: '1px dashed var(--rule-strong)' } }, h('div', { class: 'btnrow' }, h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, icon('print'), 'Print or save as PDF'), h('a', { class: 'btn btn--line', href: r.ledgerPath, 'data-link': '' }, 'View public ledger')))));
  } catch (e) { root.replaceChildren(h('h1', {}, 'Receipt not available'), h('p', { style: { margin: '14px 0 22px' } }, e.message)); }
}
