// API client + 3-second live polling with ETags.

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

let skew = 0; // server clock minus browser clock (the server clock includes Judge Mode's demo offset)
export const nowMs = () => Date.now() + skew;
export const syncClock = (serverNow) => { if (Number.isFinite(serverNow)) skew = serverNow - Date.now(); };

export async function api(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  if (res.status === 304) return { notModified: true, etag: res.headers.get('etag') };
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `Request failed (${res.status}).`);
  const etag = res.headers.get('etag');
  if (etag && json && typeof json === 'object') Object.defineProperty(json, '__etag', { value: etag, enumerable: false });
  return json;
}

let configP = null;
export const getConfig = () => (configP ??= api('GET', '/api/config').catch((e) => { configP = null; throw e; }));

/** Poll a role view every ~3s. Calls onData only when something changed. Pauses while the tab is hidden. */
export function pollView(token, { onData, onError, interval = 3000 }) {
  let etag = null; let stopped = false; let timer = null; let inflight = false; let failures = 0;
  const path = `/api/p/${encodeURIComponent(token)}`;
  async function tick() {
    if (stopped || inflight) return;
    if (document.hidden) { schedule(); return; }
    inflight = true;
    try {
      const r = await api('GET', path, undefined, etag ? { 'If-None-Match': etag } : {});
      failures = 0;
      if (!r.notModified) { etag = r.__etag ?? null; syncClock(r.serverNow); onData(r); }
    } catch (e) {
      failures += 1;
      if (e.status === 401 || e.status === 404) { stopped = true; onError?.(e); return; }
      if (failures === 3) onError?.(e);
    } finally { inflight = false; }
    schedule();
  }
  const schedule = () => { if (!stopped) { clearTimeout(timer); timer = setTimeout(tick, interval + Math.min(failures, 5) * 2000); } };
  const refresh = () => { etag = null; clearTimeout(timer); return tick(); };
  const onVisible = () => { if (!document.hidden) refresh(); };
  const onExternal = () => refresh();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('sp:refresh', onExternal);
  tick();
  return { refresh, stop() { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('sp:refresh', onExternal); } };
}

export const nudge = () => window.dispatchEvent(new Event('sp:refresh'));
