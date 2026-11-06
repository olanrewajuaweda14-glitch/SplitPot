// HMAC-SHA512 webhook signing and verification, shared by the mock and Paystack providers.
//
// Paystack: header `x-paystack-signature` = HMAC-SHA512(secret, request body), hex digest.
// We hash the RAW BYTES as received. Never re-serialise parsed JSON before hashing.
// TODO(verify): Paystack's own example hashes JSON.stringify(req.body). Confirm that raw
// bytes produce the same digest on a real delivery.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignatureError } from '../shared/errors.js';

export const SIGNATURE_HEADER = 'x-paystack-signature';

export function signPayload(secret, rawBody) {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

/** Throws SignatureError unless `headers[x-paystack-signature]` matches the raw body. */
export function verifySignature(secret, rawBody, headers) {
  if (!secret) throw new SignatureError('Webhook secret is not configured on the server.');
  if (!Buffer.isBuffer(rawBody)) throw new SignatureError('Webhook body must be the raw request bytes.');
  const header = headers?.[SIGNATURE_HEADER];
  const given = Array.isArray(header) ? header[0] : header;
  if (typeof given !== 'string' || !/^[0-9a-f]{128}$/i.test(given)) throw new SignatureError();
  const expected = Buffer.from(signPayload(secret, rawBody), 'hex');
  const actual = Buffer.from(given, 'hex');
  // Lengths are equal (64 bytes) by the regex above, which timingSafeEqual requires.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new SignatureError();
}
