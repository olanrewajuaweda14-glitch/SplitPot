// Accounts, sessions, dashboards, invitation states, decline, split revision. Over real HTTP with cookie jars.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, advance } from './helpers.js';
import { HOUR } from '../src/engine/helpers.js';

async function boot(env = {}) {
  const app = makeApp(env); await app.listen(0);
  const base = `http://127.0.0.1:${app.port}`;
  const jar = () => {
    let cookie = '';
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) { const pair = sc.split(';')[0]; cookie = pair.endsWith('=') ? '' : pair; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, headers: res.headers };
    };
    return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
  };
  return { app, base, jar, close: () => app.close() };
}
const tok = (p) => p.split('/').pop();
const PW = 'correct horse battery';
const signup = (c, email = 'ada@example.com', name = 'Ada Obi') => c.call('POST', '/api/auth/signup', { email, name, password: PW });
const SPEC = (extra = {}) => ({
  title: 'Short film', clientName: 'Acme Films', clientEmail: '',
  collaborators: [{ name: 'Ada', role: 'Director', bps: 5000 }, { name: 'Bayo', role: 'Editor', bps: 3000 }, { name: 'Chi', role: 'Sound', bps: 2000 }],
  milestones: [{ title: 'Rough cut', amountKobo: 30_000_000, criteria: ['Under five minutes.'] }, { title: 'Final', amountKobo: 20_000_000, criteria: ['Delivered as MP4.'] }], ...extra,
});
async function makeProject(c, spec = SPEC()) { const r = await c.call('POST', '/api/projects', spec); assert.equal(r.status, 200, r.text); const L = r.json.links; return { id: r.json.projectId, lead: tok(L.lead), client: tok(L.client), collabs: L.collaborators.map((x) => tok(x.path)), ledger: tok(L.ledger) }; }
async function confirmAll(app, P) { for (let i = 0; i < 3; i += 1) await app.engine.confirmShare(P.collabs[i], { accept: true, bankCode: '044', accountNumber: `300000000${i + 1}` }); }
async function fund(app, P, opts) { const { reference } = await app.engine.startFunding(P.client); const { webhook } = await app.provider.completeCheckout(reference, opts); const r = await app.engine.handleWebhook(webhook.rawBody, webhook.headers); await r.done; return reference; }

test('signup sets an HttpOnly SameSite=Strict cookie, never returns or stores the password', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar();
  const r = await signup(c); assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//);
  assert.ok(!r.text.includes(PW) && !r.text.includes('passHash'));
  const me = await c.call('GET', '/api/auth/me'); assert.equal(me.json.user.email, 'ada@example.com'); assert.equal(me.json.user.name, 'Ada Obi');
  const u = Object.values(app.store.snapshot().users)[0];
  assert.ok(!JSON.stringify(app.store.snapshot()).includes(PW), 'plaintext password must not be in the store');
  assert.match(u.passHash, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'salt:scrypt hash');
});

test('signup validation: duplicate email, weak password, bad email, short name', async (t) => {
  const { jar, close } = await boot(); t.after(close); const c = jar();
  assert.equal((await signup(c)).status, 200);
  assert.equal((await signup(jar())).json.error.code, 'EMAIL_TAKEN');
  assert.equal((await signup(jar(), 'ADA@EXAMPLE.COM')).json.error.code, 'EMAIL_TAKEN', 'email is case-insensitive');
  assert.equal((await jar().call('POST', '/api/auth/signup', { email: 'x@example.com', name: 'Xi Li', password: 'short' })).json.error.code, 'PASSWORD_TOO_SHORT');
  assert.equal((await jar().call('POST', '/api/auth/signup', { email: 'x@example.com', name: 'Xi Li', password: 'password' })).json.error.code, 'PASSWORD_WEAK');
  assert.equal((await jar().call('POST', '/api/auth/signup', { email: 'not-an-email', name: 'Xi Li', password: PW })).json.error.code, 'EMAIL_INVALID');
  assert.equal((await jar().call('POST', '/api/auth/signup', { email: 'x@example.com', name: 'X', password: PW })).json.error.code, 'FIELD_TOO_SHORT');
});

