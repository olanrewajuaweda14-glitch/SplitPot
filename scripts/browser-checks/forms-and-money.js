const { chromium, firefox, webkit, devices } = require('playwright'); const S = (process.env.SHOTS || require('path').join(require('os').tmpdir(), 'splitpot-shots')) + '/'; require('fs').mkdirSync(S, { recursive: true }); const U = process.env.BASE || 'http://localhost:4321';
const post = (u, b) => fetch(U + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const results = []; const ok = (n, c, x = '') => { results.push([c ? 'PASS' : 'FAIL', n, x]); console.log(c ? 'PASS' : 'FAIL', n, x); };
(async () => {
  const b = await ({ chromium, firefox, webkit }[process.env.BROWSER || 'chromium']).launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('dialog', (d) => d.accept());
  p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/TUNNEL|Failed to load resource: the server responded with a status of 4/.test(m.text())) errs.push(m.text().slice(0, 200)); });
  const go = async (u) => { await p.goto(U + u); await p.waitForTimeout(1800); };
  const txt = async () => (await p.textContent('main')).replace(/\s+/g, ' ');

  // ---- A. create a real project through the UI
  await go('/new');
  const next = async () => { await p.click('[data-next]'); await p.waitForTimeout(350); };
  await p.fill('#pt', 'Test short film'); await p.fill('#pc', 'Acme Films');
  await p.fill('#mt0', 'Rough cut'); await p.fill('#ma0', '300,000'); await p.fill('#mc0', 'Under 5 minutes\nColour graded');
  await p.click('text=Add a milestone'); await p.fill('#mt1', 'Final'); await p.fill('#ma1', '200000'); await p.fill('#mc1', 'Delivered as MP4');
  await next();
  await p.fill('#tn0', 'Ada'); await p.fill('#tr0', 'Director'); await p.fill('#tn1', 'Bayo'); await p.fill('#tr1', 'Editor');
  const addBtn = await p.$('text=Add a person'); await addBtn.click(); await p.fill('#tn2', 'Chi'); await p.fill('#tr2', 'Sound');
  await next();
  await next(); ok('create: allocation step blocks Continue before shares add to 100%', (await p.locator('[data-step-errors]').count()) === 1);
  await p.click('text=Split evenly'); await p.waitForTimeout(300);
  await p.waitForTimeout(400); const t1 = await txt(); ok('create: shows 100% + fee preview', /100%/.test(t1) && /₦7,500/.test(t1) && /₦507,500/.test(t1));
  await next(); await next(); await p.screenshot({ path: S + '30-create-filled.png', fullPage: true }); await next();
  await p.click('[data-publish]'); await p.click('[data-confirm]'); await p.waitForTimeout(1800);
  ok('create: links page shown', /Invite your team/.test(await txt())); await p.screenshot({ path: S + '31-links.png' });
  const hrefs = await p.$$eval('main a[href^="/p/"]', (a) => a.map((x) => x.getAttribute('href'))); const leadPath = hrefs.find((h) => h.includes('/lead/'));
  // get all links via lead view API
  const leadTok = leadPath.split('/').pop(); const lv = await (await fetch(`${U}/api/p/${leadTok}`)).json();
  const collab = lv.links.collaborators; const client = lv.links.client;
  ok('create: 3 splits sum 10000 bps', lv.project.collaborators.reduce((a, c) => a + c.bps, 0) === 10000, lv.project.collaborators.map((c) => c.bps).join(','));

  // ---- B. each collaborator confirms through the UI
  for (const c of collab) {
    await go(c.path);
    await p.selectOption('#bk', '044'); await p.fill('#ac', '10000000' + c.id.slice(1).padStart(2, '0'));
    await p.click('text=Check the account name'); await p.waitForTimeout(800);
    const nm = await p.textContent('.resolved'); 
    await p.check('#acc'); await p.click('text=Confirm my share'); await p.waitForTimeout(1500);
    ok(`confirm ${c.name}: name resolved + confirmed`, /\S/.test(nm) && /confirmed/i.test(await txt()), nm.trim().slice(0, 50));
  }
  await p.screenshot({ path: S + '32-collab-confirmed.png' });
  // ---- C. client pays through the UI + simulated checkout
  await go(client); ok('client: Fund panel visible', /Fund the pot/.test(await txt()));
  await p.click('button:has-text("Pay ₦")'); await p.waitForTimeout(1800); ok('checkout: labelled simulated', /Simulated checkout — test mode\./.test(await p.textContent('main')));
  await p.click('button:has-text("Pay ₦")'); await p.waitForTimeout(5000);
  let v = await (await fetch(`${U}/api/p/${leadTok}`)).json(); ok('funding: pot funded via signed webhook', v.project.funding.status === 'funded' && v.project.status === 'active', v.project.status);
  ok('client page returned and shows Active', /Active/.test(await txt()));
  // ---- D. lead delivers via UI form
  await go(`/p/lead/${leadTok}`);
  await p.fill('input[type=url]', 'https://example.com/cut1'); await p.fill('.mform textarea', 'First cut attached for review.'); await p.click('button:has-text("Submit delivery")'); await p.waitForTimeout(2500);
  v = await (await fetch(`${U}/api/p/${leadTok}`)).json(); ok('deliver form: milestone delivered', v.project.milestones[0].status === 'delivered');
  // ---- E. client dispute via UI
  await go(client); await p.click('text=Dispute this milestone'); await p.waitForTimeout(300);
  await p.click('.mform .check >> nth=0'); await p.fill('.mform textarea', 'The colour grade is missing entirely.'); await p.click('text=Open a dispute and freeze this milestone'); await p.waitForTimeout(2500);
  v = await (await fetch(`${U}/api/p/${leadTok}`)).json(); ok('dispute form: only milestone 1 frozen', v.project.milestones[0].frozen && !v.project.milestones[1].frozen);
  await p.screenshot({ path: S + '33-client-disputed.png', fullPage: true });
  // ---- F. proposals: client proposes split 50 -> lead rejects -> lead proposes fix -> client rejects -> escalate -> reviewer
  await p.selectOption('.dispute select', 'split'); await p.fill('.dispute input[placeholder^="Percent"]', '50'); await p.click('text=Send proposal'); await p.waitForTimeout(2000);
  ok('propose: client split proposal shown', /proposes: Split/.test(await txt()));
  await go(`/p/lead/${leadTok}`); await p.click('text=Reject'); await p.waitForTimeout(1500);
  v = await (await fetch(`${U}/api/p/${leadTok}`)).json(); ok('respond: reject recorded', v.project.milestones[0].dispute.proposals[0].status === 'rejected');
  await p.click('text=Ask the simulated reviewer to decide'); await p.waitForTimeout(1500);
  v = await (await fetch(`${U}/api/p/${leadTok}`)).json(); ok('escalate: dispute in_review', v.project.milestones[0].dispute.status === 'in_review');

  // ---- G. demo project: reviewer decides through the UI (split 60%)
  let st = await post('/api/demo/stage', { stage: 'disputed' }); let L = st.links;
  await go(L.client); await p.selectOption('.dispute select', 'split'); await p.fill('.dispute input[placeholder^="Percent"]', '50'); await p.click('text=Send proposal'); await p.waitForTimeout(1800);
  await go(L.lead); await p.click('text=Reject'); await p.waitForTimeout(1500); await p.click('text=Ask the simulated reviewer to decide'); await p.waitForTimeout(1500);
  await go(L.reviewer); ok('reviewer page labelled simulated', /Simulated/.test(await txt()));
  await p.selectOption('.mform select', 'split'); await p.fill('.mform input[placeholder^="Percent"]', '60'); await p.click('.mform .check >> nth=1'); await p.fill('.mform textarea', 'Scenes were missing, so a partial release is fair.'); await p.screenshot({ path: S + '34-reviewer.png', fullPage: true });
  await p.click('text=Record decision'); await p.waitForTimeout(5000);
  v = await (await fetch(`${U}/api/p/${L.lead.split('/').pop()}`)).json(); const m1 = v.project.milestones[0];
  ok('reviewer: split recorded, 60% released / refund simulated', m1.resolution === 'split' && m1.refundKobo === 16000000, `refund=${m1.refundKobo}`);
  ok('reviewer: team payouts sum to 24,000,000 kobo', v.project.payouts.filter((x) => x.milestoneId === 'm1').reduce((a, x) => a + x.amountKobo, 0) === 24000000);
  ok('reviewer: milestone 2 untouched', v.project.milestones[1].status === 'delivered');
  // ---- H. accept path: lead proposes release, client accepts via UI
  st = await post('/api/demo/stage', { stage: 'disputed' }); L = st.links;
  await go(L.lead); await p.selectOption('.dispute select', 'release'); await p.click('text=Send proposal'); await p.waitForTimeout(1800);
  await go(L.client); await p.click('text=Accept'); await p.waitForTimeout(5000);
  v = await (await fetch(`${U}/api/p/${L.lead.split('/').pop()}`)).json(); ok('accept: full release paid', v.project.milestones[0].resolution === 'released' && v.project.payouts.filter((x) => x.milestoneId === 'm1' && x.status === 'success').length === 4);
  // ---- I. failing payout + retry through the UI
  st = await post('/api/demo/stage', { stage: 'delivered' }); L = st.links; await post('/api/demo/failing-account');
  await go(L.client); await p.click('text=/Approve and release/'); await p.click('[data-confirm]'); await p.waitForTimeout(6000);
  await go(L.lead); const failed = await p.$('text=Failed'); ok('payout failure shown with reason', !!failed); await p.screenshot({ path: S + '35-failed-payout.png', fullPage: true });
  const retry = await p.$('button:has-text("Retry payout")'); ok('retry button present for lead', !!retry);
  if (retry) { await retry.click(); await p.waitForTimeout(6000); }
  v = await (await fetch(`${U}/api/p/${L.lead.split('/').pop()}`)).json(); const pm = v.project.payouts.filter((x) => x.milestoneId === 'm1');
  ok('retry: all 4 payouts succeeded, exactly 4 rows or retried once', pm.filter((x) => x.status === 'success').length === 4, pm.map((x) => x.status + ':a' + x.attempt).join(','));
  ok('retry: no collaborator paid twice', new Set(pm.filter((x) => x.status === 'success').map((x) => x.collaboratorId)).size === 4);
  // ---- J. wrong amount rejected through checkout UI
  st = await post('/api/demo/stage', { stage: 'ready' }); L = st.links; await go(L.client); await p.click('button:has-text("Pay ₦")'); await p.waitForTimeout(1500);
  await p.click('summary'); await p.click('text=Pay ₦1,000 too little'); await p.waitForTimeout(5000);
  v = await (await fetch(`${U}/api/p/${L.lead.split('/').pop()}`)).json(); ok('underpayment rejected, pot NOT funded', v.project.funding.status !== 'funded' && v.project.status === 'awaiting_funding', v.project.status);
  await go(L.client); ok('client sees rejection message', /did not match|rejected|not counted/i.test(await txt()));
  await b.close();
  console.log('\nSUMMARY', results.filter((r) => r[0] === 'PASS').length + '/' + results.length, 'ERRORS:', errs.join(' | ') || 'none');
  require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'splitpot-ids.json'), JSON.stringify({ leadTok }));
})();
