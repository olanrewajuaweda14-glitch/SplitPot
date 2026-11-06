// DOM helpers, formatters, rolling digits, toasts, icons. No innerHTML with user content anywhere.

import { formatNaira, bpsToPercentString } from '/shared/money.js';

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const NS = 'http://www.w3.org/2000/svg';

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, kids);
  return el;
}
export function s(tag, props, ...kids) {
  const el = document.createElementNS(NS, tag);
  applyProps(el, props);
  append(el, kids);
  return el;
}
/** Trusted STATIC markup only (icons, illustrations written by us). Never pass user data. */
export function staticSvg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ICONS = {
  check: '<path d="M4 12.5l5 5L20 6.500"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.500"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="1.500"/><path d="M5 15V6a2 2 0 012-2h9"/>',
  arrow: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  link: '<path d="M10 14a4 4 0 005.700 0l3-3a4 4 0 00-5.700-5.700l-1 1M14 10a4 4 0 00-5.700 0l-3 3a4 4 0 005.700 5.700l1-1"/>',
  print: '<path d="M7 9V4h10v5M7 17H5a1 1 0 01-1-1v-5a2 2 0 012-2h12a2 2 0 012 2v5a1 1 0 01-1 1h-2"/><rect x="7" y="14" width="10" height="6"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 8h16M4 16h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  retry: '<path d="M4 12a8 8 0 0114-5.300L20 9M20 4v5h-5M20 12a8 8 0 01-14 5.300L4 15M4 20v-5h5"/>',
  snow: '<path d="M12 3v18M4.200 7.500l15.600 9M4.200 16.500l15.600-9"/>',
  pot: '<path d="M4 8h16l-1.500 6.500A5 5 0 0113.600 18h-3.200a5 5 0 01-4.900-3.500z"/><path d="M12 3v3"/>',
};
export function icon(name, size = 18) {
  return staticSvg(`<svg xmlns="${NS}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] ?? ''}</svg>`);
}

// ---------- formatting ----------
export const naira = (kobo) => formatNaira(kobo);
export const nairaK = (kobo, forceKobo = false) => formatNaira(kobo, { forceKobo });
export const pct = (bps) => bpsToPercentString(bps);
const dateFmt = new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Lagos' });
const dateLong = new Intl.DateTimeFormat('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Lagos', timeZoneName: 'short' });
export const fmtDate = (ms) => dateFmt.format(new Date(ms));
export const fmtDateLong = (ms) => dateLong.format(new Date(ms));
export function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440); const hh = Math.floor((m % 1440) / 60); const mm = m % 60;
  if (d >= 1) return `${d}d ${hh}h`;
  if (hh >= 1) return `${hh}h ${String(mm).padStart(2, '0')}m`;
  return `${mm}m`;
}
export const shortHash = (hex) => (hex ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : '');

// ---------- status ----------
const STATUS = {
  awaiting_confirmations: ['Awaiting confirmations', 'waiting'], awaiting_funding: ['Awaiting funding', 'waiting'], active: ['Active', 'paid'], completed: ['Completed', 'paid'],
  pending: ['Waiting for delivery', 'waiting'], delivered: ['Delivered, in review', 'waiting'], closed: ['Closed', 'paid'], frozen: ['Frozen: disputed', 'frozen'],
  queued: ['Queued', 'waiting'], processing: ['Sending', 'waiting'], success: ['Paid', 'paid'], failed: ['Failed', 'fail'], unknown: ['Result unknown, safe to retry', 'waiting'], reversed: ['Reversed by the bank', 'fail'],
  confirmed: ['Confirmed', 'paid'], unconfirmed: ['Waiting to confirm', 'waiting'], funded: ['Funded', 'paid'], unfunded: ['Not funded', 'waiting'],
  invited: ['Invited', 'waiting'], viewed: ['Viewed, not yet accepted', 'waiting'], accepted: ['Accepted', 'paid'], declined: ['Declined', 'fail'], negotiating: ['Negotiating', 'frozen'], in_review: ['With reviewer (simulated)', 'frozen'], resolved: ['Resolved', 'paid'],
};
export function pill(key, label) {
  const [text, kind] = STATUS[key] ?? [key, 'neutral'];
  return h('span', { class: `pill pill--${kind}` }, label ?? text);
}
export const statusText = (key) => (STATUS[key] ?? [key])[0];

// ---------- rolling digits ----------
/** Render `text` into `el` with each digit as a vertical strip that rolls when the value changes. */
export function setRoll(el, text, { animate = true } = {}) {
  el.classList.add('roll');
  const still = !animate || reduceMotion();
  el.classList.toggle('roll--static', still);
  const chars = [...text];
  const prev = el._rollText;
  const sameShape = prev && prev.length === text.length && [...prev].every((c, i) => /\d/.test(c) === /\d/.test(chars[i]));
  if (!sameShape) {
    el.textContent = '';
    el._strips = [];
    for (const c of chars) {
      if (/\d/.test(c)) {
        const strip = h('span', { class: 'roll__strip' }, ...Array.from({ length: 10 }, (_, i) => h('span', {}, String(i))));
        el.append(h('span', { class: 'roll__d', 'aria-hidden': 'true' }, strip));
        el._strips.push(strip);
      } else el.append(h('span', { class: 'roll__sym', 'aria-hidden': 'true' }, c));
    }
  }
  el.setAttribute('role', 'text');
  el.setAttribute('aria-label', text);
  const digits = chars.filter((c) => /\d/.test(c)).map(Number);
  const apply = () => el._strips.forEach((st, i) => { st.style.transitionDelay = still ? '0ms' : `${(digits.length - 1 - i) * 55}ms`; st.style.transform = `translateY(${-digits[i]}em)`; });
  if (!sameShape && !still) { el._strips.forEach((st) => { st.style.transform = 'translateY(0)'; }); requestAnimationFrame(() => requestAnimationFrame(apply)); } else apply();
  el._rollText = text;
}
export function rollNaira(el, kobo, opts) { setRoll(el, naira(kobo), opts); }

