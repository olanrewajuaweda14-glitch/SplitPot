// Paystack adapter CONTRACT tests against a fake HTTP layer.
// These prove our adapter sends the requests the DOCS describe and maps the documented responses.
// They do NOT prove Paystack behaves that way: nothing here talks to the real API (see docs/PAYSTACK_VERIFICATION.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaystackProvider } from '../src/providers/paystack.js';
import { signPayload } from '../src/providers/webhookSignature.js';
import { JsonStore } from '../src/storage/jsonStore.js';
import { Engine, initialState } from '../src/engine/engine.js';
import { rejectsWith } from './helpers.js';

const KEY = 'sk_test_unit_test_key_not_real';
const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function fakePaystack(overrides = {}) {
  const calls = [];
  const charges = {};
  const handlers = {
    'GET /bank': () => resp(200, { status: true, data: [{ name: 'Access Bank', code: '044' }, { name: 'Zenith Bank', code: '057' }] }),
    'GET /bank/resolve': (_i, u) => resp(200, { status: true, data: { account_number: u.searchParams.get('account_number'), account_name: 'TEST PERSON' } }),
    'POST /transaction/initialize': (i) => { const b = JSON.parse(i.body); charges[b.reference] = b; return resp(200, { status: true, data: { authorization_url: `https://checkout.paystack.com/${b.reference}`, access_code: 'ac_1', reference: b.reference } }); },
    'GET /transferrecipient': () => resp(404, { status: false, message: 'n/a' }),
    'POST /transferrecipient': () => resp(201, { status: true, data: { recipient_code: 'RCP_abc123' } }),
    'POST /transfer/bulk': (i) => resp(200, { status: true, message: 'queued', data: JSON.parse(i.body).transfers.map((t) => ({ reference: t.reference, recipient: t.recipient, amount: t.amount, transfer_code: `TRF_${t.reference.slice(-4)}`, currency: 'NGN', status: 'pending' })) }),
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ host: u.host, method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const h = Object.entries(handlers).find(([k]) => k === `${init.method} ${u.pathname}` || (k.endsWith('/*') && `${init.method} ${u.pathname}`.startsWith(k.slice(0, -1))));
    return h ? h[1](init, u) : resp(404, { status: false, message: 'not found' });
  };
  return { fetchImpl, calls, charges };
}

test('refuses to start without a secret key', () => {
  assert.throws(() => createPaystackProvider({ secretKey: '' }), /PAYSTACK_SECRET_KEY/);
});

test('initialize: POST /transaction/initialize with the secret as a Bearer header, to api.paystack.co only', async () => {
  const f = fakePaystack(); const p = createPaystackProvider({ secretKey: KEY, fetchImpl: f.fetchImpl });
  const r = await p.initializeCharge({ reference: 'sp-chg-p1-1', amountKobo: 101_500_000, currency: 'NGN', email: 'c@example.com', callbackUrl: 'https://x.test/paid', metadata: { projectId: 'p1' } });
  assert.equal(r.authorizationUrl, 'https://checkout.paystack.com/sp-chg-p1-1');
  const c = f.calls[0];
  assert.deepEqual([c.host, c.method, c.path], ['api.paystack.co', 'POST', '/transaction/initialize']);
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.body.amount, '101500000', 'amount is integer kobo');
  assert.equal(c.body.reference, 'sp-chg-p1-1');
  assert.ok(!JSON.stringify(c.body).includes(KEY), 'the key is never in a request body');
});

test('verify: reads data.status, data.amount and data.currency', async () => {
  const f = fakePaystack({ 'GET /transaction/verify/*': () => resp(200, { status: true, data: { status: 'success', amount: 101_500_000, currency: 'NGN', reference: 'sp-chg-p1-1' } }) });
  const p = createPaystackProvider({ secretKey: KEY, fetchImpl: f.fetchImpl });
  assert.deepEqual(await p.verifyCharge('sp-chg-p1-1'), { reference: 'sp-chg-p1-1', status: 'success', amountKobo: 101_500_000, currency: 'NGN' });
  assert.equal(f.calls[0].path, '/transaction/verify/sp-chg-p1-1');
  assert.equal(f.calls[0].method, 'GET');
});

