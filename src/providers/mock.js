// Mock payment provider. Everything here is SIMULATED: no bank, no card, no money.
//
// It exists to exercise the exact same code paths as production:
//  - checkout completion produces a webhook body signed with HMAC-SHA512, delivered
//    over real HTTP to /api/webhooks/payment, verified by the same function Paystack uses;
//  - the engine still calls verifyCharge() server-side before marking anything funded;
//  - transfers are idempotent on `reference`, like Paystack's.
//
// State lives in store.mock so it survives restarts and resets with the demo.

import { randomBytes, createHash } from 'node:crypto';
import { ProviderError } from '../shared/errors.js';
import { signPayload, verifySignature, SIGNATURE_HEADER } from './webhookSignature.js';

export const FAILING_TEST_ACCOUNT = '0000000404';
export const UNRESOLVABLE_TEST_ACCOUNT = '0000000000';

// Mock list. Real bank codes must come from Paystack's list-banks endpoint.
// TODO(verify): codes below are placeholders for the mock only.
export const MOCK_BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'Guaranty Trust Bank', code: '058' },
  { name: 'Kuda Microfinance Bank', code: '50211' },
  { name: 'Moniepoint Microfinance Bank', code: '50515' },
  { name: 'OPay', code: '999992' },
  { name: 'Stanbic IBTC Bank', code: '221' },
  { name: 'United Bank for Africa', code: '033' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Zenith Bank', code: '057' },
];

