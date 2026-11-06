// 7. Every illegal state transition throws a typed error with an understandable message.
// 8. Automatic release happens only after a delivery, only after 72 hours.
// 17. A frozen milestone can never be paid.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seeded, advance, project, rejectsWith } from './helpers.js';
import { StateError, SplitPotError } from '../src/shared/errors.js';

const rough = { link: 'https://example.com/rough', note: 'Rough cut delivered with all scenes.' };

test('funding before confirmations is blocked, and says how many are missing', async () => {
  const app = makeApp(); const s = await seeded(app, 'created');
  const err = await rejectsWith(assert, app.engine.startFunding(s.client), 'FUNDING_BEFORE_CONFIRMATIONS');
  assert.ok(err instanceof StateError && err instanceof SplitPotError);
  assert.match(err.message, /0 of 4 have confirmed/); // the lead's bank is prefilled but nobody has ACCEPTED yet
});

test('funding stays blocked until the LAST collaborator confirms', async () => {
  const app = makeApp(); const s = await seeded(app, 'created');
  const accts = [['044', '1000000001'], ['058', '1000000002'], ['057', '1000000003']];
  for (let i = 0; i < 3; i += 1) await app.engine.confirmShare(s.collabs[i], { accept: true, bankCode: accts[i][0], accountNumber: accts[i][1] });
  await rejectsWith(assert, app.engine.startFunding(s.client), 'FUNDING_BEFORE_CONFIRMATIONS');
  await app.engine.confirmShare(s.collabs[3], { accept: true, bankCode: '50211', accountNumber: '1000000004' });
  assert.equal(project(app, s.projectId).status, 'awaiting_funding');
  const f = await app.engine.startFunding(s.client);
  assert.match(f.authorizationUrl, /^\/checkout\/sp-chg-/);
});

test('release before funding is blocked', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  await rejectsWith(assert, app.engine.approveMilestone(s.client, 'm1'), 'RELEASE_BEFORE_FUNDING');
  await rejectsWith(assert, app.engine.submitDelivery(s.lead, 'm1', rough), 'DELIVERY_BEFORE_FUNDING');
  await rejectsWith(assert, app.engine.openDispute(s.client, 'm1', { unmetCriteria: [0], reason: 'Not what was agreed.' }), 'DISPUTE_BEFORE_FUNDING');
});

test('approval without delivery is blocked; delivery needs a real link and a note', async () => {
  const app = makeApp(); const s = await seeded(app, 'funded');
  await rejectsWith(assert, app.engine.approveMilestone(s.client, 'm1'), 'APPROVAL_WITHOUT_DELIVERY');
  await rejectsWith(assert, app.engine.submitDelivery(s.lead, 'm1', { link: '', note: 'a long enough note here' }), 'FIELD_TOO_SHORT');
  await rejectsWith(assert, app.engine.submitDelivery(s.lead, 'm1', { link: 'javascript:alert(1)', note: 'a long enough note here' }), 'URL_INVALID');
  await rejectsWith(assert, app.engine.submitDelivery(s.lead, 'm1', { link: 'https://user:pw@example.com/x', note: 'a long enough note here' }), 'URL_INVALID');
  await rejectsWith(assert, app.engine.submitDelivery(s.lead, 'm1', { link: 'https://example.com/ok', note: 'short' }), 'FIELD_TOO_SHORT');
  await rejectsWith(assert, app.engine.submitDelivery(s.lead, 'nope', rough), 'MILESTONE_NOT_FOUND');
  assert.equal(project(app, s.projectId).milestones[0].status, 'pending', 'rejected submissions change nothing');
});

test('delivery starts a 72-hour window; delivering twice is blocked', async () => {
  const app = makeApp(); const s = await seeded(app, 'funded');
  const t = app.clock.t;
  const r = await app.engine.submitDelivery(s.lead, 'm1', rough);
  assert.equal(r.reviewDeadline, t + 72 * 3_600_000);
  await rejectsWith(assert, app.engine.submitDelivery(s.lead, 'm1', rough), 'ALREADY_DELIVERED');
});

test('dispute after the review window is blocked', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  advance(app, 71);
  await app.engine.openDispute(s.client, 'm1', { unmetCriteria: [0], reason: 'Over three minutes long.' }); // still inside the window
  const app2 = makeApp(); const s2 = await seeded(app2, 'delivered');
  advance(app2, 72);
  const err = await rejectsWith(assert, app2.engine.openDispute(s2.client, 'm1', { unmetCriteria: [0], reason: 'Over three minutes long.' }), 'DISPUTE_AFTER_WINDOW');
  assert.match(err.message, /72-hour review window has ended/);
});

test('double release is blocked, even under 25 concurrent approvals', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => app.engine.approveMilestone(s.client, 'm1')));
  await app.engine.idle();
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one approval wins');
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'DOUBLE_RELEASE');
  const p = project(app, s.projectId);
  assert.equal(Object.keys(p.payouts).length, 4, 'four payouts, not one hundred');
  assert.equal(p.ledger.filter((e) => e.type === 'milestone.released').length, 1);
  assert.equal(app.store.snapshot().mock.moneyOutKobo, 40_000_000, 'the provider moved the milestone amount exactly once');
});

