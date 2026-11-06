# SplitPot — ONE PAYMENT. EVERYONE PAID.

A shared payment pot for Nigerian creative teams. The team agrees the split first, the client pays once, money is released per milestone, disputes freeze only the disputed milestone, and every move is on a hash-chained public ledger with receipts.

**Prototype in test mode. No real money moves.** SplitPot is not a licensed payment company and does not hold funds.

## Run it (3 steps, no installs)
1. Install Node.js 22 or newer from https://nodejs.org (check with `node --version`).
2. Unzip, then in a terminal go into the folder:
   - Mac/Linux: `cd path/to/splitpot`
   - Windows: open the folder in File Explorer, click the address bar, type `cmd` and press Enter.
3. Start it: `node src/server.js` (same on every system; no `npm install` is needed because there are no dependencies).
   Open the address it prints (normally http://localhost:3000). Stop with Ctrl+C.

Judge Mode is on by default with the simulated provider; open `/demo`. If port 3000 is busy it moves to 3001, 3002 and so on. Use another port with `PORT=5000 node src/server.js` (Mac/Linux) or `set PORT=5000 && node src/server.js` (Windows cmd).
Run the tests with `npm test`. Judge demo: `/demo` has a nine-step guided walkthrough and a reset button.

## What is simulated (labelled in the UI)
Custody of money, identity/account-name verification, the dispute reviewer, client refunds, bank transfers (mock provider). The 1.5% fee is an assumption, charged on top, not refunded. The 51% figure is one NECLive survey of 377 creatives, not market data.

## Architecture
- `src/shared/money.js` integer kobo, BigInt largest-remainder allocation, basis points, fee half-up (also served to the browser).
- `src/domain/ledger.js` append-only SHA-256 chain with a tail anchor.
- `src/engine/` the only place money is allocated (`#release`), role-redacted views, Judge Mode (drives the real commands).
- `src/providers/` `mock` (default) and `paystack` adapter (contract-tested with a fake HTTP client, NOT tested live; see `docs/PAYSTACK_VERIFICATION.md`).
- `src/storage/jsonStore.js` atomic JSON file with a process-wide mutex.
- `src/http.js` routes, capability tokens, CSP, rate limits, signed webhook endpoint.
- `public/` vanilla ES-module SPA (no build step).

## Safety properties (tested)
Funding only via a signature-verified webhook (HMAC-SHA512 over the raw body) plus a server-side verify of amount and currency; duplicate webhooks counted once; no double release under concurrent approvals; deterministic payout references so a lost response cannot double-pay; frozen milestones never paid; public ledger never exposes tokens or account numbers.

## Env vars
`PORT`, `DEMO_MODE`, `PROVIDER=mock|paystack`, `PAYSTACK_SECRET_KEY`, `PUBLIC_BASE_URL` (must be publicly reachable for real webhooks), `DATA_FILE`, `FEE_BPS`, `TEST_RELAX_LIMITS` (tests only, demo mode only).

## Accounts and screens
Sign up, log in, log out, password recovery (no email service, so the reset link is shown on screen and labelled simulated), first-run profile setup, a cross-project dashboard (real numbers, charts, recent transactions, activity), a Create-a-Split wizard (6 steps, percent or amount, live totals), invitation states (invited, viewed, accepted, declined), revise-split with re-confirmation of changed shares, a payout centre (filters, retry, receipts), a cross-project ledger (filter by project, date, type, status; timeline or table; CSV export) and settings (profile, feed filters, a saved payout account shown masked, change password, sign out everywhere).
Passwords are stored only as salted scrypt hashes. Sessions are HttpOnly SameSite=Strict cookies with a 14-day expiry. Notification switches only choose what shows in the dashboard feed, because no email or SMS is sent; the ledger is never filtered.

## Run the checks yourself (any browser)
Unit tests need nothing: `npm test` (114 tests).
Browser checks need Playwright, which is the only dev dependency:
```
npm install
npm run browsers:install          # downloads Chromium, Firefox and WebKit (Safari's engine), once
npm run check:browser             # Chromium: account screens, money flow, 3-minute demo, devices
npm run check:browser:all         # the same in Chromium, Firefox and WebKit
npm run check:crawl               # also click every control on every screen (slow, about an hour)
node scripts/browser-checks/run-all.js --browser=webkit --crawl=dashboard@data,settings@empty   # one browser, chosen screens
```
`run-all.js` starts its own throwaway server on a free port with its own data file, so it never touches your data. To run one script against a server you started yourself:
`DEMO_MODE=true TEST_RELAX_LIMITS=true PORT=4321 node src/server.js`, then `BASE=http://localhost:4321 BROWSER=firefox node scripts/browser-checks/accounts.js`.
`TEST_RELAX_LIMITS` switches rate limits off and works only with demo mode; never set it on a public server. Screenshots go to your temp folder (`SHOTS=/some/dir` to choose).
A real phone cannot be driven by these scripts: open the server on your computer's network address from the phone (`HOST` is already 0.0.0.0) and walk the 3-minute demo by hand.

## Verified (actually run, in Chromium only)
- `npm test`: 114 unit, integration and HTTP tests pass (91 engine/HTTP plus 23 for accounts: password hashing, sessions, CSRF, rate limits, reset, claims, invitation states, revise, saved account never exposed).
- `scripts/browser-checks/accounts.js`: sign-up, log-in and recovery validation, session cookie flags, welcome, empty dashboard, the six-step wizard with the ₦500,000 five-person scenario, decline and revise, funding and approval through the UI, dashboard numbers, payout centre, ledger filters and CSV export, settings, logout, mobile layout (iPhone 12) and reduced motion.
- `forms-and-money.js` (27 checks), `three-minute-demo.js`, `devices-and-reduced-motion.js`: the money flow, the demo, phones and tablets.
- `click-every-control.js`: opens every screen and state, including the account screens signed in, clicks every visible control on fresh data and reports controls with no effect, console or server errors, broken links and unnamed controls. Result: every screen and state (including all account screens, signed in) with no dead controls, no console or server errors, no broken links and no unnamed controls, after the fixes listed in the changelog below.

## Not verified (cannot be done from the build environment)
- Firefox and Safari/WebKit: the browsers could not be downloaded in the build environment, so nothing has run in them. The scripts are ready (`npm run check:browser:all`), but treat those browsers as untested until you run it.
- Real phones: only Chromium's phone and tablet emulation was used.
- Live Paystack calls (needs a Paystack test key and a public webhook URL; only contract-tested against a fake HTTP client).
- Real fonts: Bricolage Grotesque and Atkinson Hyperlegible Next load from Google Fonts and were unreachable here, so all screenshots show fallback fonts. Open it online once and check.
- Real email or SMS: none is sent, so recovery links and notifications are simulated.
- Screen-reader and keyboard-only walkthrough, and a formal contrast audit: not done. The banner link in the top bar is 20px tall (the rest of the interface meets 44px).
- Real custody: needs a licensed partner; none engaged.

## 3-minute judge demo
1. `/` — let the opener and hero play; press Fund, Dispute, Approve on the illustrated pot (labelled illustration). (0:40)
2. `/demo` → "Delivered": client page. Show the 72-hour countdown and the pot. (0:30)
3. Approve: four payouts, open a receipt, show the ledger hash. (0:40)
4. Judge Mode "Dispute": only milestone 1 freezes; milestone 2 keeps moving. (0:30)
5. Public ledger: "Chain verified", then Judge Mode "Tamper ledger" → "Chain broken at entry N.", then Restore. (0:30)
6. Honesty section: what is simulated and the licensing gap. (0:10)

## Bugs the new checks found and fixed (this round)
- The router swallowed the CSV download link, so "Export CSV" did nothing.
- Opening `/new?step=review` with an empty form crashed; deep links now open at most the Allocation step.
- A fast double navigation raised an unhandled "Transition was skipped" error.
- Every script in `scripts/browser-checks/` crashed under the repo's `"type": "module"`; the folder is now CommonJS.
- Wizard hints beside each share did not update while typing.
