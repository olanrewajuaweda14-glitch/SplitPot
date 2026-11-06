import { h, icon, pill, naira, fmtDate, act, toast, confirmDialog } from '../ui.js';
import { api } from '../api.js';
import { subnav, loadInto, head } from './appnav.js';

export const title = 'Payout centre';
const STATUSES = [['', 'All statuses'], ['success', 'Paid'], ['queued', 'Queued'], ['processing', 'Sending'], ['failed', 'Failed'], ['unknown', 'Result unknown'], ['reversed', 'Reversed']];

export function mount({ main }) {
  return loadInto(main, () => api('GET', '/api/me/payouts'), (d, root, reload) => {
    const page = h('div', { class: 'wrap page' }); root.append(page);
    page.append(head('Payout centre', 'Every payout, one list'), subnav('payouts'));
    if (!d.rows.length) { page.append(h('div', { class: 'empty' }, h('h2', {}, 'No payouts yet'), h('p', {}, 'Payouts appear here after a client funds a project and a milestone is approved or released. Retry controls show up if one fails.'), h('a', { class: 'btn btn--line', href: '/dashboard', 'data-link': '' }, 'Back to dashboard'))); return; }
    const st = h('select', { class: 'select', id: 'pf-st' }, ...STATUSES.map(([v, t]) => h('option', { value: v }, t)));
    const projects = [...new Map(d.rows.map((r) => [r.projectId, r.project])).entries()];
    const pr = h('select', { class: 'select', id: 'pf-pr' }, h('option', { value: '' }, 'All projects'), ...projects.map(([id, t]) => h('option', { value: id }, t)));
    const sum = h('div', { class: 'metrics', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' } }); const list = h('div', {}); const count = h('p', { class: 'hint', role: 'status' });
    const draw = () => {
      const rows = d.rows.filter((r) => (!st.value || r.status === st.value) && (!pr.value || r.projectId === pr.value));
      const paid = rows.filter((r) => r.status === 'success').reduce((a, r) => a + r.amountKobo, 0); const pend = rows.filter((r) => ['queued', 'processing'].includes(r.status)).reduce((a, r) => a + r.amountKobo, 0); const bad = rows.filter((r) => ['failed', 'unknown', 'reversed'].includes(r.status));
      sum.replaceChildren(...[['Paid', naira(paid), 'paid'], ['In progress', naira(pend), 'waiting'], ['Need attention', `${bad.length} (${naira(bad.reduce((a, r) => a + r.amountKobo, 0))})`, 'frozen']].map(([l, v, k]) => h('div', { class: `metric metric--${k}` }, h('div', { class: 'metric__l' }, l), h('div', { class: 'metric__v num' }, v))));
      count.textContent = `${rows.length} payout${rows.length === 1 ? '' : 's'} shown`;
      if (!rows.length) { list.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'No payouts match these filters.'))); return; }
      list.replaceChildren(h('div', { class: 'rowtable doc doc--flush' }, h('div', { class: 'tbl-scroll' }, h('table', { class: 'tbl' }, h('caption', { class: 'vh' }, 'Payouts'), h('thead', {}, h('tr', {}, ...['When', 'Recipient', 'Project and milestone', 'Method', 'Status'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col', class: 'r' }, 'Amount'), h('th', { scope: 'col' }, 'Actions'))),
        h('tbody', {}, ...rows.map((r) => {
          const retry = r.canRetry ? h('button', { class: 'btn btn--line btn--sm', type: 'button' }, icon('retry'), 'Retry') : null;
          if (retry) retry.onclick = async () => { const ok = await confirmDialog({ title: 'Retry this payout?', body: `Send ${naira(r.amountKobo)} to ${r.recipient} again. A payout that already succeeded is never sent twice.`, confirmLabel: 'Retry payout' }); if (!ok) return; const x = await act(retry, () => api('POST', `/api/p/${r.projectPath.split('/').pop()}/payouts/${r.id}/retry`), { ok: 'Retry started' }); if (x) setTimeout(reload, 600); };
          return h('tr', {}, h('td', { 'data-l': 'When' }, fmtDate(r.ts)), h('td', { 'data-l': 'Recipient' }, h('strong', {}, r.recipient), h('div', { class: 'hint' }, r.role)), h('td', { 'data-l': 'Project' }, r.project, h('div', { class: 'hint' }, r.milestone), r.simulated ? h('span', { class: 'stamp stamp--amber' }, 'Synthetic') : null), h('td', { 'data-l': 'Method' }, r.method), h('td', { 'data-l': 'Status' }, pill(r.status), r.failureReason ? h('div', { class: 'hint' }, r.failureReason) : null), h('td', { class: 'r num' }, naira(r.amountKobo)), h('td', {}, h('div', { class: 'btnrow' }, retry, r.receiptPath ? h('a', { class: 'btn btn--line btn--sm', href: r.receiptPath, 'data-link': '' }, 'Receipt') : null, h('a', { class: 'btn btn--ghost btn--sm', href: r.projectPath, 'data-link': '' }, 'Project'))));
        }))))));
    };
    st.onchange = draw; pr.onchange = draw;
    page.append(h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', { for: 'pf-pr' }, 'Project'), pr), h('div', { class: 'field' }, h('label', { for: 'pf-st' }, 'Status'), st)), sum, count, list, d.simulated ? h('p', { class: 'hint', style: { marginTop: '14px' } }, 'Test mode: payouts are simulated and no real money moves.') : null);
    draw();
  });
}