test('approving a milestone after it was auto-released is a double release', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  advance(app, 73); await app.engine.tick(); await app.engine.idle();
  await rejectsWith(assert, app.engine.approveMilestone(s.client, 'm1'), 'DOUBLE_RELEASE');
});

test('8. auto-release: only after delivery, only after 72 hours, and only once', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  advance(app, 71); await app.engine.tick(); await app.engine.idle();
  assert.equal(project(app, s.projectId).milestones[0].status, 'delivered', 'not at 71 hours');
  assert.equal(Object.keys(project(app, s.projectId).payouts).length, 0);

  advance(app, 2); // 73h
  for (let i = 0; i < 3; i += 1) { await app.engine.tick(); await app.engine.idle(); } // idempotent
  const p = project(app, s.projectId);
  assert.equal(p.milestones[0].status, 'closed');
  assert.equal(p.milestones[0].resolution, 'released');
  assert.equal(Object.keys(p.payouts).length, 4);
  assert.ok(Object.values(p.payouts).every((po) => po.status === 'success'));
  assert.equal(p.ledger.filter((e) => e.type === 'milestone.auto_released').length, 1);
  assert.equal(p.ledger.filter((e) => e.type === 'payout.succeeded').length, 4);
  assert.equal(app.store.snapshot().mock.moneyOutKobo, 40_000_000);

  assert.equal(p.milestones[1].status, 'pending', 'the undelivered milestone is untouched');
  advance(app, 24 * 30); await app.engine.tick(); await app.engine.idle();
  const later = project(app, s.projectId);
  assert.equal(later.milestones[1].status, 'pending', 'silence never releases a milestone that was not delivered');
  assert.equal(Object.keys(later.payouts).length, 4);
});

test('a read after the deadline also applies it (no timer needed)', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  advance(app, 80);
  const v = await app.engine.view(s.lead);
  await app.engine.idle();
  assert.equal(v.project.milestones[0].status, 'closed');
});

test('17. a frozen milestone cannot be approved, auto-released, or paid', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  await rejectsWith(assert, app.engine.approveMilestone(s.client, 'm1'), 'MILESTONE_FROZEN');

  advance(app, 80); // m1's 72h window passes while frozen, m2's does too
  await app.engine.tick(); await app.engine.idle();
  const p = project(app, s.projectId);
  assert.equal(p.milestones[0].status, 'delivered', 'frozen milestone is not auto-released');
  assert.equal(p.milestones[1].status, 'closed', 'the OTHER milestone continued normally');
  assert.equal(Object.keys(p.payouts).filter((k) => k.startsWith('po_m1_')).length, 0);
});

test('17b. defence in depth: even a queued payout on a frozen milestone is never sent', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  const moneyBefore = app.store.snapshot().mock.moneyOutKobo;
  // Force an impossible state (a queued payout for the frozen milestone) and see whether the engine still refuses.
  await app.store.transact((d) => {
    const p = d.projects[s.projectId];
    p.payouts.po_m1_c2 = { id: 'po_m1_c2', milestoneId: 'm1', collaboratorId: 'c2', amountKobo: 10_000_000, status: 'queued', attempt: 0, reference: null, transferCode: null, failureReason: null, queuedAt: 0, startedAt: null, completedAt: null, retryAfter: 0, ledgerSeq: null, ledgerHash: null, receiptNo: null };
    p.payouts.po_m1_c3 = { ...p.payouts.po_m1_c2, id: 'po_m1_c3', collaboratorId: 'c3', status: 'failed', attempt: 1, reference: 'sp-x-m1-c3-a1' };
  });
  await app.engine.runPayouts(s.projectId);
  let p = project(app, s.projectId);
  assert.equal(p.payouts.po_m1_c2.status, 'queued', 'left untouched');
  assert.equal(app.store.snapshot().mock.moneyOutKobo, moneyBefore, 'no money moved');
  await rejectsWith(assert, app.engine.retryPayout(s.lead, 'po_m1_c3'), 'PAYING_FROZEN_MILESTONE');
  p = project(app, s.projectId);
  assert.equal(p.payouts.po_m1_c3.status, 'failed');
});

test('other one-way doors: re-funding, re-confirming, unknown ids', async () => {
  const app = makeApp(); const s = await seeded(app, 'funded');
  await rejectsWith(assert, app.engine.startFunding(s.client), 'ALREADY_FUNDED');
  await rejectsWith(assert, app.engine.confirmShare(s.collabs[1], { accept: true, bankCode: '058', accountNumber: '1000000009' }), 'ALREADY_CONFIRMED');
  await rejectsWith(assert, app.engine.openDispute(s.client, 'm1', { unmetCriteria: [0], reason: 'Nothing delivered yet.' }), 'DISPUTE_WITHOUT_DELIVERY');
  await rejectsWith(assert, app.engine.retryPayout(s.lead, 'po_nope'), 'PAYOUT_NOT_FOUND');
  const v = await app.engine.view(s.lead);
  assert.equal(v.project.status, 'active');
});
