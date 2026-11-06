// Who is signed in. The session lives in an HttpOnly cookie the page cannot read, so we ask the server.
import { api } from './api.js';

let user; // undefined = not asked yet, null = anonymous
const listeners = new Set();

export async function me({ force = false } = {}) {
  if (user === undefined || force) {
    try { user = (await api('GET', '/api/auth/me')).user ?? null; } catch { user = null; }
  }
  return user;
}
export const current = () => user ?? null;
export function setUser(u) { user = u; for (const fn of listeners) fn(user); }
export const onAuth = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch { /* cookie is cleared server-side when reachable; either way drop local state */ }
  setUser(null);
}

/** Only same-site paths are allowed as a post-login destination (no open redirects). */
export function safeNext(raw, fallback = '/dashboard') {
  const v = String(raw ?? '');
  return /^\/(?!\/)[\w\-./?=&%#]*$/.test(v) && !v.startsWith('/api') ? v : fallback;
}
export const nextFromUrl = () => safeNext(new URLSearchParams(location.search).get('next'));
