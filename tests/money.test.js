import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateByShares, calcFee, splitRelease, splitEvenlyBps, validateShares, formatNaira, parseNairaToKobo,
  bpsToPercentString, parsePercentToBps, toBigKobo, maskAccount, isValidAccountNumber,
} from '../src/shared/money.js';
import { prng } from './helpers.js';

const seededShares = [
  { id: 'director', bps: 4000 }, { id: 'editor', bps: 2500 }, { id: 'camera', bps: 2000 }, { id: 'sound', bps: 1500 },
];
const sum = (rows) => rows.reduce((a, r) => a + BigInt(r.amountKobo), 0n);

test('1. largest-remainder: the seeded scenario splits exactly', () => {
  const rough = allocateByShares(40_000_000, seededShares);
  assert.deepEqual(rough.map((r) => r.amountKobo), [16_000_000, 10_000_000, 8_000_000, 6_000_000]);
  const final = allocateByShares(60_000_000, seededShares);
  assert.deepEqual(final.map((r) => r.amountKobo), [24_000_000, 15_000_000, 12_000_000, 9_000_000]);
  assert.equal(sum(rough), 40_000_000n);
  assert.equal(sum(final), 60_000_000n);
});

test('2. awkward amounts: remainders are handed out so the parts always equal the whole', () => {
  const thirds = [{ id: 'a', bps: 3334 }, { id: 'b', bps: 3333 }, { id: 'c', bps: 3333 }];
  const cases = [
    [1, thirds], [2, thirds], [100, thirds], [100_001, thirds], [99_999_999, thirds], [10_000_000_000_000, thirds],
    [1, seededShares], [3, seededShares], [7, seededShares], [123_456_789, seededShares],
  ];
  for (const [total, shares] of cases) {
    const out = allocateByShares(total, shares);
    assert.equal(sum(out), BigInt(total), `parts must equal ${total}`);
    out.forEach((r) => assert.ok(r.amountKobo >= 0 && Number.isSafeInteger(r.amountKobo)));
  }
  // 1 kobo among thirds goes to the largest share, deterministically.
  assert.deepEqual(allocateByShares(1, thirds).map((r) => r.amountKobo), [1, 0, 0]);
  // 100,001 kobo: the extra kobo goes to the largest remainder (the 33.34% share).
  assert.deepEqual(allocateByShares(100_001, thirds).map((r) => r.amountKobo), [33_341, 33_330, 33_330]);
});

test('2b. property test: 3,000 random totals and share vectors never lose or invent a kobo', () => {
  const rnd = prng(2026);
  for (let n = 0; n < 3000; n += 1) {
    const people = 1 + Math.floor(rnd() * 12);
    // random positive integer bps summing to exactly 10,000
    const cuts = new Set();
    while (cuts.size < people - 1) cuts.add(1 + Math.floor(rnd() * 9999));
    const edges = [0, ...[...cuts].sort((a, b) => a - b), 10_000];
    const shares = edges.slice(1).map((e, i) => ({ id: `p${i}`, bps: e - edges[i] })).filter((s) => s.bps > 0);
    if (shares.reduce((a, s) => a + s.bps, 0) !== 10_000) continue;
    const total = Math.floor(rnd() * 5e11);
    const out = allocateByShares(total, shares);
    assert.equal(sum(out), BigInt(total));
    out.forEach((r, i) => {
      const exact = (BigInt(total) * BigInt(shares[i].bps)) / 10_000n;
      assert.ok(BigInt(r.amountKobo) === exact || BigInt(r.amountKobo) === exact + 1n, 'each part is floor or floor+1');
    });
  }
});

test('3. share validation: must be integer basis points totalling exactly 10,000', () => {
  assert.doesNotThrow(() => validateShares(seededShares));
  assert.throws(() => validateShares([{ id: 'a', bps: 5000 }, { id: 'b', bps: 4999 }]), { code: 'SHARES_NOT_100' });
  assert.throws(() => validateShares([{ id: 'a', bps: 5000 }, { id: 'b', bps: 5001 }]), { code: 'SHARES_NOT_100' });
  assert.throws(() => validateShares([{ id: 'a', bps: 33.33 }, { id: 'b', bps: 9966.67 }]), { code: 'SHARE_INVALID' });
  assert.throws(() => validateShares([{ id: 'a', bps: 0 }, { id: 'b', bps: 10_000 }]), { code: 'SHARE_INVALID' });
  assert.throws(() => validateShares([{ id: 'a', bps: -5 }, { id: 'b', bps: 10_005 }]), { code: 'SHARE_INVALID' });
  assert.throws(() => validateShares([]), { code: 'SHARES_EMPTY' });
  const err = (() => { try { validateShares([{ id: 'a', bps: 9000 }]); } catch (e) { return e; } return null; })();
  assert.match(err.message, /90% but must total exactly 100%/);
});

