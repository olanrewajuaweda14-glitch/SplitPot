// The living financial network: contour lines, curved flow lines, connected nodes, drifting light
// particles, faint ledger numerals, soft radial highlights, three parallax depths.
//
// Restraint is part of the design: a handful of particles on SMIL paths, a few slow node pulses,
// parallax only while the pointer moves, everything paused when off-screen, hidden, or when the
// visitor prefers reduced motion.

import { s, reduceMotion } from './ui.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const W = 1600; const H = 900;

function loopPath(cx, cy, r, rnd, wobble = 0.07, squash = 0.62) {
  const n = 18; const ph = rnd() * 6.28; const ph2 = rnd() * 6.28;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + wobble * Math.sin(a * 2 + ph) + wobble * 0.55 * Math.sin(a * 3 + ph2);
    return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k * squash];
  });
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  let d = `M${mid(pts[n - 1], pts[0]).map((v) => v.toFixed(1)).join(' ')}`;
  for (let i = 0; i < n; i += 1) { const p = pts[i]; const m = mid(p, pts[(i + 1) % n]); d += ` Q${p[0].toFixed(1)} ${p[1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`; }
  return `${d}Z`;
}

const NUMERALS = ['₦ 400,000', '₦ 600,000', '0.015', '4,000 bps', 'NGN', '₦ 15,000', '10,000 bps', 'sha-256', '2,500', '72 h', '₦ 1,015,000', '1,500 bps', '0x7f3a', '5 d', 'ref 0412', '₦ 250,000', '₦ 150,000'];

