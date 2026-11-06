const { chromium, firefox, webkit, devices } = require('playwright'); const S = (process.env.SHOTS || require('path').join(require('os').tmpdir(), 'splitpot-shots')) + '/'; require('fs').mkdirSync(S, { recursive: true }); const U = process.env.BASE || 'http://localhost:4321';
const post=(u,b)=>fetch(U+u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());
(async()=>{ const b=await ({ chromium, firefox, webkit }[process.env.BROWSER || 'chromium']).launch(); const errs=[];
 const st=await post('/api/demo/stage',{stage:'disputed'}); const L=st.links;
 const routes=[['/', 'landing'],['/new','create'],['/demo','demo'],[L.lead,'lead'],[L.client,'client'],[L.collaborators[1].path,'collab'],[L.reviewer,'reviewer'],[L.ledger,'ledger']];
 const profiles={ 'iPhone SE (360-ish)': { ...devices['iPhone SE'] }, 'Pixel 7': devices['Pixel 7'], 'iPad Mini': devices['iPad Mini'], '360x740 Android': { viewport:{width:360,height:740}, deviceScaleFactor:2, isMobile:true, hasTouch:true, userAgent: devices['Pixel 7'].userAgent } };
 for (const [name,prof] of Object.entries(profiles)) {
   const ctx=await b.newContext(prof); const p=await ctx.newPage(); p.on('pageerror',e=>errs.push(name+' '+e.message)); p.on('console',m=>{if(m.type()==='error'&&!/TUNNEL|status of 4/.test(m.text()))errs.push(name+' '+m.text().slice(0,150))});
   for (const [r,label] of routes) { await p.goto(U+r); await p.waitForTimeout(label==='landing'?4200:2200);
     const m=await p.evaluate(()=>{ const ov=document.documentElement.scrollWidth-innerWidth; const small=[...document.querySelectorAll('a,button,input,select,textarea')].filter(e=>{const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&(r.height<40||r.width<40)&&e.type!=='checkbox'&&!e.closest('.skip')&&!e.classList.contains('skip')}).map(e=>(e.textContent||e.id||e.tagName).trim().slice(0,28)+` ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`); return {ov,small:small.slice(0,5),n:small.length}; });
     console.log(name.padEnd(20),label.padEnd(9),'overflow',m.ov,'smallTargets',m.n,m.small.join(' | ')); if (label==='landing'||label==='lead'||label==='create') await p.screenshot({path:S+`m-${name.split(' ')[0]}-${label}.png`,fullPage:false}); }
   await ctx.close(); }
 // reduced motion
 const rc=await b.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'}); const rp=await rc.newPage(); rp.on('pageerror',e=>errs.push('RM '+e.message));
 await rp.goto(U+'/'); await rp.waitForTimeout(1200);
 const rm=await rp.evaluate(()=>({openerHidden:document.getElementById('opener').hidden, h1Visible:[...document.querySelectorAll('.hero h1 .ln>span')].every(s=>getComputedStyle(s).transform==='none'||getComputedStyle(s).transform==='matrix(1, 0, 0, 1, 0, 0)'), heroLede:getComputedStyle(document.querySelector('.hero__lede')).opacity, sparks:document.querySelectorAll('.bg-spark').length, heroGo:document.querySelector('.hero').classList.contains('hero--go')}));
 console.log('REDUCED MOTION', JSON.stringify(rm)); await rp.screenshot({path:S+'rm-landing.png'});
 await rp.click('text=Fund the pot'); await rp.waitForTimeout(400); console.log('RM hero demo funded instantly:', /whole project is now in the pot/.test(await rp.textContent('.demo-line')));
 console.log('ERRORS:',errs.join('\n')||'none'); await b.close(); })();
