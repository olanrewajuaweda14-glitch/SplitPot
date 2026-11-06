import { h } from '../ui.js';
export const title = 'Payment received';
export function mount({ main }) {
  main.append(h('section', { class: 'stage page-stage' }, h('div', { class: 'wrap page' }, h('h1', {}, 'Payment received'), h('p', { style: { margin: '14px 0 22px' } }, 'The simulated payment has been sent for verification. Open your client link to watch the pot fill.'), h('a', { class: 'btn btn--amber', href: '/enter', 'data-link': '' }, 'Open a project link'))));
}
