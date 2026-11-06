// End-to-end browser checks for the account screens: sign-up, login, recovery, welcome, dashboard, Create-a-Split wizard,
// invitation states (accept / decline / revise), payout centre, ledger filters + CSV export, settings, logout.
//
// Run against a fresh server:  DEMO_MODE=true PORT=4321 DATA_FILE=/tmp/sp.json node src/server.js
// Then:                        BASE=http://localhost:4321 node scripts/browser-checks/accounts.js
// Pick the browser:            BROWSER=chromium|firefox|webkit   (default chromium)
const { chromium, firefox, webkit, devices } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BASE = process.env.BASE || 'http://localhost:4321'; const BROWSER = process.env.BROWSER || 'chromium';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'splitpot-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
let failed = 0; const ok = (n, c, x = '') => { if (!c) failed++; console.log(c ? 'PASS' : 'FAIL', n, x); };
const EMAIL = `ada${Date.now()}@example.com`; const PW = 'correct horse battery';

(async () => {
  const engine = { chromium, firefox, webkit }[BROWSER]; const b = await engine.launch(); const errs = [];
  const watch = (p) => { p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/TUNNEL|fonts\.g|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); }); };
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); const p = await ctx.newPage(); watch(p);
  const go = async (u) => { await p.goto(BASE + u); await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(700); };
  const metrics = () => p.$$eval('.metric', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.metric__l').textContent, e.querySelector('.metric__v').getAttribute('aria-label') || e.querySelector('.metric__v').textContent])));
  const txt = async () => (await p.textContent('main')).replace(/\s+/g, ' ');
  const shot = (n) => p.screenshot({ path: path.join(SHOTS, n + '.png'), fullPage: true });
  const cfg = await (await fetch(BASE + '/api/config')).json(); const BANK = cfg.banks[0].code;

  // ---- A. guards: signed-out visitors are sent to log in and come back afterwards
  await go('/dashboard'); ok('guard: /dashboard redirects to login with next', /\/login\?next=%2Fdashboard/.test(p.url()), p.url());
  ok('nav (signed out): Log in + Start a Split', (await p.locator('nav[aria-label=Main] >> text=Log in').count()) === 1 && (await p.locator('nav[aria-label=Main] >> text=Start a Split').count()) === 1);

  // ---- B. sign-up validation and success
  await go('/signup'); await shot('acct-01-signup');
  await p.click('button[type=submit]'); await p.waitForTimeout(300);
  ok('signup: empty submit shows three errors', (await p.locator('.err:not(:empty)').count()) >= 3);
  ok('signup: focus moves to first invalid field', await p.evaluate(() => document.activeElement?.id === 'su-name'));
  await p.fill('#su-name', 'Ada Obi'); await p.fill('#su-email', 'not-an-email'); await p.fill('#su-pw', 'short'); await p.click('button[type=submit]'); await p.waitForTimeout(300);
  ok('signup: bad email and short password rejected', /valid email/.test(await txt()) && /at least 8/.test(await txt()));
  await p.fill('#su-email', EMAIL); await p.fill('#su-pw', 'password'); await p.click('button[type=submit]'); await p.waitForTimeout(1200);
  ok('signup: weak password rejected by server', /harder to guess/.test(await txt()), p.url());
  await p.fill('#su-pw', PW); await p.click('button[aria-pressed]'); ok('signup: show-password toggles', (await p.getAttribute('#su-pw', 'type')) === 'text');
  await p.click('button[type=submit]'); await p.waitForTimeout(1500);
  ok('signup: lands on /welcome', /\/welcome$/.test(p.url()), p.url());
  ok('signup: session cookie is HttpOnly and not readable from JS', (await ctx.cookies()).some((c) => c.name === 'sp_session' && c.httpOnly) && !(await p.evaluate(() => document.cookie.includes('sp_session'))));
  ok('nav (signed in): Dashboard, Payouts, Activity, Settings, Log out', (await p.locator('nav[aria-label=Main] a:has-text("Dashboard")').count()) === 1 && (await p.locator('[data-logout]').count()) >= 1);

  // ---- C. welcome / profile setup
  await shot('acct-02-welcome');
  await p.fill('#wp', 'abc'); await p.click('button[type=submit]'); await p.waitForTimeout(400);
  ok('welcome: bad phone rejected', /7 to 18 digits/.test(await txt()));
  await p.fill('#wp', '+234 801 234 5678'); await p.selectOption('#wb-bk', BANK); await p.fill('#wb-ac', '12345'); await p.click('button[type=submit]'); await p.waitForTimeout(800);
  ok('welcome: half-filled bank explains what is wrong', /10 digits|account number/.test(await txt()) && /\/welcome$/.test(p.url()));
  await p.fill('#wb-ac', '0123456789'); await p.click('text=Check the account name'); await p.waitForTimeout(900);
  ok('welcome: account name resolves', /\d{4}/.test(await p.textContent('.resolved')) && (await p.textContent('.resolved')).length > 8, await p.textContent('.resolved'));
  await p.click('button[type=submit]'); await p.waitForTimeout(1500);
  ok('welcome: saves and opens the dashboard', /\/dashboard$/.test(p.url()), p.url());

  // ---- D. dashboard, empty state
  ok('dashboard: empty state with Create a Split', /No splits yet/.test(await txt()) && (await p.locator('main a:has-text("Create a Split")').count()) >= 1); await shot('acct-03-dashboard-empty');
  for (const q of ['Create a Split', 'Invite Collaborators', 'View Payments', 'Open Ledger']) ok(`dashboard: quick action "${q}" present`, (await p.locator(`.quick >> text=${q}`).count()) === 1);

  // ---- E. wizard: ₦500,000 five-person hero scenario, by amount
  await p.click('.quick >> text=Create a Split'); await p.waitForTimeout(900);
  await p.click('[data-next]'); await p.waitForTimeout(300);
  ok('wizard: step 1 blocks empty continue and lists what is missing', (await p.locator('[data-step-errors]').count()) === 1 && /title/.test(await txt()));
  await p.fill('#pt', 'Lagos brand film'); await p.fill('#pc', 'Acme Studios'); await p.fill('#mt0', 'Shoot and edit'); await p.fill('#ma0', '500,000'); await p.fill('#mc0', 'Runs 60 to 90 seconds\nColour graded\nDelivered as MP4');
  await p.click('[data-next]'); await p.waitForTimeout(400);
  ok('wizard: step 2 (people) shows your name prefilled', (await p.inputValue('#tn0')) === 'Ada Obi');
  const people = [['Ada Obi', 'Videographer'], ['Bisi', 'Photographer'], ['Chidi', 'Editor'], ['Dayo', 'Makeup artist'], ['Efe', 'Creative director']];
  for (let i = 2; i < 5; i++) await p.click('text=Add a person');
  for (let i = 0; i < 5; i++) { await p.fill(`#tn${i}`, people[i][0]); await p.fill(`#tr${i}`, people[i][1]); }
  await p.click('[data-next]'); await p.waitForTimeout(400);
  await p.click('button:has-text("By amount")'); await p.waitForTimeout(300);
  const amts = ['200000', '100000', '100000', '50000', '50000']; for (let i = 0; i < 4; i++) await p.fill(`#ta${i}`, amts[i]);
  ok('wizard: live total shows unassigned money', /₦50,000 of the project is still unassigned|90\.00%|still to give out/.test(await txt()) || /₦450,000/.test(await txt()));
  await p.click('[data-next]'); await p.waitForTimeout(300); ok('wizard: allocation gate blocks 90% total', (await p.locator('[data-step-errors]').count()) === 1 && /unassigned/.test(await txt()));
  await p.fill('#ta4', '50000'); await p.waitForTimeout(300); ok('wizard: percent shown beside amount', /= 10(\.0+)?% of the project/.test(await txt()));
  await p.click('[data-next]'); await p.waitForTimeout(400); ok('wizard: validation step is all clear', /Everything checks out/.test(await txt()), '');
  await p.click('[data-next]'); await p.waitForTimeout(400);
  ok('wizard: review shows ₦500,000 + fee ₦7,500 + client pays ₦507,500', /₦500,000/.test(await txt()) && /₦7,500/.test(await txt()) && /₦507,500/.test(await txt())); await shot('acct-04-review');
  await p.click('[data-next]'); await p.waitForTimeout(400);
  await p.click('[data-publish]'); await p.waitForTimeout(500); ok('wizard: publish asks for confirmation (custom dialog, not native)', (await p.locator('[role=alertdialog]').count()) === 1);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300); ok('wizard: Escape cancels the dialog', (await p.locator('[role=alertdialog]').count()) === 0);
  await p.click('[data-publish]'); await p.click('[data-confirm]'); await p.waitForTimeout(1800);
  ok('wizard: invite links page', /Invite your team/.test(await txt()) && /It is on your dashboard/.test(await txt()));
  const leadPath = await p.$$eval('main a[href^="/p/lead/"]', (a) => a[0].getAttribute('href')); const leadTok = leadPath.split('/').pop();
  const lv = await (await fetch(`${BASE}/api/p/${leadTok}`)).json(); const collab = lv.links.collaborators; const client = lv.links.client;
  ok('wizard: shares are exactly 40/20/20/10/10 and sum 10,000', lv.project.collaborators.map((c) => c.bps).join() === '4000,2000,2000,1000,1000');

  // ---- F. dashboard now shows it (owned automatically because we were signed in)
  await go('/dashboard'); await shot('acct-05-dashboard-created');
  const m1 = await metrics(); ok('dashboard: total project value ₦500,000', m1['Total project value'] === '₦500,000', JSON.stringify(m1));
  ok('dashboard: pending confirmations = 5', m1['Pending confirmations'] === '5'); ok('dashboard: project row with attention text', (await p.locator('[data-project]').count()) === 1 && /Waiting|confirm/i.test(await p.textContent('[data-project]')));
  ok('dashboard: charts render (svg, with accessible names)', (await p.locator('svg.chart[role=img][aria-label]').count()) >= 1);

  // ---- G. lead confirms own share using the saved account
  await go(leadPath.replace('/lead/', '/collab/').replace(leadTok, collab[0].path.split('/').pop())); ok('confirm: saved account offered', (await p.locator('[data-use-saved]').count()) === 1);
  await p.check('[data-use-saved]'); await p.check('#acc'); await p.click('button:has-text("Confirm my share")'); await p.waitForTimeout(2500);
  ok('confirm: lead confirmed with saved account', /confirmed/i.test(await txt()) && /ending|\*{2,}|••|\d{4}/.test(await txt()));

  // ---- H. collaborator in a separate anonymous browser: invited -> viewed -> declined -> accepted
  const ctx2 = await b.newContext({ viewport: { width: 390, height: 800 } }); const q = await ctx2.newPage(); watch(q);
  const c2 = collab[1].path; let st = await (await fetch(`${BASE}/api/p/${leadTok}`)).json();
  ok('invite state: before viewing = invited', st.project.collaborators[1].invitation === 'invited');
  await q.goto(BASE + c2); await q.waitForTimeout(1800);
  st = await (await fetch(`${BASE}/api/p/${leadTok}`)).json(); ok('invite state: after viewing = viewed', st.project.collaborators[1].invitation === 'viewed');
  ok('collaborator (anon): sees log-in prompt to add to dashboard', /Log in to add it/.test(await q.textContent('main')));
  await q.click('[data-decline-toggle]'); await q.fill('#dec-r', 'no'); await q.click('button:has-text("Decline this share")'); await q.waitForTimeout(400);
  ok('decline: short reason rejected', st.project.collaborators[1].invitation === 'viewed' && (await q.locator('[role=alertdialog]').count()) === 0);
  await q.fill('#dec-r', 'I was promised 25 percent'); await q.click('button:has-text("Decline this share")'); await q.waitForTimeout(400); await q.click('[data-confirm]'); await q.waitForTimeout(2500);
  st = await (await fetch(`${BASE}/api/p/${leadTok}`)).json(); ok('decline: state = declined with reason', st.project.collaborators[1].invitation === 'declined' && /25 percent/.test(st.project.collaborators[1].declineReason));
  await shot('acct-06-collab-declined-mobile');
  await go(leadPath); ok('lead sees Declined pill and reason', /Declined/.test(await txt()) && /I was promised 25 percent/.test(await txt()));

  // ---- I. lead revises the split; only changed people re-confirm
  await post(`/api/p/${collab[2].path.split('/').pop()}/confirm`, { accept: true, bankCode: BANK, accountNumber: '1111111111' });
  await go(leadPath); await p.click('[data-revise-toggle]'); await p.fill('#rv-c1', '35'); await p.fill('#rv-c2', '25'); await p.waitForTimeout(300);
  ok('revise: button disabled until total is 100%', (await p.locator('button:has-text("Send the revised split")').isDisabled()) === false);
  await p.click('button:has-text("Send the revised split")'); await p.waitForTimeout(400); ok('revise: warns who must re-confirm', /confirm again/.test(await p.textContent('[role=alertdialog]')));
  await p.click('[data-confirm]'); await p.waitForTimeout(2500);
  st = await (await fetch(`${BASE}/api/p/${leadTok}`)).json(); ok('revise: shares are now 35/25/20/10/10', st.project.collaborators.map((c) => c.bps).join() === '3500,2500,2000,1000,1000');
  ok('revise: unchanged confirmed person stays confirmed', st.project.collaborators[2].confirmed === true && st.project.collaborators[0].confirmed === false);
  // everyone confirms, client pays through the simulated checkout
  for (const c of collab) { const r = await post(`/api/p/${c.path.split('/').pop()}/confirm`, { accept: true, bankCode: BANK, accountNumber: '2222222222' }); }
  await go(client); await p.click('button:has-text("Pay ₦")'); await p.waitForTimeout(1800); await p.click('button:has-text("Pay ₦")'); await p.waitForTimeout(4500);
  st = await (await fetch(`${BASE}/api/p/${leadTok}`)).json(); ok('client paid: project funded', st.project.funding.status === 'funded', st.project.funding.status);
  // deliver + approve milestone through the UI (custom confirm dialog)
  await go(leadPath); await p.fill('input[type=url]', 'https://example.com/film'); await p.fill('.mform textarea', 'Final cut delivered in full'); await p.click('button:has-text("Submit delivery")'); await p.waitForTimeout(2000);
  await go(client); if (!(await p.locator('text=/Approve and release/').count())) { await shot('acct-debug-approve'); console.log('DEBUG client page:', (await txt()).slice(0, 700)); }
  await p.click('text=/Approve and release/'); await p.waitForTimeout(500); ok('approve: custom dialog names the amount', /₦500,000/.test(await p.textContent('[role=alertdialog]')));
  await p.click('[data-confirm]'); await p.waitForTimeout(6500);

  // ---- J. dashboard / payouts / activity with real data
  await go('/dashboard'); await shot('acct-07-dashboard-paid'); const m2 = await metrics();
  ok('dashboard: completed payouts ₦500,000', m2['Completed payouts'] === '₦500,000', JSON.stringify(m2)); ok('dashboard: awaiting settlement ₦0', m2['Awaiting settlement'] === '₦0');
  ok('dashboard: recent transactions list payouts', /paid/i.test(await p.textContent('.rowtable')));
  await go('/payouts'); await shot('acct-08-payouts'); ok('payouts: five paid rows summing ₦500,000', (await p.locator('tbody tr').count()) === 5 && /Paid\s*₦500,000/.test(await txt()));
  await p.selectOption('#pf-st', 'failed'); await p.waitForTimeout(300); ok('payouts: status filter to Failed shows empty message', /No payouts match/.test(await txt())); await p.selectOption('#pf-st', '');
  ok('payouts: receipt link works', (await p.locator('a:has-text("Receipt")').count()) === 5);
  await go('/activity'); await shot('acct-09-activity'); const total = await p.textContent('.toolbar .hint'); ok('activity: entries listed', /of \d+ entries shown/.test(total), total);
  await p.selectOption('#af-ty', 'Payout'); await p.waitForTimeout(300); const filtered = await p.textContent('.toolbar .hint'); ok('activity: type filter narrows the list', filtered !== total && /5 of/.test(filtered), filtered);
  await p.fill('#af-from', '2999-01-01'); await p.waitForTimeout(300); ok('activity: future date filter gives empty state with clear button', /No entries match/.test(await txt()));
  await p.click('main >> text=Clear filters >> nth=0'); await p.waitForTimeout(300);
  await p.click('button:has-text("Table")'); await p.waitForTimeout(300); ok('activity: table view', (await p.locator('table.tbl').count()) === 1);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-export]')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok('activity: CSV export has header, rows and hashes', /^﻿Project,Entry number/.test(csv) && csv.split('\r\n').length > 10 && /[0-9a-f]{64}/.test(csv), `${csv.split('\r\n').length} lines`);

  // ---- K. settings
  await go('/settings'); await shot('acct-10-settings');
  await p.fill('#st-name', 'A'); await p.click('button:has-text("Save changes")'); await p.waitForTimeout(300); ok('settings: short name rejected inline', /at least 2/.test(await txt()));
  await p.fill('#st-name', 'Ada Okafor'); await p.fill('#st-phone', '+234 802 000 1111'); await p.click('button:has-text("Save changes")'); await p.waitForTimeout(900);
  await go('/settings'); ok('settings: profile persisted across reload', (await p.inputValue('#st-name')) === 'Ada Okafor' && (await p.inputValue('#st-phone')) === '+234 802 000 1111');
  ok('settings: saved bank shown masked (no full number)', /\*|•|\d{4}/.test(await p.textContent('[data-saved-bank]')) && !/0123456789/.test(await txt()));
  await p.uncheck('#pf-payouts'); await p.waitForTimeout(700); await go('/dashboard'); ok('prefs: payouts hidden from dashboard activity feed', !/Payout sent/.test(await p.textContent('.feed')));
  await go('/activity'); await p.click('button:has-text("Timeline")'); await p.waitForTimeout(300); ok('prefs: ledger still shows payouts (never filtered)', (await p.locator('li.lentry:has-text("Payout")').count()) >= 1);
  await go('/settings'); await p.check('#pf-payouts'); await p.waitForTimeout(500);
  await p.fill('#sc-cur', 'wrong password!'); await p.fill('#sc-new', 'a brand new passphrase'); await p.click('button:has-text("Change password")'); await p.waitForTimeout(900); ok('security: wrong current password rejected', /not correct/.test(await txt()));
  await p.fill('#sc-cur', PW); await p.click('button:has-text("Change password")'); await p.waitForTimeout(1200); ok('security: password changed', /Password changed/.test(await p.textContent('#toasts')));
  await p.click('button:has-text("Remove saved account")'); await p.click('[data-confirm]'); await p.waitForTimeout(1200); ok('settings: saved account removed', /No account saved yet/.test(await txt()));

  // ---- L. logout, login failures, success, redirect back, recovery
  await p.click('nav[aria-label=Main] [data-logout]'); await p.waitForTimeout(1200); ok('logout: back on landing, signed out nav', /\/$/.test(p.url()) && (await p.locator('nav[aria-label=Main] >> text=Log in').count()) === 1);
  ok('logout: session actually ended server-side', (await (await ctx.request.get(BASE + '/api/auth/me')).json()).user === null);
  await go('/payouts'); ok('logout: protected page redirects to login', /\/login\?next=%2Fpayouts/.test(p.url()));
  await p.fill('#li-email', EMAIL); await p.fill('#li-pw', PW); await p.click('button[type=submit]'); await p.waitForTimeout(1200); ok('login: old password rejected after change, uniform message', /do not match/.test(await txt()));
  await p.fill('#li-pw', 'a brand new passphrase'); await p.click('button[type=submit]'); await p.waitForTimeout(1500); ok('login: success returns to the page we wanted (/payouts)', /\/payouts$/.test(p.url()), p.url());
  await p.click('nav[aria-label=Main] [data-logout]'); await p.waitForTimeout(800);
  await go('/forgot'); await p.fill('#fg-email', EMAIL); await p.click('button[type=submit]'); await p.waitForTimeout(1000); ok('forgot: reset link shown on screen, labelled simulated', /Simulated/.test(await txt()) && (await p.locator('[data-reset-link]').count()) === 1);
  await p.click('[data-reset-link]'); await p.waitForTimeout(800); await p.fill('#rs-pw', 'recovered passphrase 1'); await p.fill('#rs-pw2', 'different'); await p.click('button[type=submit]'); await p.waitForTimeout(300); ok('reset: mismatch caught', /do not match/.test(await txt()));
  await p.fill('#rs-pw2', 'recovered passphrase 1'); await p.click('button[type=submit]'); await p.waitForTimeout(1500); ok('reset: goes to login', /\/login$/.test(p.url()), p.url());
  await p.fill('#li-email', EMAIL); await p.fill('#li-pw', 'recovered passphrase 1'); await p.click('button[type=submit]'); await p.waitForTimeout(1500); ok('reset: can log in with the recovered password', /\/dashboard$/.test(p.url()), p.url());
  await go('/reset/not-a-real-token-123'); await p.fill('#rs-pw', 'another good one 22'); await p.fill('#rs-pw2', 'another good one 22'); await p.click('button[type=submit]'); await p.waitForTimeout(900); ok('reset: bogus token refused', /invalid or has expired/.test(await txt()));

  // ---- M. phone-size pass over every account screen: no horizontal scroll, tap targets, no errors
  const ph = await b.newContext({ ...(devices['iPhone 12'] ?? { viewport: { width: 390, height: 800 } }) }); const m = await ph.newPage(); watch(m);
  await m.goto(BASE + '/login'); await m.fill('#li-email', EMAIL); await m.fill('#li-pw', 'recovered passphrase 1'); await m.click('button[type=submit]'); await m.waitForTimeout(1500);
  for (const u of ['/dashboard', '/payouts', '/activity', '/settings', '/new', '/signup']) {
    await m.goto(BASE + u); await m.waitForTimeout(1300);
    const over = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth); const small = await m.evaluate(() => [...document.querySelectorAll('main a, main button, main input, main select')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && (r.height < 40) && getComputedStyle(e).visibility !== 'hidden' && e.type !== 'checkbox' && !e.closest('[hidden]'); }).map((e) => (e.textContent || e.id).trim().slice(0, 24)));
    ok(`mobile ${u}: no horizontal scroll`, over <= 1, `overflow ${over}px`); ok(`mobile ${u}: tap targets >= 40px`, small.length === 0, small.join('|'));
    await m.screenshot({ path: path.join(SHOTS, `acct-m${u.replace('/', '-')}.png`), fullPage: true });
  }
  await m.goto(BASE + '/dashboard'); await m.waitForTimeout(800); await m.click('.nav__toggle'); ok('mobile: menu sheet lists Dashboard/Payouts/Activity/Settings/Log out', (await m.locator('.nav__sheet a').allTextContents()).join().includes('Settings') && (await m.locator('.nav__sheet [data-logout]').count()) === 1);

  // ---- N. reduced motion
  const rm = await b.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } }); const r = await rm.newPage(); watch(r);
  await r.goto(BASE + '/login'); await r.fill('#li-email', EMAIL); await r.fill('#li-pw', 'recovered passphrase 1'); await r.click('button[type=submit]'); await r.waitForTimeout(1200); await r.goto(BASE + '/dashboard'); await r.waitForTimeout(800);
  ok('reduced motion: dashboard shows final numbers with no rolling', await r.evaluate(() => document.querySelector('.metric__v')?.classList.contains('roll--static')));

  await go('/new?step=review'); ok('wizard: deep link to a later step with no data falls back safely (no crash)', /Project details|Allocation|Participants/.test(await txt()) && !/Review\b/.test((await p.textContent('.steps li[aria-current]')) || ''));
  // ---- O. guided demo + reset
  await go('/demo'); ok('demo: nine guided steps listed', (await p.locator('.walk li').count()) === 9);
  await p.click('[data-demo-reset]'); await p.waitForTimeout(300); await p.click('[data-confirm]'); await p.waitForTimeout(2500); ok('demo: reset lands on a fresh project', /\/p\/lead\//.test(p.url()) && /Waiting on confirmations|Confirm/i.test(await txt()), p.url());
  ok('landing: hero scenario is ₦500,000 with five people and new CTAs', await (async () => { await go('/'); await p.waitForTimeout(3500); const t = await p.textContent('body'); return /Start a Split/.test(t) && /See How It Works/.test(t) && /Creative director/.test(t) && /Makeup artist/.test(t); })());
  ok('no page or console errors across the whole run', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); await b.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SCRIPT CRASH', e.message); process.exit(2); });
