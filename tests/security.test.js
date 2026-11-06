// 18. Role and access-token validation, plus the audit items: secret exposure, role bypass, data leakage, input hardening.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp, seeded, project, rejectsWith, userProject, fundIt } from './helpers.js';

const SEED_ACCOUNTS = ['1000000001', '1000000002', '1000000003', '1000000004', '0000000404'];

test('18. every command checks the role: wrong-role tokens are refused (403) and change nothing', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  await app.engine.openDispute(s.client, 'm1', { unmetCriteria: [0], reason: 'Over three minutes long.' });
  const before = app.store.version;
  const E = app.engine;
  const forbidden = {
    'collaborator': [
      () => E.approveMilestone(s.collabs[1], 'm1'), () => E.submitDelivery(s.collabs[1], 'm2', { link: 'https://x.example/a', note: 'long enough note' }),
      () => E.startFunding(s.collabs[1]), () => E.openDispute(s.collabs[1], 'm1', { unmetCriteria: [0], reason: 'long enough reason' }),
      () => E.proposeResolution(s.collabs[1], 'm1', { kind: 'release' }), () => E.reviewerDecide(s.collabs[1], 'm1', {}),
      () => E.retryPayout(s.collabs[1], 'po_m1_c1'), () => E.escalateDispute(s.collabs[1], 'm1'),
    ],
    'client': [
      () => E.submitDelivery(s.client, 'm2', { link: 'https://x.example/a', note: 'long enough note' }), () => E.confirmShare(s.client, { accept: true }),
      () => E.resolveAccount(s.client, { bankCode: '044', accountNumber: '1234567890' }), () => E.retryPayout(s.client, 'po_m1_c1'), () => E.reviewerDecide(s.client, 'm1', {}),
    ],
    'lead': [
      () => E.approveMilestone(s.lead, 'm2'), () => E.openDispute(s.lead, 'm2', { unmetCriteria: [0], reason: 'long enough reason' }), () => E.startFunding(s.lead),
      () => E.confirmShare(s.lead, { accept: true }), () => E.reviewerDecide(s.lead, 'm1', {}),
    ],
    'reviewer': [
      () => E.approveMilestone(s.reviewer, 'm2'), () => E.submitDelivery(s.reviewer, 'm2', { link: 'https://x.example/a', note: 'long enough note' }),
      () => E.proposeResolution(s.reviewer, 'm1', { kind: 'release' }), () => E.startFunding(s.reviewer), () => E.retryPayout(s.reviewer, 'po_m1_c1'),
      () => E.respondToProposal(s.reviewer, 'm1', 'pr_1', { accept: true }), () => E.confirmShare(s.reviewer, { accept: true }), () => E.receipt(s.reviewer, 'po_m1_c1'),
    ],
  };
  for (const [role, calls] of Object.entries(forbidden)) {
    for (const call of calls) {
      const err = await rejectsWith(assert, call, 'ROLE_FORBIDDEN');
      assert.equal(err.status, 403, role);
    }
  }
  assert.equal(app.store.version, before, 'refused commands wrote nothing');
});

test('18b. invalid, malformed or look-alike tokens are refused with 401 and no information', async () => {
  const app = makeApp(); const s = await seeded(app, 'funded');
  const good = s.lead;
  const bad = ['', ' ', 'x', 'short-token', 'x'.repeat(43), 'A'.repeat(200), '__proto__', 'constructor', 'toString'.repeat(4), ` ${good}`, `${good} `, good.slice(1), good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a'), good.toLowerCase() === good ? good.toUpperCase() : good.toLowerCase(), null, undefined, 42, {}, [good]];
  for (const t of bad) {
    const err = await rejectsWith(assert, () => app.engine.view(t), 'TOKEN_INVALID');
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes(String(good)), 'the error never echoes real tokens');
  }
  await rejectsWith(assert, () => app.engine.publicLedger('__proto__'), 'LEDGER_NOT_FOUND');
  await rejectsWith(assert, () => app.engine.publicLedger('constructor'), 'LEDGER_NOT_FOUND');
  await rejectsWith(assert, () => app.engine.publicLedger(s.lead), 'LEDGER_NOT_FOUND'); // a private token is not a ledger id
  const v = await app.engine.view(good);
  assert.equal(v.role, 'lead');
});

test('tokens are unguessable, unique across projects, and never stored as the lookup key', async () => {
  const app = makeApp();
  const a = await seeded(app, 'created');
  const u1 = await userProject(app, { confirm: false });
  const u2 = await userProject(app, { confirm: false });
  const all = [a, u1, u2].flatMap((x) => [x.lead, x.client, x.reviewer, ...x.collabs]);
  assert.equal(new Set(all).size, all.length, 'no token is ever reused');
  for (const t of all) assert.match(t, /^[A-Za-z0-9_-]{43}$/, '256 bits, base64url');
  const state = app.store.snapshot();
  for (const t of all) assert.ok(!Object.hasOwn(state.tokenIndex, t), 'the index is keyed by a hash of the token');
  assert.ok(!all.includes(a.publicId));
});

