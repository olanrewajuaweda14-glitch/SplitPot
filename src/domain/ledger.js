// Append-only, hash-chained ledger.
//
//   hash(n) = SHA-256( hash(n-1) + "\n" + canonical({ seq, ts, type, projectId, data }) )
//
// What this gives you: tamper EVIDENCE. Editing, reordering, or deleting a middle
// entry breaks the chain at a specific entry number. What it does not give you:
// protection against someone who can rewrite the whole store and recompute every
// hash. Publish the head hash somewhere you do not control (anchoring) for that.

import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);
const ENTRY_KEYS = ['data', 'hash', 'prevHash', 'projectId', 'seq', 'ts', 'type'];

/**
 * Deterministic JSON: sorted keys, no whitespace, integers/strings/booleans/null only.
 * Floats are rejected on purpose: money in the ledger is integer kobo.
 */
export function canonicalize(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new TypeError('Ledger numbers must be safe integers.');
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
      const keys = Object.keys(v)
        .filter((k) => v[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalize a value of type ${typeof v}.`);
  }
}

export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

export function computeEntryHash(prevHash, body) {
  return sha256Hex(`${prevHash}\n${canonicalize(body)}`);
}

const bodyOf = (e) => ({ seq: e.seq, ts: e.ts, type: e.type, projectId: e.projectId, data: e.data });

/** Append to `entries` (mutates the array) and return the new entry. */
export function appendEntry(entries, { ts, type, projectId, data }) {
  const prev = entries[entries.length - 1];
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  const seq = entries.length + 1;
  const body = { seq, ts, type, projectId, data: data ?? {} };
  const entry = { ...body, prevHash, hash: computeEntryHash(prevHash, body) };
  entries.push(entry);
  return entry;
}

/**
 * Verify the whole chain. Returns:
 *   { ok: true,  length, head }
 *   { ok: false, brokenAt: <seq>, reason, length, head }
 * `anchor` ({ seq, hash }) is the last known head; it catches truncation of the tail.
 */
export function verifyChain(entries, anchor) {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const seq = i + 1;
    const fail = (reason) => ({ ok: false, brokenAt: seq, reason, length: entries.length, head: lastHash(entries) });
    const keys = Object.keys(e).sort();
    if (keys.length !== ENTRY_KEYS.length || keys.some((k, j) => k !== ENTRY_KEYS[j])) {
      return fail('Entry has unexpected fields.');
    }
    if (e.seq !== seq) return fail('Entry number is out of sequence.');
    if (e.prevHash !== prevHash) return fail('Link to the previous entry does not match.');
    let expected;
    try {
      expected = computeEntryHash(prevHash, bodyOf(e));
    } catch {
      return fail('Entry contents are not valid ledger data.');
    }
    if (e.hash !== expected) return fail('Entry contents do not match its hash.');
    prevHash = e.hash;
  }
  if (anchor && anchor.seq > 0) {
    const tail = entries[entries.length - 1];
    if (!tail || tail.seq !== anchor.seq || tail.hash !== anchor.hash) {
      return {
        ok: false,
        brokenAt: Math.min(entries.length + 1, anchor.seq),
        reason: 'Ledger tail does not match the last recorded head (entries removed or replaced).',
        length: entries.length,
        head: lastHash(entries),
      };
    }
  }
  return { ok: true, length: entries.length, head: lastHash(entries) };
}

const lastHash = (entries) => (entries.length ? entries[entries.length - 1].hash : GENESIS_HASH);

/** Human string for the UI: "Chain verified" or "Chain broken at entry N." */
export const chainStatusText = (v) => (v.ok ? 'Chain verified' : `Chain broken at entry ${v.brokenAt}.`);