test('banks, account resolution and transfer recipients use the documented endpoints and fields', async () => {
  const f = fakePaystack(); const p = createPaystackProvider({ secretKey: KEY, fetchImpl: f.fetchImpl });
  assert.deepEqual(await p.listBanks(), [{ name: 'Access Bank', code: '044' }, { name: 'Zenith Bank', code: '057' }]);
  assert.deepEqual(await p.resolveAccount({ accountNumber: '0123456789', bankCode: '044' }), { accountNumber: '0123456789', bankCode: '044', accountName: 'TEST PERSON' });
  assert.deepEqual(f.calls[1].query, { account_number: '0123456789', bank_code: '044' });
  assert.deepEqual(await p.createRecipient({ name: 'TEST PERSON', accountNumber: '0123456789', bankCode: '044' }), { recipientCode: 'RCP_abc123' });
  assert.deepEqual(f.calls[2].body, { type: 'nuban', name: 'TEST PERSON', account_number: '0123456789', bank_code: '044', currency: 'NGN' });
  assert.equal(f.calls[2].path, '/transferrecipient');
});

test('bulk transfer: documented body, max 100 per batch, one batch every 5 seconds, pending is not paid', async () => {
  const f = fakePaystack(); const waits = [];
  const p = createPaystackProvider({ secretKey: KEY, fetchImpl: f.fetchImpl, sleepImpl: async (ms) => { waits.push(ms); } });
  const transfers = Array.from({ length: 150 }, (_, i) => ({ reference: `sp-test-m1-c${i}-a1`.padEnd(20, 'x'), recipientCode: `RCP_${i}`, amountKobo: 1000 + i, reason: 'SplitPot test' }));
  const { results } = await p.bulkTransfer({ transfers });
  const bulk = f.calls.filter((c) => c.path === '/transfer/bulk');
  assert.deepEqual(bulk.map((c) => c.body.transfers.length), [100, 50]);
  assert.deepEqual([bulk[0].body.currency, bulk[0].body.source], ['NGN', 'balance']);
  assert.deepEqual(Object.keys(bulk[0].body.transfers[0]).sort(), ['amount', 'reason', 'recipient', 'reference']);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 4900 && waits[0] <= 5000, `waited ~5s between batches, got ${waits[0]}`);
  assert.equal(results.length, 150);
  assert.ok(results.every((r) => r.status === 'pending'), 'a queued transfer is NOT reported as paid');
});

test('bulk transfer statuses map: success -> success, failed/reversed -> failed, queued/pending/otp -> pending', async () => {
  const f = fakePaystack({ 'POST /transfer/bulk': () => resp(200, { status: true, data: [
    { reference: 'a', status: 'success' }, { reference: 'b', status: 'failed' }, { reference: 'c', status: 'reversed' }, { reference: 'd', status: 'otp' }, { reference: 'e', status: 'queued' },
  ] }) });
  const p = createPaystackProvider({ secretKey: KEY, fetchImpl: f.fetchImpl });
  const { results } = await p.bulkTransfer({ transfers: [{ reference: 'a', recipientCode: 'r', amountKobo: 1, reason: 'x' }] });
  assert.deepEqual(results.map((r) => r.status), ['success', 'failed', 'failed', 'pending', 'pending']);
});

