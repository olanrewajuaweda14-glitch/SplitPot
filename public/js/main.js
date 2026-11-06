// Router, navigation, opener, directional view transitions. No framework.
import { h, s, icon, staticSvg, reduceMotion, session, $ } from './ui.js';
import { getConfig } from './api.js';
import { mountJudge } from './judge.js';
import { me, current, onAuth, signOut, safeNext } from './auth.js';

const routes = [
  [/^\/$/, () => import('./views/landing.js'), { nav: 'dark' }],
  [/^\/enter$/, () => import('./views/enter.js'), { nav: 'light' }],
  [/^\/new$/, () => import('./views/create.js'), { nav: 'light' }],
  [/^\/demo$/, () => import('./views/demo.js'), { nav: 'dark' }],
  [/^\/p\/(lead|collab|client|reviewer)\/([\w-]+)$/, () => import('./views/project.js'), { nav: 'dark' }],
  [/^\/ledger\/([\w-]+)$/, () => import('./views/ledger.js'), { nav: 'light' }],
  [/^\/receipt\/([\w-]+)\/([\w-]+)$/, () => import('./views/receipt.js'), { nav: 'light' }],
  [/^\/checkout\/([\w.-]+)$/, () => import('./views/checkout.js'), { nav: 'light' }],
  [/^\/paid$/, () => import('./views/paid.js'), { nav: 'dark' }],
  [/^\/(signup|login|forgot)$/, () => import('./views/auth.js'), { nav: 'light', guest: true }],
  [/^\/reset\/([\w-]+)$/, () => import('./views/auth.js'), { nav: 'light', page: 'reset' }],
  [/^\/welcome$/, () => import('./views/welcome.js'), { nav: 'light', auth: true }],
  [/^\/(dashboard)$/, () => import('./views/dashboard.js'), { nav: 'light', auth: true }],
  [/^\/(payouts)$/, () => import('./views/payouts.js'), { nav: 'light', auth: true }],
  [/^\/(activity)$/, () => import('./views/activity.js'), { nav: 'light', auth: true }],
  [/^\/(settings)$/, () => import('./views/settings.js'), { nav: 'light', auth: true }],
];

const main = $('#main'); let cleanup = null; let currentPath = null; let config = null; let order = 0; const trail = [];

export const MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 10h22l-2 9.500a8 8 0 01-7.800 6.500h-4.400A8 8 0 017 19.500z" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linejoin="round"/><path d="M7.400 17h17.200l-.7 3a7 7 0 01-6.800 5.500h-3.200a7 7 0 01-6.800-5.500z" fill="#E9A23B"/><path d="M16 3v4" stroke="currentColor" stroke-width="2.400" stroke-linecap="round"/></svg>';

