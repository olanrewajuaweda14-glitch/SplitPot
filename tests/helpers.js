// Shared test fixtures. Every test gets a fresh in-memory app and a clock it controls.

import { createApp } from '../src/http.js';
import { HOUR } from '../src/engine/helpers.js';

export const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

export function makeApp(extraEnv = {}) {
  const clock = { t: T0 };
  const app = createApp(
    { PAYMENT_PROVIDER: 'mock', DATA_FILE: ':memory:', DEMO_MODE: '1', TICK_MS: '0', ...extraEnv },
    { baseNow: () => clock.t },
  );
  app.clock = clock;
  return app;
}

/** Move the clock like Judge Mode does (both the real-time stub and the demo offset are fine; we use the stub). */
export const advance = (app, hours) => { app.clock.t += hours * HOUR; };

export const tokenOf = (path) => path.split('/').pop();

/** The seeded music-video scenario at a given stage, via the real engine commands. Returns tokens + project id. */
export async function seeded(app, stage = 'created') {
  const out = await app.demo.stage(stage);
  await app.engine.idle();
  return {
    projectId: out.projectId,
    lead: tokenOf(out.links.lead),
    client: tokenOf(out.links.client),
    reviewer: tokenOf(out.links.reviewer),
    collabs: out.links.collaborators.map((c) => tokenOf(c.path)),
    publicId: tokenOf(out.links.ledger),
  };
}

export const project = (app, id) => app.store.snapshot().projects[id];

/** Assert a promise rejects with a typed error carrying the given code. */
export async function rejectsWith(assert, promiseOrFn, code) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    assert.equal(err.code, code, `expected error code ${code} but got ${err.code}: ${err.message}`);
    assert.ok(typeof err.message === 'string' && err.message.length > 10, 'error should carry an understandable message');
    return err;
  }
  assert.fail(`expected a rejection with code ${code}, but the call succeeded`);
  return null;
}

/** A tiny deterministic PRNG so property tests are reproducible. */
export function prng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A non-demo, user-style project with awkward numbers (33.34 / 33.33 / 33.33 and odd kobo amounts). */
export async function userProject(app, { confirm = true } = {}) {
  const input = {
    title: 'Wedding film', clientName: 'Test Client', clientEmail: 'client@example.com',
    collaborators: [
      { name: 'Lead', role: 'Lead', bps: 3334, bankCode: '044', accountNumber: '2000000001' },
      { name: 'Second', role: 'Collaborator', bps: 3333 },
      { name: 'Third', role: 'Collaborator', bps: 3333 },
    ],
    milestones: [
      { title: 'Ceremony edit', amountKobo: 100_001, criteria: ['Includes the vows.'] },
      { title: 'Highlights reel', amountKobo: 250_007, criteria: ['Under five minutes.', 'Colour graded.'] },
    ],
  };
  const out = await app.engine.createProject(input);
  const t = (p) => p.split('/').pop();
  const tokens = { projectId: out.projectId, lead: t(out.links.lead), client: t(out.links.client), reviewer: t(out.links.reviewer), collabs: out.links.collaborators.map((c) => t(c.path)), publicId: t(out.links.ledger) };
  if (confirm) {
    const banks = [['044', '2000000001'], ['058', '2000000002'], ['057', '2000000003']];
    for (let i = 0; i < 3; i += 1) await app.engine.confirmShare(tokens.collabs[i], { accept: true, bankCode: banks[i][0], accountNumber: banks[i][1] });
  }
  return tokens;
}

/** Fund a project through the real pathway: charge -> simulated checkout -> signed webhook -> server-side verify. */
export async function fundIt(app, client, opts = {}) {
  const { reference } = await app.engine.startFunding(client);
  const { webhook } = await app.provider.completeCheckout(reference, opts);
  const r = await app.engine.handleWebhook(webhook.rawBody, webhook.headers);
  await r.done;
  return { reference, webhook, ...r };
}