test('one collaborator cannot read another collaborator\'s receipt; the team and client can', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  const err = await rejectsWith(assert, app.engine.receipt(s.collabs[2], 'po_m1_c2'), 'RECEIPT_FORBIDDEN');
  assert.equal(err.status, 403);
  assert.equal((await app.engine.receipt(s.collabs[1], 'po_m1_c2')).recipient.name, 'Editor');
  assert.equal((await app.engine.receipt(s.lead, 'po_m1_c2')).recipient.name, 'Editor');
  assert.equal((await app.engine.receipt(s.client, 'po_m1_c2')).recipient.name, 'Editor');
  await rejectsWith(assert, app.engine.receipt(s.collabs[1], 'po_m1_missing'), 'PAYOUT_NOT_FOUND');
  await rejectsWith(assert, app.engine.receipt(s.collabs[1], '__proto__'), 'PAYOUT_NOT_FOUND');
});

test('bank accounts are masked everywhere: no view, receipt, ledger or error ever contains a full account number', async () => {
  const app = makeApp(); const s = await seeded(app, 'funded');
  await app.demo.useFailingAccount();
  await app.engine.submitDelivery(s.lead, 'm1', { link: 'https://example.com/r', note: 'Rough cut delivered.' });
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  const dumps = {};
  for (const [name, t] of Object.entries({ lead: s.lead, client: s.client, reviewer: s.reviewer, c1: s.collabs[0], c2: s.collabs[1], c4: s.collabs[3] })) dumps[name] = JSON.stringify(await app.engine.view(t));
  dumps.ledger = JSON.stringify(await app.engine.publicLedger(s.publicId));
  dumps.receipt = JSON.stringify(await app.engine.receipt(s.collabs[1], 'po_m1_c2'));
  dumps.state404 = JSON.stringify(await app.demo.links());
  for (const [name, d] of Object.entries(dumps)) for (const n of SEED_ACCOUNTS) assert.ok(!d.includes(n), `${name} leaks ${n}`);
  assert.ok(dumps.lead.includes('••••••0002'));
  const c2 = JSON.parse(dumps.c2);
  assert.equal(c2.project.collaborators[1].bank.masked, '••••••0002');
  assert.equal(c2.project.collaborators[2].bank, null, 'a collaborator sees nobody else\'s bank');
  assert.equal(JSON.parse(dumps.client).project.collaborators.every((c) => c.bank === null), true, 'the client sees no bank details at all');
  assert.equal(JSON.parse(dumps.reviewer).project.collaborators.every((c) => c.bank === null), true);
  // account HOLDER names only for the lead and the owner
  assert.ok(!dumps.client.includes('SYNTHETIC EDITOR'));
  assert.ok(!dumps.c1.includes('SYNTHETIC EDITOR'));
  assert.ok(dumps.c2.includes('SYNTHETIC EDITOR'));
  assert.ok(dumps.lead.includes('SYNTHETIC EDITOR'));
});

test('the public ledger exposes no capability token, account number, account holder name or free text', async () => {
  const app = makeApp(); const s = await seeded(app, 'disputed');
  await app.engine.proposeResolution(s.lead, 'm1', { kind: 'release', note: 'SECRET-NEGOTIATION-NOTE please release' });
  const out = JSON.stringify(await app.engine.publicLedger(s.publicId));
  for (const t of [s.lead, s.client, s.reviewer, ...s.collabs]) assert.ok(!out.includes(t), 'no token in the public ledger');
  for (const n of SEED_ACCOUNTS) assert.ok(!out.includes(n));
  assert.ok(!out.includes('SYNTHETIC EDITOR (DEMO ACCOUNT)'));
  assert.ok(!out.includes('SECRET-NEGOTIATION-NOTE'), 'free text is committed by hash, not published');
  assert.ok(!out.includes('Two scenes from the shot list are missing'));
  assert.ok(out.includes('reasonHash'));
  assert.ok(!/accountNumber|recipientCode|authorizationUrl|"access"/.test(out));
});

