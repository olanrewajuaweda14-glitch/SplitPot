// Read models. Each role gets only what that role may see.
//
// Hard rules enforced here:
//  - Full bank account numbers are NEVER returned by any view. Masked, last four only.
//  - Account-holder names are shown only to the lead and to the account's own owner.
//  - Capability tokens appear only in the lead's view (client + collaborator links), and the
//    reviewer link only in demo mode. The public ledger never contains any token.

import { verifyChain, chainStatusText } from '../domain/ledger.js';
import { maskAccount } from '../shared/money.js';
import { own, isFrozen } from './helpers.js';

const STATUS_LABEL = {
  awaiting_confirmations: 'Awaiting confirmations',
  awaiting_funding: 'Awaiting funding',
  active: 'Active',
  completed: 'Completed',
};

const verification = (p) => {
  const v = verifyChain(p.ledger, p.ledgerAnchor);
  return { ...v, text: chainStatusText(v) };
};

const publicEntry = (e) => ({ seq: e.seq, ts: e.ts, type: e.type, data: e.data, prevHash: e.prevHash, hash: e.hash });

function plannedTotal(p, collaboratorId) {
  return p.milestones.reduce((a, m) => a + (m.plannedAllocation.find((x) => x.collaboratorId === collaboratorId)?.amountKobo ?? 0), 0);
}

function potState(p) {
  const funded = p.funding.status === 'funded';
  const bands = p.milestones.map((m) => {
    const pos = Object.values(p.payouts).filter((po) => po.milestoneId === m.id);
    let state;
    if (!funded) state = 'unfunded';
    else if (isFrozen(m)) state = 'frozen';
    else if (m.status === 'closed') {
      if (m.resolution === 'refunded') state = 'refunded';
      else state = pos.length > 0 && pos.every((po) => po.status === 'success') ? 'paid' : pos.some((po) => ['failed', 'unknown', 'reversed'].includes(po.status)) ? 'payout_failed' : 'releasing';
    } else state = m.status === 'delivered' ? 'delivered' : 'waiting';
    return { id: m.id, title: m.title, amountKobo: m.amountKobo, state, refundKobo: m.refundKobo };
  });
  const channels = p.collaborators.map((c) => {
    const pos = Object.values(p.payouts).filter((po) => po.collaboratorId === c.id);
    const paid = pos.filter((po) => po.status === 'success').reduce((a, po) => a + po.amountKobo, 0);
    let state = 'idle';
    if (pos.some((po) => ['failed', 'unknown', 'reversed'].includes(po.status))) state = 'failed';
    else if (pos.some((po) => ['queued', 'processing'].includes(po.status))) state = 'paying';
    else if (pos.length > 0 && p.milestones.every((m) => m.status === 'closed')) state = 'paid';
    else if (paid > 0) state = 'partial';
    return { id: c.id, name: c.name, role: c.role, bps: c.bps, state, paidKobo: paid, plannedKobo: plannedTotal(p, c.id) };
  });
  return { totalKobo: p.totalKobo, funded, fundedKobo: funded ? p.totalKobo : 0, bands, channels };
}

