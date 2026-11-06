import { h, act, naira, toast } from '../ui.js';
import { api } from '../api.js';
export const title = 'Simulated checkout';
export async function mount({ main, params, navigate, config }) {
  const [ref] = params; const ret = new URLSearchParams(location.search).get('return'); const back = ret && /^\/p\/client\/[\w-]+$/.test(ret) ? ret : '/paid';
  const root = h('div', { class: 'wrap page page--narrow' }, h('div', { class: 'loader' }, h('span', {}, 'Loading'))); main.append(root);
  try {
    const c = await api('GET', `/api/mock/checkout/${encodeURIComponent(ref)}`);
    const finish = async (btn, body, msg) => { const r = await act(btn, () => api('POST', `/api/mock/checkout/${encodeURIComponent(ref)}/complete`, body)); if (r) { toast(msg, 'ok'); setTimeout(() => navigate(back), 900); } };
    const pay = h('button', { class: 'btn btn--amber btn--block', type: 'button' }, `Pay ${naira(c.amountKobo)}`); const fail = h('button', { class: 'btn btn--line btn--block', type: 'button' }, 'Simulate a failed payment');
    pay.onclick = () => finish(pay, { outcome: 'success' }, 'Payment sent. Verifying it now.'); fail.onclick = () => finish(fail, { outcome: 'failed' }, 'Simulated failure recorded.');
    const demo = config.demoMode ? h('details', { class: 'judge-opts' }, h('summary', {}, 'Judge options: payments that must be rejected'), h('p', { class: 'hint' }, 'These show that the server checks the amount and currency itself.'), (() => { const a = h('button', { class: 'btn btn--line btn--sm', type: 'button' }, 'Pay ₦1,000 too little'); const b = h('button', { class: 'btn btn--line btn--sm', type: 'button' }, 'Pay in the wrong currency (USD)'); a.onclick = () => finish(a, { outcome: 'success', shortfallKobo: 100000 }, 'Underpayment sent. The server should reject it.'); b.onclick = () => finish(b, { outcome: 'success', currency: 'USD' }, 'Wrong currency sent. The server should reject it.'); return h('div', { class: 'btnrow' }, a, b); })()) : null;
    root.replaceChildren(h('div', { class: 'doc checkout' }, h('div', { class: 'doc__head' }, h('h1', { class: 'doc__title' }, 'Simulated checkout — test mode.'), h('span', { class: 'stamp' }, 'Simulated')), h('div', { class: 'doc__body' },
      h('p', { class: 'hint' }, 'This page stands in for a payment provider. No card is used and no real money moves.'), h('p', { class: 'receipt__amt num' }, naira(c.amountKobo)), h('p', {}, `${c.projectTitle}. Client: ${c.clientName}.`), c.status !== 'pending' ? h('p', { class: 'err' }, 'This simulated payment was already completed.') : h('div', { class: 'stack' }, pay, fail), demo)));
  } catch (e) { root.replaceChildren(h('h1', {}, 'Checkout not found'), h('p', {}, e.message)); }
}
