// Boot script. Run with:  node src/server.js     (or: npm start)
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`\n  SplitPot needs Node.js 22 or newer. You have ${process.versions.node}.\n  Install the current LTS from https://nodejs.org, open a NEW terminal, then run this again.\n`);
  process.exit(1);
}

const { createApp } = await import('./http.js');
const app = createApp(process.env);

const wanted = app.config.port;
let started = false;
for (let port = wanted; port < wanted + 10 && !started; port += 1) {
  try {
    // eslint-disable-next-line no-await-in-loop
    await app.listen(port);
    started = true;
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;
    console.log(`  Port ${port} is busy, trying ${port + 1}...`);
    app.server = null;
  }
}
if (!started) { console.error(`\n  Ports ${wanted} to ${wanted + 9} are all busy. Close the other program or run:  PORT=5000 node src/server.js\n`); process.exit(1); }

const { config } = app;
console.log('');
console.log('  SplitPot: Prototype in test mode. No real money moves.');
console.log(`  provider   ${config.provider}${config.provider === 'mock' ? ' (simulated)' : ' (UNTESTED against a live account)'}`);
if (config.limitsRelaxed) console.log('  WARNING rate limits are OFF (TEST_RELAX_LIMITS). Use only for automated browser tests.');
console.log(`  judge mode ${config.demoMode ? `ON  -> open http://localhost:${app.port}/demo` : 'off'}`);
console.log(`  open       http://localhost:${app.port}`);
console.log('  stop       press Ctrl+C');
console.log('');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await app.close(); process.exit(0); });
}