export function mountNetwork(host, { seed = 11, nodes = 30, focus = { x: 0.7, y: 0.52 }, particles = 9, parallax = true, loops = 6 } = {}) {
  const rnd = rng(seed);
  const small = host.clientWidth < 700;
  const nNodes = small ? Math.round(nodes * 0.55) : nodes;
  const nParticles = reduceMotion() ? 0 : small ? Math.max(3, Math.round(particles * 0.5)) : particles;
  const fx = focus.x * W; const fy = focus.y * H;

  const svg = s('svg', { class: 'bgnet', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(s('defs', {},
    s('radialGradient', { id: `glowA${seed}`, cx: '50%', cy: '50%', r: '50%' }, s('stop', { offset: '0', 'stop-color': '#E9A23B', 'stop-opacity': '0.20' }), s('stop', { offset: '1', 'stop-color': '#E9A23B', 'stop-opacity': '0' })),
    s('radialGradient', { id: `glowB${seed}`, cx: '50%', cy: '50%', r: '50%' }, s('stop', { offset: '0', 'stop-color': '#5CCB9F', 'stop-opacity': '0.16' }), s('stop', { offset: '1', 'stop-color': '#5CCB9F', 'stop-opacity': '0' })),
  ));

  const layer = (depth) => { const g = s('g', { class: 'bglayer', 'data-depth': depth }); svg.append(g); return g; };
  const back = layer(0.25); const mid = layer(0.55); const front = layer(1);

  // radial highlights
  back.append(s('ellipse', { cx: fx, cy: fy, rx: 640, ry: 420, fill: `url(#glowA${seed})` }), s('ellipse', { cx: W * 0.12, cy: H * 0.85, rx: 520, ry: 340, fill: `url(#glowB${seed})` }));

  // thin contour lines (financial-diagram feel)
  for (let i = 0; i < loops; i += 1) back.append(s('path', { class: 'bg-contour', d: loopPath(fx, fy, 150 + i * 105, rnd, 0.05 + i * 0.006) }));

  // left-edge scale ticks
  const ticks = s('g', { class: 'bg-ticks' });
  for (let i = 0; i <= 20; i += 1) {
    const y = 90 + i * 36; const long = i % 5 === 0;
    ticks.append(s('line', { x1: 40, x2: long ? 66 : 54, y1: y, y2: y }));
    if (long) ticks.append(s('text', { x: 74, y: y + 4, class: 'bg-num' }, ['1M', '750k', '500k', '250k', '0'][i / 5]));
  }
  back.append(ticks);

  // scattered faint numerals
  for (let i = 0; i < (small ? 6 : 14); i += 1) {
    back.append(s('text', { class: 'bg-num', x: (60 + rnd() * (W - 160)).toFixed(0), y: (60 + rnd() * (H - 120)).toFixed(0), transform: `rotate(${((rnd() - 0.5) * 6).toFixed(1)})` }, NUMERALS[Math.floor(rnd() * NUMERALS.length)]));
  }

  // nodes by dart throwing, weighted away from the focus so the hero pot stays clear
  const pts = [];
  let guard = 0;
  while (pts.length < nNodes && guard++ < 4000) {
    const p = [60 + rnd() * (W - 120), 50 + rnd() * (H - 100)];
    if (Math.hypot(p[0] - fx, (p[1] - fy) * 1.3) < 190) continue;
    if (pts.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > (small ? 150 : 120))) pts.push(p);
  }
  const edgeSet = new Set(); const edges = [];
  pts.forEach((p, i) => {
    pts.map((q, j) => [j, Math.hypot(p[0] - q[0], p[1] - q[1])]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 2).forEach(([j, dist]) => {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (edgeSet.has(key)) return; edgeSet.add(key); edges.push([i, j, dist]);
    });
  });
  edges.forEach(([i, j], k) => {
    const a = pts[i]; const b = pts[j];
    const mx = (a[0] + b[0]) / 2; const my = (a[1] + b[1]) / 2; const nx = -(b[1] - a[1]); const ny = b[0] - a[0]; const l = Math.hypot(nx, ny) || 1; const bend = (rnd() - 0.5) * 0.34 * l;
    mid.append(s('path', { class: 'bg-edge', id: `bgE${seed}_${k}`, d: `M${a[0].toFixed(1)} ${a[1].toFixed(1)} Q${(mx + (nx / l) * bend).toFixed(1)} ${(my + (ny / l) * bend).toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}` }));
  });
  pts.forEach((p, i) => {
    const hub = i % 7 === 0;
    const g = s('g', { transform: `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})` });
    if (hub) g.append(s('circle', { class: 'bg-ring', r: 9 }));
    g.append(s('circle', { class: `bg-node${i % 5 === 1 ? ' bg-node--pulse' : ''}`, r: hub ? 3.4 : 2.2, style: i % 5 === 1 ? { animationDelay: `${(rnd() * -12).toFixed(1)}s`, animationDuration: `${(8 + rnd() * 6).toFixed(1)}s` } : undefined }));
    mid.append(g);
  });

  // drifting light particles along selected flow paths
  const flow = [...edges.keys()].sort((a, b) => edges[b][2] - edges[a][2]).slice(0, Math.max(nParticles, 1));
  for (let i = 0; i < nParticles; i += 1) {
    const k = flow[i % flow.length]; const dur = 9 + rnd() * 8;
    const dot = s('circle', { class: 'bg-spark', r: 2.4 },
      s('animateMotion', { dur: `${dur.toFixed(1)}s`, repeatCount: 'indefinite', begin: `${(-rnd() * dur).toFixed(1)}s`, keyPoints: i % 2 ? '1;0' : '0;1', keyTimes: '0;1', calcMode: 'linear' }, s('mpath', { href: `#bgE${seed}_${k}` })),
      s('animate', { attributeName: 'opacity', values: '0;0.95;0.95;0', keyTimes: '0;0.12;0.88;1', dur: `${dur.toFixed(1)}s`, repeatCount: 'indefinite', begin: `${(-rnd() * dur).toFixed(1)}s` }));
    front.append(dot);
  }
  host.prepend(svg);

  // ---- life-cycle: only animate while visible
  let visible = true;
  const setPaused = (p) => { svg.classList.toggle('is-paused', p); try { p ? svg.pauseAnimations() : svg.unpauseAnimations(); } catch { /* old browsers */ } };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; setPaused(!visible || document.hidden); }, { threshold: 0 });
  io.observe(host);
  const onVis = () => setPaused(!visible || document.hidden);
  document.addEventListener('visibilitychange', onVis);
  if (reduceMotion()) { try { svg.pauseAnimations(); } catch { /* ignore */ } svg.classList.add('is-paused'); }

  // ---- parallax: pointer + scroll, rAF-throttled, no continuous loop
  const layers = [...svg.querySelectorAll('.bglayer')];
  let px = 0; let py = 0; let scrollY = 0; let queued = false;
  const paint = () => { queued = false; for (const g of layers) { const d = Number(g.dataset.depth); g.style.transform = `translate3d(${(px * d * -16).toFixed(1)}px, ${(py * d * -10 + scrollY * d * -0.05).toFixed(1)}px, 0)`; } };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  const onMove = (e) => { const r = host.getBoundingClientRect(); px = ((e.clientX - r.left) / r.width - 0.5) * 2; py = ((e.clientY - r.top) / r.height - 0.5) * 2; queue(); };
  const onScroll = () => { if (visible) { scrollY = Math.min(window.scrollY, 900); queue(); } };
  if (parallax && !reduceMotion() && matchMedia('(pointer: fine)').matches) host.addEventListener('pointermove', onMove, { passive: true });
  if (parallax && !reduceMotion()) window.addEventListener('scroll', onScroll, { passive: true });

  return {
    svg,
    destroy() { io.disconnect(); document.removeEventListener('visibilitychange', onVis); host.removeEventListener('pointermove', onMove); window.removeEventListener('scroll', onScroll); svg.remove(); },
  };
}
