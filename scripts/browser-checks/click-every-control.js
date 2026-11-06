const { chromium, firefox, webkit } = require('playwright'); const fs = require('fs');
const U = process.env.BASE || 'http://localhost:4400'; const report = { checked: 0, problems: [], pages: {} };
const post = (u, b) => fetch(U + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const tok = (p) => p.split('/').pop(); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = null; let seq = 0;
/** Sign a fresh user up through the API and remember the session cookie so the next browser context starts logged in. */
async function newUser() {
  const r = await fetch(U + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Crawl User', email: `crawl${Date.now()}${seq++}@example.com`, password: 'crawler passphrase 1' }) });
  const m = /sp_session=([^;]+)/.exec(r.headers.getSetCookie().join(';')); cookie = m[1]; return cookie;
}
const authed = (u, b) => fetch(U + u, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `sp_session=${cookie}`, origin: U }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const withProject = async ({ approve = false, failing = false } = {}) => {
  await newUser(); const L = (await post('/api/demo/stage', { stage: approve ? 'delivered' : 'funded' })).links;
  if (failing) await post('/api/demo/failing-account');
  await authed('/api/me/claim', { token: tok(L.lead) }); if (approve) { await post(`/api/p/${tok(L.client)}/milestones/m1/approve`); await sleep(3500); } return L;
};
const FIX = {
  signup: async () => '/signup', login: async () => '/login', forgot: async () => '/forgot', reset: async () => '/reset/crawler-token-0123456789',
  welcome: async () => { await newUser(); return '/welcome'; },
  'dashboard@empty': async () => { await newUser(); return '/dashboard'; },
  'dashboard@data': async () => { await withProject({ approve: true }); return '/dashboard'; },
  'payouts@data': async () => { await withProject({ approve: true }); return '/payouts'; },
  'payouts@failed': async () => { await withProject({ approve: true, failing: true }); return '/payouts'; },
  'activity@data': async () => { await withProject({ approve: true }); return '/activity'; },
  'settings@empty': async () => { await newUser(); return '/settings'; },
  'settings@saved-bank': async () => { await newUser(); await authed('/api/me/bank', { bankCode: '044', accountNumber: '0123456789' }); return '/settings'; },
  'lead@claim': async () => { await newUser(); const L = (await post('/api/demo/stage', { stage: 'created' })).links; return L.lead; },
  'collab@signed-in': async () => { await newUser(); await authed('/api/me/bank', { bankCode: '044', accountNumber: '0123456789' }); return (await post('/api/demo/stage', { stage: 'created' })).links.collaborators[1].path; },
  'create@people': async () => '/new?step=people', 'create@allocation': async () => '/new?step=allocation', 'create@review': async () => '/new?step=review',
  home: async () => '/', enter: async () => '/enter', create: async () => '/new', demo: async () => '/demo', paid: async () => '/paid', notfound: async () => '/nope/nothing',
  'collab@created': async () => (await post('/api/demo/stage', { stage: 'created' })).links.collaborators[1].path,
  'lead@created': async () => (await post('/api/demo/stage', { stage: 'created' })).links.lead,
  'client@created': async () => (await post('/api/demo/stage', { stage: 'created' })).links.client,
  'client@ready': async () => (await post('/api/demo/stage', { stage: 'ready' })).links.client,
  'lead@funded': async () => (await post('/api/demo/stage', { stage: 'funded' })).links.lead,
  'client@delivered': async () => (await post('/api/demo/stage', { stage: 'delivered' })).links.client,
  'lead@delivered': async () => (await post('/api/demo/stage', { stage: 'delivered' })).links.lead,
  'collab@delivered': async () => (await post('/api/demo/stage', { stage: 'delivered' })).links.collaborators[1].path,
  'client@disputed': async () => (await post('/api/demo/stage', { stage: 'disputed' })).links.client,
  'lead@disputed': async () => (await post('/api/demo/stage', { stage: 'disputed' })).links.lead,
  'reviewer@disputed': async () => (await post('/api/demo/stage', { stage: 'disputed' })).links.reviewer,
  'ledger': async () => (await post('/api/demo/stage', { stage: 'disputed' })).links.ledger,
  'reviewer@in_review': async () => { const L = (await post('/api/demo/stage', { stage: 'disputed' })).links; await post(`/api/p/${tok(L.client)}/milestones/m1/propose`, { kind: 'split', releaseBps: 5000 }); await post(`/api/p/${tok(L.lead)}/milestones/m1/proposals/pr_1/respond`, { accept: false }); await post(`/api/p/${tok(L.lead)}/milestones/m1/escalate`); return L.reviewer; },
  'lead@payout-failed': async () => { const L = (await post('/api/demo/stage', { stage: 'delivered' })).links; await post('/api/demo/failing-account'); await post(`/api/p/${tok(L.client)}/milestones/m1/approve`); await sleep(3500); return L.lead; },
  'receipt': async () => { const L = (await post('/api/demo/stage', { stage: 'delivered' })).links; await post(`/api/p/${tok(L.client)}/milestones/m1/approve`); await sleep(3500); const v = await (await fetch(`${U}/api/p/${tok(L.lead)}`)).json(); const po = v.project.payouts.find((x) => x.status === 'success'); return `/receipt/${tok(L.lead)}/${po.id}`; },
  'checkout': async () => { const L = (await post('/api/demo/stage', { stage: 'ready' })).links; const r = await post(`/api/p/${tok(L.client)}/fund`); return new URL(r.authorizationUrl, U).pathname; },
};
const fx = async (n) => { cookie = null; return FIX[n](); };
const only = process.argv[2] ? process.argv[2].split(',') : Object.keys(FIX);

(async () => {
  const b = await ({ chromium, firefox, webkit }[process.env.BROWSER || 'chromium']).launch();
  for (const name of only) {
    const page$ = { elements: 0, noEffect: [], errors: [], badLinks: [] };
    report.pages[name] = page$;
    const open = async () => { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); if (cookie) await ctx.addCookies([{ name: 'sp_session', value: cookie, url: U }]); const p = await ctx.newPage(); const errs = []; let reqs = 0; let popups = 0; let dialogs = 0;
      p.on('pageerror', (e) => errs.push('pageerror: ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/TUNNEL|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
      p.on('response', (r) => { if (r.url().startsWith(U + '/api/') && r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url().replace(U, '')}`); });
      p.on('request', (r) => { if (r.url().startsWith(U + '/api/') && r.method() === 'POST') reqs++; }); p.on('popup', () => popups++); p.on('dialog', (d) => { dialogs++; d.accept(); });
      return { ctx, p, errs, get reqs() { return reqs; }, get popups() { return popups; }, get dialogs() { return dialogs; } }; };
    // first pass: enumerate
    let path = await fx(name); let s = await open(); await s.p.goto(U + path); await s.p.waitForTimeout(name === 'home' ? 4200 : 2300);
    const sel = 'a[href]:not(.skip), button, summary, [role=button], input[type=checkbox], select';
    const list = await s.p.evaluate((sel) => [...document.querySelectorAll(sel)].map((e, i) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); const vis = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[hidden]'); const label = (e.getAttribute('aria-label') || e.textContent || e.value || e.id || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 40); return { i, vis, label, tag: e.tagName, href: e.getAttribute('href'), disabled: e.disabled === true, pressed: e.getAttribute('aria-pressed') === 'true', type: e.type, hasName: !!((e.getAttribute('aria-label') || e.textContent || '').trim() || e.getAttribute('title') || e.labels?.length) }; }), sel);
    page$.elements = list.filter((x) => x.vis).length; report.errors = report.errors || [];
    for (const el of list) { if (el.vis && !el.hasName) page$.noEffect.push(`NO ACCESSIBLE NAME: <${el.tag}> #${el.i}`); }
    // link health
    for (const el of list.filter((x) => x.vis && x.tag === 'A' && x.href && x.href.startsWith('/') && !x.href.startsWith('/#'))) { const code = (await fetch(U + el.href.split('#')[0])).status; if (code >= 400) page$.badLinks.push(`${el.href} -> ${code}`); }
    page$.errors.push(...s.errs); await s.ctx.close();
    // second pass: click each visible control on fresh data
    for (const el of list.filter((x) => x.vis)) {
      report.checked++;
      if (el.disabled || el.pressed) { continue; } // a toggle that is already selected has nothing left to do
      path = await fx(name); s = await open(); const p = s.p;
      try {
        await p.goto(U + path); await p.waitForTimeout(name === 'home' ? 4200 : 2000);
        await p.evaluate(() => { window.__m = 0; const main = document.querySelector('main'); new MutationObserver((ms) => { for (const m of ms) if (!(m.target.closest && m.target.closest('svg')) && !(m.target.nodeType === 1 && m.target.namespaceURI.includes('svg'))) window.__m++; }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); });
        const h = (await p.$$(sel))[el.i]; if (!h) { page$.noEffect.push(`ELEMENT GONE before click: ${el.label}`); await s.ctx.close(); continue; }
        await h.evaluate((e) => { const d = e.closest('details'); if (d) d.open = true; }); // controls inside a collapsed <details> are opened first, as a person would
        const before = await p.evaluate(() => ({ y: scrollY, url: location.href, toasts: document.querySelectorAll('.toast').length, m: window.__m }));
        const baseNoise = await (async () => { const a = await p.evaluate(() => window.__m); await p.waitForTimeout(350); return (await p.evaluate(() => window.__m)) - a; })();
        const r0 = s.reqs; const pop0 = s.popups; const dlg0 = s.dialogs;
        await h.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await h.click({ timeout: 4000, force: false }).catch(async (e) => { page$.noEffect.push(`CLICK FAILED (${/intercept|not visible|outside/.test(e.message) ? 'covered or hidden' : 'error'}): "${el.label}"`); });
        await p.waitForTimeout(900);
        const after = await p.evaluate(() => ({ y: scrollY, url: location.href, toasts: document.querySelectorAll('.toast').length, m: window.__m })).catch(() => null);
        if (after) { const changed = after.url !== before.url || after.toasts !== before.toasts || Math.abs(after.y - before.y) > 5 || s.reqs > r0 || s.popups > pop0 || s.dialogs > dlg0 || (after.m - before.m) > baseNoise + 0; const samePage = el.href && el.href.split('#')[0] === new URL(before.url).pathname + new URL(before.url).search; if (!changed && !samePage && !(el.tag === 'INPUT' || el.tag === 'SELECT')) page$.noEffect.push(`NO VISIBLE EFFECT: ${el.tag} "${el.label}"${el.href ? ' -> ' + el.href : ''}`); }
        page$.errors.push(...s.errs.map((e) => `after clicking "${el.label}": ${e}`));
      } catch (e) { page$.errors.push(`crawler: ${el.label}: ${e.message.slice(0, 100)}`); }
      await s.ctx.close();
    }
    const n = page$.noEffect.length + page$.errors.length + page$.badLinks.length; console.log(`${name.padEnd(20)} controls ${String(page$.elements).padStart(3)}  problems ${n}`); for (const x of [...page$.noEffect, ...page$.errors, ...page$.badLinks]) console.log('    - ' + x);
    fs.writeFileSync(require('path').join(process.env.SHOTS || require('os').tmpdir(), `crawl-${process.env.TAG||'x'}.json`), JSON.stringify(report, null, 1));
  }
  await b.close(); console.log('\nTOTAL controls tested:', report.checked);
})();
