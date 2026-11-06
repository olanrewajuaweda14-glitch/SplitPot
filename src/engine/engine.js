// SplitPot engine: every command, every state transition, every money movement.
//
// Rules this file is built around:
//  - Each command authorises the capability token against an allowed role list first.
//  - State changes happen inside synchronous store transactions only. Provider calls
//    (network) happen OUTSIDE any transaction: intent -> provider call -> result.
//  - Money is integer kobo; allocation is largest-remainder on BigInt (shared/money.js).
//  - Illegal transitions throw typed errors (shared/errors.js) with understandable messages.
//  - Everything that matters is appended to the project's hash-chained ledger.
//  - Ledger data is PUBLIC: it never contains tokens, full account numbers, account holder
//    names, or free-text messages (only hashes of them).

import {
  AuthError, NotFoundError, StateError, ValidationError, InternalError, ProviderError, SplitPotError, redactAccounts,
} from '../shared/errors.js';
import {
  allocateByShares, calcFee, splitRelease, toBigKobo, validateShares, formatNaira, isValidAccountNumber, last4,
  DEFAULT_FEE_BPS, CURRENCY, MAX_KOBO,
} from '../shared/money.js';
import { appendEntry, verifyChain, chainStatusText } from '../domain/ledger.js';
import { mockInitialState } from '../providers/mock.js';
import {
  own, randomId, newToken, tokenKey, sha256, cleanText, cleanUrl, cleanEmail, HOUR, REVIEW_WINDOW_MS, NEGOTIATION_MS, isFrozen,
} from './helpers.js';
import { buildView, buildPublicLedger, buildReceipt } from './views.js';

export const initialState = ({ mock = true } = {}) => ({
  version: 0,
  clock: { offsetMs: 0 },
  projects: {},
  tokenIndex: {},
  publicIndex: {},
  refIndex: {},
  webhookEvents: {},
  demo: null,
  ...(mock ? { mock: mockInitialState() } : {}),
});

const MAX_PROJECTS = 1000;
const MAX_EVENTS_KEPT = 500;
const MAX_ATTEMPTS = 20;
const ROLE_LABEL = { lead: 'team lead', collaborator: 'collaborator', client: 'client', reviewer: 'reviewer' };

export class Engine {
  #store;
  #provider;
  #baseNow;
  #banks = { at: 0, list: [] };
  #inflight = new Set();

  constructor({ store, provider, config = {}, baseNow = () => Date.now() }) {
    this.#store = store;
    this.#provider = provider;
    this.#baseNow = baseNow;
    this.config = { demoMode: false, feeBps: DEFAULT_FEE_BPS, publicBaseUrl: '', ...config };
  }

  get store() { return this.#store; }
  get provider() { return this.#provider; }

  /** Run payouts in the background but keep track of them, so tests and shutdown can await completion. */
  #payoutsInBackground(projectId) {
    const p = this.runPayouts(projectId).catch((e) => console.error('[payouts]', e?.code ?? e?.message));
    this.#inflight.add(p);
    p.finally(() => this.#inflight.delete(p));
  }

  /** Resolves when every background payout run has finished. */
  async idle() {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
  }

  now() { return this.#baseNow() + this.#store.read((s) => s.clock.offsetMs); }
  #nowIn(draft) { return this.#baseNow() + draft.clock.offsetMs; }

  // ------------------------------------------------------------------ auth

  /** Resolve a capability token to { project, role, collaboratorId } or throw. Works on live or draft state. */
  authorize(state, token, roles) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
      throw new AuthError('TOKEN_INVALID', 'This link is not valid. Check that you copied the whole link.', 401);
    }
    const rec = own(state.tokenIndex, tokenKey(token));
    if (!rec) throw new AuthError('TOKEN_INVALID', 'This link is not valid. Check that you copied the whole link.', 401);
    if (!roles.includes(rec.role)) {
      throw new AuthError('ROLE_FORBIDDEN', `This link is for the ${ROLE_LABEL[rec.role]} and cannot do that. Ask the right person to do it from their own link.`, 403);
    }
    const project = own(state.projects, rec.projectId);
    if (!project) throw new NotFoundError('PROJECT_NOT_FOUND', 'This project no longer exists.');
    return { project, role: rec.role, collaboratorId: rec.collaboratorId ?? null };
  }

  #who(p, role, collaboratorId) {
    if (role === 'collaborator') return p.collaborators.find((c) => c.id === collaboratorId)?.name ?? 'Collaborator';
    if (role === 'lead') return p.collaborators.find((c) => c.isLead)?.name ?? 'Team lead';
    return role === 'client' ? p.clientName : 'Reviewer (simulated)';
  }

