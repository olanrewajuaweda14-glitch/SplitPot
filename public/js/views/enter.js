import { h, icon, $ } from '../ui.js';
export const title = 'Open a project link';
export function mount({ main, config, navigate }) {
  const input = h('input', { class: 'input', id: 'lk', type: 'text', placeholder: 'https://…/p/client/…', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'lk-e' });
  const err = h('p', { class: 'err', id: 'lk-e', role: 'alert' });
  const go = (e) => { e.preventDefault(); const m = /\/(p\/(?:lead|collab|client|reviewer)\/[\w-]+|ledger\/[\w-]+|receipt\/[\w-]+\/[\w-]+)/.exec(input.value.trim()); if (!m) { err.textContent = 'That does not look like a SplitPot link. Paste the whole link you were sent.'; input.setAttribute('aria-invalid', 'true'); return; } navigate(`/${m[1]}`); };
  main.append(h('div', { class: 'wrap page page--narrow' },
    h('p', { class: 'sec__kicker' }, 'No accounts'), h('h1', { class: 'page-h' }, 'Open a project link'),
    h('p', { class: 'sec__lead' }, 'SplitPot has no logins. Each person gets a private link. Whoever holds the link can act in that role, so share it only with the right person.'),
    h('form', { class: 'doc', style: { marginTop: '28px' }, onsubmit: go, novalidate: true }, h('div', { class: 'doc__body' }, h('div', { class: 'field' }, h('label', { for: 'lk' }, 'Your link'), input, err), h('button', { class: 'btn', type: 'submit' }, 'Open', icon('arrow')))),
    config.demoMode ? h('p', { style: { marginTop: '22px' } }, 'No link yet? ', h('a', { href: '/demo', 'data-link': '' }, 'Open the judge demo'), ' for a seeded project marked SYNTHETIC DEMO DATA.') : null));
  input.focus();
}
