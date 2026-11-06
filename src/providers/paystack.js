// Paystack server-side adapter. UNTESTED AGAINST A REAL ACCOUNT.
//
// Written from Paystack's public docs, read on 2026-11-01 (see docs/PAYSTACK_VERIFICATION.md).
// The sandbox this was built in has no Paystack keys and no route to api.paystack.co, so
// nothing in this file has ever been executed against the live API. Anything not confirmed by
// the docs is marked TODO(verify).
//
// The secret key is read from the environment on the server only. It is never sent to the
// browser and never logged.

import { ProviderError } from '../shared/errors.js';
import { verifySignature } from './webhookSignature.js';
import { normalizeEvent } from './mock.js';

const API = 'https://api.paystack.co';
const BATCH_MAX = 100; // docs: no more than 100 transfers per batch
const BATCH_SPACING_MS = 5000; // docs: one batch every 5 seconds, else 429
const TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPaystackProvider({ secretKey, fetchImpl = fetch, sleepImpl = sleep }) {
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack.');
  let lastBatchAt = 0;
  let bankCache = { at: 0, banks: [] };

  async function call(method, path, { body, query } = {}) {
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or timeout: the outcome is UNKNOWN. Callers must not assume failure.
      throw new ProviderError('PROVIDER_UNREACHABLE', 'Could not reach Paystack. The outcome is unknown.', { cause: String(err?.name ?? err) });
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || json?.status === false) {
      throw new ProviderError('PROVIDER_REJECTED', json?.message || `Paystack returned HTTP ${res.status}.`, { http: res.status });
    }
    return json;
  }

  return {
    name: 'paystack',
    isMock: false,

    async listBanks() {
      if (Date.now() - bankCache.at < 3600_000 && bankCache.banks.length) return bankCache.banks;
      // TODO(verify): one source documents `currency=NGN`, another `country=nigeria`.
      const j = await call('GET', '/bank', { query: { currency: 'NGN', perPage: 200 } });
      bankCache = { at: Date.now(), banks: (j.data ?? []).map((b) => ({ name: b.name, code: String(b.code) })) };
      return bankCache.banks;
    },

    async initializeCharge({ reference, amountKobo, currency, email, callbackUrl, metadata }) {
      // TODO(verify): `currency` is not documented on the Accept Payments page for this endpoint.
      // If Paystack rejects it, drop it: the account default is NGN.
      const j = await call('POST', '/transaction/initialize', {
        body: { email, amount: String(amountKobo), currency, reference, callback_url: callbackUrl, metadata },
      });
      const d = j.data ?? {};
      if (!d.authorization_url) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Paystack did not return an authorization URL.');
      return { reference: d.reference ?? reference, authorizationUrl: d.authorization_url, accessCode: d.access_code };
    },

    /** Server-side verification. The caller compares amount and currency to its OWN records. */
    async verifyCharge(reference) {
      const j = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      const d = j.data ?? {};
      return { reference: d.reference ?? reference, status: String(d.status ?? 'unknown'), amountKobo: Number.isSafeInteger(d.amount) ? d.amount : 0, currency: String(d.currency ?? '') };
    },

    parseAndVerifyWebhook(rawBody, headers) {
      verifySignature(secretKey, rawBody, headers);
      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new ProviderError('WEBHOOK_BODY_INVALID', 'Webhook body is not valid JSON.');
      }
      // TODO(verify): payload shape of charge.success / transfer.* (data.reference, data.amount,
      // data.currency, data.status) was not shown on the webhook docs page that was read.
      return normalizeEvent(body, rawBody);
    },

    async resolveAccount({ accountNumber, bankCode }) {
      const j = await call('GET', '/bank/resolve', { query: { account_number: accountNumber, bank_code: bankCode } });
      const name = j.data?.account_name;
      if (!name) throw new ProviderError('ACCOUNT_NOT_RESOLVED', 'Could not resolve this account.');
      return { accountNumber, bankCode, accountName: name };
    },

    async createRecipient({ name, accountNumber, bankCode, currency = 'NGN' }) {
      const j = await call('POST', '/transferrecipient', { body: { type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency } });
      const code = j.data?.recipient_code;
      if (!code) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Paystack did not return a recipient code.');
      return { recipientCode: code };
    },

    /**
     * Max 100 per batch, one batch per 5 s. References must be 16-50 chars of [a-z0-9_-]
     * (docs); reusing a reference on retry prevents double credit.
     * Requires that OTP for transfers is disabled in the Paystack dashboard.
     */
    async bulkTransfer({ transfers, currency = 'NGN' }) {
      const results = [];
      for (let i = 0; i < transfers.length; i += BATCH_MAX) {
        const wait = lastBatchAt + BATCH_SPACING_MS - Date.now();
        if (wait > 0) await sleepImpl(wait);
        const chunk = transfers.slice(i, i + BATCH_MAX);
        lastBatchAt = Date.now();
        const j = await call('POST', '/transfer/bulk', {
          body: {
            currency,
            source: 'balance',
            transfers: chunk.map((t) => ({ amount: t.amountKobo, recipient: t.recipientCode, reference: t.reference, reason: t.reason })),
          },
        });
        for (const row of j.data ?? []) {
          // `queued` / `pending` are not final: the outcome arrives via transfer.* webhook.
          const s = String(row.status ?? '');
          results.push({
            reference: row.reference,
            status: s === 'success' ? 'success' : s === 'failed' || s === 'reversed' ? 'failed' : 'pending',
            transferCode: row.transfer_code,
            failureReason: s === 'failed' || s === 'reversed' ? `Paystack reported the transfer as ${s}.` : undefined,
          });
        }
      }
      return { results };
    },
  };
}
