// 10-14: webhook signature, amount, currency, duplicates.  Funding is never marked from a redirect or an unverified claim.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seeded, project, rejectsWith, fundIt, userProject } from './helpers.js';
import { signPayload } from '../src/providers/webhookSignature.js';
import { SignatureError } from '../src/shared/errors.js';

const secretOf = (app) => app.store.snapshot().mock.secret;
const events = (app) => Object.keys(app.store.snapshot().webhookEvents).length;

test('10. a validly signed webhook funds the pot, after the server verifies the charge itself', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  assert.equal(project(app, s.projectId).funding.status, 'unfunded');
  const { reference, ack } = await fundIt(app, s.client);
  assert.deepEqual(ack, { received: true, duplicate: false });
  const p = project(app, s.projectId);
  assert.equal(p.status, 'active');
  assert.equal(p.funding.status, 'funded');
  assert.equal(p.funding.reference, reference);
  const e = p.ledger.find((x) => x.type === 'funding.verified');
  assert.equal(e.data.paidKobo, 101_500_000);
  assert.equal(e.data.potKobo, 100_000_000);
  assert.equal(e.data.feeKobo, 1_500_000);
  assert.equal(e.data.verification, 'signature+server-side-verify+amount+currency');
});

test('starting a payment, or visiting the callback page, never funds anything', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  const { reference } = await app.engine.startFunding(s.client);
  await app.engine.view(s.client); await app.engine.view(s.client); // "browser redirect": just reads
  assert.equal(project(app, s.projectId).funding.status, 'unfunded');
  // even a paid charge is not "funded" until the signed webhook is processed
  await app.provider.completeCheckout(reference, { outcome: 'success' });
  assert.equal(project(app, s.projectId).funding.status, 'unfunded');
});

test('11. an invalid signature is rejected and records nothing', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  const { reference } = await app.engine.startFunding(s.client);
  const { webhook } = await app.provider.completeCheckout(reference, { outcome: 'success' });

  const flipped = Buffer.from(webhook.rawBody); flipped[flipped.length - 4] ^= 0x01;
  const wrongSecret = { 'x-paystack-signature': signPayload('not-the-secret', webhook.rawBody) };
  const attempts = [
    ['body altered after signing', flipped, webhook.headers],
    ['no signature header', webhook.rawBody, {}],
    ['garbage signature', webhook.rawBody, { 'x-paystack-signature': 'abc' }],
    ['right length, wrong value', webhook.rawBody, { 'x-paystack-signature': 'a'.repeat(128) }],
    ['signed with another secret', webhook.rawBody, wrongSecret],
    ['signature of an empty body', webhook.rawBody, { 'x-paystack-signature': signPayload(secretOf(app), Buffer.alloc(0)) }],
  ];
  for (const [name, raw, headers] of attempts) {
    const err = await rejectsWith(assert, app.engine.handleWebhook(raw, headers), 'WEBHOOK_SIGNATURE_INVALID');
    assert.ok(err instanceof SignatureError, name);
    assert.equal(err.status, 401, name);
  }
  assert.equal(events(app), 0, 'nothing recorded for rejected webhooks');
  assert.equal(project(app, s.projectId).funding.status, 'unfunded');
  // and the genuine one still works afterwards
  const ok = await app.engine.handleWebhook(webhook.rawBody, webhook.headers); await ok.done;
  assert.equal(project(app, s.projectId).funding.status, 'funded');
});

test('12. incorrect payment amount is rejected: the project stays unfunded and the ledger says why', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  await fundIt(app, s.client, { shortfallKobo: 100_000 }); // client pays ₦1,000 short
  const p = project(app, s.projectId);
  assert.equal(p.funding.status, 'unfunded');
  assert.equal(p.status, 'awaiting_funding');
  const rej = p.ledger.find((x) => x.type === 'funding.rejected');
  assert.equal(rej.data.reason, 'amount_mismatch');
  assert.equal(rej.data.expectedKobo, 101_500_000);
  assert.equal(rej.data.receivedKobo, 101_400_000);
  assert.ok(!p.ledger.some((x) => x.type === 'funding.verified'));
  // the client can try again and pay properly
  await fundIt(app, s.client);
  assert.equal(project(app, s.projectId).funding.status, 'funded');
});

test('13. incorrect currency is rejected', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  await fundIt(app, s.client, { currency: 'USD' });
  const p = project(app, s.projectId);
  assert.equal(p.funding.status, 'unfunded');
  const rej = p.ledger.find((x) => x.type === 'funding.rejected');
  assert.equal(rej.data.reason, 'currency_mismatch');
  assert.equal(rej.data.receivedCurrency, 'USD');
});

test('14. a duplicate webhook is acknowledged but changes nothing', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  const { webhook } = await fundIt(app, s.client);
  const before = project(app, s.projectId).ledger.length;
  for (let i = 0; i < 3; i += 1) {
    const r = await app.engine.handleWebhook(webhook.rawBody, webhook.headers); await r.done;
    assert.deepEqual(r.ack, { received: true, duplicate: true });
  }
  const p = project(app, s.projectId);
  assert.equal(p.ledger.length, before);
  assert.equal(p.ledger.filter((x) => x.type === 'funding.verified').length, 1);
  assert.equal(events(app), 1);
});

