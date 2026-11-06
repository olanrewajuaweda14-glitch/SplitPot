// The whole product over real HTTP: create -> confirm -> fund (signed webhook over the wire) -> deliver -> approve -> payouts -> receipts -> ledger.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { signPayload } from '../src/providers/webhookSignature.js';

async function boot(env = {}) {
  const app = makeApp(env);
  await app.listen(0);
  const base = `http://127.0.0.1:${app.port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); } };
  return { app, call, base, until, close: () => app.close() };
}
const tok = (p) => p.split('/').pop();

test('FULL JOURNEY over HTTP: create -> confirm -> fund -> deliver -> approve -> payouts -> receipts -> ledger verifies', async (t) => {
  const { app, call, until, close } = await boot(); t.after(close);

  const created = await call('POST', '/api/projects', {
    title: 'Music video', clientName: 'Client Studio', clientEmail: 'client@example.com',
    collaborators: [{ name: 'Director', role: 'Lead', bps: 4000, bankCode: '044', accountNumber: '1000000001' }, { name: 'Editor', role: 'Collaborator', bps: 2500 }, { name: 'Camera', role: 'Collaborator', bps: 2000 }, { name: 'Sound', role: 'Collaborator', bps: 1500 }],
    milestones: [{ title: 'Rough cut', amountKobo: 40_000_000, criteria: ['At most three minutes.', 'All shot-list scenes included.'] }, { title: 'Final edit', amountKobo: 60_000_000, criteria: ['Three to four minutes.'] }],
  });
  assert.equal(created.status, 200);
  const L = { lead: tok(created.json.links.lead), client: tok(created.json.links.client), collabs: created.json.links.collaborators.map((c) => tok(c.path)), ledger: tok(created.json.links.ledger) };

  // client cannot pay yet
  let r = await call('POST', `/api/p/${L.client}/fund`, {});
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'FUNDING_BEFORE_CONFIRMATIONS');

  const banks = (await call('GET', '/api/config')).json.banks;
  assert.ok(banks.length >= 5);
  for (const [i, [bank, acct]] of [['044', '1000000001'], ['058', '1000000002'], ['057', '1000000003'], ['50211', '1000000004']].entries()) {
    const name = await call('POST', `/api/p/${L.collabs[i]}/resolve-account`, { bankCode: bank, accountNumber: acct });
    assert.equal(name.status, 200); assert.match(name.json.accountName, /TEST ACCOUNT/); assert.match(name.json.masked, /^••••••\d{4}$/);
    r = await call('POST', `/api/p/${L.collabs[i]}/confirm`, { accept: true, bankCode: bank, accountNumber: acct });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.equal((await call('GET', `/api/p/${L.client}`)).json.project.status, 'awaiting_funding');

  // fund: initialise -> simulated checkout -> signed webhook delivered by the server over HTTP
  r = await call('POST', `/api/p/${L.client}/fund`, {});
  assert.equal(r.status, 200);
  const ref = r.json.reference; assert.match(r.json.authorizationUrl, /^\/checkout\/sp-chg-/);
  const info = await call('GET', `/api/mock/checkout/${ref}`);
  assert.deepEqual([info.json.amountKobo, info.json.currency, info.json.simulated], [101_500_000, 'NGN', true]);
  r = await call('POST', `/api/mock/checkout/${ref}/complete`, { outcome: 'success' });
  assert.deepEqual([r.json.delivered, r.json.webhookStatus], [true, 200]);
  await until(async () => (await call('GET', `/api/p/${L.client}`)).json.project.funding.status === 'funded');

  // deliver + approve
  r = await call('POST', `/api/p/${L.lead}/milestones/m1/deliver`, { link: 'https://example.com/rough', note: 'Rough cut v1, all scenes in.' });
  assert.equal(r.status, 200);
  r = await call('POST', `/api/p/${L.client}/milestones/m1/approve`, {});
  assert.equal(r.status, 200);
  const done = await until(async () => { const v = (await call('GET', `/api/p/${L.lead}`)).json; return v.project.payouts.length === 4 && v.project.payouts.every((p) => p.status === 'success') ? v : null; });
  assert.deepEqual(done.project.payouts.map((p) => p.amountKobo).sort((a, b) => a - b), [6_000_000, 8_000_000, 10_000_000, 16_000_000]);

  // receipts: collaborator opens their own; it carries the ledger entry hash
  const mine = done.project.payouts.find((p) => p.name === 'Editor');
  const rc = await call('GET', `/api/p/${L.collabs[1]}/receipts/${mine.id}`);
  assert.equal(rc.status, 200);
  assert.equal(rc.json.ledger.hash, mine.ledgerHash);
  assert.equal(rc.json.simulated, true);
  const other = done.project.payouts.find((p) => p.name === 'Camera');
  assert.equal((await call('GET', `/api/p/${L.collabs[1]}/receipts/${other.id}`)).status, 403);

  // public ledger
  const led = await call('GET', `/api/ledger/${L.ledger}`);
  assert.equal(led.json.verification.text, 'Chain verified');
  assert.deepEqual(led.json.entries.map((e) => e.type).filter((x) => /^(funding|milestone|payout)/.test(x)).slice(0, 4), ['funding.initiated', 'funding.verified', 'milestone.delivered', 'milestone.approved']);
  for (const secret of [L.lead, L.client, ...L.collabs]) assert.ok(!led.text.includes(secret));
});

test('HTTP: statuses and error shapes for bad tokens, wrong roles, bad JSON, wrong content type, huge bodies', async (t) => {
  const { call, base, close } = await boot(); t.after(close);
  const s = (await call('POST', '/api/demo/stage', { stage: 'delivered' })).json;
  const T = (p) => tok(p);
  let r = await call('GET', '/api/p/not-a-real-token-not-a-real-token');
  assert.equal(r.status, 401); assert.equal(r.json.error.code, 'TOKEN_INVALID');
  r = await call('POST', `/api/p/${T(s.links.collaborators[1].path)}/milestones/m1/approve`, {});
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'ROLE_FORBIDDEN');
  r = await call('POST', `/api/p/${T(s.links.client)}/milestones/zz/approve`, {});
  assert.equal(r.status, 404);
  r = await fetch(`${base}/api/p/${T(s.links.client)}/milestones/m1/dispute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nope' });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'JSON_INVALID');
  r = await fetch(`${base}/api/p/${T(s.links.client)}/milestones/m1/dispute`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"a":1}' });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'CONTENT_TYPE');
  r = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(200_000) }) });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'BODY_TOO_LARGE');
  r = await call('GET', '/api/nope'); assert.equal(r.status, 404);
  r = await call('POST', '/api/projects', { title: 'T' }); assert.equal(r.status, 400);
  assert.ok(r.json.error.message.length > 10);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('HTTP webhook endpoint: 401 on a bad signature (nothing recorded), 200 + duplicate flag on a replay', async (t) => {
  const { app, call, base, close } = await boot(); t.after(close);
  const s = (await call('POST', '/api/demo/stage', { stage: 'ready' })).json;
  const fund = await call('POST', `/api/p/${tok(s.links.client)}/fund`, {});
  const { webhook } = await app.provider.completeCheckout(fund.json.reference, { outcome: 'success' });
  const send = (headers, body = webhook.rawBody) => fetch(`${base}/api/webhooks/payment`, { method: 'POST', headers, body });

  let r = await send({ 'content-type': 'application/json' });
  assert.equal(r.status, 401);
  r = await send({ 'content-type': 'application/json', 'x-paystack-signature': signPayload('wrong', webhook.rawBody) });
  assert.equal(r.status, 401); assert.equal((await r.json()).error.code, 'WEBHOOK_SIGNATURE_INVALID');
  assert.equal(Object.keys(app.store.snapshot().webhookEvents).length, 0);

  r = await send(webhook.headers); assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { received: true, duplicate: false });
  r = await send(webhook.headers); assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { received: true, duplicate: true });
  await app.engine.idle();
  for (let i = 0; i < 40 && (await call('GET', `/api/p/${tok(s.links.client)}`)).json.project.funding.status !== 'funded'; i += 1) await new Promise((x) => setTimeout(x, 25));
  assert.equal((await call('GET', `/api/p/${tok(s.links.client)}`)).json.project.funding.status, 'funded');
});

