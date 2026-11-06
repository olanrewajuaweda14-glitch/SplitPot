# Paystack integration: what was checked, and what was not

Checked on **2026-11-01** by reading Paystack's public documentation pages from the build
sandbox. **Nothing here was exercised against the live Paystack API**: the sandbox has no
Paystack keys and no route to `api.paystack.co`. The adapter in `src/providers/paystack.js`
is written from these docs and is **untested against a real account**.

## Confirmed from the docs pages

| Item | What the page says |
|---|---|
| Initialize | `POST https://api.paystack.co/transaction/initialize`. `email` and `amount` required. `amount` is in the currency's subunit. Optional `reference`, `callback_url`, `metadata`. Response `data.authorization_url`, `data.access_code`, `data.reference`. Must be called from a server. |
| Verify | `GET https://api.paystack.co/transaction/verify/:reference`. Check `data.status` is `success` (others: `failed`, `abandoned`, `ongoing`, `pending`, `processing`, `queued`, `reversed`). Also returns `data.amount`, `data.currency`, `data.reference`. |
| Bulk transfer | `POST https://api.paystack.co/transfer/bulk` with `currency`, `source` (`"balance"`), `transfers[]` of `{ amount, recipient, reference, reason }`. Max 100 per batch; one batch every 5 s (else 429). OTP for transfers must be disabled. Response `data[]` of `{ reference, recipient, amount, transfer_code, currency, status }`. |
| Transfer outcome | Asynchronous. Per-transfer webhooks `transfer.success`, `transfer.failed`, `transfer.reversed`, or poll `GET /transfer/verify/:reference`. **Test-mode transfers always return `success`.** |
| Transfer reference | Lowercase letters, digits, `_` and `-`; **16 to 50 characters**. Reusing a reference on retry prevents double credit; a new reference is a new transfer. |
| Create recipient | `POST https://api.paystack.co/transferrecipient` with `type: "nuban"`, `name`, `account_number`, `bank_code`, `currency: "NGN"`. Response `data.recipient_code`, `data.details`. |
| Resolve account | `GET https://api.paystack.co/bank/resolve?account_number=&bank_code=` returns `account_name` (secondary source, not Paystack's own page). |
| Webhook signature | Header `x-paystack-signature`, HMAC-SHA512 hex, keyed with the secret key. Return 200 quickly. Retries: live every 3 min for 4 tries then hourly for 72 h; test hourly for 72 h. |

## Not confirmed (marked `TODO(verify)` in code)

1. **`currency` on Initialize.** The Accept Payments page documents no currency field for this
   endpoint. The adapter sends `currency: "NGN"`; if Paystack rejects it, remove it (the account
   default is NGN).
2. **List-banks query parameter.** One source says `currency`, another says `country`. The adapter
   uses `?currency=NGN`. Bank codes in mock mode are **placeholders**; real codes must come from
   the list-banks endpoint.
3. **Webhook payload shape** for `charge.success` and `transfer.*`. The webhook page fetched did not
   show them. The normaliser assumes `data.reference`, `data.amount`, `data.currency`, `data.status`.
4. **Raw body vs `JSON.stringify(req.body)`.** Paystack's example hashes the re-serialised body.
   SplitPot hashes the **raw bytes** (the spec's requirement and the safer choice). Confirm
   against a real delivery.
5. **Retry after a definitive transfer failure.** Docs say retry with the same reference after an
   *error*. For a transfer that *failed at the bank*, SplitPot starts a new attempt with a new
   reference (so a failed attempt can never be double-counted). Whether Paystack would accept the
   old reference is unconfirmed.
6. **Webhook source IPs.** The page says an allowlist exists; the addresses were not retrieved.
7. **Charge failure webhooks.** The verify page says webhooks are sent only for successful
   transactions, so SplitPot learns about failed/abandoned charges only by polling verify.
8. **Test-mode transfer behaviour** beyond "always success": whether recipients for arbitrary
   account numbers can be created in test mode.

## Consequence worth knowing

Because Paystack test transfers always succeed, **the failed-payout path cannot be exercised in
Paystack test mode.** It is only demonstrable through the mock provider's designated failing
account (`0000000404`, fails on the first attempt only).