export const mockInitialState = () => ({
  secret: randomBytes(32).toString('hex'),
  charges: {},
  transfers: {},
  recipients: {},
  failedOnce: {},
  names: {},
  moneyOutKobo: 0,
});

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function createMockProvider({ store, baseUrl = () => '', now = () => Date.now() }) {
  const secret = () => store.snapshot().mock.secret;

  const tx = (fn) =>
    store.transact((draft) => {
      draft.mock ??= mockInitialState();
      return fn(draft.mock);
    });

  return {
    name: 'mock',
    isMock: true,

    async listBanks() {
      return MOCK_BANKS;
    },

    async initializeCharge({ reference, amountKobo, currency }) {
      await tx((m) => {
        if (m.charges[reference]) return; // idempotent on reference
        m.charges[reference] = { reference, amountKobo, currency, status: 'pending', paidKobo: 0, paidCurrency: currency, createdAt: now() };
      });
      return { reference, authorizationUrl: `${baseUrl()}/checkout/${encodeURIComponent(reference)}`, accessCode: `mock_${sha(reference).slice(0, 12)}` };
    },

    async verifyCharge(reference) {
      const m = store.snapshot().mock;
      const c = Object.hasOwn(m.charges, reference) ? m.charges[reference] : null;
      if (!c) throw new ProviderError('CHARGE_NOT_FOUND', 'The payment provider has no charge with that reference.');
      return {
        reference,
        status: c.status, // 'pending' | 'success' | 'failed'
        amountKobo: c.status === 'success' ? c.paidKobo : 0,
        currency: c.paidCurrency,
      };
    },

    /** Builds the exact { rawBody, headers } a provider would POST to our webhook URL. */
    signWebhook(eventBody) {
      const rawBody = Buffer.from(JSON.stringify(eventBody), 'utf8');
      return { rawBody, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signPayload(secret(), rawBody) } };
    },

    parseAndVerifyWebhook(rawBody, headers) {
      verifySignature(secret(), rawBody, headers);
      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new ProviderError('WEBHOOK_BODY_INVALID', 'Webhook body is not valid JSON.');
      }
      return normalizeEvent(body, rawBody);
    },

    /** Simulated checkout page action. Returns the signed webhook to deliver. */
    async completeCheckout(reference, { outcome = 'success', shortfallKobo = 0, currency } = {}) {
      const next = await tx((m) => {
        const c = Object.hasOwn(m.charges, reference) ? m.charges[reference] : null;
        if (!c) throw new ProviderError('CHARGE_NOT_FOUND', 'No simulated charge with that reference.');
        if (c.status !== 'pending') return { alreadyFinal: true, charge: { ...c } };
        if (outcome === 'success') {
          c.status = 'success';
          c.paidKobo = Math.max(1, c.amountKobo - shortfallKobo);
          c.paidCurrency = currency || c.currency;
        } else {
          c.status = 'failed';
        }
        return { alreadyFinal: false, charge: { ...c } };
      });
      if (next.alreadyFinal) return { webhook: null, charge: next.charge };
      const c = next.charge;
      const body =
        c.status === 'success'
          ? { event: 'charge.success', data: { id: Number.parseInt(sha(reference).slice(0, 8), 16), reference, status: 'success', amount: c.paidKobo, currency: c.paidCurrency } }
          : { event: 'charge.failed', data: { reference, status: 'failed', amount: c.amountKobo, currency: c.currency } };
      return { webhook: this.signWebhook(body), charge: c };
    },

    async getCharge(reference) {
      const m = store.snapshot().mock;
      return Object.hasOwn(m.charges, reference) ? m.charges[reference] : null;
    },

    async resolveAccount({ accountNumber, bankCode }) {
      if (!MOCK_BANKS.some((b) => b.code === bankCode)) throw new ProviderError('BANK_UNKNOWN', 'That bank is not in the test bank list.');
      if (accountNumber === UNRESOLVABLE_TEST_ACCOUNT) {
        throw new ProviderError('ACCOUNT_NOT_RESOLVED', 'Could not resolve this account number. Check the number and the bank.');
      }
      const m = store.snapshot().mock;
      const known = Object.hasOwn(m.names, accountNumber) ? m.names[accountNumber] : null;
      return { accountNumber, bankCode, accountName: known ?? `TEST ACCOUNT ${accountNumber.slice(-4)}` };
    },

    /** Demo seeding helper: give an account number a fixed synthetic account name. */
    async registerName(accountNumber, accountName) {
      await tx((m) => {
        m.names[accountNumber] = accountName;
      });
    },

    async createRecipient({ name, accountNumber, bankCode }) {
      const code = `RCP_mock_${sha(`${bankCode}:${accountNumber}`).slice(0, 12)}`;
      await tx((m) => {
        m.recipients[code] ??= { code, name, accountNumber, bankCode };
      });
      return { recipientCode: code };
    },

    /**
     * transfers: [{ reference, recipientCode, amountKobo, reason }]
     * Idempotent on reference: a repeated reference returns the stored result and moves nothing.
     * The designated test account fails once, then succeeds on a later (new-reference) attempt.
     */
    async bulkTransfer({ transfers, currency = 'NGN' }) {
      if (!Array.isArray(transfers) || transfers.length === 0) return { results: [] };
      if (transfers.length > 100) throw new ProviderError('BATCH_TOO_LARGE', 'A batch can hold at most 100 transfers.');
      const results = await tx((m) => {
        const out = [];
        for (const t of transfers) {
          const prior = Object.hasOwn(m.transfers, t.reference) ? m.transfers[t.reference] : null;
          if (prior) {
            out.push({ reference: t.reference, status: prior.status, transferCode: prior.transferCode, failureReason: prior.failureReason, duplicate: true });
            continue;
          }
          const rec = Object.hasOwn(m.recipients, t.recipientCode) ? m.recipients[t.recipientCode] : null;
          if (!rec) {
            out.push({ reference: t.reference, status: 'failed', failureReason: 'Unknown transfer recipient.' });
            continue;
          }
          const transferCode = `TRF_mock_${sha(t.reference).slice(0, 12)}`;
          if (rec.accountNumber === FAILING_TEST_ACCOUNT && !m.failedOnce[rec.accountNumber]) {
            m.failedOnce[rec.accountNumber] = true;
            const failureReason = `Beneficiary bank rejected the transfer (simulated failure for the designated test account ending ${FAILING_TEST_ACCOUNT.slice(-4)}).`;
            m.transfers[t.reference] = { reference: t.reference, status: 'failed', transferCode, failureReason, amountKobo: t.amountKobo, currency };
            out.push({ reference: t.reference, status: 'failed', transferCode, failureReason });
            continue;
          }
          m.transfers[t.reference] = { reference: t.reference, status: 'success', transferCode, amountKobo: t.amountKobo, currency };
          m.moneyOutKobo += t.amountKobo;
          out.push({ reference: t.reference, status: 'success', transferCode });
        }
        return out;
      });
      return { results };
    },

    async resetFailureMemory() {
      await tx((m) => {
        m.failedOnce = {};
      });
    },
  };
}

/** Provider event -> engine event. Shape mirrors Paystack's { event, data } envelope. */
export function normalizeEvent(body, rawBody) {
  const type = typeof body?.event === 'string' ? body.event : '';
  const d = body?.data ?? {};
  return {
    id: sha(rawBody),
    type,
    reference: typeof d.reference === 'string' ? d.reference : null,
    status: typeof d.status === 'string' ? d.status : null,
    amountKobo: Number.isSafeInteger(d.amount) ? d.amount : null,
    currency: typeof d.currency === 'string' ? d.currency : null,
    reason: typeof d.reason === 'string' ? d.reason : null,
  };
}
