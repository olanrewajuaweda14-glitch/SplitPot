// 15 duplicate payout, 16 failed payout retry, plus the "lost response" case that causes real double payments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seeded, advance, project, rejectsWith, userProject, fundIt } from './helpers.js';
import { ProviderError } from '../src/shared/errors.js';

const moneyOut = (app) => app.store.snapshot().mock.moneyOutKobo;
const succeeded = (p) => p.ledger.filter((e) => e.type === 'payout.succeeded');

test('a release pays every collaborator the exact allocation, and the parts equal the milestone', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  const p = project(app, s.projectId);
  const amounts = ['c1', 'c2', 'c3', 'c4'].map((c) => p.payouts[`po_m1_${c}`].amountKobo);
  assert.deepEqual(amounts, [16_000_000, 10_000_000, 8_000_000, 6_000_000]);
  assert.equal(amounts.reduce((a, b) => a + b, 0), 40_000_000);
  assert.ok(Object.values(p.payouts).every((po) => po.status === 'success' && po.ledgerHash && po.receiptNo));
  assert.equal(moneyOut(app), 40_000_000);
});

test('awkward kobo: each milestone pays out to the kobo, even with 33.34/33.33/33.33 shares', async () => {
  const app = makeApp(); const u = await userProject(app);
  await fundIt(app, u.client);
  for (const [id, amount] of [['m1', 100_001], ['m2', 250_007]]) {
    await app.engine.submitDelivery(u.lead, id, { link: 'https://example.com/x', note: 'Delivered, please review.' });
    await app.engine.approveMilestone(u.client, id); await app.engine.idle();
    const paid = Object.values(project(app, u.projectId).payouts).filter((po) => po.milestoneId === id).reduce((a, po) => a + po.amountKobo, 0);
    assert.equal(paid, amount, `${id} payouts add up to the milestone`);
  }
  assert.equal(moneyOut(app), 350_008);
  assert.equal(project(app, u.projectId).status, 'completed');
});

test('payout references satisfy the documented Paystack format (16-50 chars, [a-z0-9_-])', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  for (const po of Object.values(project(app, s.projectId).payouts)) assert.match(po.reference, /^[a-z0-9_-]{16,50}$/);
});

test('15. duplicate payout: approval racing six extra payout runs still pays each person once', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  await app.engine.approveMilestone(s.client, 'm1'); // starts a background payout run
  await Promise.all(Array.from({ length: 6 }, () => app.engine.runPayouts(s.projectId)));
  await app.engine.idle();
  const p = project(app, s.projectId);
  assert.equal(moneyOut(app), 40_000_000, 'money left the platform exactly once');
  assert.equal(succeeded(p).length, 4, 'one payout.succeeded entry per person');
  assert.ok(Object.values(p.payouts).every((po) => po.attempt === 1));
  await app.engine.tick(); await app.engine.idle();
  assert.equal(moneyOut(app), 40_000_000);
});

test('15b. the provider itself refuses to send the same reference twice', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  const po = project(app, s.projectId).payouts.po_m1_c2;
  const c = project(app, s.projectId).collaborators[1];
  const again = await app.provider.bulkTransfer({ transfers: [{ reference: po.reference, recipientCode: c.recipientCode, amountKobo: po.amountKobo, reason: 'replay' }] });
  assert.equal(again.results[0].duplicate, true);
  assert.equal(moneyOut(app), 40_000_000);
});

test('16. a failed payout shows a clear reason, does not block the others, and retries safely', async () => {
  const app = makeApp(); const s = await seeded(app, 'funded');
  await app.demo.useFailingAccount();
  await app.engine.submitDelivery(s.lead, 'm1', { link: 'https://example.com/r', note: 'Rough cut delivered.' });
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();

  let p = project(app, s.projectId);
  const sound = p.payouts.po_m1_c4;
  assert.equal(sound.status, 'failed');
  assert.match(sound.failureReason, /simulated failure for the designated test account ending 0404/);
  assert.deepEqual(['c1', 'c2', 'c3'].map((c) => p.payouts[`po_m1_${c}`].status), ['success', 'success', 'success']);
  assert.equal(moneyOut(app), 34_000_000, 'the three good payouts went out; Sound did not');
  assert.ok(p.ledger.some((e) => e.type === 'payout.failed' && e.data.collaboratorId === 'c4'));
  assert.equal(p.status, 'active', 'a failed payout keeps the project from completing');
  const view = await app.engine.view(s.lead);
  assert.equal(view.project.pot.channels[3].state, 'failed');
  assert.equal(view.project.pot.bands[0].state, 'payout_failed');

  // only the lead can retry
  await rejectsWith(assert, app.engine.retryPayout(s.collabs[3], 'po_m1_c4'), 'ROLE_FORBIDDEN');
  await rejectsWith(assert, app.engine.retryPayout(s.client, 'po_m1_c4'), 'ROLE_FORBIDDEN');

  await app.engine.retryPayout(s.lead, 'po_m1_c4'); await app.engine.idle();
  p = project(app, s.projectId);
  assert.equal(p.payouts.po_m1_c4.status, 'success');
  assert.equal(p.payouts.po_m1_c4.attempt, 2);
  assert.match(p.payouts.po_m1_c4.reference, /-a2$/);
  assert.equal(moneyOut(app), 40_000_000, 'total paid equals the milestone: nobody paid twice');
  assert.deepEqual(['c1', 'c2', 'c3'].map((c) => p.payouts[`po_m1_${c}`].attempt), [1, 1, 1], 'good payouts were not re-sent');

  await rejectsWith(assert, app.engine.retryPayout(s.lead, 'po_m1_c4'), 'PAYOUT_ALREADY_PAID');
  await rejectsWith(assert, app.engine.retryPayout(s.lead, 'po_m1_c1'), 'PAYOUT_ALREADY_PAID');
  assert.equal(moneyOut(app), 40_000_000);
});

