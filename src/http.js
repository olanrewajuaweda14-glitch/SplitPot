// HTTP layer: config, routing, static files, rate limits, security headers.
// No dependencies. All business rules live in the engine; this file only translates.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './storage/jsonStore.js';
import { createProvider } from './providers/index.js';
import { Engine, initialState } from './engine/engine.js';
import { Demo } from './engine/demo.js';
import { Accounts } from './engine/accounts.js';
import { own } from './engine/helpers.js';
import { SplitPotError, ValidationError, NotFoundError, RateLimitError, AuthError, SignatureError } from './shared/errors.js';
import { DEFAULT_FEE_BPS } from './shared/money.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'src', 'shared');

export function loadConfig(env = process.env) {
  const provider = String(env.PAYMENT_PROVIDER ?? 'mock').toLowerCase();
  const port = Number(env.PORT ?? 3000);
  let demoMode = env.DEMO_MODE !== undefined ? ['1', 'true', 'yes'].includes(String(env.DEMO_MODE).toLowerCase()) : provider === 'mock';
  if (provider !== 'mock' && demoMode) {
    console.warn('[config] Judge Mode needs PAYMENT_PROVIDER=mock. Disabling it.');
    demoMode = false;
  }
  const dataFile = env.DATA_FILE === ':memory:' ? null : path.resolve(env.DATA_FILE ?? path.join(ROOT, 'data', 'splitpot.json'));
  return {
    provider, port, host: env.HOST ?? '0.0.0.0', demoMode, dataFile,
    paystackSecretKey: env.PAYSTACK_SECRET_KEY ?? '',
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    feeBps: Number(env.FEE_BPS ?? DEFAULT_FEE_BPS),
    trustProxy: env.TRUST_PROXY === '1',
    tickMs: Number(env.TICK_MS ?? 4000),
  };
}

export function createApp(env = process.env, overrides = {}) {
  const config = loadConfig(env);
  const store = new JsonStore({ file: config.dataFile, initial: () => initialState({ mock: config.provider === 'mock' }) });
  const provider = createProvider({ kind: config.provider, store, secretKey: config.paystackSecretKey, baseUrl: () => '' });
  const engine = new Engine({ store, provider, config: { demoMode: config.demoMode, feeBps: config.feeBps, publicBaseUrl: config.publicBaseUrl }, baseNow: overrides.baseNow });
  const demo = new Demo(engine);
  const accounts = new Accounts({ store, engine, baseNow: overrides.baseNow });
  const app = { config, store, provider, engine, demo, accounts, port: config.port, server: null, timer: null };
  app.handler = createHandler(app);
  app.listen = (port = config.port) => new Promise((resolve, reject) => {
    app.server = http.createServer(app.handler);
    app.server.requestTimeout = 30_000;
    app.server.once('error', reject);
    app.server.listen(port, config.host, () => {
      app.server.removeListener('error', reject);
      app.port = app.server.address().port;
      if (config.tickMs > 0) app.timer = setInterval(() => engine.tick().catch((e) => console.error('[tick]', e?.code ?? e?.message)), config.tickMs).unref();
      resolve(app);
    });
  });
  app.close = async () => { await engine.idle(); return new Promise((resolve) => { clearInterval(app.timer); app.server ? app.server.close(() => resolve()) : resolve(); app.server?.closeAllConnections?.(); }); };
  return app;
}

// ---------------------------------------------------------------- helpers

