// 9 partial dispute allocation; the dispute journey: freeze -> negotiate -> time -> reviewer -> resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seeded, advance, project, rejectsWith } from './helpers.js';

const moneyOut = (app) => app.store.snapshot().mock.moneyOutKobo;
const longNote = 'Criterion two is not met: two shot-list scenes are missing from the delivery record, so the work is only partly complete.';

test('opening a dispute needs an unmet criterion and a reason, and freezes ONLY that milestone', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  await rejectsWith(assert, app.engine.openDispute(s.client, 'm1', { unmetCriteria: [], reason: 'It is not what we agreed on.' }), 'CRITERIA_REQUIRED');
  await rejectsWith(assert, app.engine.openDispute(s.client, 'm1', { unmetCriteria: [7], reason: 'It is not what we agreed on.' }), 'CRITERIA_REQUIRED');
  await rejectsWith(assert, app.engine.openDispute(s.client, 'm1', { unmetCriteria: [0] }), 'FIELD_REQUIRED');
  await rejectsWith(assert, app.engine.openDispute(s.client, 'm1', { unmetCriteria: [0], reason: 'short' }), 'FIELD_TOO_SHORT');
  const r = await app.engine.openDispute(s.client, 'm1', { unmetCriteria: [1, 1, 0], reason: 'Two scenes are missing from the cut.' });
  assert.equal(r.disputeStatus, 'negotiating');
  assert.equal(r.negotiationDeadline, app.clock.t + 5 * 24 * 3_600_000, 'five-day negotiation period');
  await rejectsWith(assert, app.engine.openDispute(s.client, 'm1', { unmetCriteria: [0], reason: 'Trying to open it again.' }), 'DISPUTE_ALREADY_OPEN');

  const v = await app.engine.view(s.client);
  assert.equal(v.project.milestones[0].frozen, true);
  assert.deepEqual(v.project.milestones[0].dispute.unmetCriteria, [0, 1]);
  assert.equal(v.project.milestones[1].frozen, false);
  assert.equal(v.project.pot.bands[0].state, 'frozen');
  assert.equal(v.project.pot.bands[1].state, 'waiting');
});

test('other milestones continue normally while one is frozen', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  await app.engine.approveMilestone(s.client, 'm2'); await app.engine.idle();
  const p = project(app, s.projectId);
  assert.equal(p.milestones[1].status, 'closed');
  assert.equal(moneyOut(app), 60_000_000, 'the final edit paid in full');
  assert.equal(p.milestones[0].status, 'delivered');
  assert.equal(Object.keys(p.payouts).filter((k) => k.startsWith('po_m1')).length, 0, 'nothing from the frozen milestone moved');
  assert.equal(p.status, 'active');
});

test('9. partial dispute allocation: a 60/40 split pays 60% to the team (by share) and refunds 40% (simulated)', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  const { proposalId } = await app.engine.proposeResolution(s.client, 'm1', { kind: 'split', releaseBps: 6000, note: 'Pay 60% for the work delivered.' });
  await rejectsWith(assert, app.engine.respondToProposal(s.client, 'm1', proposalId, { accept: true }), 'OWN_PROPOSAL');
  await rejectsWith(assert, app.engine.respondToProposal(s.collabs[1], 'm1', proposalId, { accept: true }), 'ROLE_FORBIDDEN');
  await app.engine.respondToProposal(s.lead, 'm1', proposalId, { accept: true }); await app.engine.idle();

  const p = project(app, s.projectId);
  const paid = ['c1', 'c2', 'c3', 'c4'].map((c) => p.payouts[`po_m1_${c}`].amountKobo);
  assert.deepEqual(paid, [9_600_000, 6_000_000, 4_800_000, 3_600_000]);
  assert.equal(paid.reduce((a, b) => a + b, 0), 24_000_000, '60% of ₦400,000');
  assert.equal(p.milestones[0].refundKobo, 16_000_000, '40% refunded');
  assert.equal(24_000_000 + 16_000_000, p.milestones[0].amountKobo, 'release + refund = milestone, to the kobo');
  assert.equal(p.milestones[0].resolution, 'split');
  assert.equal(p.refunds.length, 1);
  assert.equal(p.refunds[0].status, 'simulated');
  const refundEntry = p.ledger.find((e) => e.type === 'refund.simulated');
  assert.equal(refundEntry.data.simulated, true);
  assert.match(refundEntry.data.note, /SIMULATED/);
  assert.match(refundEntry.data.note, /fee is not refunded/);
  assert.equal(moneyOut(app), 24_000_000, 'only the released part left the platform');
  assert.equal(p.milestones[0].dispute.status, 'resolved');
  assert.equal(p.milestones[0].dispute.outcome.via, 'agreement');
});