// ---------- toasts, clipboard ----------
export function toast(msg, kind = 'info', ms = 4200) {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `toast${kind === 'ok' ? ' toast--ok' : kind === 'err' ? ' toast--err' : ''}` }, msg);
  host.append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s, transform .3s'; t.style.opacity = '0'; t.style.transform = 'translateY(10px)'; setTimeout(() => t.remove(), 320); }, ms);
}
export async function copyText(text, okMsg = 'Link copied') {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  toast(okMsg, 'ok', 2200);
}
export const abs = (path) => `${location.origin}${path}`;

export function copyButton(getText, label = 'Copy link') {
  const b = h('button', { class: 'btn btn--line btn--sm', type: 'button', onclick: () => copyText(getText()) }, icon('copy'), label);
  return b;
}

export function busy(btn, on) { btn.classList.toggle('is-busy', on); btn.disabled = on; }
/** Run an async action behind a button: busy state, error toast, no double submits. */
export async function act(btn, fn, { ok } = {}) {
  if (btn.classList.contains('is-busy')) return undefined;
  busy(btn, true);
  try {
    const r = await fn();
    if (ok) toast(ok, 'ok');
    return r;
  } catch (e) {
    toast(e.message || 'Something went wrong.', 'err', 6000);
    return undefined;
  } finally { busy(btn, false); }
}

export function loader(text = 'Loading…') {
  return h('div', { class: 'loader', role: 'status' },
    staticSvg(`<svg viewBox="0 0 64 64" aria-hidden="true"><defs><clipPath id="lc"><path d="M12 20h40l-3.500 16c-1.300 6-6.500 10-12.500 10h-8c-6 0-11.200-4-12.500-10z"/></clipPath></defs><path d="M12 20h40l-3.500 16c-1.300 6-6.500 10-12.500 10h-8c-6 0-11.200-4-12.500-10z" fill="none" stroke="currentColor" stroke-width="2.500" stroke-linejoin="round"/><g clip-path="url(#lc)"><rect class="fillrect" x="8" y="20" width="48" height="30" fill="#E9A23B"/></g></svg>`),
    h('span', {}, text));
}

/** Shared-element hand-off for the pot: remember where it was, FLIP it from there on the next page. */
export const potFlip = {
  rect: null,
  capture() { const el = document.querySelector('[data-pot]'); this.rect = el ? el.getBoundingClientRect() : null; },
  apply(el) {
    const from = this.rect; this.rect = null;
    if (!from || !el || reduceMotion() || !el.animate) return;
    const to = el.getBoundingClientRect();
    if (!to.width || !from.width) return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const sc = from.width / to.width;
    el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sc})`, opacity: 0.2 }, { transform: 'none', opacity: 1 }], { duration: 780, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)' });
  },
};

/** A strict "this value is in memory only" store for per-session UI bits. */
export const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
};

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }


// ---------- dialogs and skeletons ----------
/** Accessible confirmation modal. Resolves true on confirm, false on cancel/Escape/backdrop. Replaces window.confirm. */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'amber' }) {
  return new Promise((resolve) => {
    const prev = document.activeElement; const id = `dlg${Math.random().toString(36).slice(2, 8)}`;
    const ok = h('button', { class: `btn btn--${tone}`, type: 'button', 'data-confirm': '' }, confirmLabel);
    const no = h('button', { class: 'btn btn--line', type: 'button', 'data-cancel': '' }, cancelLabel);
    const box = h('div', { class: 'dlg', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': `${id}t`, 'aria-describedby': `${id}b` }, h('h2', { id: `${id}t` }, title), h('div', { id: `${id}b`, class: 'dlg__b' }, body), h('div', { class: 'btnrow dlg__a' }, no, ok));
    const back = h('div', { class: 'dlg-back' }, box);
    const done = (v) => { document.removeEventListener('keydown', key, true); back.remove(); document.body.classList.remove('has-dlg'); prev?.focus?.(); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Tab') { const f = [no, ok]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
    };
    ok.onclick = () => done(true); no.onclick = () => done(false);
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(false); });
    document.addEventListener('keydown', key, true);
    document.body.classList.add('has-dlg'); document.body.append(back); no.focus();
  });
}

/** Shimmering placeholder blocks shown while a screen loads. */
export function skeleton(kind = 'page') {
  const bar = (w, ht = 14) => h('span', { class: 'sk', style: { width: w, height: `${ht}px` } });
  if (kind === 'cards') return h('div', { class: 'sk-grid', 'aria-hidden': 'true' }, ...Array.from({ length: 4 }, () => h('div', { class: 'sk-card' }, bar('40%', 12), bar('70%', 30))));
  return h('div', { class: 'wrap page', role: 'status', 'aria-label': 'Loading' }, bar('22%', 12), bar('48%', 44), h('div', { style: { height: '22px' } }), h('div', { class: 'sk-grid', 'aria-hidden': 'true' }, ...Array.from({ length: 4 }, () => h('div', { class: 'sk-card' }, bar('40%', 12), bar('70%', 30)))), h('div', { style: { height: '22px' } }), h('div', { class: 'sk-card sk-card--tall', 'aria-hidden': 'true' }, bar('30%', 14), bar('100%', 90)), h('span', { class: 'vh' }, 'Loading'));
}

/** Show field-level validation: marks inputs invalid and writes the message to an alert region. */
export function fieldError(box, input, msg) { box.textContent = msg ?? ''; if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); } }
