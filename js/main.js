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
    retry: 'Prøv igen',
  },
  en: {
    signingIn: 'Signing in to Genesys Cloud…',
    setupTitle: 'The widget is not set up',
    setupBody: 'Open it from Genesys Cloud (Client Application integration) with a URL like this:',
    setupMissing: 'Missing',
    setupRedirect: 'The OAuth client (Code Authorization / PKCE) needs this redirect URI:',
    setupPerms: 'Users need the permissions <code>analytics:conversationDetail:view</code> and <code>routing:queue:view</code>.',
    retry: 'Try again',
  },
};

const ctx = gc.readContext();
const lang = (() => { const l = (ctx.lang || navigator.language || 'en').slice(0, 2).toLowerCase(); return I18N[l] ? l : 'en'; })();
const t = key => W[lang]?.[key] ?? I18N[lang]?.[key] ?? W.en[key] ?? I18N.en[key] ?? key;

document.documentElement.lang = lang;
// The theme picked with the toolbar button wins, then ?theme, then the OS setting.
const savedTheme = (() => { try { return localStorage.getItem('tw-theme'); } catch { return null; } })();
const theme = [savedTheme, ctx.theme].find(v => v === 'dark' || v === 'light');
if (theme) document.documentElement.dataset.theme = theme;

const root = document.getElementById('root');
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
    <p>${t('setupPerms')}</p>`);
}

async function boot() {
  // ?demo shows the widget with demo data and no sign-in (for trying it out outside Genesys).
  if (new URLSearchParams(location.search).has('demo')) {
    initTraffic(root, t, toast);
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
  initTraffic(root, t, toast, { live: true, autoFetch: true, message });
}

boot().catch(e => notice(`<p>${esc(t('trafficLiveFailed'))}: ${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">${esc(t('retry'))}</button>`));