test('16b. lost response: the provider paid but we never heard back. Retrying cannot double-pay.', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  const real = app.provider.bulkTransfer.bind(app.provider);
  let calls = 0;
  app.provider.bulkTransfer = async (args) => {
    calls += 1;
    const out = await real(args); // the money really moved...
    if (calls === 1) throw new ProviderError('PROVIDER_UNREACHABLE', 'Connection dropped before the response arrived.'); // ...but we never saw the answer
    return out;
  };
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  let p = project(app, s.projectId);
  assert.ok(Object.values(p.payouts).every((po) => po.status === 'unknown'), 'ambiguous outcome is "unknown", never "failed"');
  const refsBefore = Object.values(p.payouts).map((po) => po.reference);
  assert.equal(moneyOut(app), 40_000_000);

  // backoff: nothing is hammered immediately
  await app.engine.tick(); await app.engine.idle();
  assert.equal(calls, 1);

  advance(app, 0.1); // 6 minutes, past the backoff
  await app.engine.tick(); await app.engine.idle();
  p = project(app, s.projectId);
  assert.ok(Object.values(p.payouts).every((po) => po.status === 'success'));
  assert.deepEqual(Object.values(p.payouts).map((po) => po.reference), refsBefore, 'the SAME references were reused, so the provider de-duplicated');
  assert.equal(moneyOut(app), 40_000_000, 'still exactly one milestone paid out');
  assert.equal(succeeded(p).length, 4);
});

test('16c. the provider was unreachable and nothing was sent: retry with the same reference pays once', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  const real = app.provider.bulkTransfer.bind(app.provider);
  let down = true;
  app.provider.bulkTransfer = async (args) => { if (down) throw new ProviderError('PROVIDER_UNREACHABLE', 'Could not reach the provider.'); return real(args); };
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  assert.equal(moneyOut(app), 0);
  down = false;
  await app.engine.retryPayout(s.lead, 'po_m1_c1'); await app.engine.idle();
  assert.equal(project(app, s.projectId).payouts.po_m1_c1.status, 'success');
  assert.equal(moneyOut(app), 16_000_000, 'only the retried payout moved');
  advance(app, 1); await app.engine.tick(); await app.engine.idle();
  assert.equal(moneyOut(app), 40_000_000);
});

test('a definitive provider rejection is a failure with the provider\'s reason, not "unknown"', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  const real = app.provider.bulkTransfer.bind(app.provider);
  let reject = true;
  app.provider.bulkTransfer = async (a) => { if (reject) throw new ProviderError('PROVIDER_REJECTED', 'Insufficient balance for this batch.'); return real(a); };
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  const p = project(app, s.projectId);
  assert.ok(Object.values(p.payouts).every((po) => po.status === 'failed' && po.failureReason === 'Insufficient balance for this batch.'));
  reject = false;
  for (const id of Object.keys(p.payouts)) await app.engine.retryPayout(s.lead, id);
  await app.engine.idle();
  assert.equal(moneyOut(app), 40_000_000);
});

test('a receipt exists only for a successful payout and references its ledger entry hash', async () => {
  const app = makeApp(); const s = await seeded(app, 'funded');
  await app.demo.useFailingAccount();
  await app.engine.submitDelivery(s.lead, 'm1', { link: 'https://example.com/r', note: 'Rough cut delivered.' });
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  await rejectsWith(assert, app.engine.receipt(s.collabs[3], 'po_m1_c4'), 'RECEIPT_NOT_READY');
  const r = await app.engine.receipt(s.collabs[1], 'po_m1_c2');
  const entry = project(app, s.projectId).ledger[r.ledger.seq - 1];
  assert.equal(entry.type, 'payout.succeeded');
  assert.equal(r.ledger.hash, entry.hash);
  assert.equal(r.ledger.prevHash, entry.prevHash);
  assert.equal(r.ledger.matchesChain, true);
  assert.equal(r.amountKobo, 10_000_000);
  assert.equal(r.simulated, true);
  assert.equal(r.recipient.masked, '••••••0002');
  assert.ok(!JSON.stringify(r).includes('1000000002'), 'full account number never leaves the server');
  assert.equal(r.chain.text, 'Chain verified');
});
