// Start-up: read the launch parameters from Genesys Cloud, sign in to that org, show Traffic.
import { I18N } from './i18n.js';
import * as gc from './genesys-auth.js';
import { initTraffic } from './traffic.js';

// Texts only the widget needs; everything else comes from i18n.js.
const W = {
  da: {
    signingIn: 'Logger ind i Genesys Cloud…',
    setupTitle: 'Widget\'en mangler opsætning',
    setupBody: 'Åbn den fra Genesys Cloud (Client Application-integration) med en URL som denne:',
    setupMissing: 'Mangler',
    setupRedirect: 'OAuth-klienten (Code Authorization / PKCE) skal have denne redirect URI:',
    setupPerms: 'Brugeren skal have rettighederne <code>analytics:conversationDetail:view</code> og <code>routing:queue:view</code>.',
    setupTry: 'Eller åbn den direkte her (fx lokalt med npm start):',
    setupRegion: 'Region',
    setupOpen: 'Åbn med live data',
    setupDemo: 'Vis demo-data',
    retry: 'Prøv igen',
  },
  en: {
    signingIn: 'Signing in to Genesys Cloud…',
    setupTitle: 'The widget is not set up',
    setupBody: 'Open it from Genesys Cloud (Client Application integration) with a URL like this:',
    setupMissing: 'Missing',
    setupRedirect: 'The OAuth client (Code Authorization / PKCE) needs this redirect URI:',
    setupPerms: 'Users need the permissions <code>analytics:conversationDetail:view</code> and <code>routing:queue:view</code>.',
    setupTry: 'Or open it directly here (e.g. locally with npm start):',
    setupRegion: 'Region',
    setupOpen: 'Open with live data',
    setupDemo: 'Show demo data',
    retry: 'Try again',
  },
};

const ctx = gc.readContext();
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// The language picked in the toolbar wins, then gcLangTag / ?lang, then the browser language.
const LANGS = Object.keys(I18N);
let lang = [store.get('tw-lang'), ctx.lang, navigator.language, 'en'].map(l => (l || '').slice(0, 2).toLowerCase()).find(l => I18N[l]);
const t = key => W[lang]?.[key] ?? I18N[lang]?.[key] ?? W.en[key] ?? I18N.en[key] ?? key;
const setLang = l => { lang = l; document.documentElement.lang = l; store.set('tw-lang', l); };
const langOpts = () => ({ langs: LANGS, lang, onLang: setLang });

document.documentElement.lang = lang;
// The theme picked with the toolbar button wins, then ?theme, then the OS setting.
const theme = [store.get('tw-theme'), ctx.theme].find(v => v === 'dark' || v === 'light');
if (theme) document.documentElement.dataset.theme = theme;

const root = document.getElementById('root');
const REGIONS = ['mypurecloud.com', 'usw2.pure.cloud', 'cac1.pure.cloud', 'sae1.pure.cloud', 'mypurecloud.ie',
  'euw2.pure.cloud', 'mypurecloud.de', 'euc2.pure.cloud', 'mec1.pure.cloud', 'aps1.pure.cloud', 'mypurecloud.jp', 'apne2.pure.cloud',
  'apne3.pure.cloud', 'mypurecloud.com.au'];
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (type || '');
  setTimeout(() => { el.className = 'toast ' + (type || ''); }, 1800);
}

function notice(html) {
  root.classList.remove('traffic');
  root.innerHTML = `<div class="notice">${html}</div>`;
}

function showSetup() {
  const url = `${gc.redirectUri()}?clientId=<OAuth client ID>&gcHostOrigin={{gcHostOrigin}}&gcTargetEnv={{gcTargetEnv}}&gcLangTag={{gcLangTag}}`;
  notice(`<h2>${esc(t('setupTitle'))}</h2>
    <p>${esc(t('setupBody'))}</p><pre>${esc(url)}</pre>
    <p>${esc(t('setupMissing'))}: <b>${ctx.problems.map(esc).join(', ')}</b></p>
    <p>${esc(t('setupRedirect'))}</p><pre>${esc(gc.redirectUri())}</pre>
    <p>${t('setupPerms')}</p>
    <p>${esc(t('setupTry'))}</p>
    <form class="setup-form" method="get">
      <label>Client ID <input name="clientId" required pattern="[0-9a-fA-F-]{36}" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(ctx.clientId)}" /></label>
      <label>${esc(t('setupRegion'))} <input name="region" required list="regions" placeholder="mypurecloud.de" value="${esc(ctx.region)}" /></label>
      <datalist id="regions">${REGIONS.map(r => `<option value="${r}"></option>`).join('')}</datalist>
      <input type="hidden" name="lang" value="${lang}" />
      <button class="btn primary">${esc(t('setupOpen'))}</button>
      <a class="btn" href="?demo&lang=${lang}">${esc(t('setupDemo'))}</a>
    </form>`);
}

async function boot() {
  // ?demo shows the widget with demo data and no sign-in (for trying it out outside Genesys).
  if (new URLSearchParams(location.search).has('demo')) {
    initTraffic(root, t, toast, langOpts());
    root.querySelector('[data-tr="demo"]').click();
    return;
  }
  if (!ctx.ok) { showSetup(); return; }
  gc.setContext(ctx);
  let message = '';
  if (gc.isLoginRedirect()) {
    try { await gc.completeLogin(); } catch (e) { message = `${t('trafficLiveFailed')}: ${e.message}`; }
  } else if (!gc.getSession() && !gc.recentLoginAttempt()) {
    // The user is already signed in to Genesys Cloud, so this normally returns straight away.
    notice(`<p>${esc(t('signingIn'))}</p>`);
    await gc.startLogin();
    return;
  }
  if (!gc.getSession() && !message) message = t('trafficLogin');
  initTraffic(root, t, toast, { live: true, autoFetch: true, message, ...langOpts() });
}

boot().catch(e => notice(`<p>${esc(t('trafficLiveFailed'))}: ${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">${esc(t('retry'))}</button>`));