class Limiter {
  #m = new Map();
  disabled = false; // only ever set by TEST_RELAX_LIMITS in demo mode, so the browser crawler can create hundreds of throwaway users
  constructor() { setInterval(() => { const n = Date.now(); for (const [k, v] of this.#m) if (n > v.reset) this.#m.delete(k); }, 60_000).unref(); }
  hit(key, limit, windowMs) {
    if (this.disabled) return;
    const now = Date.now();
    let e = this.#m.get(key);
    if (!e || now > e.reset) { e = { n: 0, reset: now + windowMs }; this.#m.set(key, e); }
    e.n += 1;
    if (e.n > limit) throw new RateLimitError();
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
].join('; ');

function baseHeaders() {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', // capability links live in URLs: never leak them via Referer
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...baseHeaders(), ...headers });
  res.end(body);
}
const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

const COOKIE = 'sp_session';
const readCookie = (req, name) => { for (const part of String(req.headers.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); } return null; };
const setCookie = (token, secure, maxAgeS = 14 * 24 * 3600) => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
const clearCookie = (secure) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;

const tooLarge = () => Object.assign(new ValidationError('BODY_TOO_LARGE', 'Request body is too large.'), { closeConnection: true });

async function readRaw(req, limit) {
  // Reject on the declared size before reading anything, and again while streaming (chunked bodies).
  if (Number(req.headers['content-length']) > limit) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw tooLarge();
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 64 * 1024) {
  const raw = await readRaw(req, limit);
  if (raw.length === 0) return {};
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new ValidationError('CONTENT_TYPE', 'Send JSON with Content-Type: application/json.');
  try {
    const v = JSON.parse(raw.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new ValidationError('JSON_INVALID', 'The request body is not valid JSON.');
  }
}

function compile(pattern) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  return { re, keys };
}

// ---------------------------------------------------------------- handler

export function createHandler(app) {
  const { engine, demo, provider, config, accounts } = app;
  const limiter = new Limiter();
  if (config.demoMode && ['1', 'true'].includes(String(process.env.TEST_RELAX_LIMITS ?? ''))) { limiter.disabled = true; config.limitsRelaxed = true; }
  const routes = [];
  const add = (method, pattern, fn) => routes.push({ method, ...compile(pattern), fn });

  // --- meta
  add('GET', '/healthz', async () => ({ ok: true }));
  add('GET', '/api/config', async () => ({
    provider: { name: provider.name, isMock: !!provider.isMock }, demoMode: config.demoMode, feeBps: config.feeBps,
    banks: await engine.listBanks(),
    labels: { banner: 'Prototype in test mode. No real money moves.', simulated: ['Real-money custody', 'Identity verification', 'Dispute reviewer', 'Client refunds'] },
  }));

  // --- projects
  add('POST', '/api/projects', async ({ req, body, ip }) => {
    limiter.hit(`create:${ip}`, 12, 3_600_000);
    const u = accounts.optional(sessionOf(req));
    return engine.createProject(body, { origin: 'user', ownerUserId: u?.id ?? null });
  });

  // --- accounts (a convenience layer; project links still work without one)
  const secure = config.publicBaseUrl.startsWith('https://');
  const sessionOf = (req) => readCookie(req, COOKIE);
  const need = (req) => { const tok = sessionOf(req); if (!tok) throw new AuthError('NOT_SIGNED_IN', 'Log in to continue.', 401); return tok; };
  add('POST', '/api/auth/signup', async ({ body, ip, res }) => {
    limiter.hit(`signup:${ip}`, 10, 3_600_000);
    const r = await accounts.signup(body);
    res.setHeader('Set-Cookie', setCookie(r.token, secure));
    return { user: r.user };
  });
  add('POST', '/api/auth/login', async ({ body, ip, res }) => {
    limiter.hit(`login:${ip}`, 20, 60_000);
    limiter.hit(`login:${String(body.email ?? '').toLowerCase().slice(0, 120)}`, 8, 300_000);
    const r = await accounts.login(body);
    res.setHeader('Set-Cookie', setCookie(r.token, secure));
    return { user: r.user };
  });
  add('POST', '/api/auth/logout', async ({ req, res }) => { await accounts.logout(sessionOf(req)); res.setHeader('Set-Cookie', clearCookie(secure)); return { ok: true }; });
  add('GET', '/api/auth/me', async ({ req }) => { const u = accounts.optional(sessionOf(req)); return { user: u ? accounts.me(sessionOf(req)) : null }; });
  add('POST', '/api/auth/forgot', async ({ body, ip }) => { limiter.hit(`forgot:${ip}`, 6, 3_600_000); return accounts.requestReset(body); });
  add('POST', '/api/auth/reset', async ({ body, ip }) => { limiter.hit(`reset:${ip}`, 10, 3_600_000); return accounts.resetPassword(body); });
  add('POST', '/api/me/profile', ({ req, body }) => accounts.updateProfile(need(req), body));
  add('POST', '/api/me/prefs', ({ req, body }) => accounts.updatePrefs(need(req), body));
  add('POST', '/api/me/bank', ({ req, body, ip }) => { limiter.hit(`bank:${ip}`, 30, 60_000); return accounts.setDefaultBank(need(req), body); });
  add('POST', '/api/me/resolve-account', ({ req, body, ip }) => { limiter.hit(`resolve:${ip}`, 40, 60_000); return accounts.resolveAccount(need(req), body); });
  add('POST', '/api/me/bank/clear', ({ req }) => accounts.clearDefaultBank(need(req)));
  add('POST', '/api/me/password', async ({ req, body, res }) => { const r = await accounts.changePassword(need(req), body); return r; });
  add('POST', '/api/me/logout-all', async ({ req, res }) => { const r = await accounts.logoutEverywhere(need(req)); res.setHeader('Set-Cookie', clearCookie(secure)); return r; });
  add('POST', '/api/me/claim', ({ req, body }) => accounts.claim(need(req), String(body.token ?? '')));
  add('POST', '/api/me/unclaim', ({ req, body }) => accounts.unclaim(need(req), String(body.projectId ?? '')));
  add('GET', '/api/me/dashboard', ({ req }) => accounts.dashboard(need(req)));
  add('GET', '/api/me/payouts', ({ req }) => accounts.payouts(need(req)));
  add('GET', '/api/me/ledger', ({ req }) => accounts.ledger(need(req)));

  // --- role-scoped reads and commands
  add('GET', '/api/p/:token', async ({ params, req, res }) => {
    const tag = `W/"${engine.viewTag(params.token)}"`;
    if (req.headers['if-none-match'] === tag) { send(res, 304, '', { ETag: tag, 'Cache-Control': 'no-store' }); return undefined; }
    const view = await engine.view(params.token);
    json(res, 200, view, { ETag: `W/"${engine.viewTag(params.token)}"` });
    return undefined;
  });
  add('POST', '/api/p/:token/resolve-account', async ({ params, body, ip }) => { limiter.hit(`resolve:${ip}`, 40, 60_000); return engine.resolveAccount(params.token, body); });
  add('POST', '/api/p/:token/confirm', ({ req, params, body }) => {
    if (body.useSavedAccount === true) { // the full saved account number never leaves the server
      const u = accounts.optional(sessionOf(req));
      if (!u?.defaultBank) throw new ValidationError('NO_SAVED_ACCOUNT', 'You have no saved payout account. Add one in Settings, or type your account here.');
      body = { ...body, bankCode: u.defaultBank.bankCode, accountNumber: u.defaultBank.accountNumber };
    }
    return engine.confirmShare(params.token, body);
  });
  add('POST', '/api/p/:token/decline', ({ params, body }) => engine.declineShare(params.token, body));
  add('POST', '/api/p/:token/revise-split', ({ params, body }) => engine.reviseSplit(params.token, body));
  add('POST', '/api/p/:token/fund', ({ params }) => engine.startFunding(params.token));
  add('POST', '/api/p/:token/milestones/:mid/deliver', ({ params, body }) => engine.submitDelivery(params.token, params.mid, body));
  add('POST', '/api/p/:token/milestones/:mid/approve', ({ params }) => engine.approveMilestone(params.token, params.mid));
  add('POST', '/api/p/:token/milestones/:mid/dispute', ({ params, body }) => engine.openDispute(params.token, params.mid, body));
  add('POST', '/api/p/:token/milestones/:mid/propose', ({ params, body }) => engine.proposeResolution(params.token, params.mid, body));
  add('POST', '/api/p/:token/milestones/:mid/escalate', ({ params }) => engine.escalateDispute(params.token, params.mid));
  add('POST', '/api/p/:token/milestones/:mid/proposals/:pid/respond', ({ params, body }) => engine.respondToProposal(params.token, params.mid, params.pid, body));
  add('POST', '/api/p/:token/milestones/:mid/review', ({ params, body }) => engine.reviewerDecide(params.token, params.mid, body));
  add('POST', '/api/p/:token/payouts/:pid/retry', ({ params }) => engine.retryPayout(params.token, params.pid));
  add('GET', '/api/p/:token/receipts/:pid', ({ params }) => engine.receipt(params.token, params.pid));
  add('GET', '/api/ledger/:publicId', ({ params }) => engine.publicLedger(params.publicId));

  // --- provider webhook (raw body; signature verified before anything is recorded)
  add('POST', '/api/webhooks/payment', async ({ req, res }) => {
    const raw = await readRaw(req, 256 * 1024);
    try {
      const { ack } = await engine.handleWebhook(raw, req.headers);
      json(res, 200, ack); // acknowledged as soon as the event is durably recorded; processing continues
    } catch (err) {
      if (err instanceof SignatureError) { json(res, 401, err.toJSON()); return undefined; }
      throw err;
    }
    return undefined;
  });

  // --- simulated checkout (mock provider only)
  const needMock = () => { if (!provider.isMock) throw new NotFoundError('NOT_FOUND', 'Not found.'); };
  add('GET', '/api/mock/checkout/:ref', async ({ params }) => {
    needMock();
    const c = await provider.getCharge(params.ref);
    if (!c) throw new NotFoundError('CHARGE_NOT_FOUND', 'No simulated charge with that reference.');
    const loc = engine.store.read((s) => own(s.refIndex, params.ref));
    const p = loc && engine.store.read((s) => own(s.projects, loc.projectId));
    return { reference: c.reference, amountKobo: c.amountKobo, currency: c.currency, status: c.status, projectTitle: p?.title ?? 'Project', clientName: p?.clientName ?? '', demoMode: config.demoMode, simulated: true };
  });
  add('POST', '/api/mock/checkout/:ref/complete', async ({ params, body, ip }) => {
    needMock();
    limiter.hit(`checkout:${ip}`, 30, 60_000);
    const outcome = body.outcome === 'failed' ? 'failed' : 'success';
    const opts = { outcome };
    if (config.demoMode) { // underpay / wrong currency exist only to demonstrate that verification rejects them
      if (Number.isSafeInteger(body.shortfallKobo) && body.shortfallKobo > 0) opts.shortfallKobo = body.shortfallKobo;
      if (typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency)) opts.currency = body.currency;
    }
    const { webhook, charge } = await provider.completeCheckout(params.ref, opts);
    if (!webhook) return { delivered: false, status: charge.status, note: 'This simulated payment was already completed.' };
    // Deliver the signed webhook over real HTTP, exactly as a provider would.
    const r = await fetch(`http://127.0.0.1:${app.port}/api/webhooks/payment`, { method: 'POST', headers: webhook.headers, body: webhook.rawBody });
    return { delivered: r.ok, webhookStatus: r.status, status: charge.status };
  });

  // --- Judge Mode (demo only)
  const needDemo = () => { if (!config.demoMode) throw new NotFoundError('NOT_FOUND', 'Not found.'); };
  add('GET', '/api/demo/state', async () => { needDemo(); try { return demo.links(); } catch (e) { if (e.code === 'DEMO_NOT_SEEDED') return { seeded: false }; throw e; } });
  add('POST', '/api/demo/stage', async ({ body, ip }) => { needDemo(); limiter.hit(`demo:${ip}`, 60, 60_000); return demo.stage(String(body.stage), { fresh: body.fresh === true }); });
  add('POST', '/api/demo/fast-forward', async ({ body }) => { needDemo(); return demo.fastForward(body.hours); });
  add('POST', '/api/demo/tamper', async () => { needDemo(); return demo.tamper(); });
  add('POST', '/api/demo/restore', async () => { needDemo(); return demo.restore(); });
  add('POST', '/api/demo/failing-account', async () => { needDemo(); return demo.useFailingAccount(); });

  // --- static
  async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    let base = PUBLIC_DIR;
    if (rel.startsWith('/shared/')) { base = SHARED_DIR; rel = rel.slice('/shared'.length); }
    const full = path.normalize(path.join(base, rel));
    if (full !== base && !full.startsWith(base + path.sep)) return send(res, 400, 'Bad path');
    let file = full;
    let stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (stat?.isDirectory()) { file = path.join(file, 'index.html'); stat = fs.existsSync(file) ? fs.statSync(file) : null; }
    if (!stat) {
      if (path.extname(rel) && !rel.endsWith('.html')) return send(res, 404, 'Not found');
      file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
      stat = fs.statSync(file);
    }
    const isHtml = file.endsWith('.html');
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const headers = { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', ETag: etag, 'Cache-Control': isHtml ? 'no-store' : 'no-cache' };
    if (req.headers['if-none-match'] === etag && !isHtml) return send(res, 304, '', headers);
    return send(res, 200, req.method === 'HEAD' ? '' : fs.readFileSync(file), headers);
  }

  return async function handler(req, res) {
    const ip = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const isApi = pathname.startsWith('/api/') || pathname === '/healthz';
      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
        return await serveStatic(req, res, pathname);
      }
      limiter.hit(`api:${ip}`, 600, 60_000);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        if (req.method === 'POST' && req.headers.origin && sessionOf(req) && !pathname.startsWith('/api/webhooks/')) {
          let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { ok = false; }
          if (!ok) throw new AuthError('ORIGIN_MISMATCH', 'This request came from a different site, so it was blocked.', 403);
        }
        const needsBody = req.method === 'POST' && !pathname.startsWith('/api/webhooks/');
        const body = needsBody ? await readJson(req) : {};
        const out = await r.fn({ req, res, params, body, ip, query: url.searchParams });
        if (out !== undefined && !res.writableEnded) json(res, 200, out);
        return undefined;
      }
      return json(res, 404, new NotFoundError('NOT_FOUND', 'No such endpoint.').toJSON());
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) { try { limiter.hit(`authfail:${ip}`, 30, 60_000); } catch { return json(res, 429, new RateLimitError().toJSON()); } }
      if (err instanceof SplitPotError) {
        if (err.closeConnection) { // unread body bytes would corrupt the next request on a kept-alive socket
          res.once('finish', () => req.socket.destroy());
          return json(res, err.status, err.toJSON(), { Connection: 'close' });
        }
        return json(res, err.status, err.toJSON());
      }
      console.error('[http] unexpected error:', err);
      return json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Nothing was changed.' } });
    }
  };
}