test('login: wrong password and unknown email give the same answer; logout ends the session', async (t) => {
  const { jar, close } = await boot(); t.after(close); await signup(jar());
  const a = await jar().call('POST', '/api/auth/login', { email: 'ada@example.com', password: 'wrong password!' });
  const b = await jar().call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrong password!' });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.json.error.message, b.json.error.message); assert.equal(a.json.error.code, 'LOGIN_FAILED');
  const c = jar(); const ok = await c.call('POST', '/api/auth/login', { email: 'Ada@Example.com', password: PW }); assert.equal(ok.status, 200);
  const cookie = c.cookie; assert.equal((await c.call('GET', '/api/auth/me')).json.user.name, 'Ada Obi');
  await c.call('POST', '/api/auth/logout', {}); assert.equal((await c.call('GET', '/api/auth/me')).json.user, null);
  const stale = jar(); stale.cookie = cookie; assert.equal((await stale.call('GET', '/api/auth/me')).json.user, null, 'the old cookie must be dead server-side too');
});

test('login is rate limited per email', async (t) => {
  const { jar, close } = await boot(); t.after(close); await signup(jar());
  let last; for (let i = 0; i < 10; i += 1) last = await jar().call('POST', '/api/auth/login', { email: 'ada@example.com', password: 'wrong password!' });
  assert.equal(last.status, 429);
});

test('sessions expire after 14 days', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c);
  advance(app, 13 * 24); assert.ok((await c.call('GET', '/api/auth/me')).json.user);
  advance(app, 2 * 24); assert.equal((await c.call('GET', '/api/auth/me')).json.user, null);
});

test('cookie sessions refuse cross-site POSTs', async (t) => {
  const { jar, close } = await boot(); t.after(close); const c = jar(); await signup(c);
  const r = await c.call('POST', '/api/me/profile', { name: 'Evil' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'ORIGIN_MISMATCH');
  assert.equal((await c.call('GET', '/api/auth/me')).json.user.name, 'Ada Obi');
});

test('password reset: single use, ends sessions, unknown email looks identical', async (t) => {
  const { jar, close } = await boot(); t.after(close); const c = jar(); await signup(c);
  const known = await jar().call('POST', '/api/auth/forgot', { email: 'ada@example.com' }); const unknown = await jar().call('POST', '/api/auth/forgot', { email: 'ghost@example.com' });
  assert.deepEqual(Object.keys(known.json).sort(), Object.keys(unknown.json).sort()); assert.equal(known.json.simulated, true);
  assert.equal((await jar().call('POST', '/api/auth/reset', { token: tok(unknown.json.resetPath), password: 'a brand new password' })).json.error.code, 'RESET_INVALID');
  assert.equal((await jar().call('POST', '/api/auth/reset', { token: tok(known.json.resetPath), password: 'short' })).json.error.code, 'PASSWORD_TOO_SHORT');
  assert.equal((await jar().call('POST', '/api/auth/reset', { token: tok(known.json.resetPath), password: 'a brand new password' })).status, 200);
  assert.equal((await jar().call('POST', '/api/auth/reset', { token: tok(known.json.resetPath), password: 'another new password' })).json.error.code, 'RESET_INVALID', 'single use');
  assert.equal((await c.call('GET', '/api/auth/me')).json.user, null, 'old sessions end');
  assert.equal((await jar().call('POST', '/api/auth/login', { email: 'ada@example.com', password: PW })).status, 401);
  assert.equal((await jar().call('POST', '/api/auth/login', { email: 'ada@example.com', password: 'a brand new password' })).status, 200);
});

test('reset links expire after an hour', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); await signup(jar());
  const f = await jar().call('POST', '/api/auth/forgot', { email: 'ada@example.com' }); advance(app, 2);
  assert.equal((await jar().call('POST', '/api/auth/reset', { token: tok(f.json.resetPath), password: 'a brand new password' })).json.error.code, 'RESET_INVALID');
});