test('HTTP live updates: ETag gives 304 until something changes, so three-second polling is cheap', async (t) => {
  const { call, close } = await boot(); t.after(close);
  const s = (await call('POST', '/api/demo/stage', { stage: 'funded' })).json;
  const lead = tok(s.links.lead);
  const first = await call('GET', `/api/p/${lead}`);
  const etag = first.headers.get('etag'); assert.ok(etag);
  assert.equal((await call('GET', `/api/p/${lead}`, undefined, { 'if-none-match': etag })).status, 304);
  await call('POST', `/api/p/${lead}/milestones/m1/deliver`, { link: 'https://example.com/r', note: 'Delivered for review.' });
  const next = await call('GET', `/api/p/${lead}`, undefined, { 'if-none-match': etag });
  assert.equal(next.status, 200);
  assert.notEqual(next.headers.get('etag'), etag);
  assert.equal(next.json.project.milestones[0].status, 'delivered');
});

test('simulated checkout can fail, and a failed payment funds nothing', async (t) => {
  const { app, call, close } = await boot(); t.after(close);
  const s = (await call('POST', '/api/demo/stage', { stage: 'ready' })).json;
  const client = tok(s.links.client);
  const { json: f } = await call('POST', `/api/p/${client}/fund`, {});
  const again = await call('POST', `/api/p/${client}/fund`, {});
  assert.equal(again.json.reference, f.reference, 'a still-open checkout is reused, not duplicated');
  await call('POST', `/api/mock/checkout/${f.reference}/complete`, { outcome: 'failed' });
  await app.engine.idle();
  await new Promise((r) => setTimeout(r, 100));
  const v = (await call('GET', `/api/p/${client}`)).json;
  assert.equal(v.project.funding.status, 'unfunded');
  assert.ok(v.ledger.preview.some((e) => e.type === 'funding.failed'));
  const retry = await call('POST', `/api/p/${client}/fund`, {});
  assert.notEqual(retry.json.reference, f.reference, 'after a failure the client can start a new payment');
});

