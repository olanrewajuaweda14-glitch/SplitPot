// Sign up, log in, forgot password, reset password. One module, four screens.
import { h, icon, act, toast, abs, copyButton } from '../ui.js';
import { api } from '../api.js';
import { setUser, nextFromUrl } from '../auth.js';

const TITLES = { signup: 'Create your account', login: 'Log in', forgot: 'Reset your password', reset: 'Choose a new password' };
export let title = 'Log in';

const strength = (v) => { let s = 0; if (v.length >= 8) s++; if (v.length >= 12) s++; if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++; if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++; return v ? Math.max(1, s) : 0; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function pwField(id, label, { autocomplete, meter = false } = {}) {
  const input = h('input', { class: 'input', id, type: 'password', autocomplete, maxlength: 128, 'aria-describedby': `${id}-e` });
  const show = h('button', { type: 'button', 'aria-pressed': 'false', 'aria-label': `Show ${label.toLowerCase()}`, onclick: () => { const on = input.type === 'password'; input.type = on ? 'text' : 'password'; show.textContent = on ? 'Hide' : 'Show'; show.setAttribute('aria-pressed', String(on)); } }, 'Show');
  const err = h('p', { class: 'err', id: `${id}-e`, role: 'alert' });
  const m = meter ? h('div', { class: 'meter', 'data-s': '0', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')) : null;
  const hint = meter ? h('p', { class: 'hint', id: `${id}-h` }, 'At least 8 characters. A longer phrase is stronger.') : null;
  if (meter) input.addEventListener('input', () => { m.dataset.s = String(strength(input.value)); });
  return { input, err, el: h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'pwrow' }, input, show), m, hint, err) };
}
function textField(id, label, props = {}) {
  const input = h('input', { class: 'input', id, maxlength: 120, 'aria-describedby': `${id}-e`, ...props });
  const err = h('p', { class: 'err', id: `${id}-e`, role: 'alert' });
  return { input, err, el: h('div', { class: 'field' }, h('label', { for: id }, label), input, err) };
}
const setErr = (f, msg) => { f.err.textContent = msg ?? ''; if (msg) f.input.setAttribute('aria-invalid', 'true'); else f.input.removeAttribute('aria-invalid'); return !msg; };