test('3b. split-evenly helper always sums to exactly 100%', () => {
  for (let n = 1; n <= 50; n += 1) {
    const parts = splitEvenlyBps(n);
    assert.equal(parts.length, n);
    assert.equal(parts.reduce((a, b) => a + b, 0), 10_000);
    assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
  }
  assert.deepEqual(splitEvenlyBps(3), [3334, 3333, 3333]);
});

test('4. fee: 150 bps of the project total, rounded half up, charged on top', () => {
  assert.equal(calcFee(100_000_000), 1_500_000); // ₦1,000,000 -> ₦15,000
  assert.equal(formatNaira(calcFee(100_000_000)), '₦15,000');
  assert.equal(formatNaira(100_000_000 + calcFee(100_000_000)), '₦1,015,000');
  assert.equal(calcFee(100), 2); // exactly 1.5 kobo rounds UP to 2
  assert.equal(calcFee(300), 5); // exactly 4.5 rounds UP to 5
  assert.equal(calcFee(99), 1); // 1.485 rounds down
  assert.equal(calcFee(0), 0);
  assert.equal(calcFee(10_000_000_000_000), 150_000_000_000);
  assert.throws(() => calcFee(1.5), { code: 'AMOUNT_NOT_INTEGER' });
  assert.throws(() => calcFee(-1), { code: 'AMOUNT_NEGATIVE' });
  assert.throws(() => calcFee(100, 10_001), { code: 'FEE_INVALID' });
});

test('4b. percentage split partitions a milestone with no leftover', () => {
  assert.deepEqual(splitRelease(40_000_000, 6000), { releaseKobo: 24_000_000, refundKobo: 16_000_000 });
  const rnd = prng(7);
  for (let i = 0; i < 2000; i += 1) {
    const amount = Math.floor(rnd() * 1e11);
    const bps = 1 + Math.floor(rnd() * 9999);
    const { releaseKobo, refundKobo } = splitRelease(amount, bps);
    assert.equal(releaseKobo + refundKobo, amount);
  }
  assert.deepEqual(splitRelease(1, 5000), { releaseKobo: 1, refundKobo: 0 }); // half-up
});

test('money input is strict: no floats, no negatives, no absurd sizes, no NaN', () => {
  for (const bad of [0.1, 1.5, NaN, Infinity, '1.5', '-1', '', 'abc', null, undefined, {}, [], 2 ** 53]) {
    assert.throws(() => toBigKobo(bad), (e) => ['AMOUNT_NOT_INTEGER', 'AMOUNT_NEGATIVE'].includes(e.code), `rejects ${String(bad)}`);
  }
  assert.throws(() => toBigKobo(10_000_000_000_001), { code: 'AMOUNT_TOO_LARGE' });
  assert.equal(toBigKobo('1000'), 1000n);
});

test('formatting and parsing use string/BigInt arithmetic only', () => {
  assert.equal(formatNaira(0), '₦0');
  assert.equal(formatNaira(100), '₦1');
  assert.equal(formatNaira(101), '₦1.01');
  assert.equal(formatNaira(123_456_789_012), '₦1,234,567,890.12');
  assert.equal(formatNaira(10_000_000_000_000), '₦100,000,000,000');
  assert.equal(parseNairaToKobo('₦400,000'), 40_000_000);
  assert.equal(parseNairaToKobo('400000.5'), 40_000_050);
  assert.equal(parseNairaToKobo('0.07'), 7);
  assert.equal(parseNairaToKobo('1.234'), null);
  assert.equal(parseNairaToKobo('-5'), null);
  assert.equal(parseNairaToKobo('1e6'), null);
  assert.equal(bpsToPercentString(2500), '25%');
  assert.equal(bpsToPercentString(3334), '33.34%');
  assert.equal(bpsToPercentString(3330), '33.3%');
  assert.equal(parsePercentToBps('33.34%'), 3334);
  assert.equal(parsePercentToBps('100'), 10_000);
  assert.equal(parsePercentToBps('100.01'), null);
  assert.equal(parsePercentToBps('12.345'), null);
});

test('bank accounts: ten digits, masked to the last four everywhere', () => {
  assert.ok(isValidAccountNumber('0123456789'));
  for (const bad of ['123456789', '01234567890', '12345abcde', '', ' 123456789', '0123456789\n']) assert.ok(!isValidAccountNumber(bad), bad);
  assert.equal(maskAccount('0123456789'), '••••••6789');
  assert.ok(!maskAccount('0123456789').includes('012345'));
});