test('Judge Mode over HTTP: stages, clock, tamper, restore, failing account: each really changes state', async (t) => {
  const { app, call, close } = await boot(); t.after(close);
  assert.equal((await call('GET', '/api/demo/state')).json.seeded, false);
  let s = (await call('POST', '/api/demo/stage', { stage: 'created' })).json;
  assert.equal(s.status, 'awaiting_confirmations');
  const sameLinks = (await call('POST', '/api/demo/stage', { stage: 'ready' })).json;
  assert.equal(sameLinks.links.lead, s.links.lead, 'jumping keeps the links, so a second device stays connected');
  assert.equal(sameLinks.status, 'awaiting_funding');
  const fresh = (await call('POST', '/api/demo/stage', { stage: 'created', fresh: true })).json;
  assert.notEqual(fresh.links.lead, s.links.lead, 'reset issues brand-new links');
  assert.equal((await call('GET', `/api/p/${tok(s.links.lead)}`)).status, 401, 'old links stop working after a hard reset');

  s = (await call('POST', '/api/demo/stage', { stage: 'delivered' })).json;
  const lead = tok(s.links.lead); const ledger = tok(s.links.ledger);
  assert.equal((await call('GET', `/api/ledger/${ledger}`)).json.verification.text, 'Chain verified');
  const t1 = await call('POST', '/api/demo/tamper', {});
  assert.equal(t1.status, 200);
  const broken = (await call('GET', `/api/ledger/${ledger}`)).json.verification;
  assert.equal(broken.ok, false);
  assert.equal(broken.text, `Chain broken at entry ${t1.json.tamperedEntry}.`);
  assert.equal((await call('POST', '/api/demo/tamper', {})).status, 409);
  assert.equal((await call('GET', `/api/p/${lead}`)).json.ledger.verification.text, broken.text, 'the lead dashboard shows the broken chain too');
  assert.equal((await call('POST', '/api/demo/restore', {})).status, 200);
  assert.equal((await call('GET', `/api/ledger/${ledger}`)).json.verification.text, 'Chain verified');

  // the clock: 71h does nothing, 72h releases, and it is recorded
  assert.equal((await call('POST', '/api/demo/fast-forward', { hours: 24 })).json.advancedHours, 24);
  assert.equal((await call('POST', '/api/demo/fast-forward', { hours: 24 })).status, 200);
  assert.equal((await call('GET', `/api/p/${lead}`)).json.project.milestones[0].status, 'delivered');
  assert.equal((await call('POST', '/api/demo/fast-forward', { hours: 24 })).status, 200);
  await app.engine.idle();
  const after = (await call('GET', `/api/p/${lead}`)).json;
  assert.equal(after.project.milestones[0].status, 'closed');
  assert.ok(after.ledger.preview.some((e) => e.type === 'demo.clock_advanced'), 'time travel is on the record');
  assert.equal((await call('POST', '/api/demo/fast-forward', { hours: 0 })).status, 400);
  assert.equal((await call('POST', '/api/demo/fast-forward', { hours: 9999 })).status, 400);
  assert.equal((await call('POST', '/api/demo/stage', { stage: 'nonsense' })).status, 400);
});

test('with Judge Mode off, none of its endpoints exist', async (t) => {
  const { call, close } = await boot({ DEMO_MODE: '0' }); t.after(close);
  for (const [m, p] of [['GET', '/api/demo/state'], ['POST', '/api/demo/stage'], ['POST', '/api/demo/tamper'], ['POST', '/api/demo/fast-forward']]) {
    assert.equal((await call(m, p, m === 'POST' ? {} : undefined)).status, 404, p);
  }
  assert.equal((await call('GET', '/api/config')).json.demoMode, false);
});

test('rate limiting: project creation is capped per client address', async (t) => {
  const { call, close } = await boot(); t.after(close);
  const codes = [];
  for (let i = 0; i < 14; i += 1) codes.push((await call('POST', '/api/projects', { title: 'x' })).status);
  assert.equal(codes.filter((c) => c === 400).length, 12);
  assert.equal(codes.filter((c) => c === 429).length, 2);
});

test('persistence: state survives a restart, including the hash chain', async (t) => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitpot-'));
  const file = path.join(dir, 'db.json');
  const a = makeApp({ DATA_FILE: file });
  const s = await a.demo.stage('funded'); await a.engine.idle();
  const before = a.engine.verifyLedger(s.projectId);
  const b = makeApp({ DATA_FILE: file });
  assert.deepEqual(b.engine.verifyLedger(s.projectId), before);
  const v = await b.engine.view(s.links.lead.split('/').pop());
  assert.equal(v.project.funding.status, 'funded');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
});
