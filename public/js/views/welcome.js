// First-run profile setup: phone and an optional saved payout account. Both can be skipped and changed later in Settings.
import { h, icon, act, toast } from '../ui.js';
import { api } from '../api.js';
import { current, setUser } from '../auth.js';
import { bankForm } from './bankform.js';

export const title = 'Set up your profile';

export function mount({ main, config, navigate }) {
  const u = current();
  const phone = h('input', { class: 'input', id: 'wp', type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: 18, placeholder: '+234 801 234 5678', 'aria-describedby': 'wp-e' });
  const phoneErr = h('p', { class: 'err', id: 'wp-e', role: 'alert' });
  const bank = bankForm({ config, idp: 'wb' });
  const bankErr = h('p', { class: 'err', role: 'alert', 'data-bank-error': '' });
  const finish = h('button', { class: 'btn btn--amber', type: 'submit' }, 'Save and go to my dashboard');
  const skip = h('a', { class: 'btn btn--ghost', href: '/dashboard', 'data-link': '' }, 'Skip for now');
  const f = h('form', { class: 'doc', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); phoneErr.textContent = ''; bankErr.textContent = '';
    const ph = phone.value.trim();
    if (ph && !/^\+?[0-9 ()-]{7,18}$/.test(ph)) { phoneErr.textContent = 'Enter a phone number with 7 to 18 digits, or leave it blank.'; phone.setAttribute('aria-invalid', 'true'); phone.focus(); return; }
    phone.removeAttribute('aria-invalid');
    if (bank.touched() && !bank.value()) { bankErr.textContent = 'Choose a bank and enter all 10 digits of the account number, or clear both fields to skip.'; return; }
    const r = await act(finish, async () => {
      let user = u;
      if (ph) user = await api('POST', '/api/me/profile', { phone: ph });
      if (bank.touched()) { const v = bank.value(); if (!v) throw new Error('Choose a bank and enter all 10 digits of the account number, or clear both fields to skip.'); user = await api('POST', '/api/me/bank', v); }
      return user;
    });
    if (r) { setUser(r); toast('Profile saved', 'ok'); navigate('/dashboard'); }
  } },
    h('div', { class: 'doc__body' },
      h('div', { class: 'field' }, h('label', { for: 'wp' }, 'Phone number (optional)'), phone, phoneErr, h('p', { class: 'hint' }, 'Stored on your profile only. We do not send SMS in this prototype.')),
      h('h2', { class: 'mini-h' }, 'Saved payout account (optional)'),
      h('p', { class: 'hint' }, 'Save it once and use it to confirm your share in any split with one tap. Test mode: banks and names are simulated.'),
      bank.el, bankErr, h('div', { class: 'btnrow', style: { marginTop: '14px' } }, finish, skip)));
  main.append(h('div', { class: 'wrap page page--narrow' }, h('p', { class: 'sec__kicker' }, 'Welcome'), h('h1', { class: 'page-h' }, `Nice to meet you, ${u.name.split(' ')[0]}`), h('p', { class: 'sec__lead', style: { margin: '10px 0 24px' } }, 'Two optional details make confirming your share faster. You can change both in Settings.'), f));
}