test('capability links: the lead sees client + collaborator links; the reviewer link exists only in demo mode', async () => {
  const demoApp = makeApp(); const d = await seeded(demoApp, 'created');
  const lv = await demoApp.engine.view(d.lead);
  assert.ok(lv.links.reviewer, 'demo mode lists the reviewer link');
  assert.equal(lv.links.collaborators.length, 4);
  assert.ok(lv.links.client.endsWith(d.client));
  for (const other of [d.client, d.reviewer, d.collabs[1]]) assert.equal((await demoApp.engine.view(other)).links, null, 'only the lead is shown links');

  const prod = makeApp({ DEMO_MODE: '0' }); const u = await userProject(prod, { confirm: false });
  const pv = await prod.engine.view(u.lead);
  assert.equal(pv.links.reviewer, undefined, 'outside demo mode the lead is not handed the reviewer link');
  assert.ok(!JSON.stringify(pv).includes(u.reviewer));
  await rejectsWith(assert, prod.demo.stage('funded'), 'DEMO_DISABLED');
  await rejectsWith(assert, prod.engine.recordDemoEvent(u.projectId, 'demo.x', {}), 'DEMO_DISABLED');
});

test('create-project validation: shares, amounts, criteria, text and bank details', async () => {
  const app = makeApp();
  const ok = () => ({
    title: 'T', clientName: 'C',
    collaborators: [{ name: 'A', role: 'Lead', bps: 6000 }, { name: 'B', role: 'Collab', bps: 4000 }],
    milestones: [{ title: 'M', amountKobo: 1_000_000, criteria: ['Delivered as MP4.'] }],
  });
  const tweak = (fn) => { const i = ok(); fn(i); return i; };
  const cases = [
    ['SHARES_NOT_100', tweak((i) => { i.collaborators[1].bps = 3999; })],
    ['SHARES_NOT_100', tweak((i) => { i.collaborators[1].bps = 4001; })],
    ['SHARE_INVALID', tweak((i) => { i.collaborators[1].bps = 40.5; })],
    ['SHARE_INVALID', tweak((i) => { i.collaborators[1].bps = '4000'; })],
    ['CRITERIA_REQUIRED', tweak((i) => { i.milestones[0].criteria = []; })],
    ['FIELD_TOO_SHORT', tweak((i) => { i.milestones[0].criteria = ['x']; })],
    ['AMOUNT_NOT_INTEGER', tweak((i) => { i.milestones[0].amountKobo = 1000.5; })],
    ['AMOUNT_NEGATIVE', tweak((i) => { i.milestones[0].amountKobo = -5; })],
    ['AMOUNT_TOO_SMALL', tweak((i) => { i.milestones[0].amountKobo = 99; })],
    ['AMOUNT_TOO_LARGE', tweak((i) => { i.milestones[0].amountKobo = 10_000_000_000_001; })],
    ['MILESTONES_INVALID', tweak((i) => { i.milestones = []; })],
    ['COLLABORATORS_INVALID', tweak((i) => { i.collaborators = []; })],
    ['FIELD_REQUIRED', tweak((i) => { delete i.title; })],
    ['FIELD_REQUIRED', tweak((i) => { i.clientName = 42; })],
    ['FIELD_TOO_LONG', tweak((i) => { i.title = 'x'.repeat(121); })],
    ['FIELD_INVALID', tweak((i) => { i.title = 'bad\u0007title'; })],
    ['FIELD_INVALID', tweak((i) => { i.collaborators[0].name = 'evil‮name'; })],
    ['EMAIL_INVALID', tweak((i) => { i.clientEmail = 'not-an-email'; })],
    ['BANK_UNKNOWN', tweak((i) => { i.collaborators[0].bankCode = '000'; i.collaborators[0].accountNumber = '1234567890'; })],
    ['ACCOUNT_NUMBER_INVALID', tweak((i) => { i.collaborators[0].bankCode = '044'; i.collaborators[0].accountNumber = '12345'; })],
    ['ACCOUNT_NOT_RESOLVED', tweak((i) => { i.collaborators[0].bankCode = '044'; i.collaborators[0].accountNumber = '0000000000'; })],
  ];
  const before = app.store.version;
  for (const [code, input] of cases) await rejectsWith(assert, () => app.engine.createProject(input), code);
  await rejectsWith(assert, () => app.engine.createProject(null), 'INPUT_INVALID');
  assert.equal(app.store.version, before, 'rejected projects write nothing');
  const out = await app.engine.createProject(ok());
  assert.ok(out.projectId);
  const p = project(app, out.projectId);
  assert.equal(p.feeKobo, 15_000);
  assert.equal(p.clientPaysKobo, 1_015_000);
  assert.equal(p.status, 'awaiting_confirmations');
});

