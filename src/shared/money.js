// Money and share arithmetic.
//
// Rules enforced here:
//  - Money is integer kobo. No floating point is ever used in an allocation.
//  - Shares are integer basis points (1 bp = 0.01%) and must sum to exactly 10,000.
//  - Allocation uses the largest-remainder method on BigInt, so the parts always
//    add up to the whole, to the kobo.
//  - Formatting and parsing work on strings/BigInt, never on Number division.
//
// Browser-safe: the same module is imported by the server and served to the front end.

import { ValidationError, InternalError } from './errors.js';

export const CURRENCY = 'NGN';
export const BPS_TOTAL = 10000;
export const DEFAULT_FEE_BPS = 150; // ASSUMPTION to be tested, not an established market price.

// Cap keeps every stored amount a safe JS integer (< 2^53) so JSON round-trips exactly.
// 10,000,000,000,000 kobo = ₦100,000,000,000.
export const MAX_KOBO = 10_000_000_000_000n;

/** Normalise number | numeric string | bigint to a validated BigInt of kobo. */
export function toBigKobo(value, label = 'amount') {
  let b;
  if (typeof value === 'bigint') b = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError('AMOUNT_NOT_INTEGER', `${label} must be a whole number of kobo.`);
    }
    b = BigInt(value);
  } else if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
    b = BigInt(value);
  } else {
    throw new ValidationError('AMOUNT_NOT_INTEGER', `${label} must be a whole number of kobo.`);
  }
  if (b < 0n) throw new ValidationError('AMOUNT_NEGATIVE', `${label} cannot be negative.`);
  if (b > MAX_KOBO) throw new ValidationError('AMOUNT_TOO_LARGE', `${label} is larger than this prototype allows.`);
  return b;
}

/** BigInt kobo -> Number. Safe because toBigKobo caps at MAX_KOBO. */
export const koboToNumber = (b) => Number(b);

/** Shares must be integer bps, each 1..10000, summing to exactly 10,000. */
export function validateShares(shares) {
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new ValidationError('SHARES_EMPTY', 'Add at least one collaborator with a share.');
  }
  if (shares.length > 50) {
    throw new ValidationError('SHARES_TOO_MANY', 'A project can have at most 50 collaborators.');
  }
  let sum = 0;
  for (const s of shares) {
    if (!Number.isInteger(s.bps) || s.bps < 1 || s.bps > BPS_TOTAL) {
      throw new ValidationError(
        'SHARE_INVALID',
        'Each share must be a whole number of basis points between 0.01% and 100%.',
      );
    }
    sum += s.bps;
  }
  if (sum !== BPS_TOTAL) {
    throw new ValidationError(
      'SHARES_NOT_100',
      `Shares total ${bpsToPercentString(sum)} but must total exactly 100%.`,
      { totalBps: sum },
    );
  }
}

/**
 * Largest-remainder allocation.
 *   floor(total * bps / 10000) to everyone, then hand the leftover kobo, one each,
 *   to the largest fractional remainders. Ties go to the larger share, then to the
 *   earlier position, so the result is fully deterministic.
 * Returns [{ id, amountKobo }] in input order. Sum === total, always.
 */
export function allocateByShares(totalKobo, shares) {
  const total = toBigKobo(totalKobo, 'total');
  validateShares(shares);
  const rows = shares.map((s, i) => {
    const numerator = total * BigInt(s.bps);
    return { id: s.id, i, bps: s.bps, base: numerator / 10000n, rem: numerator % 10000n };
  });
  const leftover = total - rows.reduce((acc, r) => acc + r.base, 0n);
  if (leftover < 0n || leftover >= BigInt(rows.length)) {
    throw new InternalError('Largest-remainder leftover out of range.', { leftover: String(leftover) });
  }
  const order = [...rows].sort((a, b) => {
    if (a.rem !== b.rem) return a.rem > b.rem ? -1 : 1;
    if (a.bps !== b.bps) return b.bps - a.bps;
    return a.i - b.i;
  });
  const bump = new Set(order.slice(0, Number(leftover)).map((r) => r.i));
  const out = rows.map((r) => ({ id: r.id, amountKobo: koboToNumber(r.base + (bump.has(r.i) ? 1n : 0n)) }));
  const check = out.reduce((a, r) => a + BigInt(r.amountKobo), 0n);
  if (check !== total) {
    throw new InternalError('Allocation does not sum to the total.', { total: String(total), check: String(check) });
  }
  return out;
}

/** Evenly split 100% across n people in whole basis points (sums to 10,000). */
export function splitEvenlyBps(n) {
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new ValidationError('SPLIT_COUNT_INVALID', 'Choose between 1 and 50 collaborators.');
  }
  const base = Math.floor(BPS_TOTAL / n);
  const extra = BPS_TOTAL % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Platform fee: feeBps of the project total, rounded half up, charged on top. */
export function calcFee(projectTotalKobo, feeBps = DEFAULT_FEE_BPS) {
  const total = toBigKobo(projectTotalKobo, 'project total');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > BPS_TOTAL) {
    throw new ValidationError('FEE_INVALID', 'Fee must be between 0 and 10,000 basis points.');
  }
  return koboToNumber((total * BigInt(feeBps) + 5000n) / 10000n);
}

/**
 * Split a milestone between "release to the team" and "refund to the client".
 * release = round-half-up(amount * releaseBps / 10000); refund = the remainder.
 */
export function splitRelease(amountKobo, releaseBps) {
  const amount = toBigKobo(amountKobo, 'milestone amount');
  if (!Number.isInteger(releaseBps) || releaseBps < 0 || releaseBps > BPS_TOTAL) {
    throw new ValidationError('SPLIT_BPS_INVALID', 'Split must be between 0% and 100%.');
  }
  const release = (amount * BigInt(releaseBps) + 5000n) / 10000n;
  return { releaseKobo: koboToNumber(release), refundKobo: koboToNumber(amount - release) };
}

const groupThousands = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 100000000 -> "₦1,000,000". Kobo shown only when non-zero (or forced). String math only. */
export function formatNaira(kobo, { forceKobo = false, symbol = '₦' } = {}) {
  const b = toBigKobo(kobo);
  const whole = b / 100n;
  const frac = b % 100n;
  const base = groupThousands(whole.toString());
  if (frac === 0n && !forceKobo) return `${symbol}${base}`;
  return `${symbol}${base}.${frac.toString().padStart(2, '0')}`;
}

/** "400,000" | "₦400000.5" -> 40000050 kobo. Returns null when the text is not a clean amount. */
export function parseNairaToKobo(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/[₦,\s]/g, '');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const kobo = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  if (kobo > MAX_KOBO) return null;
  return koboToNumber(kobo);
}

/** 3334 -> "33.34%", 2500 -> "25%". */
export function bpsToPercentString(bps) {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%`;
}

/** "33.34" | "25%" -> 3334 / 2500 bps. Null when not a clean percentage with <= 2 decimals. */
export function parsePercentToBps(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.replace(/[%\s]/g, ''));
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bps <= BPS_TOTAL ? bps : null;
}

export const isValidAccountNumber = (s) => typeof s === 'string' && /^\d{10}$/.test(s);
export const last4 = (s) => String(s).slice(-4);
/** Mask everything except the last four digits. */
export const maskAccount = (s) => `••••••${last4(s)}`;