  #log(p, type, data, now) {
    const e = appendEntry(p.ledger, { ts: now, type, projectId: p.id, data });
    p.ledgerAnchor = { seq: e.seq, hash: e.hash };
    return e;
  }

  // ------------------------------------------------------------------ banks

  async listBanks() {
    if (this.#banks.list.length && Date.now() - this.#banks.at < 3_600_000) return this.#banks.list;
    const list = await this.#provider.listBanks();
    this.#banks = { at: Date.now(), list };
    return list;
  }

  // ------------------------------------------------------------------ create project

  #validateProjectInput(input) {
    if (!input || typeof input !== 'object') throw new ValidationError('INPUT_INVALID', 'Send the project details as a JSON object.');
    const title = cleanText(input.title, { label: 'Project title', max: 120 });
    const clientName = cleanText(input.clientName, { label: 'Client name', max: 80 });
    const clientEmail = cleanEmail(input.clientEmail);
    if (!Array.isArray(input.collaborators) || input.collaborators.length < 1 || input.collaborators.length > 20) {
      throw new ValidationError('COLLABORATORS_INVALID', 'Add between 1 and 20 collaborators (you count as the first).');
    }
    const collaborators = input.collaborators.map((c, i) => ({
      name: cleanText(c?.name, { label: `Collaborator ${i + 1} name`, max: 60 }),
      role: cleanText(c?.role, { label: `Collaborator ${i + 1} role`, max: 60 }),
      bps: c?.bps,
      bank: i === 0 && c?.bankCode ? { bankCode: String(c.bankCode), accountNumber: String(c.accountNumber ?? '') } : null,
    }));
    validateShares(collaborators.map((c, i) => ({ id: `c${i + 1}`, bps: c.bps })));
    if (!Array.isArray(input.milestones) || input.milestones.length < 1 || input.milestones.length > 12) {
      throw new ValidationError('MILESTONES_INVALID', 'Add between 1 and 12 milestones.');
    }
    let sum = 0n;
    const milestones = input.milestones.map((m, i) => {
      const amount = toBigKobo(m?.amountKobo, `Milestone ${i + 1} amount`);
      if (amount < 10_000n) throw new ValidationError('AMOUNT_TOO_SMALL', `Milestone ${i + 1} must be at least ₦100.`);
      sum += amount;
      if (!Array.isArray(m?.criteria) || m.criteria.length < 1 || m.criteria.length > 10) {
        throw new ValidationError('CRITERIA_REQUIRED', `Milestone ${i + 1} needs between 1 and 10 written acceptance criteria.`);
      }
      return {
        title: cleanText(m?.title, { label: `Milestone ${i + 1} title`, max: 100 }),
        amountKobo: Number(amount),
        criteria: m.criteria.map((x, j) => cleanText(x, { label: `Milestone ${i + 1} criterion ${j + 1}`, min: 3, max: 200 })),
      };
    });
    const totalKobo = Number(toBigKobo(sum, 'Project total'));
    return { title, clientName, clientEmail, collaborators, milestones, totalKobo };
  }

  async createProject(input, { origin = 'user', tokens = null, ownerUserId = null } = {}) {
    const spec = this.#validateProjectInput(input);
    let leadBank = null;
    const b = spec.collaborators[0].bank;
    if (b) {
      const banks = await this.listBanks();
      const bank = banks.find((x) => x.code === b.bankCode);
      if (!bank) throw new ValidationError('BANK_UNKNOWN', 'Choose your bank from the list.');
      if (!isValidAccountNumber(b.accountNumber)) throw new ValidationError('ACCOUNT_NUMBER_INVALID', 'Account number must be exactly 10 digits.');
      const r = await this.#provider.resolveAccount({ accountNumber: b.accountNumber, bankCode: b.bankCode });
      leadBank = { bankCode: b.bankCode, bankName: bank.name, accountNumber: b.accountNumber, accountName: r.accountName };
    }
    return this.#store.transact((draft) => this.#createInDraft(draft, spec, leadBank, { origin, tokens, ownerUserId }));
  }

  #createInDraft(draft, spec, leadBank, { origin, tokens, ownerUserId = null }) {
    if (Object.keys(draft.projects).length >= MAX_PROJECTS) {
      throw new ValidationError('CAPACITY_REACHED', 'This prototype has reached its project limit. Try again later.');
    }
    const now = this.#nowIn(draft);
    let id;
    do id = randomId('p', 10); while (own(draft.projects, id));
    const feeBps = this.config.feeBps;
    const feeKobo = calcFee(spec.totalKobo, feeBps);
    const collaborators = spec.collaborators.map((c, i) => ({
      id: `c${i + 1}`, name: c.name, role: c.role, isLead: i === 0, bps: c.bps,
      confirmed: false, confirmedAt: null, viewedAt: null, declinedAt: null, declineReason: null, bank: i === 0 ? leadBank : null, recipientCode: null,
    }));
    const shares = collaborators.map((c) => ({ id: c.id, bps: c.bps }));
    const milestones = spec.milestones.map((m, i) => ({
      id: `m${i + 1}`, idx: i + 1, title: m.title, amountKobo: m.amountKobo, criteria: m.criteria,
      plannedAllocation: allocateByShares(m.amountKobo, shares).map((a) => ({ collaboratorId: a.id, amountKobo: a.amountKobo })),
      status: 'pending', delivery: null, deliveryHistory: [], dispute: null, disputeHistory: [],
      resolution: null, refundKobo: 0, payoutAllocation: null, closedAt: null,
    }));
    const access = {
      lead: tokens?.lead ?? newToken(), client: tokens?.client ?? newToken(), reviewer: tokens?.reviewer ?? newToken(),
      collaborators: Object.fromEntries(collaborators.map((c, i) => [c.id, tokens?.collaborators?.[i] ?? newToken()])),
    };
    const publicId = tokens?.publicId ?? randomId('l', 12);
    const p = {
      id, origin, title: spec.title, clientName: spec.clientName, clientEmail: spec.clientEmail, currency: CURRENCY,
      createdAt: now, status: 'awaiting_confirmations',
      feeBps, totalKobo: spec.totalKobo, feeKobo, clientPaysKobo: spec.totalKobo + feeKobo,
      collaborators, milestones,
      funding: { status: 'unfunded', attempts: [], reference: null, amountKobo: null, fundedAt: null },
      payouts: {}, refunds: [], access, publicId, ownerUserId, ledger: [], ledgerAnchor: null, demoTamper: null,
    };
    draft.projects[id] = p;
    draft.publicIndex[publicId] = id;
    draft.tokenIndex[tokenKey(access.lead)] = { projectId: id, role: 'lead' };
    draft.tokenIndex[tokenKey(access.client)] = { projectId: id, role: 'client' };
    draft.tokenIndex[tokenKey(access.reviewer)] = { projectId: id, role: 'reviewer' };
    for (const c of collaborators) draft.tokenIndex[tokenKey(access.collaborators[c.id])] = { projectId: id, role: 'collaborator', collaboratorId: c.id };
    this.#log(p, 'project.created', {
      title: p.title, origin, clientName: p.clientName, totalKobo: p.totalKobo, feeBps, feeKobo, clientPaysKobo: p.clientPaysKobo,
      collaborators: collaborators.map((c) => ({ id: c.id, name: c.name, role: c.role, bps: c.bps })),
      milestones: milestones.map((m) => ({ id: m.id, title: m.title, amountKobo: m.amountKobo, criteriaCount: m.criteria.length, criteriaHash: sha256(JSON.stringify(m.criteria)) })),
    }, now);
    return { projectId: id, links: this.#links(p) };
  }

  #links(p) {
    return {
      lead: `/p/lead/${p.access.lead}`,
      client: `/p/client/${p.access.client}`,
      reviewer: `/p/reviewer/${p.access.reviewer}`,
      collaborators: p.collaborators.map((c) => ({ id: c.id, name: c.name, path: `/p/collab/${p.access.collaborators[c.id]}` })),
      ledger: `/ledger/${p.publicId}`,
    };
  }

  // ------------------------------------------------------------------ reads

  /** Role-specific view. Applies due deadlines first (idempotent), then builds a redacted snapshot. */
  async view(token) {
    const pre = this.#store.read((s) => this.authorize(s, token, ['lead', 'collaborator', 'client', 'reviewer']));
    await this.processDeadlines(pre.project.id);
    if (pre.role === 'collaborator' && !pre.project.collaborators.find((c) => c.id === pre.collaboratorId)?.viewedAt) {
      await this.#store.transact((draft) => {
        const a = this.authorize(draft, token, ['collaborator']);
        const c = a.project.collaborators.find((x) => x.id === a.collaboratorId);
        if (c && !c.viewedAt) c.viewedAt = this.#nowIn(draft);
      });
    }
    const state = this.#store.snapshot();
    const auth = this.authorize(state, token, ['lead', 'collaborator', 'client', 'reviewer']);
    return buildView(state, auth, { demoMode: this.config.demoMode, provider: { name: this.#provider.name, isMock: !!this.#provider.isMock }, now: this.#baseNow() + state.clock.offsetMs });
  }

  /** Cheap ETag material so pollers can get a 304 without building a view. */
  viewTag(token) {
    return this.#store.read((s) => {
      const a = this.authorize(s, token, ['lead', 'collaborator', 'client', 'reviewer']);
      return `${s.version}:${a.role}:${a.collaboratorId ?? ''}`;
    });
  }

  async publicLedger(publicId) {
    const pid = this.#store.read((s) => own(s.publicIndex, publicId));
    if (!pid) throw new NotFoundError('LEDGER_NOT_FOUND', 'No public ledger exists at this address.');
    await this.processDeadlines(pid);
    const state = this.#store.snapshot();
    return buildPublicLedger(state, own(state.projects, pid), { provider: { name: this.#provider.name, isMock: !!this.#provider.isMock } });
  }

  async receipt(token, payoutId) {
    const state = this.#store.snapshot();
    const auth = this.authorize(state, token, ['lead', 'collaborator', 'client']);
    const po = own(auth.project.payouts, payoutId);
    if (!po) throw new NotFoundError('PAYOUT_NOT_FOUND', 'No such payout.');
    if (auth.role === 'collaborator' && po.collaboratorId !== auth.collaboratorId) {
      throw new AuthError('RECEIPT_FORBIDDEN', 'You can only open your own receipts.', 403);
    }
    if (po.status !== 'success') throw new StateError('RECEIPT_NOT_READY', 'A receipt is only issued once the payout has succeeded.');
    return buildReceipt(auth.project, po, { provider: { name: this.#provider.name, isMock: !!this.#provider.isMock } });
  }

  verifyLedger(projectId) {
    const p = this.#store.read((s) => own(s.projects, projectId));
    if (!p) throw new NotFoundError('PROJECT_NOT_FOUND', 'No such project.');
    const v = verifyChain(p.ledger, p.ledgerAnchor);
    return { ...v, text: chainStatusText(v) };
  }

  // ------------------------------------------------------------------ collaborators

  async resolveAccount(token, { bankCode, accountNumber } = {}) {
    this.#store.read((s) => this.authorize(s, token, ['collaborator']));
    const banks = await this.listBanks();
    const bank = banks.find((b) => b.code === bankCode);
    if (!bank) throw new ValidationError('BANK_REQUIRED', 'Choose your bank first.');
    if (!isValidAccountNumber(accountNumber)) throw new ValidationError('ACCOUNT_NUMBER_INVALID', 'Account number must be exactly 10 digits.');
    const r = await this.#provider.resolveAccount({ accountNumber, bankCode });
    return { accountName: r.accountName, bankName: bank.name, masked: `••••••${last4(accountNumber)}` };
  }

  async confirmShare(token, input = {}) {
    const pre = this.#store.read((s) => this.authorize(s, token, ['collaborator']));
    if (input.accept !== true) throw new ValidationError('ACCEPT_REQUIRED', 'Tick the box to accept your share before confirming.');
    const me = pre.project.collaborators.find((c) => c.id === pre.collaboratorId);
    const bankCode = String(input.bankCode ?? me.bank?.bankCode ?? '');
    const accountNumber = String(input.accountNumber ?? me.bank?.accountNumber ?? '');
    const banks = await this.listBanks();
    const bank = banks.find((b) => b.code === bankCode);
    if (!bank) throw new ValidationError('BANK_REQUIRED', 'Choose your bank.');
    if (!isValidAccountNumber(accountNumber)) throw new ValidationError('ACCOUNT_NUMBER_INVALID', 'Account number must be exactly 10 digits.');
    // The account name is ALWAYS re-resolved here. A name sent by the browser is never trusted.
    const resolved = await this.#provider.resolveAccount({ accountNumber, bankCode });
    return this.#store.transact((draft) => {
      const { project: p, collaboratorId } = this.authorize(draft, token, ['collaborator']);
      const c = p.collaborators.find((x) => x.id === collaboratorId);
      const now = this.#nowIn(draft);
      if (c.confirmed) throw new StateError('ALREADY_CONFIRMED', 'You have already confirmed this share. Payout details are locked once confirmed.');
      if (p.status !== 'awaiting_confirmations') throw new StateError('CONFIRMATION_CLOSED', 'This project is no longer collecting confirmations.');
      c.bank = { bankCode, bankName: bank.name, accountNumber, accountName: resolved.accountName };
      c.confirmed = true;
      c.confirmedAt = now;
      c.declinedAt = null;
      c.declineReason = null;
      this.#log(p, 'collaborator.confirmed', {
        collaboratorId: c.id, name: c.name, role: c.role, bps: c.bps,
        shareKobo: p.milestones.reduce((a, m) => a + m.plannedAllocation.find((x) => x.collaboratorId === c.id).amountKobo, 0),
        bankName: bank.name, accountLast4: last4(accountNumber),
      }, now);
      if (p.collaborators.every((x) => x.confirmed)) {
        p.status = 'awaiting_funding';
        this.#log(p, 'project.ready_to_fund', { confirmed: p.collaborators.length, clientPaysKobo: p.clientPaysKobo }, now);
      }
      return { confirmed: true, projectStatus: p.status };
    });
  }

  /** A collaborator says no (or not yet). Funding stays locked; they can still accept later. */
  async declineShare(token, input = {}) {
    return this.#store.transact((draft) => {
      const { project: p, collaboratorId } = this.authorize(draft, token, ['collaborator']);
      const c = p.collaborators.find((x) => x.id === collaboratorId);
      const now = this.#nowIn(draft);
      if (c.confirmed) throw new StateError('ALREADY_CONFIRMED', 'You already confirmed this share. Ask the team lead to reopen it if something changed.');
      if (p.funding.status === 'funded' || p.status !== 'awaiting_confirmations') throw new StateError('CONFIRMATION_CLOSED', 'This project is no longer collecting confirmations.');
      const reason = cleanText(input.reason, { label: 'Reason', min: 5, max: 300, multiline: true });
      c.declinedAt = now;
      c.declineReason = reason;
      this.#log(p, 'collaborator.declined', { collaboratorId: c.id, name: c.name, role: c.role, bps: c.bps, reasonHash: sha256(reason) }, now);
      return { declined: true };
    });
  }

  /** Lead changes the split before funding. Anyone whose share changed must confirm again. */
  async reviseSplit(token, input = {}) {
    return this.#store.transact((draft) => {
      const { project: p } = this.authorize(draft, token, ['lead']);
      const now = this.#nowIn(draft);
      if (p.funding.status === 'funded' || !['awaiting_confirmations', 'awaiting_funding'].includes(p.status)) throw new StateError('SPLIT_LOCKED', 'The pot is funded, so the split can no longer be changed.');
      const rows = Array.isArray(input.collaborators) ? input.collaborators : [];
      if (rows.length !== p.collaborators.length) throw new ValidationError('SPLIT_INCOMPLETE', 'Send a share for every person.');
      const next = new Map();
      for (const r of rows) {
        const id = typeof r?.id === 'string' ? r.id : '';
        if (!p.collaborators.some((c) => c.id === id) || next.has(id)) throw new ValidationError('SPLIT_PERSON_INVALID', 'The split names someone who is not on this project, or names someone twice.');
        next.set(id, r.bps);
      }
      validateShares(p.collaborators.map((c) => ({ id: c.id, bps: next.get(c.id) })));
      const changed = p.collaborators.filter((c) => next.get(c.id) !== c.bps);
      if (changed.length === 0) throw new ValidationError('SPLIT_UNCHANGED', 'No share changed.');
      const shares = p.collaborators.map((c) => ({ id: c.id, bps: next.get(c.id) }));
      const changes = changed.map((c) => ({ id: c.id, name: c.name, fromBps: c.bps, toBps: next.get(c.id) }));
      for (const c of p.collaborators) c.bps = next.get(c.id);
      for (const m of p.milestones) m.plannedAllocation = allocateByShares(m.amountKobo, shares).map((a) => ({ collaboratorId: a.id, amountKobo: a.amountKobo }));
      for (const c of changed) { c.confirmed = false; c.confirmedAt = null; c.declinedAt = null; c.declineReason = null; }
      for (const a of p.funding.attempts) if (a.status === 'initiated') a.status = 'cancelled';
      p.status = 'awaiting_confirmations';
      this.#log(p, 'split.revised', { changes, reconfirmationRequired: changed.map((c) => c.id), note: 'Anyone whose share changed must confirm again before the client can pay.' }, now);
      return { changed: changed.length, status: p.status };
    });
  }

  // ------------------------------------------------------------------ funding

  async startFunding(token) {
    // 1) intent (locked)
    const intent = await this.#store.transact((draft) => {
      const { project: p } = this.authorize(draft, token, ['client']);
      const now = this.#nowIn(draft);
      if (p.status === 'awaiting_confirmations') {
        const n = p.collaborators.filter((c) => c.confirmed).length;
        throw new StateError('FUNDING_BEFORE_CONFIRMATIONS', `Payment is locked until every collaborator confirms their share. ${n} of ${p.collaborators.length} have confirmed.`, { confirmed: n, total: p.collaborators.length });
      }
      if (p.status !== 'awaiting_funding') throw new StateError('ALREADY_FUNDED', 'This project has already been funded.');
      const live = [...p.funding.attempts].reverse().find((a) => a.status === 'initiated' && a.authorizationUrl && now - a.createdAt < 30 * 60_000);
      if (live) return { reuse: { reference: live.reference, authorizationUrl: live.authorizationUrl } };
      if (p.funding.attempts.length >= MAX_ATTEMPTS) throw new StateError('TOO_MANY_ATTEMPTS', 'Too many payment attempts for this project.');
      const reference = `sp-chg-${p.id}-${p.funding.attempts.length + 1}`;
      p.funding.attempts.push({ reference, createdAt: now, expectedKobo: p.clientPaysKobo, currency: p.currency, status: 'initiated', authorizationUrl: null });
      draft.refIndex[reference] = { projectId: p.id, kind: 'charge' };
      this.#log(p, 'funding.initiated', { reference, expectedKobo: p.clientPaysKobo, currency: p.currency }, now);
      return { reference, expectedKobo: p.clientPaysKobo, currency: p.currency, email: p.clientEmail || `client+${p.id}@splitpot.invalid`, projectId: p.id };
    });
    if (intent.reuse) return intent.reuse;
    // 2) provider call (NOT locked)
    let init;
    try {
      init = await this.#provider.initializeCharge({
        reference: intent.reference, amountKobo: intent.expectedKobo, currency: intent.currency, email: intent.email,
        callbackUrl: `${this.config.publicBaseUrl}/paid`, metadata: { projectId: intent.projectId },
      });
    } catch (err) {
      await this.#store.transact((draft) => {
        const p = own(draft.projects, intent.projectId);
        const a = p?.funding.attempts.find((x) => x.reference === intent.reference);
        if (a) a.status = 'failed_to_start';
      });
      throw err;
    }
    // 3) result (locked)
    await this.#store.transact((draft) => {
      const a = own(draft.projects, intent.projectId)?.funding.attempts.find((x) => x.reference === intent.reference);
      if (a && a.status === 'initiated') a.authorizationUrl = init.authorizationUrl;
    });
    return { reference: intent.reference, authorizationUrl: init.authorizationUrl };
  }

  /**
   * Provider webhook entry point. Signature is verified over the RAW bytes first; an invalid
   * signature throws SignatureError and records nothing. A valid event is recorded durably,
   * acknowledged, and processed afterwards: `done` resolves when processing finishes.
   */
  async handleWebhook(rawBody, headers) {
    const evt = this.#provider.parseAndVerifyWebhook(rawBody, headers);
    const fresh = await this.#store.transact((draft) => {
      if (own(draft.webhookEvents, evt.id)) return false;
      draft.webhookEvents[evt.id] = { id: evt.id, type: evt.type, reference: evt.reference, receivedAt: this.#nowIn(draft), status: 'received', tries: 0, event: evt };
      const ids = Object.keys(draft.webhookEvents);
      if (ids.length > MAX_EVENTS_KEPT) for (const k of ids.slice(0, ids.length - MAX_EVENTS_KEPT)) delete draft.webhookEvents[k];
      return true;
    });
    if (!fresh) return { ack: { received: true, duplicate: true }, done: Promise.resolve() };
    const done = this.#processEvent(evt).catch((err) => {
      console.error('[webhook] processing failed, will be retried by the tick:', err?.code ?? err?.message);
    });
    return { ack: { received: true, duplicate: false }, done };
  }

  async #markEvent(id, status, note) {
    await this.#store.transact((draft) => {
      const e = own(draft.webhookEvents, id);
      if (e) { e.status = status; e.note = note ?? null; e.tries = (e.tries ?? 0) + 1; }
    });
  }

  async #processEvent(evt) {
    try {
      let outcome;
      if (evt.type === 'charge.success') outcome = await this.#onChargeSuccess(evt);
      else if (evt.type === 'charge.failed') outcome = await this.#onChargeFailed(evt);
      else if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(evt.type)) outcome = await this.#onTransferEvent(evt);
      else outcome = { status: 'ignored', note: `Event type ${evt.type || '(none)'} is not handled.` };
      await this.#markEvent(evt.id, outcome.status, outcome.note);
    } catch (err) {
      await this.#markEvent(evt.id, 'received', `error: ${err?.code ?? err?.message}`).catch(() => {});
      throw err;
    }
  }

  async #onChargeSuccess(evt) {
    const loc = this.#store.read((s) => own(s.refIndex, evt.reference));
    if (!loc || loc.kind !== 'charge') return { status: 'ignored', note: 'Unknown payment reference.' };
    // The webhook only says "something happened". We ask the provider ourselves and judge
    // the answer against OUR OWN record of what this project should pay.
    const v = await this.#provider.verifyCharge(evt.reference);
    return this.#store.transact((draft) => {
      const p = own(draft.projects, loc.projectId);
      const a = p?.funding.attempts.find((x) => x.reference === evt.reference);
      if (!p || !a) return { status: 'ignored', note: 'Reference does not match a funding attempt.' };
      const now = this.#nowIn(draft);
      if (p.funding.status === 'funded') {
        if (p.funding.reference === evt.reference) return { status: 'processed', note: 'Already funded by this payment.' };
        if (a.status !== 'duplicate') {
          a.status = 'duplicate';
          this.#log(p, 'funding.duplicate_detected', { reference: evt.reference, paidKobo: v.amountKobo, note: 'A second payment arrived after the project was funded. Refund is a manual SIMULATED step.' }, now);
        }
        return { status: 'processed', note: 'Duplicate payment recorded.' };
      }
      if (a.status === 'verified') return { status: 'processed', note: 'Already verified.' };
      if (v.status !== 'success') return { status: 'processed', note: `Provider reports status "${v.status}"; not funded.` };
      if (v.currency !== a.currency || v.amountKobo !== a.expectedKobo) {
        a.status = 'rejected';
        const reason = v.currency !== a.currency ? 'currency_mismatch' : 'amount_mismatch';
        this.#log(p, 'funding.rejected', { reference: evt.reference, reason, expectedKobo: a.expectedKobo, expectedCurrency: a.currency, receivedKobo: v.amountKobo, receivedCurrency: v.currency }, now);
        return { status: 'rejected', note: reason };
      }
      if (a.status === 'cancelled') {
        a.status = 'rejected';
        this.#log(p, 'funding.rejected', { reference: evt.reference, reason: 'split_revised', expectedKobo: a.expectedKobo, expectedCurrency: a.currency, receivedKobo: v.amountKobo, receivedCurrency: v.currency, note: 'This payment arrived after the split changed. It was not counted. Returning it is a manual SIMULATED step.' }, now);
        return { status: 'rejected', note: 'split_revised' };
      }
      if (p.status !== 'awaiting_funding') return { status: 'ignored', note: `Project is ${p.status}; cannot fund.` };
      a.status = 'verified';
      p.funding = { ...p.funding, status: 'funded', reference: evt.reference, amountKobo: v.amountKobo, fundedAt: now };
      p.status = 'active';
      this.#log(p, 'funding.verified', { reference: evt.reference, paidKobo: v.amountKobo, currency: v.currency, potKobo: p.totalKobo, feeKobo: p.feeKobo, verification: 'signature+server-side-verify+amount+currency' }, now);
      return { status: 'processed', note: 'Funded.' };
    });
  }

  async #onChargeFailed(evt) {
    const loc = this.#store.read((s) => own(s.refIndex, evt.reference));
    if (!loc || loc.kind !== 'charge') return { status: 'ignored', note: 'Unknown payment reference.' };
    return this.#store.transact((draft) => {
      const p = own(draft.projects, loc.projectId);
      const a = p?.funding.attempts.find((x) => x.reference === evt.reference);
      if (!a || a.status !== 'initiated') return { status: 'ignored', note: 'Nothing to mark failed.' };
      a.status = 'failed';
      this.#log(p, 'funding.failed', { reference: evt.reference }, this.#nowIn(draft));
      return { status: 'processed', note: 'Attempt marked failed.' };
    });
  }

  // ------------------------------------------------------------------ delivery, approval, release

  #milestone(p, mid) {
    const m = p.milestones.find((x) => x.id === mid);
    if (!m) throw new NotFoundError('MILESTONE_NOT_FOUND', 'No such milestone.');
    return m;
  }

  async submitDelivery(token, mid, input = {}) {
    return this.#store.transact((draft) => {
      const { project: p } = this.authorize(draft, token, ['lead']);
      const m = this.#milestone(p, mid);
      const now = this.#nowIn(draft);
      if (p.funding.status !== 'funded') throw new StateError('DELIVERY_BEFORE_FUNDING', 'The client has not funded this project yet. Deliver once the pot shows as funded.');
      if (m.status === 'closed') throw new StateError('MILESTONE_CLOSED', 'This milestone is already closed.');
      if (m.status === 'delivered') throw new StateError('ALREADY_DELIVERED', 'This milestone has already been delivered and is waiting for the client.');
      const link = cleanUrl(input.link, 'Delivery link');
      const note = cleanText(input.note, { label: 'Delivery note', min: 10, max: 1000, multiline: true });
      m.delivery = { link, note, submittedAt: now, reviewDeadline: now + REVIEW_WINDOW_MS, number: m.deliveryHistory.length + 1 };
      m.status = 'delivered';
      this.#log(p, 'milestone.delivered', { milestoneId: m.id, title: m.title, delivery: m.delivery.number, linkHash: sha256(link), noteHash: sha256(note), reviewDeadline: m.delivery.reviewDeadline }, now);
      return { milestoneStatus: m.status, reviewDeadline: m.delivery.reviewDeadline };
    });
  }

  async approveMilestone(token, mid) {
    const out = await this.#store.transact((draft) => {
      const { project: p } = this.authorize(draft, token, ['client']);
      const m = this.#milestone(p, mid);
      const now = this.#nowIn(draft);
      if (p.funding.status !== 'funded') throw new StateError('RELEASE_BEFORE_FUNDING', 'Nothing can be released before the project is funded.');
      if (m.status === 'closed') throw new StateError('DOUBLE_RELEASE', 'This milestone has already been settled. It cannot be released twice.');
      if (isFrozen(m)) throw new StateError('MILESTONE_FROZEN', 'This milestone is frozen by an open dispute. Resolve the dispute first.');
      if (m.status !== 'delivered') throw new StateError('APPROVAL_WITHOUT_DELIVERY', 'The team lead has not submitted this milestone yet, so there is nothing to approve.');
      this.#log(p, 'milestone.approved', { milestoneId: m.id, by: 'client' }, now);
      this.#release(p, m, { releaseKobo: m.amountKobo, refundKobo: 0, resolution: 'released', trigger: 'client_approval' }, now);
      return { projectId: p.id };
    });
    this.#payoutsInBackground(out.projectId);
    return { milestoneStatus: 'closed' };
  }

  /** The only place money is ever allocated to payouts. Everything funnels through here. */
  #release(p, m, { releaseKobo, refundKobo, resolution, trigger }, now) {
    if (p.funding.status !== 'funded') throw new StateError('RELEASE_BEFORE_FUNDING', 'Nothing can be released before the project is funded.');
    if (m.status === 'closed') throw new StateError('DOUBLE_RELEASE', 'This milestone has already been settled. It cannot be released twice.');
    if (isFrozen(m)) throw new StateError('PAYING_FROZEN_MILESTONE', 'This milestone is frozen by an open dispute and cannot be paid.');
    if (releaseKobo + refundKobo !== m.amountKobo) throw new InternalError('Release and refund must add up to the milestone amount.', { releaseKobo, refundKobo, amount: m.amountKobo });
    const alloc = releaseKobo > 0 ? allocateByShares(releaseKobo, p.collaborators.map((c) => ({ id: c.id, bps: c.bps }))) : [];
    m.payoutAllocation = alloc.map((a) => ({ collaboratorId: a.id, amountKobo: a.amountKobo }));
    m.refundKobo = refundKobo;
    m.resolution = resolution;
    m.status = 'closed';
    m.closedAt = now;
    for (const a of alloc) {
      if (a.amountKobo <= 0) continue;
      const pid = `po_${m.id}_${a.id}`;
      if (own(p.payouts, pid)) throw new StateError('DOUBLE_RELEASE', 'A payout for this milestone and person already exists.');
      p.payouts[pid] = {
        id: pid, milestoneId: m.id, collaboratorId: a.id, amountKobo: a.amountKobo, status: 'queued', attempt: 0,
        reference: null, transferCode: null, failureReason: null, queuedAt: now, startedAt: null, completedAt: null,
        retryAfter: 0, ledgerSeq: null, ledgerHash: null, receiptNo: null,
      };
    }
    this.#log(p, 'milestone.released', {
      milestoneId: m.id, title: m.title, trigger, resolution, releaseKobo, refundKobo,
      allocation: m.payoutAllocation.map((a) => ({ collaboratorId: a.collaboratorId, name: p.collaborators.find((c) => c.id === a.collaboratorId).name, amountKobo: a.amountKobo })),
    }, now);
    if (refundKobo > 0) {
      p.refunds.push({ id: `rf_${m.id}`, milestoneId: m.id, amountKobo: refundKobo, status: 'simulated', at: now });
      this.#log(p, 'refund.simulated', { milestoneId: m.id, amountKobo: refundKobo, simulated: true, note: 'SIMULATED refund to the client. No money moved. The platform fee is not refunded.' }, now);
    }
    this.#maybeComplete(p, now);
  }

  #maybeComplete(p, now) {
    if (p.status !== 'active') return;
    if (!p.milestones.every((m) => m.status === 'closed')) return;
    if (Object.values(p.payouts).some((po) => po.status !== 'success')) return;
    p.status = 'completed';
    p.completedAt = now;
    this.#log(p, 'project.completed', { milestones: p.milestones.length, paidKobo: Object.values(p.payouts).reduce((a, po) => a + po.amountKobo, 0), refundedKobo: p.refunds.reduce((a, r) => a + r.amountKobo, 0) }, now);
  }

  // ------------------------------------------------------------------ deadlines (idempotent)

  /** Apply every due 72h auto-release and 5-day escalation. Safe to call any number of times. */
  async processDeadlines(projectId = null) {
    const due = this.#store.read((s) => {
      const now = this.#baseNow() + s.clock.offsetMs;
      const ids = projectId ? [projectId] : Object.keys(s.projects);
      return ids.filter((id) => {
        const p = own(s.projects, id);
        return p && p.status === 'active' && p.milestones.some((m) => this.#isDue(m, now));
      });
    });
    if (due.length === 0) return 0;
    const touched = await this.#store.transact((draft) => {
      const now = this.#nowIn(draft);
      const ids = [];
      for (const id of due) {
        const p = own(draft.projects, id);
        if (!p || p.status !== 'active') continue;
        for (const m of p.milestones) {
          const d = m.dispute;
          if (d && d.status === 'negotiating' && now >= d.negotiationDeadline) this.#escalate(p, m, now, 'deadline');
          if (m.status === 'delivered' && !isFrozen(m) && m.delivery && now >= m.delivery.reviewDeadline) {
            this.#log(p, 'milestone.auto_released', { milestoneId: m.id, reason: 'The client did not respond within the 72-hour review window.', reviewDeadline: m.delivery.reviewDeadline }, now);
            this.#release(p, m, { releaseKobo: m.amountKobo, refundKobo: 0, resolution: 'released', trigger: 'review_window_elapsed' }, now);
            if (!ids.includes(id)) ids.push(id);
          }
        }
      }
      return ids;
    });
    for (const id of touched) this.#payoutsInBackground(id);
    return touched.length;
  }

  #isDue(m, now) {
    if (m.dispute?.status === 'negotiating' && now >= m.dispute.negotiationDeadline) return true;
    return m.status === 'delivered' && !isFrozen(m) && !!m.delivery && now >= m.delivery.reviewDeadline;
  }

  // ------------------------------------------------------------------ disputes

  #dispute(m) {
    if (!m.dispute) throw new StateError('NO_DISPUTE', 'This milestone has no dispute.');
    return m.dispute;
  }

  async openDispute(token, mid, input = {}) {
    return this.#store.transact((draft) => {
      const { project: p } = this.authorize(draft, token, ['client']);
      const m = this.#milestone(p, mid);
      const now = this.#nowIn(draft);
      if (p.funding.status !== 'funded') throw new StateError('DISPUTE_BEFORE_FUNDING', 'There is nothing to dispute before the project is funded.');
      if (m.status === 'closed') throw new StateError('MILESTONE_CLOSED', 'This milestone is already settled and can no longer be disputed.');
      if (isFrozen(m)) throw new StateError('DISPUTE_ALREADY_OPEN', 'This milestone already has an open dispute.');
      if (m.status !== 'delivered') throw new StateError('DISPUTE_WITHOUT_DELIVERY', 'Nothing has been delivered for this milestone yet, so there is nothing to dispute.');
      if (now >= m.delivery.reviewDeadline) throw new StateError('DISPUTE_AFTER_WINDOW', 'The 72-hour review window has ended. This milestone can no longer be disputed.');
      const unmet = [...new Set(Array.isArray(input.unmetCriteria) ? input.unmetCriteria : [])];
      if (unmet.length === 0 || unmet.some((i) => !Number.isInteger(i) || i < 0 || i >= m.criteria.length)) {
        throw new ValidationError('CRITERIA_REQUIRED', 'Choose at least one written acceptance criterion that was not met.');
      }
      const reason = cleanText(input.reason, { label: 'Reason', min: 10, max: 1000, multiline: true });
      if (m.dispute) m.disputeHistory.push(m.dispute);
      m.dispute = {
        id: `d_${m.id}_${m.disputeHistory.length + 1}`, status: 'negotiating', openedAt: now,
        negotiationDeadline: now + NEGOTIATION_MS, unmetCriteria: unmet.sort((a, b) => a - b), reason,
        deliveryNumber: m.delivery.number, proposals: [], history: [{ at: now, actor: 'client', type: 'opened', text: reason }],
        reviewer: null, outcome: null,
      };
      this.#log(p, 'dispute.opened', { milestoneId: m.id, title: m.title, unmetCriteria: m.dispute.unmetCriteria, reasonHash: sha256(reason), negotiationDeadline: m.dispute.negotiationDeadline, frozen: 'only this milestone' }, now);
      return { disputeStatus: m.dispute.status, negotiationDeadline: m.dispute.negotiationDeadline };
    });
  }

  async proposeResolution(token, mid, input = {}) {
    return this.#store.transact((draft) => {
      const { project: p, role } = this.authorize(draft, token, ['client', 'lead']);
      const m = this.#milestone(p, mid);
      const now = this.#nowIn(draft);
      const d = this.#dispute(m);
      if (d.status !== 'negotiating') throw new StateError('NEGOTIATION_CLOSED', d.status === 'in_review' ? 'The negotiation period is over. This case is with the reviewer.' : 'This dispute is already resolved.');
      if (now >= d.negotiationDeadline) throw new StateError('NEGOTIATION_CLOSED', 'The five-day negotiation period has ended.');
      const kind = String(input.kind ?? '');
      if (!['release', 'refund', 'split', 'fix'].includes(kind)) throw new ValidationError('PROPOSAL_KIND_INVALID', 'Choose full release, full refund, a percentage split, or fix and resubmit.');
      let releaseBps = null;
      if (kind === 'split') {
        releaseBps = input.releaseBps;
        if (!Number.isInteger(releaseBps) || releaseBps < 1 || releaseBps > 9999) throw new ValidationError('SPLIT_BPS_INVALID', 'A split must release between 0.01% and 99.99% to the team.');
      }
      const note = input.note ? cleanText(input.note, { label: 'Note', max: 500, multiline: true }) : '';
      for (const x of d.proposals) if (x.status === 'open') x.status = 'superseded';
      const prop = { id: `pr_${d.proposals.length + 1}`, by: role, kind, releaseBps, note, at: now, status: 'open', respondedAt: null };
      d.proposals.push(prop);
      d.history.push({ at: now, actor: role, type: 'proposal', text: this.#proposalText(m, prop), proposalId: prop.id });
      this.#log(p, 'dispute.proposal', { milestoneId: m.id, proposalId: prop.id, by: role, kind, releaseBps, noteHash: note ? sha256(note) : null }, now);
      return { proposalId: prop.id };
    });
  }

  #proposalText(m, prop) {
    const label = { release: 'Release the full milestone to the team', refund: 'Refund the full milestone to the client (simulated)', fix: 'Fix the issues and resubmit for a new 72-hour review' }[prop.kind]
      ?? `Release ${prop.releaseBps / 100}% to the team and refund the rest to the client (simulated)`;
    return prop.note ? `${label}. ${prop.note}` : label;
  }

  async respondToProposal(token, mid, proposalId, input = {}) {
    const out = await this.#store.transact((draft) => {
      const { project: p, role } = this.authorize(draft, token, ['client', 'lead']);
      const m = this.#milestone(p, mid);
      const now = this.#nowIn(draft);
      const d = this.#dispute(m);
      if (d.status !== 'negotiating') throw new StateError('NEGOTIATION_CLOSED', 'This dispute is no longer in negotiation.');
      const prop = d.proposals.find((x) => x.id === proposalId);
      if (!prop) throw new NotFoundError('PROPOSAL_NOT_FOUND', 'No such proposal.');
      if (prop.by === role) throw new StateError('OWN_PROPOSAL', 'You cannot respond to your own proposal. The other party has to accept or reject it.');
      if (prop.status !== 'open') throw new StateError('PROPOSAL_NOT_OPEN', 'That proposal is no longer open.');
      prop.respondedAt = now;
      if (input.accept === true) {
        prop.status = 'accepted';
        d.history.push({ at: now, actor: role, type: 'accepted', text: 'Accepted the proposal.', proposalId });
        this.#log(p, 'dispute.proposal_accepted', { milestoneId: m.id, proposalId, by: role, kind: prop.kind }, now);
        this.#settleDispute(p, m, { kind: prop.kind, releaseBps: prop.releaseBps, via: 'agreement' }, now);
        return { projectId: p.id, resolved: true };
      }
      prop.status = 'rejected';
      d.history.push({ at: now, actor: role, type: 'rejected', text: 'Rejected the proposal.', proposalId });
      this.#log(p, 'dispute.proposal_rejected', { milestoneId: m.id, proposalId, by: role }, now);
      return { projectId: p.id, resolved: false };
    });
    if (out.resolved) this.#payoutsInBackground(out.projectId);
    return { resolved: out.resolved };
  }

  /** After a proposal was rejected, either party may stop waiting and send the case to the reviewer. */
  async escalateDispute(token, mid) {
    return this.#store.transact((draft) => {
      const { project: p } = this.authorize(draft, token, ['client', 'lead']);
      const m = this.#milestone(p, mid);
      const d = this.#dispute(m);
      if (d.status !== 'negotiating') throw new StateError('NEGOTIATION_CLOSED', 'This dispute is not in negotiation.');
      if (!d.proposals.some((x) => x.status === 'rejected')) throw new StateError('ESCALATE_TOO_EARLY', 'Make a proposal and have it rejected before asking the reviewer to decide, or wait for the five days to pass.');
      this.#escalate(p, m, this.#nowIn(draft), 'requested');
      return { disputeStatus: 'in_review' };
    });
  }

  #escalate(p, m, now, why) {
    const d = m.dispute;
    d.status = 'in_review';
    d.escalatedAt = now;
    for (const x of d.proposals) if (x.status === 'open') x.status = 'expired';
    d.history.push({ at: now, actor: 'system', type: 'escalated', text: why === 'deadline' ? 'No agreement within five days. Sent to the simulated reviewer.' : 'Sent to the simulated reviewer at a party’s request.' });
    this.#log(p, 'dispute.escalated', { milestoneId: m.id, why, reviewer: 'SIMULATED' }, now);
  }

  async reviewerDecide(token, mid, input = {}) {
    const out = await this.#store.transact((draft) => {
      const { project: p } = this.authorize(draft, token, ['reviewer']);
      const m = this.#milestone(p, mid);
      const now = this.#nowIn(draft);
      const d = this.#dispute(m);
      if (d.status !== 'in_review') throw new StateError('REVIEW_NOT_READY', d.status === 'negotiating' ? 'The parties are still negotiating. The reviewer decides only after the negotiation ends.' : 'This dispute has already been decided.');
      const kind = String(input.kind ?? '');
      if (!['release', 'refund', 'split', 'fix'].includes(kind)) throw new ValidationError('DECISION_KIND_INVALID', 'Choose release, refund, split, or fix and resubmit.');
      let releaseBps = null;
      if (kind === 'split') {
        releaseBps = input.releaseBps;
        if (!Number.isInteger(releaseBps) || releaseBps < 1 || releaseBps > 9999) throw new ValidationError('SPLIT_BPS_INVALID', 'A split must release between 0.01% and 99.99% to the team.');
      }
      const cited = [...new Set(Array.isArray(input.citedCriteria) ? input.citedCriteria : [])];
      if (cited.length === 0 || cited.some((i) => !Number.isInteger(i) || i < 0 || i >= m.criteria.length)) {
        throw new ValidationError('CITATION_REQUIRED', 'A decision must cite at least one written acceptance criterion.');
      }
      const note = cleanText(input.note, { label: 'Decision note', min: 30, max: 1500, multiline: true });
      d.reviewer = { kind, releaseBps, citedCriteria: cited.sort((a, b) => a - b), note, at: now, simulated: true };
      d.history.push({ at: now, actor: 'reviewer', type: 'decision', text: note });
      this.#log(p, 'dispute.decided', { milestoneId: m.id, kind, releaseBps, citedCriteria: d.reviewer.citedCriteria, noteHash: sha256(note), deliveryNumber: d.deliveryNumber, reviewer: 'SIMULATED' }, now);
      this.#settleDispute(p, m, { kind, releaseBps, via: 'reviewer' }, now);
      return { projectId: p.id };
    });
    this.#payoutsInBackground(out.projectId);
    return { resolved: true };
  }

  #settleDispute(p, m, { kind, releaseBps, via }, now) {
    const d = m.dispute;
    d.status = 'resolved'; // unfreezes the milestone; #release re-checks everything anyway
    d.outcome = { kind, releaseBps, via, at: now };
    if (kind === 'fix') {
      m.deliveryHistory.push(m.delivery);
      m.delivery = null;
      m.status = 'pending';
      this.#log(p, 'milestone.reopened', { milestoneId: m.id, via, note: 'Fix and resubmit. A new delivery starts a new 72-hour review window.' }, now);
      return;
    }
    if (kind === 'release') return this.#release(p, m, { releaseKobo: m.amountKobo, refundKobo: 0, resolution: 'released', trigger: via }, now);
    if (kind === 'refund') return this.#release(p, m, { releaseKobo: 0, refundKobo: m.amountKobo, resolution: 'refunded', trigger: via }, now);
    const { releaseKobo, refundKobo } = splitRelease(m.amountKobo, releaseBps);
    return this.#release(p, m, { releaseKobo, refundKobo, resolution: 'split', trigger: via }, now);
  }

  // ------------------------------------------------------------------ payouts

  /** Retry a failed payout. Never re-sends one that already succeeded or is still in flight. */
  async retryPayout(token, payoutId) {
    const out = await this.#store.transact((draft) => {
      const { project: p } = this.authorize(draft, token, ['lead']);
      const po = own(p.payouts, payoutId);
      if (!po) throw new NotFoundError('PAYOUT_NOT_FOUND', 'No such payout.');
      const now = this.#nowIn(draft);
      if (po.status === 'success') throw new StateError('PAYOUT_ALREADY_PAID', 'This payout has already been paid. It will not be sent again.');
      if (po.status === 'processing') throw new StateError('PAYOUT_IN_FLIGHT', 'This payout is being sent right now. Wait for the result before retrying.');
      if (po.status === 'queued') return { projectId: p.id };
      if (isFrozen(this.#milestone(p, po.milestoneId))) throw new StateError('PAYING_FROZEN_MILESTONE', 'This milestone is frozen by an open dispute and cannot be paid.');
      // 'failed' / 'reversed' -> a NEW attempt with a NEW reference. 'unknown' keeps its reference
      // (the provider de-duplicates on it), so an ambiguous send can never pay twice.
      if (po.status !== 'unknown') po.status = 'queued';
      po.retryAfter = 0;
      this.#log(p, 'payout.retry_requested', { payoutId: po.id, milestoneId: po.milestoneId, collaboratorId: po.collaboratorId, previousStatus: po.status === 'queued' ? 'failed' : po.status, attempt: po.attempt }, now);
      return { projectId: p.id };
    });
    await this.runPayouts(out.projectId);
    return { ok: true };
  }

  /**
   * Execute queued payouts for a project. Intent (locked) -> provider call (unlocked) -> result (locked).
   * Concurrent calls are safe: only the call that flips a payout queued->processing sends it.
   */
  async runPayouts(projectId) {
    // 1) intent
    const plan = await this.#store.transact((draft) => {
      const p = own(draft.projects, projectId);
      if (!p) return [];
      const now = this.#nowIn(draft);
      const todo = [];
      for (const po of Object.values(p.payouts)) {
        const eligible = po.status === 'queued' || (po.status === 'unknown' && po.retryAfter <= now);
        if (!eligible) continue;
        const m = this.#milestone(p, po.milestoneId);
        if (isFrozen(m)) continue; // defence in depth: frozen milestones are never paid
        const c = p.collaborators.find((x) => x.id === po.collaboratorId);
        if (!c.bank) throw new InternalError('Payout for a collaborator without bank details.');
        if (po.status === 'queued') {
          po.attempt += 1;
          po.reference = `sp-${p.id}-${po.milestoneId}-${po.collaboratorId}-a${po.attempt}`;
          draft.refIndex[po.reference] = { projectId: p.id, kind: 'transfer', payoutId: po.id };
        }
        po.status = 'processing';
        po.startedAt = now;
        todo.push({ payoutId: po.id, reference: po.reference, amountKobo: po.amountKobo, collaboratorId: c.id, name: c.bank.accountName, accountNumber: c.bank.accountNumber, bankCode: c.bank.bankCode, recipientCode: c.recipientCode, reason: `SplitPot ${p.title} ${m.title}`.slice(0, 100) });
      }
      return todo;
    });
    if (plan.length === 0) return { sent: 0 };

    // 2) provider calls (no lock held)
    const failedRecipients = new Map();
    for (const t of plan) {
      if (t.recipientCode || failedRecipients.has(t.collaboratorId)) continue;
      try {
        const r = await this.#provider.createRecipient({ name: t.name, accountNumber: t.accountNumber, bankCode: t.bankCode, currency: CURRENCY });
        await this.#store.transact((draft) => {
          const c = own(draft.projects, projectId).collaborators.find((x) => x.id === t.collaboratorId);
          c.recipientCode = r.recipientCode;
        });
        for (const x of plan) if (x.collaboratorId === t.collaboratorId) x.recipientCode = r.recipientCode;
      } catch (err) {
        failedRecipients.set(t.collaboratorId, err instanceof SplitPotError ? err.message : 'Could not create the transfer recipient.');
      }
    }
    const sendable = plan.filter((t) => !failedRecipients.has(t.collaboratorId));
    let results = [];
    let batchError = null;
    if (sendable.length) {
      try {
        const r = await this.#provider.bulkTransfer({ transfers: sendable.map((t) => ({ reference: t.reference, recipientCode: t.recipientCode, amountKobo: t.amountKobo, reason: t.reason })), currency: CURRENCY });
        results = r.results;
      } catch (err) {
        batchError = err;
      }
    }

    // 3) result (locked)
    await this.#store.transact((draft) => {
      const p = own(draft.projects, projectId);
      const now = this.#nowIn(draft);
      for (const t of plan) {
        const po = own(p.payouts, t.payoutId);
        if (po.status !== 'processing' || po.reference !== t.reference) continue;
        if (failedRecipients.has(t.collaboratorId)) {
          this.#applyTransfer(p, po, { status: 'failed', failureReason: failedRecipients.get(t.collaboratorId) }, now);
        } else if (batchError) {
          const definitive = batchError instanceof ProviderError && batchError.code === 'PROVIDER_REJECTED';
          if (definitive) this.#applyTransfer(p, po, { status: 'failed', failureReason: batchError.message }, now);
          else { po.status = 'unknown'; po.retryAfter = now + 30_000 * 2 ** Math.min(po.attempt, 5); po.failureReason = 'Result unknown: the payment provider could not be reached. Retrying with the same reference is safe.'; }
        } else {
          const res = results.find((x) => x.reference === t.reference);
          if (!res) { po.status = 'unknown'; po.retryAfter = now + 30_000; po.failureReason = 'The provider returned no result for this payout. Retrying with the same reference is safe.'; }
          else this.#applyTransfer(p, po, res, now);
        }
      }
    });
    return { sent: sendable.length };
  }

  #applyTransfer(p, po, res, now) {
    if (res.transferCode) po.transferCode = res.transferCode;
    const c = p.collaborators.find((x) => x.id === po.collaboratorId);
    const m = p.milestones.find((x) => x.id === po.milestoneId);
    const base = { payoutId: po.id, milestoneId: po.milestoneId, milestoneTitle: m.title, collaboratorId: c.id, name: c.name, amountKobo: po.amountKobo, reference: po.reference, attempt: po.attempt, bankName: c.bank.bankName, accountLast4: last4(c.bank.accountNumber) };
    if (po.status === 'success') {
      if (res.status === 'reversed') {
        po.status = 'reversed';
        this.#log(p, 'payout.reversed', { ...base, note: 'The bank returned this transfer. A retry sends a new transfer.' }, now);
      }
      return; // never downgrade or re-record a success
    }
    if (res.status === 'success') {
      po.status = 'success';
      po.failureReason = null;
      po.completedAt = now;
      const e = this.#log(p, 'payout.succeeded', { ...base, simulated: !!this.#provider.isMock }, now);
      po.ledgerSeq = e.seq;
      po.ledgerHash = e.hash;
      po.receiptNo = `SP-${p.id.slice(1, 7).toUpperCase()}-${String(e.seq).padStart(4, '0')}`;
      this.#maybeComplete(p, now);
    } else if (res.status === 'failed' || res.status === 'reversed') {
      po.status = 'failed';
      po.failureReason = redactAccounts(res.failureReason || 'The transfer failed.');
      this.#log(p, 'payout.failed', { ...base, reason: po.failureReason }, now);
    } else {
      po.status = 'processing'; // pending: a transfer.* webhook will settle it
    }
  }

  async #onTransferEvent(evt) {
    const loc = this.#store.read((s) => own(s.refIndex, evt.reference));
    if (!loc || loc.kind !== 'transfer') return { status: 'ignored', note: 'Unknown transfer reference.' };
    const status = { 'transfer.success': 'success', 'transfer.failed': 'failed', 'transfer.reversed': 'reversed' }[evt.type];
    const out = await this.#store.transact((draft) => {
      const p = own(draft.projects, loc.projectId);
      const po = p && own(p.payouts, loc.payoutId);
      if (!po) return { status: 'ignored', note: 'No such payout.' };
      if (po.reference !== evt.reference) return { status: 'ignored', note: 'Stale transfer reference (an older attempt).' };
      this.#applyTransfer(p, po, { status, failureReason: evt.reason || undefined }, this.#nowIn(draft));
      return { status: 'processed', note: `Transfer ${status}.` };
    });
    return out;
  }

  // ------------------------------------------------------------------ demo hook (Judge Mode only)

  /** Mutate demo state and record a ledger entry atomically. Refuses to run unless demo mode is on. */
  async recordDemoEvent(projectId, type, data, mutate) {
    if (!this.config.demoMode) throw new AuthError('DEMO_DISABLED', 'Judge Mode is disabled on this server.', 403);
    return this.#store.transact((draft) => {
      const p = own(draft.projects, projectId);
      if (!p) throw new NotFoundError('PROJECT_NOT_FOUND', 'No such project.');
      const out = mutate ? mutate(p, draft) : undefined;
      this.#log(p, type, data, this.#nowIn(draft));
      return out;
    });
  }

  // ------------------------------------------------------------------ system tick

  /** Called by the server every few seconds and by Judge Mode. Safe to run concurrently. */
  async tick() {
    await this.processDeadlines();
    const work = this.#store.read((s) => {
      const now = this.#baseNow() + s.clock.offsetMs;
      const ids = Object.values(s.projects).filter((p) => Object.values(p.payouts).some((po) => po.status === 'queued' || (po.status === 'unknown' && po.retryAfter <= now))).map((p) => p.id);
      const stuck = Object.values(s.webhookEvents).filter((e) => e.status === 'received' && (e.tries ?? 0) < 6 && now - e.receivedAt > 10_000).map((e) => e.event);
      return { ids, stuck };
    });
    for (const id of work.ids) await this.runPayouts(id).catch((e) => console.error('[tick payouts]', e?.code ?? e?.message));
    for (const evt of work.stuck) await this.#processEvent(evt).catch(() => {});
  }
}

export { formatNaira, MAX_KOBO, HOUR, isFrozen };
