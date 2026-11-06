// Judge Mode: seeded scenario + demo controls.
//
// Every jump goes through the SAME engine commands a real user would trigger (confirm share,
// fund via signed webhook, submit delivery, open dispute). Nothing here writes "funded" or
// "paid" directly. Only demo mode, and only with the mock provider.
//
// All seeded names, accounts and links are SYNTHETIC DEMO DATA.

import { AuthError, NotFoundError, StateError, ValidationError } from '../shared/errors.js';
import { newToken, tokenKey, own, HOUR } from './helpers.js';
import { mockInitialState } from '../providers/mock.js';

const SEED_ACCOUNTS = [
  { name: 'Director', role: 'Lead', bps: 4000, bankCode: '044', accountNumber: '1000000001', holder: 'SYNTHETIC DIRECTOR (DEMO ACCOUNT)' },
  { name: 'Editor', role: 'Collaborator', bps: 2500, bankCode: '058', accountNumber: '1000000002', holder: 'SYNTHETIC EDITOR (DEMO ACCOUNT)' },
  { name: 'Camera', role: 'Collaborator', bps: 2000, bankCode: '057', accountNumber: '1000000003', holder: 'SYNTHETIC CAMERA (DEMO ACCOUNT)' },
  { name: 'Sound', role: 'Collaborator', bps: 1500, bankCode: '50211', accountNumber: '1000000004', holder: 'SYNTHETIC SOUND (DEMO ACCOUNT)' },
];

export const FAILING_SEED = { bankCode: '50211', bankName: 'Kuda Microfinance Bank', accountNumber: '0000000404', holder: 'SYNTHETIC SOUND (FAILING TEST ACCOUNT)' };

const seedInput = () => ({
  title: 'Music video: "Lagos After Dark" (SYNTHETIC DEMO)',
  clientName: 'Client Studio (synthetic)',
  collaborators: SEED_ACCOUNTS.map((a, i) => ({ name: a.name, role: a.role, bps: a.bps, ...(i === 0 ? { bankCode: a.bankCode, accountNumber: a.accountNumber } : {}) })),
  milestones: [
    { title: 'Rough cut', amountKobo: 40_000_000, criteria: ['At most three minutes.', 'All shot-list scenes included.'] },
    { title: 'Final edit', amountKobo: 60_000_000, criteria: ['Three to four minutes.', 'Two revision rounds included.', 'Delivered as 1080p MP4.'] },
  ],
});

export const STAGES = ['created', 'ready', 'funded', 'delivered', 'disputed'];

export class Demo {
  #engine;
  constructor(engine) { this.#engine = engine; }

  #guard() {
    if (!this.#engine.config.demoMode) throw new AuthError('DEMO_DISABLED', 'Judge Mode is disabled on this server.', 403);
    if (!this.#engine.provider.isMock) throw new ValidationError('DEMO_NEEDS_MOCK', 'Judge Mode only runs with PAYMENT_PROVIDER=mock.');
  }

  #info() {
    const demo = this.#engine.store.read((s) => s.demo);
    if (!demo) throw new NotFoundError('DEMO_NOT_SEEDED', 'The demo scenario has not been created yet. Use "Reset seeded scenario".');
    return demo;
  }

  /** Create the demo project in the requested stage. `fresh` also issues brand-new links. */
  async stage(stage, { fresh = false } = {}) {
    this.#guard();
    if (!STAGES.includes(stage)) throw new ValidationError('DEMO_STAGE_INVALID', `Unknown stage "${stage}".`);
    const eng = this.#engine;
    const prev = eng.store.read((s) => s.demo);
    const tokens = !fresh && prev ? prev.tokens : { lead: newToken(), client: newToken(), reviewer: newToken(), collaborators: SEED_ACCOUNTS.map(() => newToken()), publicId: `ldemo${newToken().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}` };

    // 1) remove the previous demo project and everything indexed to it
    await eng.store.transact((draft) => {
      if (draft.demo?.projectId) {
        const old = own(draft.projects, draft.demo.projectId);
        if (old) {
          delete draft.publicIndex[old.publicId];
          for (const t of [old.access.lead, old.access.client, old.access.reviewer, ...Object.values(old.access.collaborators)]) delete draft.tokenIndex[tokenKey(t)];
          for (const [ref, loc] of Object.entries(draft.refIndex)) if (loc.projectId === old.id) delete draft.refIndex[ref];
          delete draft.projects[old.id];
        }
      }
      draft.clock.offsetMs = 0;
      if (draft.mock) draft.mock = { ...mockInitialState(), secret: draft.mock.secret, names: draft.mock.names };
      draft.demo = { tokens, projectId: null };
    });

    // 2) seed through the real create path
    for (const a of SEED_ACCOUNTS) await eng.provider.registerName(a.accountNumber, a.holder);
    const { projectId } = await eng.createProject(seedInput(), { origin: 'seed', tokens });
    await eng.store.transact((draft) => { draft.demo.projectId = projectId; });

    // 3) walk forward using real commands
    const idx = STAGES.indexOf(stage);
    if (idx >= 1) await this.#confirmAll(tokens);
    if (idx >= 2) await this.#fund(tokens);
    if (idx >= 3) await eng.submitDelivery(tokens.lead, 'm1', { link: 'https://example.com/synthetic/rough-cut-v1', note: 'Rough cut v1: 2m 41s, all shot-list scenes included. Synthetic demo delivery.' });
    if (stage === 'disputed') {
      await eng.submitDelivery(tokens.lead, 'm2', { link: 'https://example.com/synthetic/final-edit-v1', note: 'Final edit v1: 3m 30s, 1080p MP4, two revision rounds used. Synthetic demo delivery.' });
      await eng.openDispute(tokens.client, 'm1', { unmetCriteria: [1], reason: 'Two scenes from the shot list are missing from the rough cut. Synthetic demo dispute.' });
    }
    return this.links();
  }

  async #confirmAll(tokens) {
    for (let i = 0; i < SEED_ACCOUNTS.length; i += 1) {
      const a = SEED_ACCOUNTS[i];
      await this.#engine.confirmShare(tokens.collaborators[i], { accept: true, bankCode: a.bankCode, accountNumber: a.accountNumber });
    }
  }

