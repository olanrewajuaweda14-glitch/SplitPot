// Typed errors. Every illegal transition or rejected command throws one of these,
// each carrying a stable machine-readable `code` and a human-readable message.
// This file is browser-safe (no Node imports).

export class SplitPotError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/** Bad input: wrong shape, out-of-range, shares not summing to 100%, etc. */
export class ValidationError extends SplitPotError {
  constructor(code, message, details) {
    super(code, message, { status: 400, details });
  }
}

/** Unknown/invalid capability token (401) or a token used for the wrong role (403). */
export class AuthError extends SplitPotError {
  constructor(code, message, status = 403) {
    super(code, message, { status });
  }
}

export class NotFoundError extends SplitPotError {
  constructor(code, message) {
    super(code, message, { status: 404 });
  }
}

/** A command that is not legal in the current state (the "illegal transition" family). */
export class StateError extends SplitPotError {
  constructor(code, message, details) {
    super(code, message, { status: 409, details });
  }
}

/** Webhook signature missing or wrong. */
export class SignatureError extends SplitPotError {
  constructor(message = 'Webhook signature is missing or does not match the request body.') {
    super('WEBHOOK_SIGNATURE_INVALID', message, { status: 401 });
  }
}

/** Replace any 10-digit run (a NUBAN account number) with a masked form. Applied to anything a provider says. */
export const redactAccounts = (text) => String(text ?? '').replace(/(?<!\d)\d{10}(?!\d)/g, (d) => `••••••${d.slice(-4)}`);

/** Provider (Paystack or mock) failed or returned something we refuse to trust. */
export class ProviderError extends SplitPotError {
  constructor(code, message, details) {
    super(code, redactAccounts(message), { status: 502, details });
  }
}

export class RateLimitError extends SplitPotError {
  constructor(message = 'Too many requests. Slow down and try again shortly.') {
    super('RATE_LIMITED', message, { status: 429 });
  }
}

/** A bug or violated invariant. Never caused by user input. */
export class InternalError extends SplitPotError {
  constructor(message, details) {
    super('INTERNAL_INVARIANT', message, { status: 500, details });
  }
}

export const isSplitPotError = (e) => e instanceof SplitPotError;