test('errors: HTTP errors are definitive rejections, network errors are UNKNOWN outcomes', async () => {
  const f = fakePaystack({ 'POST /transfer/bulk': () => resp(400, { status: false, message: 'You cannot initiate third party payouts as a starter business' }) });
  const p = createPaystackProvider({ secretKey: KEY, fetchImpl: f.fetchImpl });
  const e1 = await rejectsWith(assert, p.bulkTransfer({ transfers: [{ reference: 'a', recipientCode: 'r', amountKobo: 1, reason: 'x' }] }), 'PROVIDER_REJECTED');
  assert.match(e1.message, /third party payouts/);
  const p2 = createPaystackProvider({ secretKey: KEY, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await rejectsWith(assert, p2.verifyCharge('x'), 'PROVIDER_UNREACHABLE');
  const p3 = createPaystackProvider({ secretKey: KEY, fetchImpl: async () => resp(200, { status: false, message: 'Transaction reference not found' }) });
  await rejectsWith(assert, p3.verifyCharge('x'), 'PROVIDER_REJECTED');
});

test('webhooks: x-paystack-signature is HMAC-SHA512 of the RAW body; compared in constant time', () => {
  const p = createPaystackProvider({ secretKey: KEY, fetchImpl: async () => resp(200, {}) });
  const raw = Buffer.from('{"event":"charge.success","data":{"reference":"sp-chg-p1-1","status":"success","amount":5000,"currency":"NGN"}}');
  const sig = signPayload(KEY, raw);
  assert.match(sig, /^[0-9a-f]{128}$/);
  const evt = p.parseAndVerifyWebhook(raw, { 'x-paystack-signature': sig });
  assert.deepEqual([evt.type, evt.reference, evt.amountKobo, evt.currency], ['charge.success', 'sp-chg-p1-1', 5000, 'NGN']);
  // whitespace changes the raw bytes, so a re-serialised body no longer matches
  assert.throws(() => p.parseAndVerifyWebhook(Buffer.from(JSON.stringify(JSON.parse(raw), null, 2)), { 'x-paystack-signature': sig }), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  assert.throws(() => p.parseAndVerifyWebhook(raw, { 'x-paystack-signature': signPayload('other-key', raw) }), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  assert.throws(() => p.parseAndVerifyWebhook(raw, {}), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  assert.throws(() => p.parseAndVerifyWebhook(raw.toString(), { 'x-paystack-signature': sig }), { code: 'WEBHOOK_SIGNATURE_INVALID' }, 'a parsed/stringified body is refused');
});

test('engine + Paystack adapter end to end against the fake: funded only after verify matches amount and currency', async () => {
  let verifyAmount = 101_500_000; let verifyCurrency = 'NGN'; let verifyStatus = 'success';
  const f = fakePaystack({ 'GET /transaction/verify/*': () => resp(200, { status: true, data: { status: verifyStatus, amount: verifyAmount, currency: verifyCurrency } }) });
  const store = new JsonStore({ file: null, initial: () => initialState({ mock: false }) });
  const provider = createPaystackProvider({ secretKey: KEY, fetchImpl: f.fetchImpl, sleepImpl: async () => {} });
  const engine = new Engine({ store, provider, config: { demoMode: false } });
  const out = await engine.createProject({
    title: 'T', clientName: 'C', clientEmail: 'c@example.com',
    collaborators: [{ name: 'A', role: 'Lead', bps: 5000 }, { name: 'B', role: 'Editor', bps: 5000 }],
    milestones: [{ title: 'M1', amountKobo: 100_000_000, criteria: ['Delivered.'] }],
  });
  const tok = (p) => p.split('/').pop();
  for (const [i, c] of out.links.collaborators.entries()) await engine.confirmShare(tok(c.path), { accept: true, bankCode: '044', accountNumber: `300000000${i}` });
  const { reference, authorizationUrl } = await engine.startFunding(tok(out.links.client));
  assert.match(authorizationUrl, /^https:\/\/checkout\.paystack\.com\//);
  const hook = (event, data) => { const raw = Buffer.from(JSON.stringify({ event, data })); return [raw, { 'x-paystack-signature': signPayload(KEY, raw) }]; };

  verifyAmount = 101_400_000; // Paystack says the customer paid less than we expected
  let r = await engine.handleWebhook(...hook('charge.success', { reference, status: 'success', amount: 101_500_000, currency: 'NGN' })); await r.done;
  assert.equal(store.snapshot().projects[out.projectId].funding.status, 'unfunded', 'the webhook body said OK but verification disagreed');

  const second = await engine.startFunding(tok(out.links.client));
  verifyAmount = 101_500_000;
  r = await engine.handleWebhook(...hook('charge.success', { reference: second.reference, status: 'success', amount: 101_500_000, currency: 'NGN' })); await r.done;
  assert.equal(store.snapshot().projects[out.projectId].funding.status, 'funded');
  const verifyCalls = f.calls.filter((c) => c.path.startsWith('/transaction/verify/'));
  assert.equal(verifyCalls.length, 2, 'every funding decision was preceded by a server-side verify call');
  assert.ok(f.calls.every((c) => c.host === 'api.paystack.co'));
  assert.ok(f.calls.every((c) => c.headers.Authorization === `Bearer ${KEY}`));
});