export function buildView(state, { project: p, role, collaboratorId }, { demoMode, provider, now }) {
  const isLead = role === 'lead';
  const seesAllPayouts = role === 'lead' || role === 'client';

  const collaborators = p.collaborators.map((c) => ({
    id: c.id, name: c.name, role: c.role, isLead: c.isLead, bps: c.bps,
    plannedKobo: plannedTotal(p, c.id), confirmed: c.confirmed, confirmedAt: c.confirmedAt,
    invitation: c.confirmed ? 'accepted' : c.declinedAt ? 'declined' : c.viewedAt ? 'viewed' : 'invited', viewedAt: c.viewedAt ?? null, declinedAt: c.declinedAt ?? null,
    declineReason: isLead || c.id === collaboratorId ? c.declineReason ?? null : null,
    bank: c.bank && (isLead || c.id === collaboratorId)
      ? { bankName: c.bank.bankName, bankCode: c.bank.bankCode, masked: maskAccount(c.bank.accountNumber), accountName: c.bank.accountName }
      : null,
    hasBank: !!c.bank,
  }));

  const milestones = p.milestones.map((m) => ({
    id: m.id, idx: m.idx, title: m.title, amountKobo: m.amountKobo, criteria: m.criteria,
    plannedAllocation: m.plannedAllocation, status: m.status, frozen: isFrozen(m),
    delivery: m.delivery, deliveryHistory: m.deliveryHistory.map((d) => ({ number: d.number, submittedAt: d.submittedAt, link: d.link, note: d.note })),
    dispute: m.dispute, disputeCount: m.disputeHistory.length + (m.dispute ? 1 : 0),
    resolution: m.resolution, refundKobo: m.refundKobo, payoutAllocation: m.payoutAllocation, closedAt: m.closedAt,
  }));

  const payouts = Object.values(p.payouts)
    .filter((po) => seesAllPayouts || (role === 'collaborator' && po.collaboratorId === collaboratorId) || role === 'reviewer')
    .map((po) => ({
      id: po.id, milestoneId: po.milestoneId, collaboratorId: po.collaboratorId,
      name: p.collaborators.find((c) => c.id === po.collaboratorId).name,
      amountKobo: po.amountKobo, status: po.status, attempt: po.attempt, failureReason: po.failureReason,
      reference: isLead || po.collaboratorId === collaboratorId ? po.reference : undefined,
      completedAt: po.completedAt, ledgerSeq: po.ledgerSeq, ledgerHash: po.ledgerHash, receiptNo: po.receiptNo,
    }));

  const attempts = p.funding.attempts;
  const latest = attempts[attempts.length - 1] ?? null;
  const lastRejection = [...p.ledger].reverse().find((e) => e.type === 'funding.rejected');
  const funding = {
    status: p.funding.status, expectedKobo: p.clientPaysKobo, amountKobo: p.funding.amountKobo, fundedAt: p.funding.fundedAt,
    reference: p.funding.status === 'funded' ? p.funding.reference : null,
    pending: p.funding.status !== 'funded' && !!latest && latest.status === 'initiated' && !!latest.authorizationUrl,
    lastRejection: lastRejection && (!latest || latest.status === 'rejected') ? lastRejection.data : null,
    checkoutUrl: role === 'client' && latest?.status === 'initiated' ? latest.authorizationUrl : null,
  };

  let links = null;
  if (isLead) {
    links = {
      client: `/p/client/${p.access.client}`,
      collaborators: p.collaborators.map((c) => ({ id: c.id, name: c.name, role: c.role, isLead: c.isLead, path: `/p/collab/${p.access.collaborators[c.id]}` })),
      ledger: `/ledger/${p.publicId}`,
      ...(demoMode ? { reviewer: `/p/reviewer/${p.access.reviewer}` } : {}),
    };
  }

  const entries = p.ledger;
  return {
    role, serverNow: now, demoMode, provider,
    me: collaboratorId ? { collaboratorId } : null,
    project: {
      id: p.id, title: p.title, clientName: p.clientName, origin: p.origin, status: p.status, statusLabel: STATUS_LABEL[p.status],
      currency: p.currency, createdAt: p.createdAt, completedAt: p.completedAt ?? null,
      totalKobo: p.totalKobo, feeKobo: p.feeKobo, feeBps: p.feeBps, clientPaysKobo: p.clientPaysKobo,
      confirmedCount: p.collaborators.filter((c) => c.confirmed).length, collaboratorCount: p.collaborators.length,
      collaborators, milestones, payouts, funding, refunds: p.refunds, pot: potState(p), ledgerPath: `/ledger/${p.publicId}`,
    },
    ledger: { verification: verification(p), count: entries.length, preview: entries.slice(-12).map(publicEntry) },
    links,
  };
}

export function buildPublicLedger(state, p, { provider }) {
  return {
    provider,
    project: {
      title: p.title, clientName: p.clientName, origin: p.origin, status: p.status, statusLabel: STATUS_LABEL[p.status], currency: p.currency,
      totalKobo: p.totalKobo, feeKobo: p.feeKobo, feeBps: p.feeBps, clientPaysKobo: p.clientPaysKobo,
      collaborators: p.collaborators.map((c) => ({ id: c.id, name: c.name, role: c.role, bps: c.bps })),
      milestones: p.milestones.map((m) => ({ id: m.id, title: m.title, amountKobo: m.amountKobo, status: m.status, frozen: isFrozen(m), resolution: m.resolution })),
      funded: p.funding.status === 'funded',
      pot: potState(p),
    },
    verification: verification(p),
    entries: p.ledger.map(publicEntry),
  };
}

export function buildReceipt(p, po, { provider }) {
  const c = p.collaborators.find((x) => x.id === po.collaboratorId);
  const m = p.milestones.find((x) => x.id === po.milestoneId);
  const entry = p.ledger[po.ledgerSeq - 1];
  return {
    receiptNo: po.receiptNo, simulated: !!provider.isMock, provider: provider.name,
    project: { title: p.title, clientName: p.clientName },
    milestone: { id: m.id, title: m.title },
    recipient: { name: c.name, role: c.role, bankName: c.bank.bankName, masked: maskAccount(c.bank.accountNumber), accountName: c.bank.accountName },
    amountKobo: po.amountKobo, currency: p.currency, reference: po.reference, transferCode: po.transferCode,
    paidAt: po.completedAt, attempt: po.attempt,
    ledger: { seq: po.ledgerSeq, hash: po.ledgerHash, prevHash: entry?.prevHash ?? null, matchesChain: !!entry && entry.hash === po.ledgerHash },
    chain: verification(p), ledgerPath: `/ledger/${p.publicId}`,
  };
}

export { own };
