import { h, naira as nairaRaw, pct, fmtDate, fmtDur, shortHash } from '../ui.js';
import { nowMs } from '../api.js';

const naira = (v) => (Number.isSafeInteger(v) ? nairaRaw(v) : 'an amount');
const who = (a) => ({ lead: 'The team lead', client: 'The client', reviewer: 'The simulated reviewer', system: 'The system' }[a] ?? a);
const kindText = (k, bps) => ({ release: 'release the full amount to the team', refund: 'refund the full amount to the client (simulated)', fix: 'fix and resubmit', split: `release ${pct(bps ?? 0)} to the team and refund the rest (simulated)` }[k] ?? k);

/** Plain-language description of a ledger entry. Only uses what the public ledger already contains. */
export function describeEntry(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'project.created': return ['Project created', `${d.title}. Total ${naira(d.totalKobo)}, fee ${naira(d.feeKobo)}, client pays ${naira(d.clientPaysKobo)}. Split: ${(d.collaborators ?? []).map((c) => `${c.name} ${pct(c.bps)}`).join(', ')}.`];
    case 'collaborator.confirmed': return ['Share confirmed', `${d.name} (${d.role}) confirmed ${pct(d.bps)}, ${naira(d.shareKobo)}, to ${d.bankName} ending ${d.accountLast4}.`];
    case 'project.ready_to_fund': return ['Ready to fund', `All ${d.confirmed} people confirmed. The client can now pay ${naira(d.clientPaysKobo)}.`];
    case 'funding.initiated': return ['Payment started', `Expecting ${naira(d.expectedKobo)}.`];
    case 'charge.success': return ['Payment reported', 'The provider reported a successful payment. Verification follows.'];
    case 'charge.failed': return ['Payment failed', 'The provider reported the payment did not go through.'];
    case 'funding.verified': return ['Funded', `Verified server-side: ${naira(d.paidKobo)} in ${d.currency ?? 'NGN'} matches the agreed amount. ${naira(d.potKobo)} is in the pot; the ${naira(d.feeKobo)} fee is kept apart.`];
    case 'funding.rejected': return ['Payment rejected', `${d.reason ?? 'The amount or currency did not match.'} Expected ${naira(d.expectedKobo)} ${d.expectedCurrency ?? ''}, received ${naira(d.receivedKobo)} ${d.receivedCurrency ?? ''}. The pot was not funded.`];
    case 'funding.failed': return ['Funding failed', 'The pot was not funded.'];
    case 'funding.duplicate_detected': return ['Duplicate message ignored', 'The same payment message arrived twice. It was counted once.'];
    case 'milestone.delivered': return ['Delivered', `${d.title}: delivery ${d.delivery}. The 72-hour review window started.`];
    case 'milestone.approved': return ['Approved by client', `${d.title} approved.`];
    case 'milestone.auto_released': return ['Review window ended', `${d.title}: no response within 72 hours after delivery, so it released automatically.`];
    case 'milestone.released': return ['Released', `${d.title}: ${naira(d.releaseKobo)} to the team${d.refundKobo ? `, ${naira(d.refundKobo)} returned to the client (simulated)` : ''}. ${(d.allocation ?? []).map((a) => `${a.name} ${naira(a.amountKobo)}`).join(', ')}.`];
    case 'milestone.reopened': return ['Reopened', d.note ?? 'Back to waiting for delivery.'];
    case 'dispute.opened': return ['Dispute opened', `${d.title} is frozen. Nothing else is held. Five days to negotiate.`];
    case 'dispute.proposal': return ['Proposal made', `${who(d.by)} proposed to ${kindText(d.kind, d.releaseBps)}.`];
    case 'dispute.proposal_accepted': return ['Proposal accepted', `${who(d.by)} accepted. Outcome: ${kindText(d.kind)}.`];
    case 'dispute.proposal_rejected': return ['Proposal rejected', `${who(d.by)} rejected the proposal.`];
    case 'dispute.escalated': return ['Sent to reviewer', 'Sent to the simulated reviewer.'];
    case 'dispute.decided': return ['Reviewer decided (simulated)', `Decision: ${kindText(d.kind, d.releaseBps)}.`];
    case 'payout.succeeded': case 'transfer.success': return ['Payout sent', `${naira(d.amountKobo)} paid${d.name ? ` to ${d.name}` : ''}${d.milestoneTitle ? ` for ${d.milestoneTitle}` : ''}${d.bankName ? `, ${d.bankName} ending ${d.accountLast4}` : ''}.`];
    case 'payout.failed': case 'transfer.failed': return ['Payout failed', `${d.name ? `${d.name}'s ` : ''}transfer did not go through. The lead can retry it safely.`];
    case 'payout.retry_requested': return ['Payout retry', 'A retry was requested. A payout that already succeeded cannot be sent again.'];
    case 'payout.reversed': case 'transfer.reversed': return ['Payout reversed', 'The bank reversed the transfer.'];
    case 'refund.simulated': return ['Refund (simulated)', `${naira(d.amountKobo)} returned to the client. This is simulated and moves no money. The fee is not refunded.`];
    case 'project.completed': return ['Project completed', 'Every milestone is settled.'];
    case 'demo.clock_advanced': return ['Demo clock moved forward (Judge Mode)', d.note ?? ''];
    default: return [e.type, ''];
  }
}

export function ledgerList(entries, { limit } = {}) {
  const rows = limit ? entries.slice(-limit) : entries;
  return h('ol', { class: 'ledger-list' }, ...[...rows].reverse().map((e) => { const [t, detail] = describeEntry(e); return h('li', { class: 'lentry' },
    h('div', { class: 'lentry__n num' }, `#${e.seq}`),
    h('div', { class: 'lentry__b' }, h('div', { class: 'lentry__t' }, t), detail ? h('div', { class: 'lentry__d' }, detail) : null,
      h('div', { class: 'lentry__m' }, h('time', { datetime: new Date(e.ts).toISOString() }, fmtDate(e.ts)), h('code', { title: `Full hash: ${e.hash}` }, shortHash(e.hash))))); }));
}

export function verification(v) {
  const ok = v.ok !== false && v.valid !== false && !v.brokenAt;
  return h('div', { class: `verify ${ok ? 'verify--ok' : 'verify--bad'}`, role: 'status' }, h('div', { class: `vline ${ok ? 'is-ok' : 'is-broken'}`, 'aria-hidden': 'true' }), h('strong', {}, v.text));
}

/** A live countdown. Call stop() on unmount. Follows the server clock so Judge Mode time jumps show. */
export function makeClock() {
  const items = []; let t = null;
  const tick = () => items.forEach(({ el, deadline, done }) => { const ms = deadline - nowMs(); el.textContent = ms <= 0 ? done : fmtLong(ms); });
  return {
    span(deadline, done = 'ended') { const el = h('span', { class: 'num' }); items.push({ el, deadline, done }); tick(); t ??= setInterval(tick, 1000); return el; },
    reset() { items.length = 0; },
    stop() { clearInterval(t); t = null; items.length = 0; },
  };
}
function fmtLong(ms) { const s = Math.floor(ms / 1000); const totalH = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = s % 60; const pad = (n) => String(n).padStart(2, '0'); if (totalH >= 100) { const d = Math.floor(totalH / 24); return `${d}d ${pad(totalH % 24)}h ${pad(m)}m`; } return `${totalH}h ${pad(m)}m ${pad(ss)}s`; }
export { fmtDur };