  /** Real pathway: initialise charge -> simulated checkout -> SIGNED webhook -> signature check -> server-side verify. */
  async #fund(tokens) {
    const eng = this.#engine;
    const { reference } = await eng.startFunding(tokens.client);
    const { webhook } = await eng.provider.completeCheckout(reference, { outcome: 'success' });
    const { done } = await eng.handleWebhook(webhook.rawBody, webhook.headers);
    await done;
  }

  async fastForward(hours) {
    this.#guard();
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 1 || h > 240) throw new ValidationError('DEMO_HOURS_INVALID', 'Choose between 1 and 240 hours.');
    const { projectId } = this.#info();
    const ms = Math.round(h) * HOUR;
    const offsetMs = await this.#engine.recordDemoEvent(projectId, 'demo.clock_advanced', { hours: Math.round(h), note: 'Judge Mode moved the demo clock forward. Real time is unchanged.' }, (_p, draft) => {
      draft.clock.offsetMs += ms;
      return draft.clock.offsetMs;
    });
    await this.#engine.tick();
    return { offsetMs, advancedHours: Math.round(h) };
  }

  async tamper() {
    this.#guard();
    const { projectId } = this.#info();
    const eng = this.#engine;
    return eng.store.transact((draft) => {
      const p = own(draft.projects, projectId);
      if (p.demoTamper) throw new StateError('ALREADY_TAMPERED', 'An entry is already tampered with. Restore it first.');
      if (p.ledger.length < 2) throw new StateError('LEDGER_TOO_SHORT', 'The ledger needs at least two entries before it can be tampered with.');
      const seq = Math.min(p.ledger.length, Math.max(2, Math.ceil(p.ledger.length / 2)));
      const entry = p.ledger[seq - 1];
      p.demoTamper = { seq, original: structuredClone(entry) };
      entry.data = { ...entry.data, tamperedByJudgeMode: 1 };
      return { tamperedEntry: seq };
    });
  }

  async restore() {
    this.#guard();
    const { projectId } = this.#info();
    return this.#engine.store.transact((draft) => {
      const p = own(draft.projects, projectId);
      if (!p.demoTamper) throw new StateError('NOT_TAMPERED', 'No entry is currently tampered with.');
      p.ledger[p.demoTamper.seq - 1] = p.demoTamper.original;
      const seq = p.demoTamper.seq;
      p.demoTamper = null;
      return { restoredEntry: seq };
    });
  }

  /** Point Sound at the designated failing test account so the failed-payout + retry path can be shown. */
  async useFailingAccount() {
    this.#guard();
    const { projectId } = this.#info();
    const eng = this.#engine;
    await eng.provider.registerName(FAILING_SEED.accountNumber, FAILING_SEED.holder);
    await eng.provider.resetFailureMemory();
    await eng.recordDemoEvent(projectId, 'demo.failing_account_set', { collaborator: 'Sound', note: 'Judge Mode pointed Sound at the designated failing test account (fails once, then succeeds on retry).' }, (p) => {
      const c = p.collaborators.find((x) => x.name === 'Sound');
      if (Object.values(p.payouts).some((po) => po.collaboratorId === c.id && po.status !== 'queued')) {
        throw new StateError('DEMO_TOO_LATE', 'Sound has already been through a payout. Use "Jump to funded" first.');
      }
      c.bank = { bankCode: FAILING_SEED.bankCode, bankName: FAILING_SEED.bankName, accountNumber: FAILING_SEED.accountNumber, accountName: FAILING_SEED.holder };
      c.recipientCode = null;
    });
    return { ok: true };
  }

  links() {
    this.#guard();
    const demo = this.#info();
    const p = this.#engine.store.read((s) => own(s.projects, demo.projectId));
    if (!p) throw new NotFoundError('DEMO_NOT_SEEDED', 'The demo scenario has not been created yet.');
    return {
      projectId: p.id, title: p.title, status: p.status, offsetHours: this.#engine.store.read((s) => Math.round(s.clock.offsetMs / HOUR)),
      tampered: !!p.demoTamper,
      links: {
        lead: `/p/lead/${p.access.lead}`, client: `/p/client/${p.access.client}`, reviewer: `/p/reviewer/${p.access.reviewer}`, ledger: `/ledger/${p.publicId}`,
        collaborators: p.collaborators.map((c) => ({ id: c.id, name: c.name, role: c.role, path: `/p/collab/${p.access.collaborators[c.id]}` })),
      },
    };
  }
}
