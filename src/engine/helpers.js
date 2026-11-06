// Small shared helpers for the engine: safe property access, ids, tokens, input cleaning.

import { randomBytes, createHash } from 'node:crypto';
import { ValidationError } from '../shared/errors.js';

/** Own-property lookup. Use for ANY key that came from a request, so '__proto__' cannot match. */
export const own = (obj, key) => (obj && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined);

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function randomId(prefix, len = 10) {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += B32[bytes[i] % 32];
  return `${prefix}${s}`;
}

/** 256-bit unguessable capability token, URL-safe. */
export const newToken = () => randomBytes(32).toString('base64url');

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const tokenKey = (token) => sha256(`splitpot:token:${token}`);

const cc = (n) => String.fromCharCode(n);
// C0 controls (except tab/newline handled by trimming), DEL, line/paragraph separators, bidi overrides.
const CONTROL = new RegExp(`[${cc(0)}-${cc(8)}${cc(11)}-${cc(12)}${cc(14)}-${cc(31)}${cc(127)}${cc(0x2028)}${cc(0x2029)}${cc(0x202a)}-${cc(0x202e)}${cc(0x2066)}-${cc(0x2069)}]`);

export function cleanText(v, { label, min = 1, max = 200, multiline = false } = {}) {
  if (typeof v !== 'string') throw new ValidationError('FIELD_REQUIRED', `${label} is required.`);
  let s = v.normalize('NFC').trim();
  if (!multiline) s = s.replace(/\s+/g, ' ');
  if (CONTROL.test(s)) throw new ValidationError('FIELD_INVALID', `${label} contains characters that are not allowed.`);
  if (s.length < min) {
    throw new ValidationError('FIELD_TOO_SHORT', min <= 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`);
  }
  if (s.length > max) throw new ValidationError('FIELD_TOO_LONG', `${label} can be at most ${max} characters.`);
  return s;
}

export function cleanUrl(v, label = 'Link') {
  const s = cleanText(v, { label, min: 8, max: 500 });
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError('URL_INVALID', `${label} must be a full web address starting with https://`);
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw new ValidationError('URL_INVALID', `${label} must be a plain http(s) web address.`);
  }
  return u.toString();
}

export function cleanEmail(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = cleanText(v, { label: 'Client email', max: 120 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ValidationError('EMAIL_INVALID', 'Enter a valid email address or leave it blank.');
  return s;
}

export const HOUR = 3_600_000;
export const REVIEW_WINDOW_MS = 72 * HOUR;
export const NEGOTIATION_MS = 5 * 24 * HOUR;

/** A milestone is frozen while its dispute is being negotiated or is with the reviewer. */
export const isFrozen = (m) => !!m.dispute && (m.dispute.status === 'negotiating' || m.dispute.status === 'in_review');