const APP_LINKS = [['Dashboard', '/dashboard'], ['Payouts', '/payouts'], ['Activity', '/activity'], ['Settings', '/settings']];
function renderNav(theme) {
  const nav = $('#nav'); nav.className = `nav nav--${theme}`; nav.textContent = '';
  const sheet = h('div', { class: 'nav__sheet', hidden: true });
  const u = current();
  const links = u ? [...APP_LINKS, ...(config?.demoMode ? [['Judge demo', '/demo']] : [])] : [['How it works', '/#how'], ['Who sees what', '/#roles'], ['What is real', '/#honesty'], ...(config?.demoMode ? [['Judge demo', '/demo']] : [])];
  const logout = () => h('button', { class: 'btn btn--line btn--sm', type: 'button', 'data-logout': '', onclick: async () => { await signOut(); navigate('/'); } }, 'Log out');
  const toggle = h('button', { class: 'nav__toggle', type: 'button', 'aria-label': 'Open menu', 'aria-expanded': 'false', onclick: () => { const open = sheet.hidden; sheet.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); toggle.replaceChildren(icon(open ? 'close' : 'menu', 22)); } }, icon('menu', 22));
  sheet.append(...links.map(([t, href]) => h('a', { href, 'data-link': '', onclick: () => { sheet.hidden = true; } }, t)),
    ...(u ? [h('a', { class: 'btn btn--amber', href: '/new', 'data-link': '', onclick: () => { sheet.hidden = true; } }, 'Start a Split'), h('button', { class: 'btn btn--line-dark', type: 'button', 'data-logout': '', onclick: async () => { await signOut(); navigate('/'); } }, 'Log out')]
      : [h('a', { class: 'btn btn--line-dark', href: '/login', 'data-link': '', onclick: () => { sheet.hidden = true; } }, 'Log in'), h('a', { class: 'btn btn--amber', href: '/new', 'data-link': '', onclick: () => { sheet.hidden = true; } }, 'Start a Split')]));
  nav.append(h('div', { class: 'wrap nav__in' },
    h('a', { class: 'brand', href: '/', 'data-link': '', 'aria-label': 'SplitPot home' }, staticSvg(MARK), 'SplitPot'),
    h('nav', { class: 'nav__links', 'aria-label': 'Main' }, ...links.map(([t, href]) => h('a', { href, 'data-link': '' }, t)), h('a', { href: '/enter', 'data-link': '' }, 'Open a link'), ...(u ? [h('span', { class: 'nav__user', title: u.email }, u.name.split(' ')[0]), logout()] : [h('a', { href: '/login', 'data-link': '' }, 'Log in')]), h('a', { class: `btn btn--amber btn--sm nav__cta`, href: '/new', 'data-link': '' }, 'Start a Split')),
    toggle), sheet);
}

function renderFooter() {
  const f = $('#footer'); f.textContent = '';
  f.append(h('div', { class: 'wrap' },
    h('a', { class: 'brand', href: '/', 'data-link': '' }, staticSvg(MARK), 'SplitPot'),
    h('small', {}, 'SplitPot is a student-built prototype made for the Access Youth Tech Forge. It runs in test mode. It is not a licensed payment company, it does not hold real funds, and no real money moves. Seeded projects are labelled SYNTHETIC DEMO DATA. The 1.5% fee is an assumption for the prototype, not a quote.'),
    h('div', { class: 'foot-links' }, h('a', { href: '/#honesty', 'data-link': '' }, 'What is simulated'), h('a', { href: '/new', 'data-link': '' }, 'Start a Split'), h('a', { href: '/enter', 'data-link': '' }, 'Open a project link'), h('a', { href: current() ? '/dashboard' : '/login', 'data-link': '' }, current() ? 'Dashboard' : 'Log in'), ...(config?.demoMode ? [h('a', { href: '/demo', 'data-link': '' }, 'Judge demo')] : []))));
}

function match(path) { for (const [re, load, opts] of routes) { const m = re.exec(path); if (m) return { load, opts, params: m.slice(1) }; } return null; }

async function render(path, { back = false, first = false } = {}) {
  const m = match(path.split('?')[0].split('#')[0]);
  const run = async () => {
    cleanup?.(); cleanup = null; window.scrollTo(0, 0);
    main.textContent = ''; main.removeAttribute('data-route');
    const theme = m?.opts.nav ?? 'light'; renderNav(theme); renderFooter();
    if (!m) { main.append(h('div', { class: 'wrap page' }, h('h1', {}, 'That page does not exist'), h('p', { style: { margin: '14px 0 22px' } }, 'The link may be mistyped.'), h('a', { class: 'btn', href: '/', 'data-link': '' }, 'Go to the start'))); return; }
    main.append(h('div', { class: 'loader-wrap' }));
    if (m.opts.auth || m.opts.guest) {
      await me();
      if (m.opts.auth && !current()) { navigate(`/login?next=${encodeURIComponent(path.split('#')[0])}`, { replace: true }); return; }
      if (m.opts.guest && current()) { navigate(safeNext(new URLSearchParams(location.search).get('next')), { replace: true }); return; }
    }
    let mod;
    try { mod = await m.load(); } catch (e) { main.textContent = ''; main.append(h('div', { class: 'wrap page' }, h('h1', {}, 'Could not load this page'), h('p', {}, e.message))); return; }
    main.textContent = '';
    cleanup = (await mod.mount({ main, params: m.params, page: m.opts.page ?? (m.params[0] && /^(signup|login|forgot|dashboard|payouts|activity|settings)$/.test(m.params[0]) ? m.params[0] : undefined), config, first, navigate })) ?? null;
    const hash = location.hash;
    if (hash) requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }));
    main.focus({ preventScroll: true });
    document.title = mod.title ? `${mod.title}: SplitPot` : 'SplitPot: One payment. Everyone paid.';
  };
  if (!first && document.startViewTransition && !reduceMotion()) {
    document.documentElement.dataset.nav = back ? 'back' : 'fwd';
    const vt = document.startViewTransition(run); vt.ready.catch(() => {}); vt.updateCallbackDone.catch(() => {}); try { await vt.finished; } catch { /* aborted by a newer navigation */ }
  } else await run();
  currentPath = path;
}

