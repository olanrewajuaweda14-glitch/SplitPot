// Accounts: sign-up, login, sessions, password reset, profile, and the per-user dashboard read models.
//
// Honesty notes:
//  - No email is sent in this prototype. Password reset returns the reset link on screen (labelled).
//  - Accounts are a convenience layer. A project link (capability token) still works without an account.
//  - Passwords are stored only as scrypt hashes with a per-user salt. Sessions are random 256-bit tokens, stored hashed.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AuthError, NotFoundError, StateError, ValidationError } from '../shared/errors.js';
import { maskAccount, isValidAccountNumber } from '../shared/money.js';
import { own, randomId, sha256, cleanText, newToken, HOUR } from './helpers.js';
import { describeLedger } from './ledgerText.js';

const scryptAsync = promisify(scrypt);
const MAX_USERS = 2000;
const SESSION_MS = 14 * 24 * HOUR;
const RESET_MS = HOUR;
export const PREF_KEYS = ['funding', 'confirmations', 'disputes', 'payouts'];
const DEFAULT_PREFS = { funding: true, confirmations: true, disputes: true, payouts: true };
const sessionKey = (t) => sha256(`splitpot:session:${t}`);
const resetKey = (t) => sha256(`splitpot:reset:${t}`);

async function hashPassword(password, saltHex = randomBytes(16).toString('hex')) {
  const buf = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return `${saltHex}:${buf.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const buf = await scryptAsync(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hex, 'hex');
  return want.length === buf.length && timingSafeEqual(want, buf);
}
// A real hash to compare against when the email is unknown, so login timing does not reveal which emails exist.
const DUMMY = await hashPassword('not-a-real-password');

function cleanEmailRequired(v) {
  const s = cleanText(typeof v === 'string' ? v.toLowerCase() : v, { label: 'Email', max: 120 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new ValidationError('EMAIL_INVALID', 'Enter a valid email address.');
  return s;
}
function cleanPassword(v) {
  if (typeof v !== 'string' || v.length < 8) throw new ValidationError('PASSWORD_TOO_SHORT', 'Use a password of at least 8 characters.');
  if (v.length > 128) throw new ValidationError('PASSWORD_TOO_LONG', 'Use a password of at most 128 characters.');
  if (/^(.)\1+$/.test(v) || ['password', '12345678', 'qwertyui'].includes(v.toLowerCase())) throw new ValidationError('PASSWORD_WEAK', 'Choose a password that is harder to guess.');
  return v;
}

export class Accounts {
  #store; #engine; #baseNow;
  constructor({ store, engine, baseNow = () => Date.now() }) { this.#store = store; this.#engine = engine; this.#baseNow = baseNow; }
  #now(s) { return this.#baseNow() + (s.clock?.offsetMs ?? 0); }
  #pub(u) {
    return {
      id: u.id, email: u.email, name: u.name, phone: u.phone ?? '', prefs: { ...DEFAULT_PREFS, ...u.prefs }, createdAt: u.createdAt,
      defaultBank: u.defaultBank ? { bankCode: u.defaultBank.bankCode, bankName: u.defaultBank.bankName, masked: maskAccount(u.defaultBank.accountNumber), accountName: u.defaultBank.accountName } : null,
    };
  }
  #newSession(draft, userId, now) {
    const token = newToken();
    draft.sessions[sessionKey(token)] = { userId, createdAt: now, expiresAt: now + SESSION_MS };
    // keep per-user sessions bounded
    const mine = Object.entries(draft.sessions).filter(([, v]) => v.userId === userId).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (mine.length > 8) delete draft.sessions[mine.shift()[0]];
    return token;
  }
  #ensure(draft) { draft.users ??= {}; draft.userIndex ??= {}; draft.sessions ??= {}; draft.resets ??= {}; }

  async signup({ email, name, password } = {}) {
    const e = cleanEmailRequired(email);
    const n = cleanText(name, { label: 'Name', min: 2, max: 60 });
    const pw = cleanPassword(password);
    const passHash = await hashPassword(pw);
    return this.#store.transact((draft) => {
      this.#ensure(draft);
      if (own(draft.userIndex, e)) throw new ValidationError('EMAIL_TAKEN', 'That email already has an account. Log in instead.');
      if (Object.keys(draft.users).length >= MAX_USERS) throw new ValidationError('CAPACITY_REACHED', 'This prototype has reached its account limit.');
      const now = this.#now(draft);
      let id; do id = randomId('u', 10); while (own(draft.users, id));
      draft.users[id] = { id, email: e, name: n, phone: '', passHash, createdAt: now, prefs: { ...DEFAULT_PREFS }, defaultBank: null, claims: [] };
      draft.userIndex[e] = id;
      const token = this.#newSession(draft, id, now);
      return { token, user: this.#pub(draft.users[id]) };
    });
  }

  async login({ email, password } = {}) {
    const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const snap = this.#store.snapshot();
    const uid = own(snap.userIndex ?? {}, e);
    const user = uid ? own(snap.users, uid) : null;
    const ok = await verifyPassword(typeof password === 'string' ? password.slice(0, 128) : '', user?.passHash ?? DUMMY);
    if (!user || !ok) throw new AuthError('LOGIN_FAILED', 'That email and password do not match.', 401);
    return this.#store.transact((draft) => {
      this.#ensure(draft);
      const u = own(draft.users, uid);
      if (!u) throw new AuthError('LOGIN_FAILED', 'That email and password do not match.', 401);
      return { token: this.#newSession(draft, u.id, this.#now(draft)), user: this.#pub(u) };
    });
  }

  /** Resolve a session token to a user. Throws AuthError when missing, unknown or expired. */
  auth(state, token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new AuthError('NOT_SIGNED_IN', 'Log in to continue.', 401);
    const s = own(state.sessions ?? {}, sessionKey(token));
    if (!s || s.expiresAt <= this.#now(state)) throw new AuthError('NOT_SIGNED_IN', 'Your session ended. Log in again.', 401);
    const u = own(state.users ?? {}, s.userId);
    if (!u) throw new AuthError('NOT_SIGNED_IN', 'Log in to continue.', 401);
    return u;
  }
  optional(token) { try { return this.auth(this.#store.snapshot(), token); } catch { return null; } }
  me(token) { return this.#pub(this.auth(this.#store.snapshot(), token)); }

  async logout(token) {
    if (typeof token !== 'string') return { ok: true };
    await this.#store.transact((draft) => { if (draft.sessions) delete draft.sessions[sessionKey(token)]; });
    return { ok: true };
  }

  async updateProfile(token, { name, phone } = {}) {
    return this.#store.transact((draft) => {
      const u = this.auth(draft, token);
      if (name !== undefined) u.name = cleanText(name, { label: 'Name', min: 2, max: 60 });
      if (phone !== undefined) {
        const ph = String(phone).trim();
        if (ph && !/^\+?[0-9 ()-]{7,18}$/.test(ph)) throw new ValidationError('PHONE_INVALID', 'Enter a phone number with 7 to 18 digits, or leave it blank.');
        u.phone = ph;
      }
      return this.#pub(u);
    });
  }

  async updatePrefs(token, prefs = {}) {
    return this.#store.transact((draft) => {
      const u = this.auth(draft, token);
      for (const k of PREF_KEYS) if (typeof prefs[k] === 'boolean') (u.prefs ??= { ...DEFAULT_PREFS })[k] = prefs[k];
      return this.#pub(u);
    });
  }

  async setDefaultBank(token, { bankCode, accountNumber } = {}) {
    this.auth(this.#store.snapshot(), token);
    const banks = await this.#engine.listBanks();
    const bank = banks.find((b) => b.code === bankCode);
    if (!bank) throw new ValidationError('BANK_REQUIRED', 'Choose your bank.');
    if (!isValidAccountNumber(accountNumber)) throw new ValidationError('ACCOUNT_NUMBER_INVALID', 'Account number must be exactly 10 digits.');
    const r = await this.#engine.provider.resolveAccount({ accountNumber, bankCode });
    return this.#store.transact((draft) => {
      const u = this.auth(draft, token);
      u.defaultBank = { bankCode, bankName: bank.name, accountNumber, accountName: r.accountName };
      return this.#pub(u);
    });
  }
  /** Look up the account name for a bank + number without saving anything. */
  async resolveAccount(token, { bankCode, accountNumber } = {}) {
    this.auth(this.#store.snapshot(), token);
    const banks = await this.#engine.listBanks();
    const bank = banks.find((b) => b.code === bankCode);
    if (!bank) throw new ValidationError('BANK_REQUIRED', 'Choose your bank.');
    if (!isValidAccountNumber(accountNumber)) throw new ValidationError('ACCOUNT_NUMBER_INVALID', 'Account number must be exactly 10 digits.');
    const r = await this.#engine.provider.resolveAccount({ accountNumber, bankCode });
    return { accountName: r.accountName, bankName: bank.name, masked: maskAccount(accountNumber) };
  }
  async clearDefaultBank(token) { return this.#store.transact((draft) => { const u = this.auth(draft, token); u.defaultBank = null; return this.#pub(u); }); }

  async changePassword(token, { current, next } = {}) {
    const u0 = this.auth(this.#store.snapshot(), token);
    if (!(await verifyPassword(typeof current === 'string' ? current : '', u0.passHash))) throw new AuthError('PASSWORD_WRONG', 'Your current password is not correct.', 403);
    const pw = cleanPassword(next);
    if (pw === current) throw new ValidationError('PASSWORD_UNCHANGED', 'Choose a new password that differs from the current one.');
    const passHash = await hashPassword(pw);
    return this.#store.transact((draft) => {
      const u = this.auth(draft, token);
      u.passHash = passHash;
      const keep = sessionKey(token);
      for (const [k, v] of Object.entries(draft.sessions)) if (v.userId === u.id && k !== keep) delete draft.sessions[k];
      return { ok: true, otherSessionsEnded: true };
    });
  }

  async logoutEverywhere(token) {
    return this.#store.transact((draft) => {
      const u = this.auth(draft, token);
      let n = 0;
      for (const [k, v] of Object.entries(draft.sessions)) if (v.userId === u.id) { delete draft.sessions[k]; n += 1; }
      return { ended: n };
    });
  }

  /** No email service here, so the link is returned on screen. For unknown emails the shape is identical. */
  async requestReset({ email } = {}) {
    const e = cleanEmailRequired(email);
    const token = newToken();
    await this.#store.transact((draft) => {
      this.#ensure(draft);
      const uid = own(draft.userIndex, e);
      const now = this.#now(draft);
      for (const [k, v] of Object.entries(draft.resets)) if (v.expiresAt <= now) delete draft.resets[k];
      if (uid) draft.resets[resetKey(token)] = { userId: uid, expiresAt: now + RESET_MS };
    });
    return { simulated: true, note: 'No email is sent in this prototype, so the reset link is shown here.', resetPath: `/reset/${token}`, validForMinutes: 60 };
  }

  async resetPassword({ token, password } = {}) {
    const pw = cleanPassword(password);
    const passHash = await hashPassword(pw);
    return this.#store.transact((draft) => {
      this.#ensure(draft);
      const rec = typeof token === 'string' ? own(draft.resets, resetKey(token)) : null;
      if (!rec || rec.expiresAt <= this.#now(draft)) throw new StateError('RESET_INVALID', 'This reset link is invalid or has expired. Request a new one.');
      const u = own(draft.users, rec.userId);
      if (!u) throw new StateError('RESET_INVALID', 'This reset link is invalid or has expired. Request a new one.');
      u.passHash = passHash;
      delete draft.resets[resetKey(token)];
      for (const [k, v] of Object.entries(draft.sessions)) if (v.userId === u.id) delete draft.sessions[k];
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- linking projects to an account

  /** Attach a project the caller already holds a link for. Lead links claim ownership; collaborator links add a share. */
  async claim(sessionToken, linkToken) {
    return this.#store.transact((draft) => {
      const u = this.auth(draft, sessionToken);
      const a = this.#engine.authorize(draft, linkToken, ['lead', 'collaborator']);
      u.claims ??= [];
      const exists = u.claims.some((c) => c.projectId === a.project.id && c.role === a.role && (c.collaboratorId ?? null) === (a.collaboratorId ?? null));
      if (!exists) {
        if (a.role === 'lead') {
          if (a.project.ownerUserId && a.project.ownerUserId !== u.id) throw new StateError('ALREADY_OWNED', 'This project already belongs to another account.');
          a.project.ownerUserId = u.id;
        }
        u.claims.push({ projectId: a.project.id, role: a.role, collaboratorId: a.collaboratorId ?? null });
      }
      return { projectId: a.project.id, role: a.role, added: !exists };
    });
  }
  async unclaim(sessionToken, projectId) {
    return this.#store.transact((draft) => {
      const u = this.auth(draft, sessionToken);
      u.claims = (u.claims ?? []).filter((c) => c.projectId !== projectId);
      return { ok: true };
    });
  }

  /** Every (project, role) pair this user can see, with the link path that opens it. */
  #memberships(state, u) {
    const out = []; const seen = new Set();
    const add = (p, role, cid) => {
      const k = `${p.id}:${role}:${cid ?? ''}`; if (seen.has(k)) return; seen.add(k);
      out.push({ p, role, collaboratorId: cid ?? null, path: role === 'lead' ? `/p/lead/${p.access.lead}` : `/p/collab/${p.access.collaborators[cid]}` });
    };
    for (const p of Object.values(state.projects)) if (p.ownerUserId === u.id) add(p, 'lead');
    for (const c of u.claims ?? []) { const p = own(state.projects, c.projectId); if (p && (c.role === 'lead' ? p.ownerUserId === u.id : p.collaborators.some((x) => x.id === c.collaboratorId))) add(p, c.role, c.collaboratorId); }
    return out;
  }

  dashboard(token) {
    const state = this.#store.snapshot(); const u = this.auth(state, token); const prefs = { ...DEFAULT_PREFS, ...u.prefs };
    const ms = this.#memberships(state, u);
    const projects = []; let totalValue = 0; let active = 0; let pending = 0; let awaiting = 0; let paidOut = 0; let myShare = 0;
    const bandTotals = { waiting: 0, delivered: 0, frozen: 0, paid: 0, refunded: 0 };
    const tx = []; const activity = [];
    for (const { p, role, collaboratorId, path } of ms) {
      const funded = p.funding.status === 'funded'; const me = collaboratorId ? p.collaborators.find((c) => c.id === collaboratorId) : null;
      const confirmed = p.collaborators.filter((c) => c.confirmed).length;
      const paidKobo = Object.values(p.payouts).filter((po) => po.status === 'success' && (role === 'lead' || po.collaboratorId === collaboratorId)).reduce((a, po) => a + po.amountKobo, 0);
      const open = p.milestones.filter((m) => m.status !== 'closed');
      const share = me ? p.milestones.reduce((a, m) => a + (m.plannedAllocation.find((x) => x.collaboratorId === me.id)?.amountKobo ?? 0), 0) : null;
      const frozen = p.milestones.find((m) => m.dispute && m.dispute.status !== 'resolved');
      let attention = null;
      if (role === 'lead') {
        if (p.status === 'awaiting_confirmations') { const d = p.collaborators.filter((c) => c.declinedAt && !c.confirmed); attention = d.length ? `${d.length} declined. Revise the split or talk to them.` : `${p.collaborators.length - confirmed} still to confirm`; }
        else if (p.status === 'awaiting_funding') attention = 'Waiting for the client to pay';
        else if (frozen) attention = `Dispute open on ${frozen.title}`;
        else if (Object.values(p.payouts).some((po) => ['failed', 'unknown', 'reversed'].includes(po.status))) attention = 'A payout needs a retry';
        else if (open.find((m) => m.status === 'pending')) attention = `Deliver ${open.find((m) => m.status === 'pending').title}`;
        else if (open.find((m) => m.status === 'delivered')) attention = 'With the client for review';
      } else if (me) {
        if (!me.confirmed) attention = me.declinedAt ? 'You declined. You can still accept.' : 'Confirm your share';
        else if (p.status === 'awaiting_confirmations') attention = 'Waiting for others to confirm';
        else if (p.status === 'awaiting_funding') attention = 'Waiting for the client to pay';
      }
      if (role === 'lead') { totalValue += p.totalKobo; if (p.status === 'awaiting_confirmations') pending += p.collaborators.length - confirmed; }
      else if (me && !me.confirmed) pending += 1;
      if (me && role === 'collaborator') myShare += share;
      if (p.status === 'active') active += 1;
      if (funded) for (const m of p.milestones) if (m.status !== 'closed') awaiting += role === 'lead' ? m.amountKobo : (m.plannedAllocation.find((x) => x.collaboratorId === me?.id)?.amountKobo ?? 0);
      paidOut += paidKobo;
      // pot composition for the chart (project value, whole-project view for leads, my share for collaborators)
      const potBands = funded ? p.milestones.map((m) => {
        const full = role === 'lead' ? m.amountKobo : (m.plannedAllocation.find((x) => x.collaboratorId === me?.id)?.amountKobo ?? 0);
        const st = m.dispute && m.dispute.status !== 'resolved' ? 'frozen' : m.status === 'closed' ? (m.resolution === 'refunded' ? 'refunded' : 'paid') : m.status === 'delivered' ? 'delivered' : 'waiting';
        return [st, full];
      }) : [];
      for (const [st, v] of potBands) bandTotals[st] += v;
      projects.push({
        id: p.id, title: p.title, role: role === 'lead' ? 'lead' : 'collaborator', origin: p.origin, status: p.status,
        totalKobo: p.totalKobo, shareKobo: share, confirmedCount: confirmed, collaboratorCount: p.collaborators.length, funded,
        paidKobo, attention, path, ledgerPath: `/ledger/${p.publicId}`, createdAt: p.createdAt,
        bars: { waiting: potBands.filter(([s]) => s === 'waiting' || s === 'delivered').reduce((a, [, v]) => a + v, 0), frozen: potBands.filter(([s]) => s === 'frozen').reduce((a, [, v]) => a + v, 0), paid: potBands.filter(([s]) => s === 'paid').reduce((a, [, v]) => a + v, 0), unfunded: funded ? 0 : (role === 'lead' ? p.totalKobo : share ?? 0) },
      });
      for (const po of Object.values(p.payouts)) if (role === 'lead' || po.collaboratorId === collaboratorId) tx.push({ ts: po.completedAt ?? po.queuedAt, type: 'payout', title: `${p.collaborators.find((c) => c.id === po.collaboratorId).name} paid`, status: po.status, amountKobo: po.amountKobo, project: p.title });
      if (funded && p.funding.fundedAt && role === 'lead') tx.push({ ts: p.funding.fundedAt, type: 'funding', title: 'Client payment verified', status: 'success', amountKobo: p.clientPaysKobo, project: p.title });
      for (const e of p.ledger) { const cat = ledgerCategory(e.type); if (prefs[cat.pref] === false) continue; const [title, detail] = describeLedger(e); activity.push({ ts: e.ts, project: p.title, projectId: p.id, title, detail, category: cat.label, type: e.type, seq: e.seq }); }
    }
    tx.sort((a, b) => b.ts - a.ts); activity.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
    projects.sort((a, b) => b.createdAt - a.createdAt);
    return {
      user: this.#pub(u), serverNow: this.#now(state),
      metrics: { totalValueKobo: totalValue, activeProjects: active, pendingConfirmations: pending, awaitingSettlementKobo: awaiting, completedPayoutsKobo: paidOut, myShareKobo: myShare, projectCount: projects.length },
      pot: bandTotals, projects, recentTransactions: tx.slice(0, 10), activity: activity.slice(0, 15),
    };
  }

  payouts(token) {
    const state = this.#store.snapshot(); const u = this.auth(state, token); const rows = [];
    for (const { p, role, collaboratorId, path } of this.#memberships(state, u)) {
      const tokenFor = path.split('/').pop();
      for (const po of Object.values(p.payouts)) {
        if (role !== 'lead' && po.collaboratorId !== collaboratorId) continue;
        const c = p.collaborators.find((x) => x.id === po.collaboratorId); const m = p.milestones.find((x) => x.id === po.milestoneId);
        rows.push({
          id: po.id, project: p.title, projectId: p.id, milestone: m.title, recipient: c.name, role: c.role, amountKobo: po.amountKobo,
          method: c.bank ? `Bank transfer, ${c.bank.bankName} ${maskAccount(c.bank.accountNumber)}` : 'Bank transfer', reference: po.reference ?? null,
          status: po.status, attempt: po.attempt, failureReason: po.failureReason ?? null, ts: po.completedAt ?? po.startedAt ?? po.queuedAt,
          receiptPath: po.status === 'success' && po.receiptNo ? `/receipt/${tokenFor}/${po.id}` : null, projectPath: path, canRetry: role === 'lead' && ['failed', 'unknown', 'reversed'].includes(po.status), simulated: p.origin === 'seed' || !!this.#engine.provider.isMock,
        });
      }
    }
    rows.sort((a, b) => b.ts - a.ts);
    return { simulated: !!this.#engine.provider.isMock, rows };
  }

  ledger(token) {
    const state = this.#store.snapshot(); const u = this.auth(state, token); const rows = [];
    for (const { p } of this.#memberships(state, u)) {
      for (const e of p.ledger) { const [title, detail] = describeLedger(e); const cat = ledgerCategory(e.type); rows.push({ projectId: p.id, project: p.title, seq: e.seq, ts: e.ts, type: e.type, category: cat.label, status: ledgerStatus(e.type), title, detail, hash: e.hash, amountKobo: ledgerAmount(e) }); }
    }
    rows.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
    return { rows };
  }
}

const CATS = [
  [/^(project\.|split\.)/, 'Agreement', 'confirmations'], [/^collaborator\./, 'Confirmation', 'confirmations'], [/^(funding\.|charge\.)/, 'Funding', 'funding'],
  [/^milestone\./, 'Approval', 'payouts'], [/^dispute\./, 'Dispute', 'disputes'], [/^(payout\.|transfer\.)/, 'Payout', 'payouts'], [/^refund\./, 'Refund', 'disputes'], [/^demo\./, 'Demo', 'funding'],
];
export function ledgerCategory(type) { for (const [re, label, pref] of CATS) if (re.test(type)) return { label, pref }; return { label: 'Other', pref: 'funding' }; }
export function ledgerStatus(type) {
  if (/(failed|rejected|reversed|declined)$/.test(type) || type === 'funding.rejected') return 'failed';
  if (/(succeeded|success|verified|confirmed|released|completed|approved|auto_released|proposal_accepted|decided)$/.test(type)) return 'success';
  return 'recorded';
}
function ledgerAmount(e) { const d = e.data ?? {}; return Number.isSafeInteger(d.amountKobo) ? d.amountKobo : Number.isSafeInteger(d.paidKobo) ? d.paidKobo : Number.isSafeInteger(d.releaseKobo) ? d.releaseKobo : Number.isSafeInteger(d.totalKobo) ? d.totalKobo : null; }