export function mount({ main, params, page, navigate }) {
  const kind = page ?? 'login';
  title = TITLES[kind];
  document.title = `${title}: SplitPot`;
  const form = h('form', { class: 'auth__form', novalidate: true });
  const formErr = h('p', { class: 'err', role: 'alert', 'data-form-error': '' });
  const next = nextFromUrl();
  const qs = location.search;

  if (kind === 'signup') {
    const name = textField('su-name', 'Your name', { autocomplete: 'name', maxlength: 60 }); const email = textField('su-email', 'Email', { type: 'email', autocomplete: 'email', inputmode: 'email' }); const pw = pwField('su-pw', 'Password', { autocomplete: 'new-password', meter: true });
    const go = h('button', { class: 'btn btn--amber btn--block', type: 'submit' }, 'Create my account');
    form.append(h('p', { class: 'sec__kicker' }, 'Sign up'), h('h1', { class: 'page-h' }, 'Create your account'), h('p', { class: 'sec__lead', style: { margin: '10px 0 24px' } }, 'One place for every split you lead or take part in.'), name.el, email.el, pw.el, formErr, go,
      h('p', { class: 'auth__alt' }, 'Already have an account? ', h('a', { href: `/login${qs}`, 'data-link': '' }, 'Log in')));
    form.onsubmit = async (e) => {
      e.preventDefault(); formErr.textContent = '';
      const okN = setErr(name, name.input.value.trim().length < 2 ? 'Enter your name (at least 2 characters).' : '');
      const okE = setErr(email, EMAIL_RE.test(email.input.value.trim()) ? '' : 'Enter a valid email address.');
      const okP = setErr(pw, pw.input.value.length < 8 ? 'Use at least 8 characters.' : '');
      if (!(okN && okE && okP)) { (!okN ? name : !okE ? email : pw).input.focus(); return; }
      const r = await act(go, () => api('POST', '/api/auth/signup', { name: name.input.value, email: email.input.value, password: pw.input.value }).catch((er) => { formErr.textContent = er.message; if (er.code === 'EMAIL_TAKEN') setErr(email, er.message); throw er; }));
      if (r) { setUser(r.user); toast('Account created. Welcome to SplitPot.', 'ok'); navigate(next !== '/dashboard' ? next : '/welcome', { replace: true }); }
    };
  } else if (kind === 'login') {
    const email = textField('li-email', 'Email', { type: 'email', autocomplete: 'email', inputmode: 'email' }); const pw = pwField('li-pw', 'Password', { autocomplete: 'current-password' });
    const go = h('button', { class: 'btn btn--amber btn--block', type: 'submit' }, 'Log in');
    form.append(h('p', { class: 'sec__kicker' }, 'Welcome back'), h('h1', { class: 'page-h' }, 'Log in'), h('p', { class: 'sec__lead', style: { margin: '10px 0 24px' } }, 'Your dashboard, payouts and activity are waiting.'), email.el, pw.el, h('p', { style: { marginTop: '-8px' } }, h('a', { href: '/forgot', 'data-link': '' }, 'Forgot your password?')), formErr, go,
      h('p', { class: 'auth__alt' }, 'New here? ', h('a', { href: `/signup${qs}`, 'data-link': '' }, 'Create an account')));
    form.onsubmit = async (e) => {
      e.preventDefault(); formErr.textContent = '';
      const okE = setErr(email, EMAIL_RE.test(email.input.value.trim()) ? '' : 'Enter the email you signed up with.'); const okP = setErr(pw, pw.input.value ? '' : 'Enter your password.');
      if (!(okE && okP)) { (!okE ? email : pw).input.focus(); return; }
      const r = await act(go, () => api('POST', '/api/auth/login', { email: email.input.value, password: pw.input.value }).catch((er) => { formErr.textContent = er.status === 429 ? 'Too many attempts. Wait a few minutes, then try again.' : er.message; throw er; }));
      if (r) { setUser(r.user); navigate(next, { replace: true }); }
    };
  } else if (kind === 'forgot') {
    const email = textField('fg-email', 'Email', { type: 'email', autocomplete: 'email', inputmode: 'email' }); const go = h('button', { class: 'btn btn--amber btn--block', type: 'submit' }, 'Get a reset link'); const out = h('div', { 'aria-live': 'polite' });
    form.append(h('p', { class: 'sec__kicker' }, 'Password recovery'), h('h1', { class: 'page-h' }, 'Reset your password'), h('p', { class: 'sec__lead', style: { margin: '10px 0 24px' } }, 'Enter your email. This prototype cannot send email, so the reset link appears on this screen.'), email.el, formErr, go, out, h('p', { class: 'auth__alt' }, h('a', { href: '/login', 'data-link': '' }, 'Back to log in')));
    form.onsubmit = async (e) => {
      e.preventDefault(); formErr.textContent = ''; out.replaceChildren();
      if (!setErr(email, EMAIL_RE.test(email.input.value.trim()) ? '' : 'Enter a valid email address.')) { email.input.focus(); return; }
      const r = await act(go, () => api('POST', '/api/auth/forgot', { email: email.input.value }).catch((er) => { formErr.textContent = er.message; throw er; }));
      if (r) out.append(h('div', { class: 'notice' }, h('p', {}, h('span', { class: 'stamp stamp--amber' }, 'Simulated'), ' ', r.note), h('p', {}, 'If that email has an account, this link will work for ', `${r.validForMinutes} minutes. It can be used once.`), h('p', {}, h('a', { class: 'btn btn--line btn--sm', href: r.resetPath, 'data-link': '', 'data-reset-link': '' }, 'Open the reset link')), h('div', { class: 'btnrow' }, copyButton(() => abs(r.resetPath), 'Copy reset link'))));
    };
  } else {
    const token = params[0]; const pw = pwField('rs-pw', 'New password', { autocomplete: 'new-password', meter: true }); const pw2 = pwField('rs-pw2', 'Repeat the new password', { autocomplete: 'new-password' });
    const go = h('button', { class: 'btn btn--amber btn--block', type: 'submit' }, 'Save my new password');
    form.append(h('p', { class: 'sec__kicker' }, 'Password recovery'), h('h1', { class: 'page-h' }, 'Choose a new password'), h('p', { class: 'sec__lead', style: { margin: '10px 0 24px' } }, 'Saving it signs you out everywhere else.'), pw.el, pw2.el, formErr, go);
    form.onsubmit = async (e) => {
      e.preventDefault(); formErr.textContent = '';
      const okP = setErr(pw, pw.input.value.length < 8 ? 'Use at least 8 characters.' : ''); const ok2 = setErr(pw2, pw.input.value === pw2.input.value ? '' : 'The two passwords do not match.');
      if (!(okP && ok2)) { (!okP ? pw : pw2).input.focus(); return; }
      const r = await act(go, () => api('POST', '/api/auth/reset', { token, password: pw.input.value }).catch((er) => { formErr.textContent = er.message; throw er; }));
      if (r) { toast('Password changed. Log in with the new one.', 'ok'); navigate('/login', { replace: true }); }
    };
  }

  const side = h('aside', { class: 'auth__side on-dark' }, h('h2', {}, 'ONE PAYMENT. EVERYONE PAID.'),
    h('p', {}, 'Your team does the work. SplitPot coordinates the money.'),
    h('ul', { class: 'plain' }, ...['Agree every share before the work starts', 'The client pays once, into a shared pot', 'Money moves milestone by milestone', 'Every move is written to a ledger anyone can verify'].map((t) => h('li', {}, icon('check'), t))),
    h('p', { class: 'hint' }, 'Prototype in test mode. No real money moves, and no email or SMS is sent.'));
  main.append(h('div', { class: 'wrap auth' }, form, side));
  (form.querySelector('input') ?? form).focus?.();
}
