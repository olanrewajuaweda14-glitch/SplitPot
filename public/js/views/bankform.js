// Bank + account number + "check the account name" block, shared by Welcome and Settings.
import { h, icon, act } from '../ui.js';
import { api } from '../api.js';

export function bankForm({ config, idp }) {
  const bank = h('select', { class: 'select', id: `${idp}-bk` }, h('option', { value: '' }, 'Choose your bank'), ...config.banks.map((b) => h('option', { value: b.code }, b.name)));
  const acct = h('input', { class: 'input input--num', id: `${idp}-ac`, inputmode: 'numeric', maxlength: 10, autocomplete: 'off', placeholder: '10 digits' });
  const resolved = h('p', { class: 'resolved', role: 'status' });
  const check = h('button', { class: 'btn btn--line btn--sm', type: 'button' }, 'Check the account name');
  const valid = () => bank.value && /^\d{10}$/.test(acct.value.trim());
  check.onclick = async () => {
    if (!valid()) { resolved.textContent = 'Choose a bank and enter all 10 digits first.'; return; }
    const r = await act(check, () => api('POST', '/api/me/resolve-account', { bankCode: bank.value, accountNumber: acct.value.trim() }).catch(() => null));
    resolved.replaceChildren(...(r ? [icon('check'), ` ${r.accountName}, ${r.bankName} ${r.masked}`] : ['Could not resolve that account. Check the digits.']));
  };
  return {
    el: h('div', {}, h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: bank.id }, 'Bank'), bank), h('div', { class: 'field' }, h('label', { for: acct.id }, 'Account number'), acct)), h('div', { class: 'btnrow' }, check), resolved),
    touched: () => !!(bank.value || acct.value.trim()),
    value: () => (valid() ? { bankCode: bank.value, accountNumber: acct.value.trim() } : null),
    clear: () => { bank.value = ''; acct.value = ''; resolved.textContent = ''; },
  };
}
