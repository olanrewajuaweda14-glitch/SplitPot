// Settings: personal info, notification filters, saved payout account, security. Every control calls the server.
import { h, icon, act, toast, confirmDialog } from '../ui.js';
import { api } from '../api.js';
import { current, setUser, signOut } from '../auth.js';
import { subnav, loadInto, head } from './appnav.js';
import { bankForm } from './bankform.js';

export const title = 'Settings';
const PREFS = [['funding', 'Funding and payments', 'Client payments verified or rejected'], ['confirmations', 'Agreements and confirmations', 'Splits created or revised, shares accepted or declined'], ['disputes', 'Disputes and refunds', 'Disputes opened, proposals, reviewer decisions'], ['payouts', 'Releases and payouts', 'Milestones approved, payouts sent, failed or retried']];

export function mount({ main, config, navigate }) {
  return loadInto(main, () => api('GET', '/api/auth/me').then((r) => r.user), (u, root, reload) => {
    setUser(u);
    const page = h('div', { class: 'wrap page' }); root.append(page);
    page.append(head('Settings', 'Your account'), subnav('settings'));

    // personal info
    const name = h('input', { class: 'input', id: 'st-name', value: u.name, maxlength: 60, autocomplete: 'name', 'aria-describedby': 'st-name-e' }); const nameErr = h('p', { class: 'err', id: 'st-name-e', role: 'alert' });
    const phone = h('input', { class: 'input', id: 'st-phone', value: u.phone, type: 'tel', maxlength: 18, autocomplete: 'tel', 'aria-describedby': 'st-phone-e' }); const phoneErr = h('p', { class: 'err', id: 'st-phone-e', role: 'alert' });
    const saveP = h('button', { class: 'btn btn--amber btn--sm', type: 'submit' }, 'Save changes');
    const info = h('form', { class: 'panel', novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); nameErr.textContent = phoneErr.textContent = '';
      if (name.value.trim().length < 2) { nameErr.textContent = 'Enter your name (at least 2 characters).'; name.focus(); return; }
      if (phone.value.trim() && !/^\+?[0-9 ()-]{7,18}$/.test(phone.value.trim())) { phoneErr.textContent = 'Enter a phone number with 7 to 18 digits, or leave it blank.'; phone.focus(); return; }
      const r = await act(saveP, () => api('POST', '/api/me/profile', { name: name.value, phone: phone.value }), { ok: 'Profile saved' }); if (r) setUser(r);
    } }, h('h2', {}, 'Personal information'), h('div', { class: 'grid2', style: { marginTop: '12px' } }, h('div', { class: 'field' }, h('label', { for: 'st-name' }, 'Name'), name, nameErr), h('div', { class: 'field' }, h('label', { for: 'st-phone' }, 'Phone'), phone, phoneErr)), h('div', { class: 'field' }, h('label', { for: 'st-email' }, 'Email'), h('input', { class: 'input', id: 'st-email', value: u.email, readonly: true, 'aria-describedby': 'st-email-h' }), h('p', { class: 'hint', id: 'st-email-h' }, 'Your email is your login and cannot be changed in this prototype.')), saveP);

    // notification filters
    const boxes = PREFS.map(([k, t, sub]) => { const cb = h('input', { type: 'checkbox', id: `pf-${k}`, checked: u.prefs[k] !== false }); cb.onchange = async () => { const r = await api('POST', '/api/me/prefs', { [k]: cb.checked }).catch((e) => { cb.checked = !cb.checked; toast(e.message, 'err'); return null; }); if (r) { setUser(r); toast(`${t}: ${cb.checked ? 'shown' : 'hidden'} in your activity feed`, 'ok', 2200); } }; return h('label', { class: 'toggle', for: cb.id }, cb, h('span', {}, h('strong', {}, t), h('small', {}, sub))); });
    const prefs = h('section', { class: 'panel' }, h('h2', {}, 'Notification preferences'), h('p', { class: 'hint' }, 'This prototype sends no email or SMS. These switches choose which events appear in your dashboard activity feed. The ledger always records everything.'), ...boxes);

    // payout account
    const bank = bankForm({ config, idp: 'st' });
    const saveB = h('button', { class: 'btn btn--amber btn--sm', type: 'button' }, u.defaultBank ? 'Replace saved account' : 'Save this account');
    saveB.onclick = async () => { const v = bank.value(); if (!v) { toast('Choose a bank and enter all 10 digits.', 'err'); return; } const r = await act(saveB, () => api('POST', '/api/me/bank', v), { ok: 'Payout account saved' }); if (r) { setUser(r); reload(); } };
    const clearB = u.defaultBank ? h('button', { class: 'btn btn--line btn--sm', type: 'button' }, 'Remove saved account') : null;
    if (clearB) clearB.onclick = async () => { if (!(await confirmDialog({ title: 'Remove your saved account?', body: 'Shares you already confirmed keep the account they were confirmed with. You can save a new one any time.', confirmLabel: 'Remove', tone: 'frozen' }))) return; const r = await act(clearB, () => api('POST', '/api/me/bank/clear'), { ok: 'Saved account removed' }); if (r) { setUser(r); reload(); } };
    const payment = h('section', { class: 'panel' }, h('h2', {}, 'Payment details'), h('p', { class: 'hint' }, 'Used when you tap “Use my saved account” while confirming a share. The full number never comes back to your browser; only the last four digits do.'),
      u.defaultBank ? h('div', { class: 'notice notice--ok', 'data-saved-bank': '' }, h('strong', {}, `${u.defaultBank.bankName} ${u.defaultBank.masked}`), h('div', {}, u.defaultBank.accountName)) : h('p', { class: 'hint' }, 'No account saved yet.'), bank.el, h('div', { class: 'btnrow', style: { marginTop: '12px' } }, saveB, clearB));

    // security
    const cur = h('input', { class: 'input', id: 'sc-cur', type: 'password', autocomplete: 'current-password', 'aria-describedby': 'sc-cur-e' }); const curErr = h('p', { class: 'err', id: 'sc-cur-e', role: 'alert' });
    const nw = h('input', { class: 'input', id: 'sc-new', type: 'password', autocomplete: 'new-password', 'aria-describedby': 'sc-new-e' }); const nwErr = h('p', { class: 'err', id: 'sc-new-e', role: 'alert' });
    const savePw = h('button', { class: 'btn btn--line btn--sm', type: 'submit' }, 'Change password');
    const pw = h('form', { class: 'panel', novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); curErr.textContent = nwErr.textContent = '';
      if (!cur.value) { curErr.textContent = 'Enter your current password.'; cur.focus(); return; }
      if (nw.value.length < 8) { nwErr.textContent = 'Use at least 8 characters.'; nw.focus(); return; }
      const r = await act(savePw, () => api('POST', '/api/me/password', { current: cur.value, next: nw.value }).catch((er) => { (er.code === 'PASSWORD_WRONG' ? curErr : nwErr).textContent = er.message; throw er; }), { ok: 'Password changed. Other devices were signed out.' });
      if (r) { cur.value = nw.value = ''; }
    } }, h('h2', {}, 'Security'), h('div', { class: 'grid2', style: { marginTop: '12px' } }, h('div', { class: 'field' }, h('label', { for: 'sc-cur' }, 'Current password'), cur, curErr), h('div', { class: 'field' }, h('label', { for: 'sc-new' }, 'New password'), nw, nwErr)), savePw);
    const out = h('button', { class: 'btn btn--line btn--sm', type: 'button' }, 'Sign out on all devices');
    out.onclick = async () => { if (!(await confirmDialog({ title: 'Sign out everywhere?', body: 'This ends every session, including this one. You will need to log in again.', confirmLabel: 'Sign out everywhere', tone: 'frozen' }))) return; const r = await act(out, () => api('POST', '/api/me/logout-all')); if (r) { setUser(null); toast('Signed out on all devices', 'ok'); navigate('/login'); } };
    const sess = h('section', { class: 'panel danger' }, h('h2', {}, 'Sessions'), h('p', { class: 'hint' }, 'Sessions last 14 days. Your password is stored only as a salted hash.'), h('div', { class: 'btnrow' }, out));
    page.append(h('div', { class: 'setgrid' }, info, prefs, payment, pw, sess));
  });
}
