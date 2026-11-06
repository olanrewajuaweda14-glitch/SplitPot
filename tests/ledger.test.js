import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEntry, verifyChain, chainStatusText, canonicalize, GENESIS_HASH, computeEntryHash } from '../src/domain/ledger.js';
import { JsonStore } from '../src/storage/jsonStore.js';

const build = (n = 6) => {
  const L = [];
  for (let i = 1; i <= n; i += 1) appendEntry(L, { ts: 1_000 + i, type: i % 2 ? 'funding.verified' : 'payout.succeeded', projectId: 'p1', data: { i, amountKobo: i * 100 } });
  return L;
};

test('5. ledger hash verification: genesis link, chained hashes, deterministic canonical form', () => {
  const L = build();
  assert.equal(L[0].prevHash, GENESIS_HASH);
  for (let i = 1; i < L.length; i += 1) assert.equal(L[i].prevHash, L[i - 1].hash);
  const v = verifyChain(L);
  assert.deepEqual({ ok: v.ok, length: v.length }, { ok: true, length: 6 });
  assert.equal(chainStatusText(v), 'Chain verified');
  // the hash really is SHA-256(prevHash + canonical body); key order must not matter
  const e = L[2];
  assert.equal(e.hash, computeEntryHash(e.prevHash, { seq: e.seq, ts: e.ts, type: e.type, projectId: e.projectId, data: e.data }));
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), canonicalize({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  assert.equal(L[0].hash.length, 64);
});

test('5b. the ledger refuses floats: money in it is integer kobo', () => {
  assert.throws(() => canonicalize({ amount: 1.5 }), TypeError);
  assert.throws(() => appendEntry([], { ts: 1, type: 't', projectId: 'p', data: { amount: 0.1 } }), TypeError);
});

test('6. tampering is detected and reported at the exact entry', () => {
  const edits = {
    'edit an amount': (L) => { L[2].data.amountKobo += 1; },
    'edit the type': (L) => { L[1].type = 'refund.simulated'; },
    'edit a timestamp': (L) => { L[3].ts += 1; },
    'edit the stored hash': (L) => { L[2].hash = 'a'.repeat(64); },
    'edit the prev link': (L) => { L[4].prevHash = GENESIS_HASH; },
    'add a hidden field': (L) => { L[2].extra = 'x'; },
  };
  const expectedAt = { 'edit an amount': 3, 'edit the type': 2, 'edit a timestamp': 4, 'edit the stored hash': 3, 'edit the prev link': 5, 'add a hidden field': 3 };
  for (const [name, edit] of Object.entries(edits)) {
    const L = build();
    edit(L);
    const v = verifyChain(L);
    assert.equal(v.ok, false, name);
    assert.equal(v.brokenAt, expectedAt[name], `${name}: broken at ${expectedAt[name]}`);
    assert.equal(chainStatusText(v), `Chain broken at entry ${expectedAt[name]}.`);
  }
});

test('6b. deleting, reordering or truncating entries is detected', () => {
  const del = build(); del.splice(2, 1);
  assert.equal(verifyChain(del).ok, false);
  assert.equal(verifyChain(del).brokenAt, 3);

  const swap = build(); [swap[1], swap[2]] = [swap[2], swap[1]];
  assert.equal(verifyChain(swap).ok, false);

  // truncation of the tail is only visible against a recorded head (the anchor)
  const L = build();
  const anchor = { seq: L.length, hash: L[L.length - 1].hash };
  assert.equal(verifyChain(L, anchor).ok, true);
  const cut = L.slice(0, 4);
  assert.equal(verifyChain(cut).ok, true, 'a chain alone cannot see its own tail removed');
  const v = verifyChain(cut, anchor);
  assert.equal(v.ok, false);
  assert.match(v.reason, /tail/i);
});

test('store: concurrent transactions never lose an update (process-wide mutex)', async () => {
  const store = new JsonStore({ file: null, initial: () => ({ n: 0 }) });
  await Promise.all(Array.from({ length: 200 }, () => store.transact((d) => { d.n += 1; })));
  assert.equal(store.snapshot().n, 200);
  assert.equal(store.version, 200);
});

test('store: a throwing transaction changes nothing, and async work inside a lock is refused', async () => {
  const store = new JsonStore({ file: null, initial: () => ({ n: 1 }) });
  await assert.rejects(store.transact((d) => { d.n = 99; throw new Error('boom'); }), /boom/);
  assert.equal(store.snapshot().n, 1);
  await assert.rejects(store.transact(async (d) => { d.n = 5; }), { code: 'INTERNAL_INVARIANT' });
  assert.equal(store.snapshot().n, 1, 'no provider/network call may run while the lock is held');
  await store.transact(() => {});
  assert.equal(store.version, 0, 'a no-op transaction does not write');
});

test('store: atomic file writes survive a reload, and a corrupt file is quarantined not erased', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitpot-store-'));
  const file = path.join(dir, 's.json');
  const a = new JsonStore({ file, initial: () => ({ items: [] }) });
  await a.transact((d) => { d.items.push('x'); });
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp file left behind');
  const b = new JsonStore({ file, initial: () => ({ items: [] }) });
  assert.deepEqual(b.snapshot().items, ['x']);
  fs.writeFileSync(file, '{"items": [');
  const quiet = console.error; console.error = () => {};
  const c = new JsonStore({ file, initial: () => ({ items: ['fresh'] }) });
  console.error = quiet;
  assert.deepEqual(c.snapshot().items, ['fresh']);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), 'the unreadable file was kept for inspection');
});
