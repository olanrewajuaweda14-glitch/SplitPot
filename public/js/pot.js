// The signature SplitPot graphic. State-driven: it only ever draws what the model says.
//   model = { totalKobo, funded, payLabel?, bands:[{id,title,amountKobo,state}], channels:[{id,name,bps,state,plannedKobo}] }
//   band states:    unfunded | waiting | delivered | frozen | releasing | paid | refunded | payout_failed
//   channel states: idle | paying | partial | paid | failed

import { s, reduceMotion, naira, pct } from './ui.js';

const W = 640; const H = 720;
const BOTTOM = 398; const TOP = 198; const HH = BOTTOM - TOP;
const BODY = 'M130 176 C130 318 178 404 320 404 C462 404 510 318 510 176';
const CLIP = 'M134 190 C136 312 182 398 320 398 C458 398 504 312 506 190 Z';

const ease = (t) => 1 - (1 - t) ** 3;
const bez = (p0, p1, p2, p3, t) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };

export function createPot(host, { compact = false, label = 'Payment pot' } = {}) {
  let uid = Math.random().toString(36).slice(2, 7);
  let model = null; let built = ''; let els = {}; const cur = {}; let tweens = new Set(); let raf = 0; let waveUntil = 0;

  const svg = s('svg', { class: 'pot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-labelledby': `pt${uid} pd${uid}` });
  const title = s('title', { id: `pt${uid}` }, label); const desc = s('desc', { id: `pd${uid}` }, '');
  svg.append(title, desc);
  host.append(svg);

  function build(m) {
    const key = `${m.bands.map((b) => b.id).join()}|${m.channels.map((c) => `${c.id}:${c.bps}`).join()}|${compact}`;
    if (key === built) return; built = key;
    [...svg.childNodes].forEach((n) => { if (n !== title && n !== desc) n.remove(); });
    els = { bands: {}, chan: {}, plate: {} };
    const defs = s('defs', {},
      s('clipPath', { id: `clip${uid}` }, s('path', { d: CLIP })),
      s('pattern', { id: `hatch${uid}`, width: 9, height: 9, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('rect', { width: 9, height: 9, fill: 'none' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 9, stroke: '#8CC0E0', 'stroke-width': 3, opacity: 0.85 })),
      s('linearGradient', { id: `shine${uid}`, x1: 0, x2: 1 }, s('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0 }), s('stop', { offset: 0.5, 'stop-color': '#fff', 'stop-opacity': 0.22 }), s('stop', { offset: 1, 'stop-color': '#fff', 'stop-opacity': 0 })));
    svg.append(defs);

    // contour rings + gauge (decorative, aria-hidden)
    const deco = s('g', { 'aria-hidden': 'true', class: 'pot-deco' });
    for (let i = 0; i < 4; i += 1) deco.append(s('ellipse', { cx: 320, cy: 300, rx: 250 + i * 34, ry: 210 + i * 30, class: 'pot-ring' }));
    if (!compact) {
      for (let i = 0; i <= 10; i += 1) { const y = BOTTOM - (HH * i) / 10; deco.append(s('line', { x1: 92, x2: i % 5 ? 104 : 114, y1: y, y2: y, class: 'pot-tick' })); }
      [['0', BOTTOM], ['50%', BOTTOM - HH / 2], ['100%', TOP]].forEach(([t, y]) => deco.append(s('text', { x: 86, y: y + 4, 'text-anchor': 'end', class: 'pot-num' }, t)));
    }
    svg.append(deco);

    // channels (behind the pot)
    const n = m.channels.length; const startSpan = [238, 402]; const gap = Math.min(4, 40 / n);
    const tot = m.channels.reduce((a, c) => a + c.bps, 0) || 10000;
    let cursor = startSpan[0]; const chG = s('g', { class: 'pot-channels' });
    const plateW = Math.min(compact ? 150 : 138, 600 / n - 8);
    m.channels.forEach((c, i) => {
      const span = ((startSpan[1] - startSpan[0]) * c.bps) / tot; const sx = cursor + span / 2; cursor += span;
      const ex = 40 + ((i + 0.5) * 560) / n; const w = Math.max(9, (c.bps / tot) * 128 - gap);
      const d = `M${sx.toFixed(1)} 392 C${sx.toFixed(1)} 480 ${ex.toFixed(1)} 520 ${ex.toFixed(1)} 640`;
      const base = s('path', { d, class: 'chan-edge', 'stroke-width': w + 3 }); const fill = s('path', { d, class: 'chan-fill', 'stroke-width': w });
      const flow = s('path', { d, class: 'chan-flow', 'stroke-width': Math.max(3, w * 0.34), pathLength: 100 });
      const solid = s('path', { d, class: 'chan-solid', 'stroke-width': w });
      chG.append(base, fill, solid, flow);
      const my = bez(392, 480, 520, 640, 0.52); const mx = bez(sx, sx, ex, ex, 0.52);
      chG.append(s('text', { x: mx.toFixed(1), y: (my + 5).toFixed(1), class: 'chan-pct', 'text-anchor': 'middle' }, pct(c.bps)));
      els.chan[c.id] = { solid, flow, d };
    });
    svg.append(chG);

    // pot body
    svg.append(s('path', { d: `${BODY} L506 190 L134 190 Z`, class: 'pot-inner' }));
    const bandG = s('g', { 'clip-path': `url(#clip${uid})` });
    m.bands.forEach((b) => {
      const g = s('g', { class: 'band' });
      const r = s('rect', { x: 120, width: 400, class: 'band__fill' }); const hz = s('rect', { x: 120, width: 400, class: 'band__hatch', fill: `url(#hatch${uid})` });
      const edge = s('line', { x1: 120, x2: 520, class: 'band__edge' });
      const t1 = s('text', { x: 320, class: 'band__t', 'text-anchor': 'middle' }, b.title); const t2 = s('text', { x: 320, class: 'band__a', 'text-anchor': 'middle' }, naira(b.amountKobo));
      const flash = s('rect', { x: 122, width: 396, class: 'band__flash', fill: 'none', pathLength: 100 });
      g.append(r, hz, flash, edge, t1, t2); bandG.append(g); els.bands[b.id] = { g, r, hz, edge, t1, t2, flash };
      cur[b.id] ??= 0;
    });
    const shine = s('rect', { x: 134, y: 190, width: 90, height: 210, fill: `url(#shine${uid})`, class: 'pot-shine' });
    svg.append(bandG, s('g', { 'clip-path': `url(#clip${uid})`, 'aria-hidden': 'true' }, shine));
    svg.append(s('path', { d: BODY, class: 'pot-wall' }), s('ellipse', { cx: 320, cy: 176, rx: 190, ry: 24, class: 'pot-rim' }), s('path', { d: 'M150 220 C152 280 172 340 214 372', class: 'pot-glint' }));

    // client source + pipe
    svg.append(s('path', { d: 'M320 52 L320 176', class: 'pipe', 'stroke-width': 14 }), s('path', { d: 'M320 52 L320 176', class: 'pipe-flow', pathLength: 100 }));
    els.pipe = svg.querySelector('.pipe'); els.pipeFlow = svg.querySelector('.pipe-flow');
    svg.append(s('rect', { x: 250, y: 8, width: 140, height: 44, rx: 4, class: 'plate' }), s('text', { x: 320, y: 27, 'text-anchor': 'middle', class: 'plate__name' }, 'Client'));
    els.pay = s('text', { x: 320, y: 44, 'text-anchor': 'middle', class: 'plate__st' }, ''); svg.append(els.pay);

    // destination plates
    m.channels.forEach((c, i) => {
      const ex = 40 + ((i + 0.5) * 560) / n; const g = s('g', { class: 'dest', transform: `translate(${(ex - plateW / 2).toFixed(1)} 640)` });
      const r = s('rect', { width: plateW, height: compact ? 62 : 70, rx: 4, class: 'dest__box' });
      const nm = s('text', { x: plateW / 2, y: 25, 'text-anchor': 'middle', class: 'dest__name' }, c.name.length > 11 ? `${c.name.slice(0, 10)}…` : c.name);
      const am = compact ? null : s('text', { x: plateW / 2, y: 44, 'text-anchor': 'middle', class: 'dest__amt' }, '');
      const st = s('text', { x: plateW / 2, y: compact ? 49 : 62, 'text-anchor': 'middle', class: 'dest__st' }, '');
      const tick = s('path', { d: `M${plateW - 24} 12 l5 5 l10 -11`, class: 'dest__tick', pathLength: 100 });
      g.append(r, nm, ...(am ? [am] : []), st, tick); svg.append(g); els.plate[c.id] = { g, am, st };
    });
    cur.__built = true;
  }

  function layout() {
    let y = BOTTOM;
    model.bands.forEach((b) => {
      const e = els.bands[b.id]; const hgt = cur[b.id]; const top = y - hgt; y = top;
      e.r.setAttribute('y', top.toFixed(1)); e.r.setAttribute('height', Math.max(0, hgt).toFixed(1));
      e.hz.setAttribute('y', top.toFixed(1)); e.hz.setAttribute('height', Math.max(0, hgt).toFixed(1));
      e.edge.setAttribute('y1', top.toFixed(1)); e.edge.setAttribute('y2', top.toFixed(1));
      e.flash.setAttribute('y', (top + 2).toFixed(1)); e.flash.setAttribute('height', Math.max(0, hgt - 4).toFixed(1));
      const show = hgt > 34; e.t1.setAttribute('y', (top + hgt / 2 - 2).toFixed(1)); e.t2.setAttribute('y', (top + hgt / 2 + 17).toFixed(1));
      e.t1.style.opacity = show ? 1 : 0; e.t2.style.opacity = show && !compact ? 1 : 0;
    });
  }

  function target(b) {
    const share = (HH * b.amountKobo) / (model.totalKobo || 1);
    if (!model.funded) return 0;
    return ['paid', 'releasing', 'refunded', 'payout_failed'].includes(b.state) ? 0 : share;
  }

  function run() {
    if (raf) return;
    const step = (t) => {
      raf = 0;
      for (const tw of [...tweens]) { const p = Math.min(1, (t - tw.t0) / tw.ms); cur[tw.id] = tw.from + (tw.to - tw.from) * ease(p); if (p >= 1) tweens.delete(tw); }
      layout();
      if (tweens.size) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function update(m, { animate = true } = {}) {
    const first = !model; const prev = model; model = m; build(m);
    const still = !animate || reduceMotion() || first;
    const total = m.totalKobo || 1;
    m.bands.forEach((b) => {
      const e = els.bands[b.id]; const old = prev?.bands.find((x) => x.id === b.id);
      e.g.setAttribute('class', `band band--${b.state}`);
      const to = target(b);
      if (still) { cur[b.id] = to; } else if (Math.abs((cur[b.id] ?? 0) - to) > 0.5) {
        const filling = to > (cur[b.id] ?? 0);
        tweens.add({ id: b.id, from: cur[b.id] ?? 0, to, t0: performance.now() + (filling ? 120 : 380), ms: filling ? 1500 : 1500 }); if (filling) waveUntil = performance.now() + 1800;
      }
      if (!still && old && old.state !== b.state) {
        e.g.classList.remove('fx-freeze', 'fx-glow'); void e.g.getBoundingClientRect();
        if (b.state === 'frozen') e.g.classList.add('fx-freeze'); if (b.state === 'delivered') e.g.classList.add('fx-glow');
      }
    });
    // tween start times use a future t0, so clamp p at 0
    tweens.forEach((tw) => { tw.t0 = Math.max(tw.t0, 0); });
    if (tweens.size) run(); else layout();

    // pipe + client plate
    const paying = !m.funded && m.payLabel === 'processing';
    els.pipe.setAttribute('class', `pipe ${m.funded ? 'is-funded' : ''}`); els.pipeFlow.setAttribute('class', `pipe-flow${paying ? ' is-on' : ''}${m.funded && !still ? ' is-pulse' : ''}`);
    els.pay.textContent = m.funded ? `Paid ${naira(m.totalKobo)}` : paying ? 'Verifying payment' : 'Waiting to pay';
    m.channels.forEach((c) => {
      const e = els.chan[c.id]; const p = els.plate[c.id];
      e.solid.setAttribute('class', `chan-solid chan--${c.state}`); e.flow.setAttribute('class', `chan-flow${c.state === 'paying' ? ' is-on' : ''}`);
      p.g.setAttribute('class', `dest dest--${c.state}`);
      p.st.textContent = { idle: 'Waiting', paying: 'Sending', partial: 'Part paid', paid: 'Paid', failed: 'Failed, retry' }[c.state];
      if (p.am) p.am.textContent = naira(c.state === 'paid' ? (c.paidKobo ?? c.plannedKobo) : c.plannedKobo);
    });
    desc.textContent = `${m.funded ? `Funded with ${naira(m.totalKobo)}.` : 'Not funded yet.'} ${m.bands.map((b) => `${b.title}: ${b.state.replace('_', ' ')}`).join('. ')}. ${m.channels.map((c) => `${c.name} ${pct(c.bps)}: ${c.state}`).join('. ')}.`;
    // surface shimmer only while rising
    svg.classList.toggle('is-rising', performance.now() < waveUntil);
    if (waveUntil > performance.now()) setTimeout(() => svg.classList.remove('is-rising'), waveUntil - performance.now());
  }

  return { el: svg, update, destroy() { cancelAnimationFrame(raf); svg.remove(); } };
}

/** Pot model from a project view's `pot` slice. */
export const potModel = (pot, payLabel) => ({ ...pot, payLabel, bands: pot.bands, channels: pot.channels });
