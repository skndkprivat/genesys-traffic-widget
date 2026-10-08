// Genesys Cloud sign-in for the widget: OAuth 2.0 Authorization Code + PKCE (no client secret).
//
// The widget runs as a Client Application inside Genesys Cloud. Genesys opens it with the
// URL configured on the integration, e.g.
//   https://host/traffic/?clientId=<oauth client id>&gcHostOrigin={{gcHostOrigin}}&gcLangTag={{gcLangTag}}
// The region comes from the org the user is working in (gcHostOrigin / pcEnvironment), so the
// token is always for that org and carries the signed-in user's own permissions. Because the
// user is already signed in to Genesys Cloud, the login redirect normally completes silently.

const CTX_KEY = 'tw-ctx';       // { clientId, region, lang, theme } — survives the login redirect
const PKCE_KEY = 'tw-pkce';     // verifier/state while the frame is at the login page
const TOKEN_KEY = 'tw-token';   // { token, exp, region, clientId } — this frame only
const PERIOD_KEY = 'tw-period';
const LAST_LOGIN_KEY = 'tw-last-login';

const REGION = /^(mypurecloud\.(com|ie|de|jp|com\.au)|[a-z0-9]+\.pure\.cloud)$/;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ss = { get: k => { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
             set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
             del: k => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } } };

// "https://apps.mypurecloud.de" → "mypurecloud.de"; "mypurecloud.de" → itself; anything else → ''.
export function regionFrom(value) {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  try { if (host.includes('://')) host = new URL(host).hostname; } catch { return ''; }
  host = host.replace(/^(apps|login|api)\./, '');
  return REGION.test(host) ? host : '';
}

// Reads the launch parameters. Explicit `region` wins, then pcEnvironment, then gcHostOrigin.
// Without parameters (after the login redirect) the context saved earlier in this frame is used.
export function readContext(search = location.search) {
  const p = new URLSearchParams(search);
  const fresh = {
    clientId: (p.get('clientId') || p.get('clientid') || '').trim().toLowerCase(),
    region: regionFrom(p.get('region')) || regionFrom(p.get('pcEnvironment')) || regionFrom(p.get('gcHostOrigin')),
    lang: (p.get('gcLangTag') || p.get('lang') || '').toLowerCase(),
    theme: (p.get('theme') || '').toLowerCase(),
  };
  const saved = ss.get(CTX_KEY) || {};
  const ctx = {
    clientId: fresh.clientId || saved.clientId || '',
    region: fresh.region || saved.region || '',
    lang: fresh.lang || saved.lang || '',
    theme: fresh.theme || saved.theme || '',
  };
  if (fresh.clientId || fresh.region) ss.set(CTX_KEY, ctx);
  const problems = [];
  if (!CLIENT_ID.test(ctx.clientId)) problems.push('clientId');
  if (!ctx.region) problems.push('region');
  return { ...ctx, ok: !problems.length, problems };
}

export const redirectUri = () => location.origin + location.pathname;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

let ctx = null;
export const setContext = c => { ctx = c; };

export function getSession() {
  const t = ss.get(TOKEN_KEY);
  if (!t || !ctx || t.clientId !== ctx.clientId || t.region !== ctx.region) return null;
  if (Date.now() > t.exp) { ss.del(TOKEN_KEY); return null; }
  return t;
}
export function logout() { ss.del(TOKEN_KEY); }