test('proposals: split bounds, one live offer at a time, rejection keeps the freeze', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  await rejectsWith(assert, app.engine.proposeResolution(s.lead, 'm1', { kind: 'split', releaseBps: 10_000 }), 'SPLIT_BPS_INVALID');
  await rejectsWith(assert, app.engine.proposeResolution(s.lead, 'm1', { kind: 'split', releaseBps: 0 }), 'SPLIT_BPS_INVALID');
  await rejectsWith(assert, app.engine.proposeResolution(s.lead, 'm1', { kind: 'split', releaseBps: 50.5 }), 'SPLIT_BPS_INVALID');
  await rejectsWith(assert, app.engine.proposeResolution(s.lead, 'm1', { kind: 'gift' }), 'PROPOSAL_KIND_INVALID');
  const a = await app.engine.proposeResolution(s.lead, 'm1', { kind: 'release' });
  const b = await app.engine.proposeResolution(s.lead, 'm1', { kind: 'fix' }); // supersedes a
  let d = project(app, s.projectId).milestones[0].dispute;
  assert.deepEqual(d.proposals.map((x) => x.status), ['superseded', 'open']);
  await rejectsWith(assert, app.engine.respondToProposal(s.client, 'm1', a.proposalId, { accept: true }), 'PROPOSAL_NOT_OPEN');
  await rejectsWith(assert, app.engine.escalateDispute(s.lead, 'm1'), 'ESCALATE_TOO_EARLY');
  await app.engine.respondToProposal(s.client, 'm1', b.proposalId, { accept: false });
  d = project(app, s.projectId).milestones[0].dispute;
  assert.equal(d.status, 'negotiating');
  assert.equal(d.proposals[1].status, 'rejected');
  assert.equal(moneyOut(app), 0);
  await app.engine.escalateDispute(s.client, 'm1'); // after a rejection either side can ask the reviewer
  assert.equal(project(app, s.projectId).milestones[0].dispute.status, 'in_review');
});

test('full refund agreement: nothing is paid out, the refund is a SIMULATED record', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  const { proposalId } = await app.engine.proposeResolution(s.lead, 'm1', { kind: 'refund', note: 'We will redo it from scratch.' });
  await app.engine.respondToProposal(s.client, 'm1', proposalId, { accept: true }); await app.engine.idle();
  const p = project(app, s.projectId);
  assert.equal(p.milestones[0].resolution, 'refunded');
  assert.equal(p.milestones[0].refundKobo, 40_000_000);
  assert.equal(Object.keys(p.payouts).length, 0);
  assert.equal(moneyOut(app), 0);
  assert.equal(p.refunds[0].status, 'simulated');
});

test('fix and resubmit: milestone reopens, a new delivery gets a new 72-hour window', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  const { proposalId } = await app.engine.proposeResolution(s.client, 'm1', { kind: 'fix', note: 'Add the two missing scenes.' });
  await app.engine.respondToProposal(s.lead, 'm1', proposalId, { accept: true });
  let m = project(app, s.projectId).milestones[0];
  assert.equal(m.status, 'pending');
  assert.equal(m.delivery, null);
  assert.equal(m.deliveryHistory.length, 1, 'the first delivery stays on record');
  advance(app, 1);
  const t = app.clock.t;
  const r = await app.engine.submitDelivery(s.lead, 'm1', { link: 'https://example.com/rough-v2', note: 'v2 with the two missing scenes added.' });
  assert.equal(r.reviewDeadline, t + 72 * 3_600_000);
  m = project(app, s.projectId).milestones[0];
  assert.equal(m.delivery.number, 2);
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  assert.equal(project(app, s.projectId).milestones[0].resolution, 'released');
  assert.equal(moneyOut(app), 40_000_000);
});

test('negotiation closes after five days and the case goes to the simulated reviewer', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  await rejectsWith(assert, app.engine.reviewerDecide(s.reviewer, 'm1', { kind: 'release', citedCriteria: [0], note: longNote }), 'REVIEW_NOT_READY');
  advance(app, 119);
  await app.engine.tick(); await app.engine.idle();
  assert.equal(project(app, s.projectId).milestones[0].dispute.status, 'negotiating', 'not at 119 hours');
  advance(app, 2);
  await rejectsWith(assert, app.engine.proposeResolution(s.lead, 'm1', { kind: 'release' }), 'NEGOTIATION_CLOSED');
  await app.engine.tick(); await app.engine.idle();
  const p = project(app, s.projectId);
  assert.equal(p.milestones[0].dispute.status, 'in_review');
  assert.equal(p.milestones[0].status, 'delivered');
  assert.ok(p.ledger.some((e) => e.type === 'dispute.escalated' && e.data.reviewer === 'SIMULATED'));
  assert.equal(p.milestones[1].status, 'closed', 'the other milestone auto-released after 72h in the meantime');
  await app.engine.tick(); await app.engine.tick();
  assert.equal(p.ledger.filter((e) => e.type === 'dispute.escalated').length, 1, 'escalation is idempotent');
});