test('confirming a share: explicit acceptance, valid bank, ten digits, and the server re-resolves the name', async () => {
  const app = makeApp(); const u = await userProject(app, { confirm: false });
  const c = u.collabs[1];
  await rejectsWith(assert, app.engine.confirmShare(c, { bankCode: '058', accountNumber: '2000000002' }), 'ACCEPT_REQUIRED');
  await rejectsWith(assert, app.engine.confirmShare(c, { accept: 'yes', bankCode: '058', accountNumber: '2000000002' }), 'ACCEPT_REQUIRED');
  await rejectsWith(assert, app.engine.confirmShare(c, { accept: true, accountNumber: '2000000002' }), 'BANK_REQUIRED');
  await rejectsWith(assert, app.engine.confirmShare(c, { accept: true, bankCode: '058', accountNumber: '200000002' }), 'ACCOUNT_NUMBER_INVALID');
  await rejectsWith(assert, app.engine.confirmShare(c, { accept: true, bankCode: '058', accountNumber: '20000000AB' }), 'ACCOUNT_NUMBER_INVALID');
  await rejectsWith(assert, app.engine.confirmShare(c, { accept: true, bankCode: '058', accountNumber: '0000000000' }), 'ACCOUNT_NOT_RESOLVED');
  assert.equal(project(app, u.projectId).collaborators[1].confirmed, false);
  await app.engine.confirmShare(c, { accept: true, bankCode: '058', accountNumber: '2000000009', accountName: 'FAKE NAME FROM THE BROWSER' });
  const lv = await app.engine.view(u.lead);
  assert.equal(lv.project.collaborators[1].bank.accountName, 'TEST ACCOUNT 0009', 'a browser-supplied name is ignored');
  const r = await app.engine.resolveAccount(c, { bankCode: '058', accountNumber: '2000000010' });
  assert.deepEqual(r, { accountName: 'TEST ACCOUNT 0010', bankName: 'Guaranty Trust Bank', masked: '••••••0010' });
});

test('prototype-pollution style keys in ids and bodies are inert', async () => {
  const app = makeApp(); const s = await seeded(app, 'delivered');
  await rejectsWith(assert, app.engine.approveMilestone(s.client, '__proto__'), 'MILESTONE_NOT_FOUND');
  await rejectsWith(assert, app.engine.retryPayout(s.lead, 'constructor'), 'PAYOUT_NOT_FOUND');
  await rejectsWith(assert, app.engine.respondToProposal(s.client, 'm1', '__proto__', { accept: true }), 'NO_DISPUTE');
  const body = JSON.parse('{"title":"T","clientName":"C","__proto__":{"polluted":1},"collaborators":[{"name":"A","role":"R","bps":10000}],"milestones":[{"title":"M","amountKobo":10000,"criteria":["Does the thing."]}]}');
  await app.engine.createProject(body);
  assert.equal({}.polluted, undefined);
});

test('no secret key is shipped to browsers: nothing under public/ or the shared modules mentions keys', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const scan = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scan(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
  for (const f of [...scan(path.join(root, 'public')), ...scan(path.join(root, 'src', 'shared'))]) {
    if (!/\.(js|html|css|json|svg)$/.test(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/sk_(test|live)_[A-Za-z0-9]/.test(text), `${f} contains a key-shaped string`);
    assert.ok(!/PAYSTACK_SECRET_KEY|Bearer /.test(text), `${f} references the secret key`);
  }
});

test('whatever a provider says is redacted: a failure reason that echoes an account number is masked', async () => {
  const { ProviderError, redactAccounts } = await import('../src/shared/errors.js');
  assert.equal(redactAccounts('Account 0123456789 is closed; ref 12345678901 kept'), 'Account ••••••6789 is closed; ref 12345678901 kept');
  assert.equal(new ProviderError('X', 'Bank says 0123456789 not found').message, 'Bank says ••••••6789 not found');
  const app = makeApp(); const s = await seeded(app, 'delivered');
  const w = app.provider.signWebhook; // a transfer.failed webhook whose reason leaks a full account number
  await app.engine.approveMilestone(s.client, 'm1'); await app.engine.idle();
  const po = project(app, s.projectId).payouts.po_m1_c2;
  const hook = w.call(app.provider, { event: 'transfer.failed', data: { reference: po.reference, status: 'failed', reason: 'Beneficiary account 1000000002 rejected the credit' } });
  // success is final, so use a fresh payout that is still processing
  await app.store.transact((d) => { d.projects[s.projectId].payouts.po_m1_c2.status = 'processing'; });
  const r = await app.engine.handleWebhook(hook.rawBody, hook.headers); await r.done;
  const stored = project(app, s.projectId).payouts.po_m1_c2.failureReason;
  assert.equal(stored, 'Beneficiary account ••••••0002 rejected the credit');
  assert.ok(!JSON.stringify(await app.engine.view(s.lead)).includes('1000000002'));
  assert.ok(!JSON.stringify(await app.engine.publicLedger(s.publicId)).includes('1000000002'));
});