test('changing the password needs the current one and ends other sessions only', async (t) => {
  const { jar, close } = await boot(); t.after(close); const a = jar(); await signup(a); const b = jar(); await b.call('POST', '/api/auth/login', { email: 'ada@example.com', password: PW });
  assert.equal((await a.call('POST', '/api/me/password', { current: 'nope nope nope', next: 'a brand new password' })).status, 403);
  assert.equal((await a.call('POST', '/api/me/password', { current: PW, next: PW })).json.error.code, 'PASSWORD_UNCHANGED');
  assert.equal((await a.call('POST', '/api/me/password', { current: PW, next: 'a brand new password' })).status, 200);
  assert.ok((await a.call('GET', '/api/auth/me')).json.user, 'this session stays'); assert.equal((await b.call('GET', '/api/auth/me')).json.user, null, 'the other session ends');
  assert.equal((await a.call('POST', '/api/me/logout-all', {})).json.ended, 1); assert.equal((await a.call('GET', '/api/auth/me')).json.user, null);
});

test('profile and notification preferences persist and validate', async (t) => {
  const { jar, close } = await boot(); t.after(close); const c = jar(); await signup(c);
  assert.equal((await c.call('POST', '/api/me/profile', { name: 'Ada O.', phone: '+234 801 234 5678' })).json.phone, '+234 801 234 5678');
  assert.equal((await c.call('POST', '/api/me/profile', { phone: 'abc' })).json.error.code, 'PHONE_INVALID');
  assert.equal((await c.call('POST', '/api/me/prefs', { payouts: false, bogus: false })).json.prefs.payouts, false);
  const me = (await c.call('GET', '/api/auth/me')).json.user; assert.equal(me.prefs.payouts, false); assert.equal(me.prefs.funding, true); assert.ok(!('bogus' in me.prefs));
});

test('the account-protected endpoints reject anonymous callers', async (t) => {
  const { jar, close } = await boot(); t.after(close); const c = jar();
  for (const [m, p] of [['GET', '/api/me/dashboard'], ['GET', '/api/me/payouts'], ['GET', '/api/me/ledger'], ['POST', '/api/me/profile'], ['POST', '/api/me/claim'], ['POST', '/api/me/bank']]) {
    const r = await c.call(m, p, m === 'POST' ? {} : undefined); assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.json.error.code, 'NOT_SIGNED_IN');
  }
});

test('dashboard numbers come from real data and move correctly through the journey', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c);
  const P = await makeProject(c);
  let d = (await c.call('GET', '/api/me/dashboard')).json;
  assert.equal(d.projects.length, 1); assert.equal(d.metrics.totalValueKobo, 50_000_000); assert.equal(d.metrics.pendingConfirmations, 3); assert.equal(d.metrics.activeProjects, 0); assert.equal(d.metrics.awaitingSettlementKobo, 0); assert.equal(d.metrics.completedPayoutsKobo, 0);
  await confirmAll(app, P); await fund(app, P);
  d = (await c.call('GET', '/api/me/dashboard')).json;
  assert.equal(d.metrics.pendingConfirmations, 0); assert.equal(d.metrics.activeProjects, 1); assert.equal(d.metrics.awaitingSettlementKobo, 50_000_000);
  assert.equal(d.pot.waiting, 50_000_000);
  await app.engine.submitDelivery(P.lead, 'm1', { link: 'https://example.com/a', note: 'First delivery here.' }); await app.engine.approveMilestone(P.client, 'm1'); await app.engine.idle();
  d = (await c.call('GET', '/api/me/dashboard')).json;
  assert.equal(d.metrics.completedPayoutsKobo, 30_000_000); assert.equal(d.metrics.awaitingSettlementKobo, 20_000_000); assert.equal(d.pot.paid, 30_000_000); assert.equal(d.pot.waiting, 20_000_000);
  assert.equal(d.recentTransactions.filter((x) => x.type === 'payout').length, 3); assert.ok(d.recentTransactions.some((x) => x.type === 'funding'));
  assert.ok(d.activity.length > 5 && d.activity[0].ts >= d.activity.at(-1).ts);
  assert.equal(d.projects[0].bars.paid, 30_000_000); assert.equal(d.projects[0].attention, 'Deliver Final');
});

test('a frozen milestone shows as frozen in the dashboard pot, not as waiting or paid', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c);
  await confirmAll(app, P); await fund(app, P);
  await app.engine.submitDelivery(P.lead, 'm1', { link: 'https://example.com/a', note: 'First delivery here.' });
  await app.engine.openDispute(P.client, 'm1', { unmetCriteria: [0], reason: 'It is longer than five minutes.' });
  const d = (await c.call('GET', '/api/me/dashboard')).json; assert.equal(d.pot.frozen, 30_000_000); assert.equal(d.pot.waiting, 20_000_000); assert.match(d.projects[0].attention, /Dispute open/);
});

