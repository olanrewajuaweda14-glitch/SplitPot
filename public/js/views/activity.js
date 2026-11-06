// Cross-project ledger: filter by project, date, type, status. Timeline or table. CSV export of exactly what is shown.
import { h, pill, naira, fmtDate, toast, shortHash, session } from '../ui.js';
import { api } from '../api.js';
import { subnav, loadInto, head } from './appnav.js';

export const title = 'Activity and ledger';
const STATUS = [['', 'All statuses'], ['success', 'Succeeded'], ['failed', 'Failed or rejected'], ['recorded', 'Recorded']];

/** Spreadsheet apps run text that starts with = + - @ as a formula. Defuse it. */
export const csvCell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export const toCsv = (rows) => ['Project,Entry number,Time (Africa/Lagos),Type,Category,Status,Title,Detail,Amount (NGN),Hash'].concat(rows.map((r) => [r.project, r.seq, new Date(r.ts).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false }), r.type, r.category, r.status, r.title, r.detail, r.amountKobo == null ? '' : (r.amountKobo / 100).toFixed(2), r.hash].map(csvCell).join(','))).join('\r\n');

export function mount({ main }) {
  return loadInto(main, () => api('GET', '/api/me/ledger'), (d, root) => {
    const page = h('div', { class: 'wrap page' }); root.append(page);
    page.append(head('Activity', 'Your ledger, all projects'), subnav('activity'));
    if (!d.rows.length) { page.append(h('div', { class: 'empty' }, h('h2', {}, 'Nothing recorded yet'), h('p', {}, 'Every move in your projects is written here: agreements, confirmations, payments, approvals, disputes and payouts.'), h('a', { class: 'btn btn--amber', href: '/new', 'data-link': '' }, 'Create a Split'))); return; }
    const projects = [...new Map(d.rows.map((r) => [r.projectId, r.project])).entries()]; const cats = [...new Set(d.rows.map((r) => r.category))].sort();
    const pr = h('select', { class: 'select', id: 'af-pr' }, h('option', { value: '' }, 'All projects'), ...projects.map(([id, t]) => h('option', { value: id }, t)));
    const ty = h('select', { class: 'select', id: 'af-ty' }, h('option', { value: '' }, 'All types'), ...cats.map((c) => h('option', { value: c }, c)));
    const stt = h('select', { class: 'select', id: 'af-st' }, ...STATUS.map(([v, t]) => h('option', { value: v }, t)));
    const from = h('input', { class: 'input', id: 'af-from', type: 'date', 'aria-label': 'From date' }); const to = h('input', { class: 'input', id: 'af-to', type: 'date', 'aria-label': 'To date' });
    const out = h('div', {}); const count = h('p', { class: 'hint', role: 'status' }); let mode = session.get('sp-act-mode') === 'table' ? 'table' : 'timeline'; let shown = [];
    const lagos = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(ms));
    const tabs = ['timeline', 'table'].map((k) => h('button', { type: 'button', 'aria-pressed': String(mode === k), onclick: () => { mode = k; session.set('sp-act-mode', k); tabs.forEach((b, i) => b.setAttribute('aria-pressed', String(['timeline', 'table'][i] === mode))); draw(); } }, k === 'timeline' ? 'Timeline' : 'Table'));
    const draw = () => {
      shown = d.rows.filter((r) => (!pr.value || r.projectId === pr.value) && (!ty.value || r.category === ty.value) && (!stt.value || r.status === stt.value) && (!from.value || lagos(r.ts) >= from.value) && (!to.value || lagos(r.ts) <= to.value));
      count.textContent = `${shown.length} of ${d.rows.length} entries shown`;
      if (!shown.length) { out.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'No entries match these filters.'), h('button', { class: 'btn btn--line btn--sm', type: 'button', onclick: reset }, 'Clear filters'))); return; }
      const rows = shown.slice(0, 300);
      out.replaceChildren(mode === 'timeline'
        ? h('ol', { class: 'ledger-list' }, ...rows.map((r) => h('li', { class: 'lentry' }, h('div', { class: 'lentry__n num' }, `#${r.seq}`), h('div', { class: 'lentry__b' }, h('div', { class: 'lentry__t' }, r.title, ' ', pill(r.status === 'success' ? 'success' : r.status === 'failed' ? 'failed' : 'neutral', r.status === 'success' ? 'Succeeded' : r.status === 'failed' ? 'Failed' : 'Recorded')), r.detail ? h('div', { class: 'lentry__d' }, r.detail) : null, h('div', { class: 'lentry__m' }, h('span', {}, r.project), h('span', {}, r.category), h('time', { datetime: new Date(r.ts).toISOString() }, fmtDate(r.ts)), h('code', { title: `Full hash: ${r.hash}` }, shortHash(r.hash)))))))
        : h('div', { class: 'rowtable doc doc--flush' }, h('div', { class: 'tbl-scroll' }, h('table', { class: 'tbl tbl--tight' }, h('caption', { class: 'vh' }, 'Ledger entries across your projects'), h('thead', {}, h('tr', {}, ...['#', 'When', 'Project', 'Type', 'What happened', 'Status'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col', class: 'r' }, 'Amount'))), h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', { class: 'num', 'data-l': 'Entry' }, `#${r.seq}`), h('td', { 'data-l': 'When' }, fmtDate(r.ts)), h('td', { 'data-l': 'Project' }, r.project), h('td', { 'data-l': 'Type' }, r.category), h('td', {}, h('strong', {}, r.title), r.detail ? h('div', { class: 'hint' }, r.detail) : null), h('td', { 'data-l': 'Status' }, r.status), h('td', { class: 'r num' }, r.amountKobo == null ? '' : naira(r.amountKobo)))))))),
        shown.length > rows.length ? h('p', { class: 'hint' }, `Showing the newest ${rows.length}. Narrow the filters to see older entries. Export includes all ${shown.length}.`) : null);
    };
    const reset = () => { pr.value = ''; ty.value = ''; stt.value = ''; from.value = ''; to.value = ''; draw(); };
    for (const el of [pr, ty, stt, from, to]) el.addEventListener('change', draw);
    const exp = h('button', { class: 'btn btn--line btn--sm', type: 'button', 'data-export': '' }, 'Export CSV');
    exp.onclick = () => {
      if (!shown.length) { toast('Nothing to export with these filters.', 'err'); return; }
      const blob = new Blob(['﻿', toCsv(shown)], { type: 'text/csv;charset=utf-8' }); const a = h('a', { href: URL.createObjectURL(blob), download: `splitpot-ledger-${lagos(Date.now())}.csv` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500); toast(`Exported ${shown.length} entries`, 'ok');
    };
    page.append(h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', { for: 'af-pr' }, 'Project'), pr), h('div', { class: 'field' }, h('label', { for: 'af-ty' }, 'Type'), ty), h('div', { class: 'field' }, h('label', { for: 'af-st' }, 'Status'), stt), h('div', { class: 'field' }, h('label', { for: 'af-from' }, 'From'), from), h('div', { class: 'field' }, h('label', { for: 'af-to' }, 'To'), to)),
      h('div', { class: 'toolbar' }, count, h('div', { class: 'btnrow' }, h('div', { class: 'seg-tabs', role: 'group', 'aria-label': 'View' }, ...tabs), h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: reset }, 'Clear filters'), exp)), out,
      h('p', { class: 'hint' }, 'Entries are the same hash-chained records each project shows publicly. This view is only a convenient list of them. Notification filters in Settings never hide ledger entries.'));
    draw();
  });
}