test('a signed webhook claiming success for a charge the provider says is unpaid does not fund', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  const { reference } = await app.engine.startFunding(s.client); // charge exists but was never paid
  const forged = app.provider.signWebhook({ event: 'charge.success', data: { reference, status: 'success', amount: 101_500_000, currency: 'NGN' } });
  const r = await app.engine.handleWebhook(forged.rawBody, forged.headers); await r.done;
  assert.equal(project(app, s.projectId).funding.status, 'unfunded', 'the server-side verification decides, not the webhook body');
  const ev = Object.values(app.store.snapshot().webhookEvents)[0];
  assert.match(ev.note, /not funded/);
});

test('webhooks for unknown references are recorded and ignored', async () => {
  const app = makeApp(); await seeded(app, 'ready');
  const w = app.provider.signWebhook({ event: 'charge.success', data: { reference: 'sp-chg-doesnotexist-1', status: 'success', amount: 1, currency: 'NGN' } });
  const r = await app.engine.handleWebhook(w.rawBody, w.headers); await r.done;
  assert.equal(Object.values(app.store.snapshot().webhookEvents)[0].status, 'ignored');
});

test('two payments for one project: the second is flagged as a duplicate payment, never double-funds', async () => {
  const app = makeApp(); const s = await seeded(app, 'ready');
  const [a, b] = await Promise.all([app.engine.startFunding(s.client), app.engine.startFunding(s.client)]);
  assert.notEqual(a.reference, b.reference);
  for (const ref of [a.reference, b.reference]) {
    const { webhook } = await app.provider.completeCheckout(ref, { outcome: 'success' });
    const r = await app.engine.handleWebhook(webhook.rawBody, webhook.headers); await r.done;
  }
  const p = project(app, s.projectId);
  assert.equal(p.funding.status, 'funded');
  assert.equal(p.ledger.filter((x) => x.type === 'funding.verified').length, 1);
  assert.equal(p.ledger.filter((x) => x.type === 'funding.duplicate_detected').length, 1);
});

test('transfer webhooks settle async payouts exactly once; stale references and reversals are handled', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  const real = app.provider.bulkTransfer.bind(app.provider);
  app.provider.bulkTransfer = async ({ transfers }) => ({ results: transfers.map((t) => ({ reference: t.reference, status: 'pending' })) }); // Paystack-style "queued"
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  let p = project(app, s.projectId);
  assert.ok(Object.values(p.payouts).every((po) => po.status === 'processing'), 'pending is not paid');
  const po = p.payouts.po_m1_c2;

  const send = async (event, reference, extra = {}) => {
    const w = app.provider.signWebhook({ event, data: { reference, status: event.split('.')[1], amount: po.amountKobo, currency: 'NGN', ...extra } });
    const r = await app.engine.handleWebhook(w.rawBody, w.headers); await r.done;
  };
  await send('transfer.success', po.reference);
  await send('transfer.success', po.reference); // duplicate delivery (identical bytes)
  await send('transfer.success', 'sp-unknown-m1-c9-a1');
  p = project(app, s.projectId);
  assert.equal(p.payouts.po_m1_c2.status, 'success');
  assert.equal(p.ledger.filter((e) => e.type === 'payout.succeeded' && e.data.payoutId === 'po_m1_c2').length, 1);
  assert.match(p.payouts.po_m1_c2.receiptNo, /^SP-/);

  await send('transfer.failed', p.payouts.po_m1_c3.reference, { reason: 'Account closed' });
  p = project(app, s.projectId);
  assert.equal(p.payouts.po_m1_c3.status, 'failed');
  assert.equal(p.payouts.po_m1_c3.failureReason, 'Account closed');

  await send('transfer.reversed', p.payouts.po_m1_c2.reference); // money came back after success
  p = project(app, s.projectId);
  assert.equal(p.payouts.po_m1_c2.status, 'reversed');

  app.provider.bulkTransfer = real; // provider is healthy again: retries now go through
  await app.engine.retryPayout(s.lead, 'po_m1_c3'); await app.engine.retryPayout(s.lead, 'po_m1_c2'); await app.engine.idle();
  p = project(app, s.projectId);
  assert.equal(p.payouts.po_m1_c3.status, 'success');
  assert.equal(p.payouts.po_m1_c3.attempt, 2);
  assert.notEqual(p.payouts.po_m1_c3.reference, 'sp-' + p.id + '-m1-c3-a1');
  assert.equal(p.payouts.po_m1_c2.attempt, 2);
});

test('the webhook secret differs per store and never appears in any view, ledger or error', async () => {
  const app = makeApp(); const s = await seeded(app, 'funded');
  const secret = secretOf(app);
  assert.match(secret, /^[0-9a-f]{64}$/);
  const dumps = [];
  for (const t of [s.lead, s.client, s.reviewer, ...s.collabs]) dumps.push(JSON.stringify(await app.engine.view(t)));
  dumps.push(JSON.stringify(await app.engine.publicLedger(s.publicId)));
  try { await app.engine.view('x'.repeat(43)); } catch (e) { dumps.push(JSON.stringify(e.toJSON())); }
  for (const d of dumps) assert.ok(!d.includes(secret));
});