export async function startLogin() {
  const verifier = rand(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = rand(16);
  ss.set(PKCE_KEY, { verifier, state, region: ctx.region, clientId: ctx.clientId });
  ss.set(LAST_LOGIN_KEY, Date.now());
  const u = new URL(`https://login.${ctx.region}/oauth/authorize`);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: ctx.clientId, redirect_uri: redirectUri(),
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  location.assign(u.toString());
}

// True when the URL carries an OAuth redirect this frame started.
export function isLoginRedirect() {
  const p = new URLSearchParams(location.search);
  return !!(p.get('code') || p.get('error')) && !!ss.get(PKCE_KEY);
}

// True when a login was started in the last minute — used to avoid a redirect loop.
export const recentLoginAttempt = () => Date.now() - (ss.get(LAST_LOGIN_KEY) || 0) < 60000;

export async function completeLogin() {
  const p = new URLSearchParams(location.search);
  const pending = ss.get(PKCE_KEY);
  history.replaceState(null, '', location.pathname);   // never leave the code in the URL
  ss.del(PKCE_KEY);
  if (!pending) throw new Error('No login in progress');
  if (p.get('error')) throw new Error(p.get('error_description') || p.get('error'));
  if (p.get('state') !== pending.state) throw new Error('State mismatch');
  const res = await fetch(`https://login.${pending.region}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: p.get('code'), redirect_uri: redirectUri(),
      client_id: pending.clientId, code_verifier: pending.verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const j = await res.json();
  ss.set(TOKEN_KEY, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 - 30000, region: pending.region, clientId: pending.clientId });
}

async function api(path, opts = {}) {
  const s = getSession();
  if (!s) throw new Error('auth');
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://api.${s.region}${path}`, {
      ...opts, headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 401) { logout(); throw new Error('auth'); }
    if (res.status === 403) throw new Error('forbidden');
    if (res.status === 429) { await sleep((+res.headers.get('Retry-After') || 2) * 1000); continue; }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.message || j.error || ''; } catch { /* no body */ }
      const e = new Error(`API ${res.status}${detail ? ' – ' + detail : ''}`);
      e.status = res.status;
      throw e;
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error('rate-limited');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const whoAmI = () => api('/api/v2/users/me');
export const orgName = async () => (await api('/api/v2/organizations/me')).name || '';

export function loadPeriod() { try { return localStorage.getItem(PERIOD_KEY) || 'd7'; } catch { return 'd7'; } }
export function savePeriod(p) { try { localStorage.setItem(PERIOD_KEY, p); } catch { /* ignore */ } }

// Start/end for a period key. Analytics jobs accept at most 31 days per interval,
// so longer periods are fetched in consecutive chunks.
export function periodRange(period, now = new Date()) {
  if (period === 'hour') return [new Date(now.getTime() - 3600000), now];
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  if (period === 'yesterday') { const y = new Date(d); y.setDate(y.getDate() - 1); return [y, d]; }
  if (period === 'd30') d.setDate(d.getDate() - 30);
  else if (period === 'month') d.setDate(1);
  else if (period === 'ytd') { d.setMonth(0, 1); }
  else d.setDate(d.getDate() - 7);
  return [d, now];
}

// Inbound conversation details for a period via async analytics jobs. Each result page
// is passed through `parse` straight away, so raw payloads never pile up in memory.
export async function fetchLiveConversations(period, parse, onProgress = () => {}) {
  const [from, to] = periodRange(period);
  onProgress('queues');
  const queueNames = new Map();
  for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
    const r = await api(`/api/v2/routing/queues?pageSize=500&pageNumber=${page}`);
    pages = r.pageCount || 1;
    (r.entities || []).forEach(q => queueNames.set(q.id, q.name));
  }
  const CHUNK = 30 * 86400000;
  const chunks = [];
  for (let t = from.getTime(); t < to.getTime(); t += CHUNK) chunks.push([t, Math.min(t + CHUNK, to.getTime())]);
  const out = [];
  let filterUsed = '';
  for (let ci = 0; ci < chunks.length; ci++) {
    const [a, b] = chunks[ci];
    onProgress('job', out.length, ci + 1, chunks.length);
    const interval = `${new Date(a).toISOString()}/${new Date(b).toISOString()}`;
    const dim = (dimension, value) => ({ type: 'dimension', dimension, value });
    // Preferred: voice + inbound as a segment filter. If Genesys rejects it (400),
    // fall back to the plain inbound conversation filter that is known to work.
    const bodies = [
      { interval, order: 'asc', orderBy: 'conversationStart',
        segmentFilters: [{ type: 'and', predicates: [dim('mediaType', 'voice'), dim('originatingDirection', 'inbound')] }] },
      { interval, order: 'asc', orderBy: 'conversationStart',
        conversationFilters: [{ type: 'and', predicates: [dim('originatingDirection', 'inbound')] }] },
    ];
    let jobId;
    for (let i = 0; i < bodies.length; i++) {
      filterUsed = i === 0 ? 'segment' : 'fallback';
      try {
        ({ jobId } = await api('/api/v2/analytics/conversations/details/jobs', { method: 'POST', body: JSON.stringify(bodies[i]) }));
        break;
      } catch (e) {
        if (e.status !== 400 || i === bodies.length - 1) throw e;
      }
    }
    for (;;) {
      const j = await api(`/api/v2/analytics/conversations/details/jobs/${jobId}`);
      if (j.state === 'FULFILLED') break;
      if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(j.state)) throw new Error(`Job ${j.state}`);
      await sleep(2000);
    }
    let cursor = '';
    do {
      const r = await api(`/api/v2/analytics/conversations/details/jobs/${jobId}/results?pageSize=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      for (const c of parse(r.conversations || [], queueNames)) out.push(c);
      cursor = r.cursor || '';
      onProgress('results', out.length, ci + 1, chunks.length);
    } while (cursor);
  }
  out.sort((x, y) => x.start - y.start);
  out.filterUsed = filterUsed;   // which request body Genesys accepted
  return out;
}
