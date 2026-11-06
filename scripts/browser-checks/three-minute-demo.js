const { chromium, firefox, webkit } = require('playwright'); const U = process.env.BASE || 'http://localhost:4321'; const S = (process.env.SHOTS || require('path').join(require('os').tmpdir(), 'splitpot-shots')) + '/'; require('fs').mkdirSync(S, { recursive: true });
const post=(u,b)=>fetch(U+u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());
(async()=>{ const b=await ({ chromium, firefox, webkit }[process.env.BROWSER || 'chromium']).launch(); const errs=[]; const t0=Date.now(); const lap=(n)=>console.log(String(((Date.now()-t0)/1000).toFixed(1)).padStart(5)+'s',n);
 const ctx=await b.newContext({viewport:{width:1440,height:900}}); const p=await ctx.newPage(); p.on('dialog',d=>d.accept()); p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error'&&!/TUNNEL|status of 4/.test(m.text()))errs.push(m.text().slice(0,150))});
 // 1 landing + opener + hero demo
 await p.goto(U+'/'); await p.waitForTimeout(3300); lap('opener finished, hero visible');
 await p.click('button:has-text("Fund the pot")'); await p.waitForTimeout(2200); await p.click('button:has-text("Dispute one")'); await p.waitForTimeout(1500); await p.click('button:has-text("Approve a milestone")'); await p.waitForTimeout(2600); lap('hero demo: fund, dispute, approve');
 const line=await p.textContent('.demo-line'); console.log('   hero line:',line);
 // 2 demo hub -> delivered
 await p.goto(U+'/demo'); await p.waitForTimeout(800); await p.click('.stagebtn >> nth=3'); await p.waitForTimeout(3500); lap('delivered: client page with countdown');
 console.log('   countdown visible:', /Review window ends in \d+h/.test(await p.textContent('main')));
 // 3 approve + receipt + ledger hash
 await p.click('button:has-text("Approve and release")'); await p.click('[data-confirm]'); await p.waitForTimeout(5500); lap('approved, 4 payouts');
 const paid=await p.$$('text=Paid'); console.log('   paid pills:',paid.length);
 await p.click('a:has-text("Receipt") >> nth=0'); await p.waitForTimeout(1500); console.log('   receipt shows chain:', /Chain verified/.test(await p.textContent('main'))); lap('receipt with ledger hash');
 // 4 judge panel dispute
 await p.evaluate(()=>{const pn=document.querySelector('.judge__panel'); if(pn.hidden) document.querySelector('.judge__toggle').click();}); await p.waitForTimeout(300); await p.click('.judge__panel button:has-text("Dispute")'); await p.waitForTimeout(3500); lap('judge: dispute stage');
 const body=(await p.textContent('main')).replace(/\s+/g,' '); console.log('   m1 frozen & m2 not:', /Frozen: disputed/.test(body), /Delivered, in review/.test(body));
 // 5 ledger verified -> tamper -> restore
 const lp=await p.evaluate(()=>[...document.querySelectorAll('a[href^="/ledger/"]')][0]?.getAttribute('href')); await p.goto(U+lp); await p.waitForTimeout(2200); console.log('   ledger:', await p.textContent('.verify strong'));
 await p.evaluate(()=>{const pn=document.querySelector('.judge__panel'); if(pn.hidden) document.querySelector('.judge__toggle').click();}); await p.waitForTimeout(300); await p.click('button:has-text("Tamper ledger")'); await p.waitForTimeout(3800); const tx=await p.textContent('.verify strong'); console.log('   after tamper:',tx);
 await p.screenshot({path:S+'40-tamper-live.png'}); await p.click('button:has-text("Restore ledger")'); await p.waitForTimeout(3800); console.log('   after restore:', await p.textContent('.verify strong')); lap('ledger tamper + restore (live polling, no reload)');
 // 6 honesty
 await p.goto(U+'/#honesty'); await p.waitForTimeout(2500); console.log('   honesty section present:', /Simulated in test mode/.test(await p.textContent('#honesty'))); lap('honesty section');
 console.log('ERRORS:',errs.join('|')||'none'); await b.close(); })();