test('users are isolated: B sees nothing of A, cannot steal ownership, and a collaborator sees only their own money', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const a = jar(); const b = jar(); await signup(a); await signup(b, 'bayo@example.com', 'Bayo Ade');
  const P = await makeProject(a); await confirmAll(app, P); await fund(app, P);
  assert.equal((await b.call('GET', '/api/me/dashboard')).json.projects.length, 0); assert.equal((await b.call('GET', '/api/me/payouts')).json.rows.length, 0); assert.equal((await b.call('GET', '/api/me/ledger')).json.rows.length, 0);
  assert.equal((await b.call('POST', '/api/me/claim', { token: P.lead })).json.error.code, 'ALREADY_OWNED');
  assert.equal((await b.call('POST', '/api/me/claim', { token: P.client })).status, 403, 'client links cannot be claimed');
  assert.equal((await b.call('POST', '/api/me/claim', { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await b.call('POST', '/api/me/claim', { token: P.collabs[1] })).json.added, true);
  await app.engine.submitDelivery(P.lead, 'm1', { link: 'https://example.com/a', note: 'First delivery here.' }); await app.engine.approveMilestone(P.client, 'm1'); await app.engine.idle();
  const pay = (await b.call('GET', '/api/me/payouts')).json.rows; assert.equal(pay.length, 1); assert.equal(pay[0].recipient, 'Bayo'); assert.equal(pay[0].amountKobo, 9_000_000);
  const dash = (await b.call('GET', '/api/me/dashboard')).json; assert.equal(dash.projects[0].role, 'collaborator'); assert.equal(dash.projects[0].shareKobo, 15_000_000); assert.equal(dash.metrics.completedPayoutsKobo, 9_000_000);
  const text = JSON.stringify(dash) + JSON.stringify(pay); assert.ok(!text.includes(P.lead) && !text.includes(P.client), 'no other role links leak');
  assert.equal((await b.call('POST', '/api/me/unclaim', { projectId: P.id })).status, 200); assert.equal((await b.call('GET', '/api/me/dashboard')).json.projects.length, 0);
});

test('an account created after the project can claim the lead link', async (t) => {
  const { jar, close } = await boot(); t.after(close); const anon = jar(); const P = await makeProject(anon);
  const c = jar(); await signup(c); assert.equal((await c.call('GET', '/api/me/dashboard')).json.projects.length, 0);
  assert.equal((await c.call('POST', '/api/me/claim', { token: P.lead })).json.role, 'lead'); const d = (await c.call('GET', '/api/me/dashboard')).json; assert.equal(d.projects.length, 1); assert.equal(d.projects[0].path, `/p/lead/${P.lead}`);
});

test('ledger feed honours notification preferences and exposes filter fields', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c); await confirmAll(app, P); await fund(app, P);
  const all = (await c.call('GET', '/api/me/ledger')).json.rows; assert.ok(all.every((r) => r.project && r.category && r.status && r.hash && r.ts)); assert.ok(new Set(all.map((r) => r.category)).has('Funding'));
  await c.call('POST', '/api/me/prefs', { funding: false });
  const dash = (await c.call('GET', '/api/me/dashboard')).json; assert.ok(!dash.activity.some((a) => a.category === 'Funding'), 'muted category leaves the activity feed');
  assert.ok((await c.call('GET', '/api/me/ledger')).json.rows.some((r) => r.category === 'Funding'), 'but the ledger itself is never filtered by preferences');
});