test('the reviewer must cite the written criteria and explain the decision; nobody else can decide', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  advance(app, 121); await app.engine.tick(); await app.engine.idle();
  await rejectsWith(assert, app.engine.reviewerDecide(s.lead, 'm1', { kind: 'release', citedCriteria: [1], note: longNote }), 'ROLE_FORBIDDEN');
  await rejectsWith(assert, app.engine.reviewerDecide(s.client, 'm1', { kind: 'refund', citedCriteria: [1], note: longNote }), 'ROLE_FORBIDDEN');
  await rejectsWith(assert, app.engine.reviewerDecide(s.reviewer, 'm1', { kind: 'release', citedCriteria: [], note: longNote }), 'CITATION_REQUIRED');
  await rejectsWith(assert, app.engine.reviewerDecide(s.reviewer, 'm1', { kind: 'release', citedCriteria: [9], note: longNote }), 'CITATION_REQUIRED');
  await rejectsWith(assert, app.engine.reviewerDecide(s.reviewer, 'm1', { kind: 'release', citedCriteria: [1], note: 'Looks fine.' }), 'FIELD_TOO_SHORT');
  await rejectsWith(assert, app.engine.reviewerDecide(s.reviewer, 'm1', { kind: 'maybe', citedCriteria: [1], note: longNote }), 'DECISION_KIND_INVALID');
  assert.equal(project(app, s.projectId).milestones[0].dispute.status, 'in_review', 'bad decisions change nothing');
});

test('DISPUTE JOURNEY: dispute -> freeze -> negotiation -> time advances -> reviewer decides -> resolved, with conservation of money', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  assert.equal(project(app, s.projectId).milestones[0].dispute.status, 'negotiating');

  const a = await app.engine.proposeResolution(s.lead, 'm1', { kind: 'release', note: 'All scenes are in; please release.' });
  await app.engine.respondToProposal(s.client, 'm1', a.proposalId, { accept: false });
  const b = await app.engine.proposeResolution(s.client, 'm1', { kind: 'split', releaseBps: 5000 });
  await app.engine.respondToProposal(s.lead, 'm1', b.proposalId, { accept: false });

  advance(app, 121);
  await app.engine.tick(); await app.engine.idle(); // m1 -> in_review, m2 auto-releases
  const dec = await app.engine.reviewerDecide(s.reviewer, 'm1', { kind: 'split', releaseBps: 7000, citedCriteria: [1], note: longNote });
  assert.equal(dec.resolved, true);
  await app.engine.idle();

  const p = project(app, s.projectId);
  assert.equal(p.status, 'completed');
  const m1 = p.milestones[0];
  assert.equal(m1.dispute.status, 'resolved');
  assert.equal(m1.dispute.reviewer.simulated, true);
  assert.deepEqual(m1.dispute.reviewer.citedCriteria, [1]);
  assert.equal(m1.dispute.outcome.via, 'reviewer');
  const teamPaid = Object.values(p.payouts).reduce((a, po) => a + po.amountKobo, 0);
  const refunded = p.refunds.reduce((a, r) => a + r.amountKobo, 0);
  assert.equal(teamPaid, 60_000_000 + 28_000_000);
  assert.equal(refunded, 12_000_000);
  assert.equal(teamPaid + refunded + p.feeKobo, p.clientPaysKobo, 'client paid = team + refund + fee, to the kobo');
  assert.equal(moneyOut(app), teamPaid);
  assert.ok(['dispute.opened', 'dispute.proposal', 'dispute.proposal_rejected', 'dispute.escalated', 'dispute.decided', 'milestone.released', 'refund.simulated', 'project.completed'].every((t) => p.ledger.some((e) => e.type === t)));
  assert.equal(app.engine.verifyLedger(s.projectId).ok, true);
  const decided = p.ledger.find((e) => e.type === 'dispute.decided');
  assert.equal(decided.data.reviewer, 'SIMULATED');
  await rejectsWith(assert, app.engine.reviewerDecide(s.reviewer, 'm1', { kind: 'refund', citedCriteria: [0], note: longNote }), 'REVIEW_NOT_READY');
});

test('a client who disputes cannot also be silently ignored: the auto-release clock is paused while frozen but resumes after a fix', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  const { proposalId } = await app.engine.proposeResolution(s.lead, 'm1', { kind: 'fix' });
  await app.engine.respondToProposal(s.client, 'm1', proposalId, { accept: true });
  advance(app, 100);
  await app.engine.submitDelivery(s.lead, 'm1', { link: 'https://example.com/v2', note: 'Second delivery with all scenes.' });
  advance(app, 71); await app.engine.tick(); await app.engine.idle();
  assert.equal(project(app, s.projectId).milestones[0].status, 'delivered');
  advance(app, 2); await app.engine.tick(); await app.engine.idle();
  assert.equal(project(app, s.projectId).milestones[0].status, 'closed');
  assert.equal(moneyOut(app), 100_000_000);
});
