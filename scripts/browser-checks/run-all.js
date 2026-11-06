// One command to run every browser check against a throwaway server, in one or more browsers.
//   node scripts/browser-checks/run-all.js                      -> Chromium, all quick checks
//   node scripts/browser-checks/run-all.js --browser=firefox    -> Firefox
//   node scripts/browser-checks/run-all.js --browser=all        -> Chromium, Firefox and WebKit (Safari's engine)
//   node scripts/browser-checks/run-all.js --crawl              -> also run click-every-control.js (slow: about an hour)
//   node scripts/browser-checks/run-all.js --crawl=dashboard@data,settings@empty   -> crawl only those screens
const { spawn } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs'); const net = require('net');
const root = path.resolve(__dirname, '..', '..'); const arg = (k) => (process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`)) ?? '').split('=').slice(1).join('=') || (process.argv.includes(`--${k}`) ? 'true' : '');
const browsers = (arg('browser') || 'chromium') === 'all' ? ['chromium', 'firefox', 'webkit'] : (arg('browser') || 'chromium').split(',');
const crawl = arg('crawl'); const SCRIPTS = ['accounts.js', 'forms-and-money.js', 'three-minute-demo.js', 'devices-and-reduced-motion.js'];
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn) {
  const port = await freePort(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitpot-run-'));
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_FILE: path.join(dir, 'data.json'), DEMO_MODE: 'true', TEST_RELAX_LIMITS: 'true', PUBLIC_BASE_URL: '' }, stdio: 'ignore' });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* not up yet */ } await wait(200); }
  try { return await fn(base); } finally { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const run = (file, env, args = []) => new Promise((res) => {
  const out = []; const c = spawn(process.execPath, [path.join(__dirname, file), ...args], { env: { ...process.env, ...env }, cwd: root });
  c.stdout.on('data', (d) => out.push(String(d))); c.stderr.on('data', (d) => out.push(String(d))); c.on('close', (code) => res({ code, out: out.join('') }));
});

(async () => {
  let bad = 0; const rows = [];
  for (const browser of browsers) {
    const list = [...SCRIPTS, ...(crawl ? ['click-every-control.js'] : [])];
    for (const f of list) {
      const t = Date.now();
      const r = await withServer((BASE) => run(f, { BASE, BROWSER: browser, SHOTS: path.join(os.tmpdir(), `splitpot-shots-${browser}`), TAG: browser }, f.startsWith('click') && crawl !== 'true' ? [crawl] : []));
      const fails = r.out.split('\n').filter((l) => /^FAIL|SCRIPT CRASH|problems [1-9]|^\s+- /.test(l) || /Error:/.test(l));
      const ok = r.code === 0 && fails.length === 0 && !/ERRORS: (?!none)/.test(r.out); if (!ok) bad++;
      rows.push(`${ok ? 'PASS' : 'FAIL'}  ${browser.padEnd(9)} ${f.padEnd(34)} ${((Date.now() - t) / 1000).toFixed(0)}s`);
      console.log(rows.at(-1)); if (!ok) { console.log(fails.slice(0, 12).map((l) => '      ' + l).join('\n') || r.out.split('\n').slice(-12).join('\n')); }
    }
  }
  console.log(`\n${bad ? `${bad} check file(s) FAILED` : 'ALL BROWSER CHECKS PASSED'} in: ${browsers.join(', ')}`); process.exit(bad ? 1 : 0);
})();