export function navigate(path, { replace = false } = {}) {
  if (path === currentPath && !replace) { window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); return; }
  const [p, hash] = path.split('#');
  if (hash !== undefined && p === location.pathname) { history.pushState({ o: ++order }, '', path); document.getElementById(hash)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }); return; }
  import('./ui.js').then(({ potFlip }) => potFlip.capture());
  (replace ? history.replaceState : history.pushState).call(history, { o: ++order }, '', path);
  render(path);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]'); if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank' || a.hasAttribute('download') || a.protocol === 'blob:') return;
  const url = new URL(a.href, location.href); if (url.origin !== location.origin || /^\/(api|shared)\//.test(url.pathname)) return;
  e.preventDefault(); navigate(url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', (e) => { const o = e.state?.o ?? 0; const back = o < order; order = o; render(location.pathname + location.hash, { back }); });

function opener() {
  const el = $('#opener');
  if (reduceMotion() || session.get('sp-opened') || location.pathname !== '/') return Promise.resolve();
  session.set('sp-opened', '1');
  return new Promise((done) => {
    el.hidden = false; el.setAttribute('aria-hidden', 'true');
    el.append(staticSvg(`<svg viewBox="0 0 760 300" aria-hidden="true"><path class="o-line" pathLength="1" d="M0 70 H250 C320 70 320 70 380 70"/><path class="o-line o-split" pathLength="1" d="M380 70 C440 70 440 30 520 30 H760"/><path class="o-line o-split" pathLength="1" d="M380 70 C440 70 440 70 520 70 H760" style="animation-delay:1.25s"/><path class="o-line o-split" pathLength="1" d="M380 70 C440 70 440 110 520 110 H760" style="animation-delay:1.4s"/><circle class="o-dot" cx="380" cy="70" r="7" style="animation-delay:1.05s"/><text class="o-word" x="0" y="225">SplitPot</text><text class="o-tag" x="4" y="270">One payment. Everyone paid.</text></svg>`), h('span', { class: 'opener__skip' }, 'Tap to skip'));
    let ended = false; const end = () => { if (ended) return; ended = true; el.classList.add('is-leaving'); setTimeout(() => { el.hidden = true; el.textContent = ''; el.classList.remove('is-leaving'); }, 900); done(); };
    el.onclick = end; setTimeout(end, 2900);
  });
}

(async function boot() {
  try { config = await getConfig(); } catch { config = { demoMode: false, feeBps: 150, provider: { name: 'mock', isMock: true }, banks: [] }; }
  await me();
  onAuth(() => renderNav(document.querySelector('#nav').className.includes('dark') ? 'dark' : 'light'));
  const op = opener();
  await render(location.pathname + location.search + location.hash, { first: true });
  history.replaceState({ o: 0 }, '');
  document.documentElement.classList.add('is-ready');
  const landing = $('.hero'); if (landing) { await op; landing.classList.add('hero--go'); }
  if (config.demoMode) mountJudge({ navigate });
})();
