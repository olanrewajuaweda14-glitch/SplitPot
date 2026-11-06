// Shared bits for signed-in screens: sub-navigation, load-with-skeleton, empty states, demo claim.
import { h } from '../ui.js';
import { skeleton } from '../ui.js';

const TABS = [['Dashboard', '/dashboard'], ['Payouts', '/payouts'], ['Activity', '/activity'], ['Settings', '/settings']];
export const subnav = (active) => h('nav', { class: 'subnav', 'aria-label': 'Account' }, ...TABS.map(([t, href]) => h('a', { href, 'data-link': '', ...(href === `/${active}` ? { 'aria-current': 'page' } : {}) }, t)));

/** Show a skeleton, run `load`, then call `draw(data, root)`. Errors get a retry button, never a blank page. */
export async function loadInto(main, load, draw) {
  const root = h('div', {}); main.replaceChildren(root); root.append(skeleton());
  let dead = false;
  const run = async () => {
    root.replaceChildren(skeleton());
    try { const d = await load(); if (!dead) { root.replaceChildren(); draw(d, root, run); } }
    catch (e) { if (dead) return; if (e.status === 401) { location.assign(`/login?next=${encodeURIComponent(location.pathname)}`); return; } root.replaceChildren(h('div', { class: 'wrap page' }, h('h1', {}, 'Could not load this page'), h('p', { style: { margin: '14px 0 22px' } }, e.message), h('button', { class: 'btn', type: 'button', onclick: run }, 'Try again'))); }
  };
  await run();
  return () => { dead = true; };
}

export const head = (kicker, title, ...actions) => h('div', { class: 'apphead' }, h('div', {}, h('p', { class: 'sec__kicker' }, kicker), h('h1', { class: 'page-h' }, title)), actions.length ? h('div', { class: 'btnrow' }, ...actions) : null);