test('invitation states: invited -> viewed -> accepted, and declined with a private reason', async (t) => {
  const { jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c);
  const lv = async () => (await jar().call('GET', `/api/p/${P.lead}`)).json.project.collaborators;
  assert.equal((await lv())[1].invitation, 'invited');
  await jar().call('GET', `/api/p/${P.collabs[1]}`); assert.equal((await lv())[1].invitation, 'viewed');
  const dec = await jar().call('POST', `/api/p/${P.collabs[1]}/decline`, { reason: 'My share is too low.' }); assert.equal(dec.status, 200);
  assert.equal((await lv())[1].invitation, 'declined');
  const leadSees = (await lv())[1].declineReason; assert.equal(leadSees, 'My share is too low.');
  const other = (await jar().call('GET', `/api/p/${P.collabs[2]}`)).json.project.collaborators[1]; assert.equal(other.declineReason, null, 'other collaborators never see the reason'); assert.equal(other.invitation, 'declined');
  assert.equal((await jar().call('POST', `/api/p/${P.collabs[1]}/decline`, { reason: 'x' })).json.error.code, 'FIELD_TOO_SHORT');
  assert.equal((await jar().call('POST', `/api/p/${P.lead}/decline`, { reason: 'I decline this.' })).status, 403, 'only collaborators can decline');
  const ok = await jar().call('POST', `/api/p/${P.collabs[1]}/confirm`, { accept: true, bankCode: '044', accountNumber: '3000000002' }); assert.equal(ok.status, 200);
  assert.equal((await lv())[1].invitation, 'accepted'); assert.equal((await jar().call('POST', `/api/p/${P.collabs[1]}/decline`, { reason: 'Changed my mind.' })).json.error.code, 'ALREADY_CONFIRMED');
});

test('a declined share keeps funding locked', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c);
  await app.engine.confirmShare(P.collabs[0], { accept: true, bankCode: '044', accountNumber: '3000000001' }); await app.engine.confirmShare(P.collabs[2], { accept: true, bankCode: '044', accountNumber: '3000000003' });
  await app.engine.declineShare(P.collabs[1], { reason: 'Need to renegotiate.' });
  const r = await jar().call('POST', `/api/p/${P.client}/fund`, {}); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'FUNDING_BEFORE_CONFIRMATIONS');
  assert.equal((await c.call('GET', '/api/me/dashboard')).json.projects[0].attention, '1 declined. Revise the split or talk to them.');
});

test('revising the split: changed shares re-confirm, totals must be 100%, allocations recompute exactly', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c); await confirmAll(app, P);
  assert.equal((await jar().call('GET', `/api/p/${P.client}`)).json.project.status, 'awaiting_funding');
  const bad = await jar().call('POST', `/api/p/${P.lead}/revise-split`, { collaborators: [{ id: 'c1', bps: 5000 }, { id: 'c2', bps: 3500 }, { id: 'c3', bps: 2000 }] }); assert.equal(bad.json.error.code, 'SHARES_NOT_100');
  assert.equal((await jar().call('POST', `/api/p/${P.lead}/revise-split`, { collaborators: [{ id: 'c1', bps: 5000 }, { id: 'c2', bps: 3000 }, { id: 'c3', bps: 2000 }] })).json.error.code, 'SPLIT_UNCHANGED');
  assert.equal((await jar().call('POST', `/api/p/${P.lead}/revise-split`, { collaborators: [{ id: 'c1', bps: 5000 }, { id: 'c2', bps: 3000 }, { id: 'c2', bps: 2000 }] })).json.error.code, 'SPLIT_PERSON_INVALID');
  assert.equal((await jar().call('POST', `/api/p/${P.collabs[0]}/revise-split`, { collaborators: [] })).status, 403, 'only the lead may revise');
  const ok = await jar().call('POST', `/api/p/${P.lead}/revise-split`, { collaborators: [{ id: 'c1', bps: 4500 }, { id: 'c2', bps: 3500 }, { id: 'c3', bps: 2000 }] }); assert.equal(ok.status, 200); assert.equal(ok.json.changed, 2);
  const v = (await jar().call('GET', `/api/p/${P.lead}`)).json.project;
  assert.equal(v.status, 'awaiting_confirmations'); assert.deepEqual(v.collaborators.map((x) => x.confirmed), [false, false, true], 'only changed shares need confirming again');
  assert.deepEqual(v.collaborators.map((x) => x.plannedKobo), [22_500_000, 17_500_000, 10_000_000]); assert.equal(v.collaborators.reduce((a, x) => a + x.plannedKobo, 0), 50_000_000);
  assert.equal((await jar().call('POST', `/api/p/${P.client}/fund`, {})).json.error.code, 'FUNDING_BEFORE_CONFIRMATIONS');
  await app.engine.confirmShare(P.collabs[0], { accept: true, bankCode: '044', accountNumber: '3000000001' }); await app.engine.confirmShare(P.collabs[1], { accept: true, bankCode: '044', accountNumber: '3000000002' });
  assert.equal((await jar().call('GET', `/api/p/${P.client}`)).json.project.status, 'awaiting_funding');
  const led = (await jar().call('GET', `/api/ledger/${P.ledger}`)).json; assert.ok(led.entries.some((e) => e.type === 'split.revised')); assert.equal(led.verification.text, 'Chain verified');
});

