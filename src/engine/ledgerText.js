// Plain-language description of a ledger entry (server side, used by the account dashboard and exports).
import { formatNaira, bpsToPercentString } from '../shared/money.js';

const money = (v) => (Number.isSafeInteger(v) ? formatNaira(v) : 'an amount');
const pct = (b) => bpsToPercentString(Number.isInteger(b) ? b : 0);
const who = (a) => ({ lead: 'The team lead', client: 'The client', reviewer: 'The simulated reviewer', system: 'The system' }[a] ?? String(a));
const kindText = (k, bps) => ({ release: 'release the full amount to the team', refund: 'refund the full amount to the client (simulated)', fix: 'fix and resubmit', split: `release ${pct(bps)} to the team and refund the rest (simulated)` }[k] ?? String(k));

export function describeLedger(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'project.created': return ['Project created', `${d.title}. Total ${money(d.totalKobo)}, client pays ${money(d.clientPaysKobo)}.`];
    case 'split.revised': return ['Split revised', `${(d.changes ?? []).map((c) => `${c.name} ${pct(c.fromBps)} to ${pct(c.toBps)}`).join(', ')}. Changed shares need confirming again.`];
    case 'collaborator.confirmed': return ['Share confirmed', `${d.name} (${d.role}) confirmed ${pct(d.bps)}, ${money(d.shareKobo)}.`];
    case 'collaborator.declined': return ['Share declined', `${d.name} (${d.role}) declined ${pct(d.bps)}.`];
    case 'project.ready_to_fund': return ['Ready to fund', `All ${d.confirmed} people confirmed. The client can pay ${money(d.clientPaysKobo)}.`];
    case 'funding.initiated': return ['Payment started', `Expecting ${money(d.expectedKobo)}.`];
    case 'funding.verified': return ['Funded', `${money(d.paidKobo)} verified server-side. ${money(d.potKobo)} in the pot.`];
    case 'funding.rejected': return ['Payment rejected', `${d.reason ?? 'The payment did not match.'} Expected ${money(d.expectedKobo)}, received ${money(d.receivedKobo)}. Not counted.`];
    case 'funding.failed': case 'charge.failed': return ['Payment failed', 'The pot was not funded.'];
    case 'funding.duplicate_detected': return ['Duplicate payment recorded', 'A second payment arrived after funding. Returning it is a manual simulated step.'];
    case 'milestone.delivered': return ['Delivered', `${d.title}: delivery ${d.delivery}. The 72-hour review window started.`];
    case 'milestone.approved': return ['Approved by client', `${d.title} approved.`];
    case 'milestone.auto_released': return ['Review window ended', `${d.title} released automatically after 72 hours.`];
    case 'milestone.released': return ['Released', `${d.title}: ${money(d.releaseKobo)} to the team${d.refundKobo ? `, ${money(d.refundKobo)} refunded (simulated)` : ''}.`];
    case 'milestone.reopened': return ['Reopened', d.note ?? 'Back to waiting for delivery.'];
    case 'dispute.opened': return ['Dispute opened', `${d.title} is frozen. Nothing else is held.`];
    case 'dispute.proposal': return ['Proposal made', `${who(d.by)} proposed to ${kindText(d.kind, d.releaseBps)}.`];
    case 'dispute.proposal_accepted': return ['Proposal accepted', `${who(d.by)} accepted.`];
    case 'dispute.proposal_rejected': return ['Proposal rejected', `${who(d.by)} rejected the proposal.`];
    case 'dispute.escalated': return ['Sent to reviewer', 'Sent to the simulated reviewer.'];
    case 'dispute.decided': return ['Reviewer decided (simulated)', `Decision: ${kindText(d.kind, d.releaseBps)}.`];
    case 'payout.succeeded': case 'transfer.success': return ['Payout sent', `${money(d.amountKobo)} paid${d.name ? ` to ${d.name}` : ''}${d.milestoneTitle ? ` for ${d.milestoneTitle}` : ''}.`];
    case 'payout.failed': case 'transfer.failed': return ['Payout failed', `${d.name ? `${d.name}'s ` : ''}transfer did not go through. The lead can retry it safely.`];
    case 'payout.retry_requested': return ['Payout retry', 'A retry was requested.'];
    case 'payout.reversed': case 'transfer.reversed': return ['Payout reversed', 'The bank reversed the transfer.'];
    case 'refund.simulated': return ['Refund (simulated)', `${money(d.amountKobo)} returned to the client. No money moved.`];
    case 'project.completed': return ['Project completed', 'Every milestone is settled.'];
    case 'demo.clock_advanced': return ['Demo clock moved forward', d.note ?? ''];
    default: return [e.type, ''];
  }
}
