import { h, icon, pill, naira, pct, fmtDate, setRoll, rollNaira, copyButton, abs, act, toast, potFlip, confirmDialog, $ } from '../ui.js';
import { current } from '../auth.js';
import { api, pollView, nudge, ApiError } from '../api.js';
import { mountNetwork } from '../bg.js';
import { createPot } from '../pot.js';
import { ledgerList, verification, makeClock } from './shared.js';
import { parsePercentToBps } from '/shared/money.js';

export const title = 'Project';
const ROLE = { lead: 'Team lead', collab: 'Collaborator', client: 'Client', reviewer: 'Reviewer (simulated)' };
const KIND = { release: 'Release the full amount to the team', refund: 'Refund the full amount to the client (simulated)', split: 'Split: part to the team, rest refunded (simulated)', fix: 'Fix and resubmit' };

export function mount({ main, params, config, navigate }) {
  const [rolePath, token] = params;
  const api_ = (m, p, b) => api(m, `/api/p/${token}${p}`, b);
  const clock = makeClock(); let poller; let pot; let view = null; let sig = ''; let pending = false;
  const stage = h('section', { class: 'stage pstage' }); const net = mountNetwork(stage, { seed: 5, focus: { x: 0.78, y: 0.5 }, nodes: 22, particles: 6 });
  const head = h('div', { class: 'pstage__head' }); const potHost = h('div', { class: 'potwrap potwrap--app', 'data-pot': '' });
  stage.append(h('div', { class: 'wrap pstage__grid' }, head, potHost));
  const body = h('div', { class: 'wrap pbody' });
  main.append(stage, body);
  pot = createPot(potHost, { label: 'Payment pot' }); let amount;

  const clientView = () => view.role === 'client';
  const isLead = () => view.role === 'lead';

  function renderHead(v) {
    const p = v.project; const me = v.me && p.collaborators.find((c) => c.id === v.me.collaboratorId);
    const big = v.role === 'client' ? p.clientPaysKobo : p.totalKobo;
    if (!amount) { amount = h('div', { class: 'bignum' }); }
    head.replaceChildren(
      h('p', { class: 'eyebrow' }, ROLE[rolePath === 'collab' ? 'collab' : v.role === 'collaborator' ? 'collab' : v.role] ?? v.role, me ? `: ${me.name}` : ''),
      h('h1', { class: 'ptitle' }, p.title),
      h('div', { class: 'pmeta' }, pill(p.status, p.statusLabel), p.origin === 'seed' ? h('span', { class: 'stamp stamp--amber' }, 'Synthetic demo data') : null, v.provider?.isMock ? h('span', { class: 'pill pill--sim' }, 'Test mode') : null),
      h('p', { class: 'hint pmeta__client' }, `Client: ${p.clientName}`),
      h('div', { class: 'bignum__wrap' }, h('span', { class: 'bignum__l' }, v.role === 'client' ? 'You pay once' : 'Project total'), amount),
      h('p', { class: 'next', role: 'status' }, h('span', { class: 'next__k' }, 'Next'), nextStep(v)),
      h('ul', { class: 'legend', 'aria-label': 'Colour key, always paired with words' }, ...[['waiting', 'Waiting'], ['paid', 'Paid'], ['frozen', 'Frozen: disputed']].map(([k, t]) => h('li', {}, h('i', { class: `sw sw--${k}`, 'aria-hidden': 'true' }), t))));
    rollNaira(amount, big, { animate: true });
  }

  function nextStep(v) {
    const p = v.project; const role = v.role; const f = p.funding; const frozen = p.milestones.find((m) => m.frozen);
    const open = p.milestones.find((m) => m.status !== 'closed');
    if (p.status === 'completed') return 'Every milestone is settled. The ledger is final.';
    if (p.status === 'awaiting_confirmations') return role === 'collaborator' ? (p.collaborators.find((c) => c.id === v.me.collaboratorId)?.confirmed ? 'Your share is confirmed. Waiting for the others.' : 'Check your share, add your bank account and confirm.') : `${p.confirmedCount} of ${p.collaboratorCount} people have confirmed their share.`;
    if (p.status === 'awaiting_funding') return role === 'client' ? `Pay ${naira(p.clientPaysKobo)} once to fund the pot. Nothing is released until you approve.` : 'Everyone confirmed. Waiting for the client to pay.';
    if (frozen) return role === 'reviewer' ? 'A disputed milestone is waiting on a decision after the negotiation.' : `${frozen.title} is frozen. Other milestones keep moving.`;
    if (open?.status === 'delivered') return role === 'client' ? `Review ${open.title}. Approve it, or it releases on its own when the 72 hours end.` : `${open.title} is with the client for review.`;
    if (open) return role === 'lead' ? `Deliver ${open.title} to start the client's 72-hour review.` : `Waiting for ${open.title} to be delivered.`;
    return 'All milestones are closed. Payouts are being finished.';
  }

  const section = (t, sub, ...kids) => h('section', { class: 'psec' }, h('div', { class: 'psec__h' }, h('h2', {}, t), sub ? h('p', { class: 'hint' }, sub) : null), ...kids);

  // ---------- confirm / funding panels
  function confirmPanel(v) {
    const p = v.project; const me = p.collaborators.find((c) => c.id === v.me.collaboratorId);
    if (me.confirmed) return section('Your share', null, h('div', { class: 'doc' }, h('div', { class: 'doc__body' }, h('p', {}, h('strong', {}, `${pct(me.bps)} = ${naira(me.plannedKobo)}`), ' confirmed.'), me.bank ? h('p', { class: 'hint' }, `Paid to ${me.bank.bankName} ${me.bank.masked}, ${me.bank.accountName}. Locked once confirmed.`) : null)));
    const bank = h('select', { class: 'select', id: 'bk', 'aria-describedby': 'bk-h' }, h('option', { value: '' }, 'Choose your bank'), ...config.banks.map((b) => h('option', { value: b.code }, b.name)));
    const acct = h('input', { class: 'input input--num', id: 'ac', inputmode: 'numeric', maxlength: 10, autocomplete: 'off', placeholder: '10 digits' });
    const resolved = h('p', { class: 'resolved', role: 'status' }); const accept = h('input', { type: 'checkbox', id: 'acc' });
    const check = h('button', { class: 'btn btn--line btn--sm', type: 'button' }, 'Check the account name');
    const go = h('button', { class: 'btn btn--amber', type: 'submit' }, 'Confirm my share');
    check.onclick = async () => { const r = await act(check, () => api_('POST', '/resolve-account', { bankCode: bank.value, accountNumber: acct.value.trim() })); if (r) resolved.replaceChildren(icon('check'), ` ${r.accountName}, ${r.bankName} ${r.masked}`); };
    const saved = current()?.defaultBank; const useSaved = saved ? h('input', { type: 'checkbox', id: 'use-saved', 'data-use-saved': '' }) : null;
    const typed = h('div', {}, h('div', { class: 'grid2', style: { marginTop: '18px' } }, h('div', { class: 'field' }, h('label', { for: 'bk' }, 'Bank'), bank, h('p', { class: 'hint', id: 'bk-h' }, 'Test mode: banks and names are simulated.')), h('div', { class: 'field' }, h('label', { for: 'ac' }, 'Account number'), acct)), h('div', { class: 'btnrow' }, check), resolved);
    if (useSaved) useSaved.onchange = () => { typed.hidden = useSaved.checked; };
    const f = h('form', { class: 'doc', novalidate: true, onsubmit: async (e) => { e.preventDefault(); const body = useSaved?.checked ? { accept: accept.checked, useSavedAccount: true } : { accept: accept.checked, bankCode: bank.value, accountNumber: acct.value.trim() }; const r = await act(go, () => api_('POST', '/confirm', body), { ok: 'Share confirmed' }); if (r) nudge(); } },
      h('div', { class: 'doc__body' }, h('p', { class: 'share-big' }, h('span', {}, `${pct(me.bps)} of the project`), h('strong', { class: 'num' }, naira(me.plannedKobo))), h('p', { class: 'hint' }, 'This is what you are paid across all milestones, before any dispute outcome.'),
        useSaved ? h('label', { class: 'check', for: 'use-saved', style: { marginTop: '16px' } }, useSaved, h('span', {}, `Use my saved account: ${saved.bankName} ${saved.masked}, ${saved.accountName}`)) : (current() ? null : h('p', { class: 'hint', style: { marginTop: '12px' } }, h('a', { href: `/login?next=${encodeURIComponent(location.pathname)}`, 'data-link': '' }, 'Log in'), ' to use a saved payout account.')), typed,
        h('label', { class: 'check', for: 'acc', style: { margin: '16px 0' } }, accept, h('span', {}, `I accept ${pct(me.bps)} as my share and understand it cannot be changed after confirming.`)), go));
    const reason = h('textarea', { class: 'textarea', id: 'dec-r', placeholder: 'Why? At least 5 characters. The team lead will see this.' }); const decide = h('button', { class: 'btn btn--line', type: 'submit' }, 'Decline this share');
    const dform = h('form', { class: 'mform', hidden: true, novalidate: true, onsubmit: async (e) => { e.preventDefault(); if (reason.value.trim().length < 5) { toast('Give a reason of at least 5 characters.', 'err'); reason.focus(); return; } if (!(await confirmDialog({ title: 'Decline this share?', body: 'The team lead is told, and funding stays locked. You can still accept later.', confirmLabel: 'Decline', tone: 'frozen' }))) return; const r = await act(decide, () => api_('POST', '/decline', { reason: reason.value }), { ok: 'Declined. The lead can see your reason.' }); if (r) nudge(); } }, h('div', { class: 'field' }, h('label', { for: 'dec-r' }, 'Reason for declining'), reason), decide);
    const dtoggle = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-expanded': 'false', 'data-decline-toggle': '', onclick: () => { dform.hidden = !dform.hidden; dtoggle.setAttribute('aria-expanded', String(!dform.hidden)); } }, 'I do not agree with this share');
    return section('Confirm your share', me.invitation === 'declined' ? `You declined: “${me.declineReason ?? ''}”. You can still accept below.` : 'Nothing can be funded until everyone confirms.', f, p.status === 'awaiting_confirmations' ? h('div', {}, dtoggle, dform) : null);
  }

  function fundingPanel(v) {
    const p = v.project; const f = p.funding;
    if (p.status === 'awaiting_confirmations' && v.role === 'client') return section('Waiting for the team', null, h('div', { class: 'doc' }, h('div', { class: 'doc__body' }, h('p', {}, `${p.confirmedCount} of ${p.collaboratorCount} people have confirmed their share. You can pay once all of them have.`))));
    if (v.role !== 'client' || f.status === 'funded' || p.status !== 'awaiting_funding') return null;
    const pay = h('button', { class: 'btn btn--amber btn--block', type: 'button' }, `Pay ${naira(p.clientPaysKobo)} (simulated checkout)`);
    pay.onclick = async () => { const r = await act(pay, () => api_('POST', '/fund')); if (r?.authorizationUrl) { const u = new URL(r.authorizationUrl, location.origin); navigate(`${u.pathname}?return=${encodeURIComponent(`/p/client/${token}`)}`); } };
    return section('Fund the pot', 'One payment. It is held in the pot and released milestone by milestone.', h('div', { class: 'doc' }, h('div', { class: 'doc__body' },
      h('dl', { class: 'kv' }, h('dt', {}, 'Project'), h('dd', { class: 'num' }, naira(p.totalKobo)), h('dt', {}, `Platform fee ${pct(p.feeBps)}`), h('dd', { class: 'num' }, naira(p.feeKobo)), h('dt', {}, h('strong', {}, 'You pay')), h('dd', { class: 'num' }, h('strong', {}, naira(p.clientPaysKobo)))),
      h('p', { class: 'hint' }, 'The fee rate is a prototype assumption. It is charged on top and is not refunded.'), f.lastRejection ? h('p', { class: 'err' }, f.lastRejection.reason ?? 'The last payment did not match the agreed amount, so it was not counted.') : null, pay)));
  }

  function leadStatus(v) {
    const p = v.project; if (v.role !== 'lead' || p.funding.status === 'funded') return null;
    const rows = p.collaborators.map((c) => h('div', { class: 'copyrow', 'data-collab': c.id }, h('div', {}, h('div', { class: 'copyrow__who' }, c.name, ' ', pill(c.confirmed ? 'confirmed' : (c.invitation ?? 'invited'))), h('div', { class: 'hint' }, `${c.role}, ${pct(c.bps)}`), c.invitation === 'declined' && c.declineReason ? h('div', { class: 'err' }, `Declined: ${c.declineReason}`) : null), c.confirmed || c.id === 'c1' ? null : copyButton(() => abs(v.links.collaborators.find((x) => x.id === c.id).path), 'Copy their link')));
    return section(p.status === 'awaiting_confirmations' ? 'Waiting on confirmations' : 'Split and confirmations', `${p.confirmedCount} of ${p.collaboratorCount} confirmed`, h('div', { class: 'doc' }, h('div', { class: 'doc__body' }, ...rows)), reviseForm(v));
  }

  function reviseForm(v) {
    const p = v.project; const ins = p.collaborators.map((c) => h('input', { class: 'input input--num', id: `rv-${c.id}`, inputmode: 'decimal', value: String(c.bps / 100), 'aria-label': `New share for ${c.name}, in percent` }));
    const total = h('p', { class: 'hint', role: 'status' }); const go = h('button', { class: 'btn btn--amber btn--sm', type: 'submit' }, 'Send the revised split');
    const calc = () => { const b = ins.map((i) => parsePercentToBps(i.value)); const sum = b.reduce((a, x) => a + (x ?? 0), 0); const changed = b.some((x, i) => x !== p.collaborators[i].bps); total.textContent = `Total ${pct(sum)}${sum === 10000 ? '. Ready.' : sum > 10000 ? `: ${pct(sum - 10000)} over` : `: ${pct(10000 - sum)} still to give out`}`; go.disabled = !(sum === 10000 && b.every((x) => x) && changed); };
    ins.forEach((i) => i.addEventListener('input', calc));
    const form = h('form', { class: 'mform', hidden: true, novalidate: true, onsubmit: async (e) => { e.preventDefault(); const list = p.collaborators.map((c, i) => ({ id: c.id, bps: parsePercentToBps(ins[i].value) })); const changed = list.filter((x, i) => x.bps !== p.collaborators[i].bps).map((x) => p.collaborators.find((c) => c.id === x.id).name);
      if (!(await confirmDialog({ title: 'Send a revised split?', body: `${changed.join(', ')} will have to confirm again. Everyone else keeps their confirmation. Any payment started under the old split will not count.`, confirmLabel: 'Send revised split' }))) return;
      const r = await act(go, () => api_('POST', '/revise-split', { collaborators: list }), { ok: 'Split revised. Changed shares need re-confirming.' }); if (r) nudge(); } },
      h('h4', {}, 'Revise the split'), h('p', { class: 'hint' }, 'Only people whose share changes need to confirm again.'), ...p.collaborators.map((c, i) => h('div', { class: 'field' }, h('label', { for: ins[i].id }, `${c.name} (${c.role}), percent`), ins[i])), total, go);
    const t = h('button', { class: 'btn btn--line btn--sm', type: 'button', 'aria-expanded': 'false', 'data-revise-toggle': '', onclick: () => { form.hidden = !form.hidden; t.setAttribute('aria-expanded', String(!form.hidden)); } }, 'Revise the split'); calc();
    return h('div', {}, t, form);
  }

  function accountPanel(v) {
    if (!['lead', 'collaborator'].includes(v.role)) return null;
    const u = current();
    if (!u) return section('Your dashboard', null, h('div', { class: 'doc' }, h('div', { class: 'doc__body' }, h('p', {}, 'Log in to keep this project on your dashboard, with every split you lead or take part in in one place.'), h('div', { class: 'btnrow' }, h('a', { class: 'btn btn--line btn--sm', href: `/login?next=${encodeURIComponent(location.pathname)}`, 'data-link': '' }, 'Log in to add it'), h('a', { class: 'btn btn--ghost btn--sm', href: `/signup?next=${encodeURIComponent(location.pathname)}`, 'data-link': '' }, 'Create an account')))));
    const b = h('button', { class: 'btn btn--line btn--sm', type: 'button', 'data-claim': '' }, 'Add to my dashboard');
    b.onclick = async () => { const r = await act(b, () => api('POST', '/api/me/claim', { token })); if (r) { toast(r.added ? 'Added to your dashboard' : 'Already on your dashboard', 'ok'); b.textContent = 'On your dashboard'; b.disabled = true; } };
    return section('Your dashboard', null, h('div', { class: 'doc' }, h('div', { class: 'doc__body' }, h('p', {}, `Signed in as ${u.name}.`), h('div', { class: 'btnrow' }, b, h('a', { class: 'btn btn--ghost btn--sm', href: '/dashboard', 'data-link': '' }, 'Open dashboard')))));
  }

  // ---------- split sheet
  function splitSheet(v) {
    const p = v.project; const mine = v.me?.collaboratorId;
    const rows = p.collaborators.map((c) => h('tr', { class: c.id === mine ? 'is-me' : '' }, h('td', {}, h('strong', {}, c.name), c.id === mine ? ' (you)' : '', h('div', { class: 'hint' }, c.role)), h('td', { class: 'r' }, pct(c.bps)), ...p.milestones.map((m) => h('td', { class: 'r num' }, naira(m.plannedAllocation.find((a) => a.collaboratorId === c.id).amountKobo))), h('td', { class: 'r num' }, h('strong', {}, naira(c.plannedKobo))), h('td', {}, pill(c.confirmed ? 'confirmed' : 'unconfirmed'))));
    const foot = h('tr', {}, h('td', {}, 'Total'), h('td', { class: 'r' }, pct(p.collaborators.reduce((a, c) => a + c.bps, 0))), ...p.milestones.map((m) => h('td', { class: 'r num' }, naira(m.amountKobo))), h('td', { class: 'r num' }, naira(p.totalKobo)), h('td', {}));
    return section('The split sheet', 'Agreed up front. Every payout comes from this sheet.', h('div', { class: 'doc doc--flush' }, h('div', { class: 'tbl-scroll' }, h('table', { class: 'tbl' }, h('caption', { class: 'vh' }, 'Agreed split by person and milestone'), h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Person'), h('th', { scope: 'col', class: 'r' }, 'Share'), ...p.milestones.map((m) => h('th', { scope: 'col', class: 'r' }, m.title)), h('th', { scope: 'col', class: 'r' }, 'Total'), h('th', { scope: 'col' }, 'Status'))), h('tbody', {}, ...rows), h('tfoot', {}, foot)))));
  }

  // ---------- milestones
  function milestoneCard(v, m) {
    const p = v.project; const funded = p.funding.status === 'funded';
    const pos = p.payouts.filter((x) => x.milestoneId === m.id);
    const statusKey = m.frozen ? 'frozen' : m.status;
    const card = h('article', { class: `mcard mcard--${m.frozen ? 'frozen' : m.status}` },
      h('header', { class: 'mcard__h' }, h('div', {}, h('p', { class: 'mcard__n' }, `Milestone ${m.idx}`), h('h3', {}, m.title)), h('div', { class: 'mcard__r' }, h('strong', { class: 'num mcard__amt' }, naira(m.amountKobo)), pill(statusKey))),
      h('ul', { class: 'crit' }, ...m.criteria.map((c, i) => h('li', {}, h('span', { class: 'crit__i' }, String(i + 1)), c))));
    if (m.delivery && m.status === 'delivered') {
      card.append(h('div', { class: 'delivery' }, h('p', {}, h('strong', {}, `Delivery ${m.delivery.number}`), ` submitted ${fmtDate(m.delivery.submittedAt)}`), h('p', {}, h('a', { href: m.delivery.link, target: '_blank', rel: 'noopener noreferrer' }, m.delivery.link)), h('p', { class: 'hint' }, m.delivery.note),
        !m.frozen ? h('p', { class: 'review' }, icon('clock'), ' Review window ends in ', clock.span(m.delivery.reviewDeadline, 'now. Releasing.')) : null));
    }
    if (m.resolution) card.append(h('p', { class: 'resolution' }, m.resolution === 'released' ? 'Released to the team.' : m.resolution === 'refunded' ? `Refunded to the client (simulated): ${naira(m.refundKobo)}.` : `Split: ${naira(m.payoutAllocation?.reduce?.((a, x) => a + x.amountKobo, 0) ?? 0)} released, ${naira(m.refundKobo)} refunded (simulated).`));
    if (m.dispute && (m.frozen || m.dispute.status !== 'resolved')) card.append(disputePanel(v, m));
    // actions
    if (isLead() && funded && m.status === 'pending') card.append(deliverForm(m));
    if (clientView() && m.status === 'delivered' && !m.frozen) card.append(clientActions(v, m));
    if (v.role === 'reviewer' && m.dispute?.status === 'in_review') card.append(reviewForm(m));
    if (pos.length) card.append(payoutTable(v, m, pos));
    return card;
  }

  const deliverForm = (m) => { const link = h('input', { class: 'input', id: `dl${m.id}`, type: 'url', placeholder: 'https://…', autocomplete: 'off' }); const note = h('textarea', { class: 'textarea', id: `dn${m.id}`, placeholder: 'What is in this delivery?' }); const go = h('button', { class: 'btn btn--amber', type: 'submit' }, 'Submit delivery');
    return h('form', { class: 'mform', novalidate: true, onsubmit: async (e) => { e.preventDefault(); const r = await act(go, () => api_('POST', `/milestones/${m.id}/deliver`, { link: link.value, note: note.value }), { ok: 'Delivered. The client’s 72-hour review has started.' }); if (r) nudge(); } }, h('h4', {}, 'Submit delivery'), h('div', { class: 'field' }, h('label', { for: link.id }, 'Link to the work'), link), h('div', { class: 'field' }, h('label', { for: note.id }, 'Note for the client'), note), go); };

  function clientActions(v, m) {
    const approve = h('button', { class: 'btn btn--paid', type: 'button' }, `Approve and release ${naira(m.amountKobo)}`);
    approve.onclick = async () => { if (!(await confirmDialog({ title: `Release ${naira(m.amountKobo)}?`, body: `This releases the money to the team for “${m.title}”. It cannot be undone.`, confirmLabel: 'Approve and release', tone: 'paid' }))) return; const r = await act(approve, () => api_('POST', `/milestones/${m.id}/approve`), { ok: 'Approved. Payouts are on their way.' }); if (r) nudge(); };
    const boxes = m.criteria.map((c, i) => h('label', { class: 'check check--crit' }, h('input', { type: 'checkbox', value: i }), h('span', {}, c)));
    const reason = h('textarea', { class: 'textarea', placeholder: 'What is missing? At least 10 characters.' }); const open = h('button', { class: 'btn btn--frozen', type: 'submit' }, 'Open a dispute and freeze this milestone');
    const form = h('form', { class: 'mform', hidden: true, novalidate: true, onsubmit: async (e) => { e.preventDefault(); const picked = boxes.map((b, i) => (b.firstChild.checked ? i : -1)).filter((i) => i >= 0); const r = await act(open, () => api_('POST', `/milestones/${m.id}/dispute`, { unmetCriteria: picked, reason: reason.value }), { ok: 'Milestone frozen. Only this one.' }); if (r) nudge(); } },
      h('h4', {}, 'Which written criteria were not met?'), h('div', { class: 'checks' }, ...boxes), h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Reason'), reason), open);
    const toggle = h('button', { class: 'btn btn--line', type: 'button', 'aria-expanded': 'false', onclick: () => { form.hidden = !form.hidden; toggle.setAttribute('aria-expanded', String(!form.hidden)); } }, 'Dispute this milestone');
    return h('div', { class: 'actions' }, h('div', { class: 'btnrow' }, approve, toggle), form);
  }

  function propForm(m, d) {
    const kind = h('select', { class: 'select' }, ...Object.entries(KIND).map(([k, t]) => h('option', { value: k }, t))); const bps = h('input', { class: 'input input--num', placeholder: 'Percent to the team, e.g. 60', inputmode: 'decimal' }); const note = h('input', { class: 'input', placeholder: 'Note (optional)' });
    const go = h('button', { class: 'btn btn--frozen btn--sm', type: 'submit' }, 'Send proposal'); const row = h('div', { class: 'field', hidden: true }, h('label', {}, 'Percent released to the team'), bps);
    kind.onchange = () => { row.hidden = kind.value !== 'split'; };
    return h('form', { class: 'mform', novalidate: true, onsubmit: async (e) => { e.preventDefault(); const body = { kind: kind.value, note: note.value }; if (kind.value === 'split') { const b = parsePercentToBps(bps.value); if (!b) { toast('Enter the percent released to the team, such as 60 or 62.5.', 'err'); return; } body.releaseBps = b; } const r = await act(go, () => api_('POST', `/milestones/${m.id}/propose`, body), { ok: 'Proposal sent' }); if (r) nudge(); } },
      h('h4', {}, 'Make a proposal'), h('div', { class: 'field' }, h('label', {}, 'Outcome'), kind), row, h('div', { class: 'field' }, h('label', {}, 'Note'), note), go);
  }

  function disputePanel(v, m) {
    const d = m.dispute; const box = h('div', { class: 'dispute' }, h('h4', {}, icon('snow'), ' Dispute: only this milestone is frozen'),
      h('p', {}, h('strong', {}, 'Unmet: '), d.unmetCriteria.map((i) => `${i + 1}. ${m.criteria[i]}`).join('; ')), h('p', { class: 'hint' }, `Reason: ${d.reason}`));
    if (d.status === 'negotiating') box.append(h('p', { class: 'review' }, icon('clock'), ' Negotiation ends in ', clock.span(d.negotiationDeadline, 'now. Sending to the reviewer.')));
    if (d.status === 'in_review') box.append(h('p', {}, pill('in_review'), ' ', h('span', { class: 'stamp' }, 'Simulated reviewer')));
    if (d.proposals.length) box.append(h('ul', { class: 'props' }, ...d.proposals.map((pr) => { const mine = (pr.by === 'lead' && v.role === 'lead') || (pr.by === 'client' && v.role === 'client'); const canRespond = !mine && pr.status === 'open' && (isLead() || clientView()) && d.status === 'negotiating';
      const acc = canRespond ? h('button', { class: 'btn btn--paid btn--sm', type: 'button' }, 'Accept') : null; const rej = canRespond ? h('button', { class: 'btn btn--line btn--sm', type: 'button' }, 'Reject') : null;
      if (acc) { acc.onclick = async () => { if (await act(acc, () => api_('POST', `/milestones/${m.id}/proposals/${pr.id}/respond`, { accept: true }), { ok: 'Accepted. Settling.' })) nudge(); }; rej.onclick = async () => { if (await act(rej, () => api_('POST', `/milestones/${m.id}/proposals/${pr.id}/respond`, { accept: false }), { ok: 'Rejected' })) nudge(); }; }
      return h('li', {}, h('span', {}, h('strong', {}, pr.by === 'lead' ? 'Team lead' : 'Client'), ` proposes: ${KIND[pr.kind]}${pr.kind === 'split' ? ` (${pct(pr.releaseBps)} to the team)` : ''}. `), pr.note ? h('em', {}, pr.note) : null, ' ', h('span', { class: 'hint' }, `[${pr.status}]`), canRespond ? h('span', { class: 'btnrow' }, acc, rej) : null); })));
    if (d.status === 'negotiating' && (isLead() || clientView())) {
      box.append(propForm(m, d));
      if (d.proposals.some((x) => x.status === 'rejected')) { const esc = h('button', { class: 'btn btn--line btn--sm', type: 'button' }, 'Ask the simulated reviewer to decide'); esc.onclick = async () => { if (await act(esc, () => api_('POST', `/milestones/${m.id}/escalate`), { ok: 'Sent to the simulated reviewer' })) nudge(); }; box.append(esc); }
    }
    return box;
  }

  function reviewForm(m) {
    const d = m.dispute; const kind = h('select', { class: 'select' }, ...Object.entries(KIND).map(([k, t]) => h('option', { value: k }, t))); const bps = h('input', { class: 'input input--num', placeholder: 'Percent to the team', inputmode: 'decimal' }); const row = h('div', { class: 'field', hidden: true }, h('label', {}, 'Percent released to the team'), bps); kind.onchange = () => { row.hidden = kind.value !== 'split'; };
    const boxes = m.criteria.map((c, i) => h('label', { class: 'check check--crit' }, h('input', { type: 'checkbox', value: i }), h('span', {}, c))); const note = h('textarea', { class: 'textarea', placeholder: 'Reasons for the decision. At least 30 characters.' }); const go = h('button', { class: 'btn btn--frozen', type: 'submit' }, 'Record decision');
    return h('form', { class: 'mform', novalidate: true, onsubmit: async (e) => { e.preventDefault(); const cited = boxes.map((b, i) => (b.firstChild.checked ? i : -1)).filter((i) => i >= 0); const body = { kind: kind.value, citedCriteria: cited, note: note.value }; if (kind.value === 'split') { const b = parsePercentToBps(bps.value); if (!b) { toast('Enter the percent released to the team.', 'err'); return; } body.releaseBps = b; } if (await act(go, () => api_('POST', `/milestones/${m.id}/review`, body), { ok: 'Decision recorded' })) nudge(); } },
      h('h4', {}, 'Reviewer decision ', h('span', { class: 'stamp' }, 'Simulated')), h('p', { class: 'hint' }, 'A decision must cite at least one written criterion.'), h('div', { class: 'field' }, h('label', {}, 'Decision'), kind), row, h('p', { class: 'label' }, 'Criteria this decision relies on'), h('div', { class: 'checks' }, ...boxes), h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Note'), note), go);
  }

  function payoutTable(v, m, pos) {
    return h('div', { class: 'payouts' }, h('h4', {}, 'Payouts'), h('div', { class: 'tbl-scroll' }, h('table', { class: 'tbl tbl--tight' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'To'), h('th', { scope: 'col', class: 'r' }, 'Amount'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, ''))),
      h('tbody', {}, ...pos.map((po) => { const retry = isLead() && ['failed', 'unknown', 'reversed'].includes(po.status) ? h('button', { class: 'btn btn--line btn--sm', type: 'button' }, icon('retry'), 'Retry payout') : null; if (retry) retry.onclick = async () => { if (await act(retry, () => api_('POST', `/payouts/${po.id}/retry`), { ok: 'Retry started. A payout that already succeeded is never sent twice.' })) nudge(); };
        const receipt = po.status === 'success' && po.receiptNo ? h('a', { class: 'btn btn--line btn--sm', href: `/receipt/${token}/${po.id}`, 'data-link': '' }, 'Receipt') : null;
        return h('tr', {}, h('td', {}, po.name), h('td', { class: 'r num' }, naira(po.amountKobo)), h('td', {}, pill(po.status), po.failureReason ? h('div', { class: 'hint' }, po.failureReason) : null), h('td', {}, retry ?? receipt)); })))));
  }

  const milestoneSection = (v) => section('Milestones', 'Each one is released on its own.', h('div', { class: 'mlist' }, ...v.project.milestones.map((m) => milestoneCard(v, m))));

  function ledgerPanel(v) {
    return section('The ledger', 'Every move is recorded. Each entry includes the hash of the one before it.', verification(v.ledger.verification), ledgerList(v.ledger.preview, {}), h('a', { class: 'btn btn--line', href: v.project.ledgerPath, 'data-link': '' }, `Open the full public ledger (${v.ledger.count} entries)`));
  }

  function linksPanel(v) {
    if (!v.links) return null;
    return section('Share links', 'Anyone with a link can act in that role. Share each only with the right person.', h('div', { class: 'doc' }, h('div', { class: 'doc__body' },
      h('div', { class: 'copyrow' }, h('div', {}, h('div', { class: 'copyrow__who' }, 'Client'), h('div', { class: 'hint' }, 'Pays and approves')), copyButton(() => abs(v.links.client))),
      ...v.links.collaborators.map((c) => h('div', { class: 'copyrow' }, h('div', {}, h('div', { class: 'copyrow__who' }, c.name, c.isLead ? ' (you)' : ''), h('div', { class: 'hint' }, c.role)), h('div', { class: 'btnrow' }, c.isLead ? h('a', { class: 'btn btn--line btn--sm', href: c.path, 'data-link': '' }, 'Open mine') : null, copyButton(() => abs(c.path))))),
      h('div', { class: 'copyrow' }, h('div', {}, h('div', { class: 'copyrow__who' }, 'Public ledger'), h('div', { class: 'hint' }, 'Safe to share')), copyButton(() => abs(v.links.ledger))),
      v.links.reviewer ? h('div', { class: 'copyrow' }, h('div', {}, h('div', { class: 'copyrow__who' }, 'Reviewer ', h('span', { class: 'stamp' }, 'Simulated')), h('div', { class: 'hint' }, 'Demo only')), copyButton(() => abs(v.links.reviewer))) : null)));
  }

  function render(v) {
    view = v; const p = v.project; document.title = `${p.title}: SplitPot`;
    clock.reset(); renderHead(v);
    const model = { ...p.pot, payLabel: p.funding.pending ? 'processing' : '' };
    pot.update(model, { animate: true });
    const parts = [];
    if (v.role === 'collaborator') parts.push(confirmPanel(v));
    parts.push(leadStatus(v), fundingPanel(v));
    if (v.role === 'reviewer') parts.push(section('Cases', 'You can decide only after the negotiation period has ended.', ...(p.milestones.some((m) => m.dispute) ? [] : [h('p', {}, 'No disputes yet.')])));
    parts.push(milestoneSection(v), splitSheet(v), ledgerPanel(v), linksPanel(v), accountPanel(v));
    body.replaceChildren(...parts.filter(Boolean));
  }

  const safeRender = (v) => {
    const key = JSON.stringify({ ...v, serverNow: 0 }); if (key === sig) return; sig = key;
    const ae = document.activeElement; if (body.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.value) { pending = v; ae.addEventListener('blur', () => { setTimeout(() => { if (pending) { const pv = pending; pending = false; sig = ''; safeRender(pv); } }, 300); }, { once: true }); return; }
    try { render(v); } catch (e) { console.error('render failed', e); sig = ''; body.replaceChildren(h('div', { class: 'loader' }, h('span', {}, 'Something went wrong drawing this page. Reload to try again.'))); throw e; }
    if (!safeRender.first) { safeRender.first = true; potFlip.apply(potHost); }
  };

  body.append(h('div', { class: 'loader' }, h('span', {}, 'Loading')));
  poller = pollView(token, { onData: safeRender, onError: (e) => { poller?.stop(); main.replaceChildren(h('div', { class: 'wrap page' }, h('h1', {}, e instanceof ApiError && (e.status === 401 || e.status === 404) ? 'This link does not work' : 'Could not reach the server'), h('p', { style: { margin: '14px 0 22px' } }, e.message), h('a', { class: 'btn', href: '/enter', 'data-link': '' }, 'Open a different link'))); } });
  return () => { poller?.stop(); clock.stop(); pot?.destroy(); net.destroy(); };
}