test('the split is locked once funded', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c); await confirmAll(app, P); await fund(app, P);
  const r = await jar().call('POST', `/api/p/${P.lead}/revise-split`, { collaborators: [{ id: 'c1', bps: 4500 }, { id: 'c2', bps: 3500 }, { id: 'c3', bps: 2000 }] }); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'SPLIT_LOCKED');
});

test('a payment started before a split change is NOT counted afterwards (and is recorded, not dropped)', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c); await confirmAll(app, P);
  const { reference } = await app.engine.startFunding(P.client);
  await jar().call('POST', `/api/p/${P.lead}/revise-split`, { collaborators: [{ id: 'c1', bps: 4500 }, { id: 'c2', bps: 3500 }, { id: 'c3', bps: 2000 }] });
  const { webhook } = await app.provider.completeCheckout(reference, {}); const r = await app.engine.handleWebhook(webhook.rawBody, webhook.headers); await r.done;
  const p = app.store.snapshot().projects[P.id]; assert.notEqual(p.funding.status, 'funded'); assert.notEqual(p.status, 'active');
  const rej = p.ledger.find((e) => e.type === 'funding.rejected'); assert.ok(rej); assert.equal(rej.data.reason, 'split_revised');
});

test('saved payout account: server-side only, never exposed, usable to confirm a share', async (t) => {
  const { jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c);
  assert.equal((await c.call('POST', `/api/p/${P.collabs[0]}/confirm`, { accept: true, useSavedAccount: true })).json.error.code, 'NO_SAVED_ACCOUNT');
  assert.equal((await c.call('POST', '/api/me/bank', { bankCode: '044', accountNumber: '123' })).json.error.code, 'ACCOUNT_NUMBER_INVALID');
  const set = await c.call('POST', '/api/me/bank', { bankCode: '044', accountNumber: '4000000009' }); assert.equal(set.status, 200); assert.equal(set.json.defaultBank.masked, '••••••0009');
  const everything = set.text + (await c.call('GET', '/api/auth/me')).text + (await c.call('GET', '/api/me/dashboard')).text; assert.ok(!everything.includes('4000000009'), 'full account number must never be returned');
  const anon = jar(); assert.equal((await anon.call('POST', `/api/p/${P.collabs[0]}/confirm`, { accept: true, useSavedAccount: true })).json.error.code, 'NO_SAVED_ACCOUNT', 'only works when signed in');
  const ok = await c.call('POST', `/api/p/${P.collabs[0]}/confirm`, { accept: true, useSavedAccount: true }); assert.equal(ok.status, 200);
  const me = (await jar().call('GET', `/api/p/${P.collabs[0]}`)).json.project.collaborators[0]; assert.equal(me.confirmed, true); assert.equal(me.bank.masked, '••••••0009');
  await c.call('POST', '/api/me/bank/clear', {}); assert.equal((await c.call('GET', '/api/auth/me')).json.user.defaultBank, null);
});

test('payout rows give the lead a retry hint only for failed payouts, and receipts only for successes', async (t) => {
  const { app, jar, close } = await boot(); t.after(close); const c = jar(); await signup(c); const P = await makeProject(c); await confirmAll(app, P); await fund(app, P);
  await app.engine.submitDelivery(P.lead, 'm1', { link: 'https://example.com/a', note: 'First delivery here.' }); await app.engine.approveMilestone(P.client, 'm1'); await app.engine.idle();
  const rows = (await c.call('GET', '/api/me/payouts')).json.rows; assert.equal(rows.length, 3); assert.ok(rows.every((r) => r.status === 'success' && r.receiptPath && !r.canRetry && /Bank transfer, .* ••••••\d{4}/.test(r.method)));
  assert.ok(!JSON.stringify(rows).includes('3000000001'), 'no full account numbers in payout rows');
});
