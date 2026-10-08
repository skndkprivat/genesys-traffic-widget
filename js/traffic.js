// Traffic widget: replays a period of Genesys conversations as dots flowing
// DID -> Architect flow(s) -> queue. Blue = reached an agent (conversation),
// red = ended without a conversation (e.g. hung up in the IVR).

const BLUE = '#3b82f6';
const GREEN = '#22c55e';
const RED = '#ef4444';
const HOP_MS = 1100;      // visual travel time per hop (real ms)
const LINGER_MS = 350;    // time a dot rests at its end node
const PERIODS = ['hour', 'yesterday', 'd7', 'd30', 'month', 'ytd'];

// ── Parsing ──────────────────────────────────────────────────────────────────
const cleanNum = s => String(s || '').replace(/^(tel|sip|mailto):/i, '');
// Phone numbers are masked to the last digits; e-mail addresses (the company's own mailbox) are shown in full
const maskNum = s => { s = cleanNum(s); return s.includes('@') ? s : s.length > 5 ? '••••• ' + s.slice(-5) : s || '?'; };

// Accepts Genesys Analytics conversation details ({conversations:[…]} or a bare array).
// Finds the conversation list in a page: a bare array, or the first array in
// conversations / entities / results / (any array-valued field).
export function listOf(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  for (const k of ['conversations', 'entities', 'results']) if (Array.isArray(obj[k])) return obj[k];
  return Object.values(obj).find(v => Array.isArray(v) && v.length && typeof v[0] === 'object') || [];
}

// Reads JSON text. Also accepts several pages pasted/saved back to back ({…}{…} or one per line)
// and a leading BOM. Returns an array of values; throws a readable error otherwise.
export function readJsonLoose(text) {
  text = String(text ?? '').replace(/^\uFEFF/, '').trim();
  try { return [JSON.parse(text)]; } catch (first) {
    const out = [];
    let depth = 0, inStr = false, esc = false, from = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') { if (depth++ === 0) from = i; }
      else if (ch === '}' || ch === ']') { if (--depth === 0 && from >= 0) { out.push(text.slice(from, i + 1)); from = -1; } }
    }
    try { const vals = out.map(t => JSON.parse(t)); if (vals.length) return vals; } catch { /* fall through */ }
    throw new Error(first.message);
  }
}

// "Answered" (blue) = somebody actually took the call:
//  - an agent/user participant with a connected ('interact') segment; if the export has no
//    segment types at all, the mere presence of an agent/user counts
//  - an external number the call was placed TO (session direction outbound) and connected,
//    i.e. a transfer out. An external participant with direction inbound is the CALLER and
//    does not count
//  - a transfer out of the IVR with no queue, unless it went to voicemail
export function isAnswered(parts, hadQueue) {
  const segs = p => (p.sessions || []).flatMap(x => x.segments || []);
  const connected = p => { const g = segs(p); return g.some(x => x.segmentType) ? g.some(x => x.segmentType === 'interact') : true; };
  let voicemail = false, ivrTransfer = false;
  for (const p of parts) {
    if ((p.purpose === 'agent' || p.purpose === 'user') && connected(p)) return true;
    if (p.purpose === 'external' && (p.sessions || []).some(x => x.direction === 'outbound') && connected(p)) return true;
    if (p.purpose === 'voicemail') voicemail = true;
    if (p.purpose === 'ivr' && segs(p).some(g => g.disconnectType === 'transfer')) ivrTransfer = true;
  }
  return ivrTransfer && !hadQueue && !voicemail;
}

export function parseConversations(obj, queueNames = new Map()) {
  const list = listOf(obj);
  const out = [];
  for (const c of list) {
    const firstSeg = (c.participants || []).flatMap(p => (p.sessions || []).flatMap(x => x.segments || []))
      .map(g => Date.parse(g.segmentStart)).filter(Boolean).sort((a, b) => a - b)[0];
    const start = Date.parse(c.conversationStart) || firstSeg;
    if (!start) continue;
    if (c.originatingDirection && c.originatingDirection !== 'inbound') continue;
    const parts = c.participants || [];
    let did = '', addrTo = '', media = '';
    const flows = [];
    let qid = '', segQueueName = '', acdName = '';
    let lastEnd = 0, reason = '';
    const endT = Date.parse(c.conversationEnd) || 0;
    for (const p of parts) {
      for (const s of p.sessions || []) {
        if (!did && s.dnis && p.purpose !== 'agent') did = s.dnis;
        // E-mail / messaging: the address the customer wrote to (only on inbound legs; outbound legs point at the customer)
        if (!addrTo && s.addressTo && p.purpose !== 'agent' && s.direction !== 'outbound') addrTo = s.addressTo;
        if (!media && s.mediaType && p.purpose !== 'agent') media = s.mediaType;
        if (s.flow?.flowName) {
          const t0 = Date.parse(s.segments?.[0]?.segmentStart) || start;
          flows.push({ name: s.flow.flowName, t: t0, type: String(s.flow.flowType || '').toUpperCase() });
        }
        for (const seg of s.segments || []) {
          // Last disconnect in the conversation explains how/where it ended
          const se = Date.parse(seg.segmentEnd) || 0;
          if (seg.disconnectType && se >= lastEnd) { lastEnd = se; reason = `${p.purpose || '?'}: ${seg.disconnectType}`; }
          if (seg.queueId && !qid) { qid = seg.queueId; segQueueName = seg.queueName || ''; }
        }
      }
      // On the acd participant, participantName is the queue name. (The customer's and the agent's
      // participantName are a phone number / a person, and must never be used as a queue name.)
      if (p.purpose === 'acd' && !acdName) acdName = p.participantName || '';
    }
    const queue = qid ? (queueNames.get(qid) || segQueueName || acdName || qid.slice(0, 8)) : acdName;
    flows.sort((a, b) => a.t - b.t);
    const seen = [], ftypes = [];
    flows.forEach(f => { if (seen[seen.length - 1] !== f.name) { seen.push(f.name); ftypes.push(f.type); } });
    out.push({ id: c.conversationId || '', start, did: maskNum(did || addrTo), didFull: cleanNum(did || addrTo), media, flows: seen, ftypes, queue, reason,
      dur: endT && endT >= start ? Math.round((endT - start) / 1000) : null,
      blue: isAnswered(parts, !!queue) });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Synthetic week with a realistic day/night curve, for trying the view without data.
export function demoConversations() {
  const dids = ['••••• 90300', '••••• 90200', '••••• 90100', '••••• 26400', '••••• 27600'];
  const entry = ['Click & Collect Open', 'Online Orders Open', 'Customer Care Open', 'Trade & Schools Open', 'Gift Cards Open'];
  const queues = ['Click & Collect', 'Online Orders', 'Customer Care', 'Returns & Refunds', 'Trade Accounts'];
  const weights = [4, 3, 3, 1.5, 1];
  const pick = w => { let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; } return 0; };
  const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - 7);
  const out = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 7; h < 22; h++) {
      const peak = Math.exp(-Math.pow((h - 13) / 4, 2));
      const n = Math.round((d >= 5 ? 20 : 60) * (0.3 + peak));
      for (let i = 0; i < n; i++) {
        const k = pick(weights);
        const flows = [entry[k]], ftypes = ['INBOUNDCALL'];
        const step = (name, type) => { flows.push(name); ftypes.push(type); };
        if (Math.random() < 0.7) step('Order Lookup', 'COMMONMODULE');
        if (Math.random() < 0.12) { const h = ['Trade Account Check', 'Book Finder Bot', 'Gift Card Balance'][Math.floor(Math.random() * 3)]; step(h, h.includes('Bot') ? 'BOT' : 'COMMONMODULE'); }
        if (Math.random() < 0.6) step('Queue Router', 'INQUEUECALL');
        const blue = Math.random() < 0.67;
        out.push({
          start: monday.getTime() + ((d * 24 + h) * 60 + Math.random() * 60) * 60000,
          did: dids[k], flows, ftypes, queue: blue ? queues[pick(weights)] : '', blue,
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Genesys returns every conversation with activity in the interval, including ones that
// started long before it (e.g. callbacks). Pull such outliers to the start of the real
// period so the timeline is not stretched. Live fetches pass the requested range; for
// files the range is inferred from the 2nd-98th percentile of start times.
export function clampToPeriod(convs, range) {
  if (!convs.length) return { convs, clamped: 0 };
  let [lo, hi] = range || [];
  if (!range) {
    const st = convs.map(c => c.start).sort((a, b) => a - b);
    const p = f => st[Math.min(st.length - 1, Math.floor(st.length * f))];
    const span = Math.max(p(0.98) - p(0.02), 3600000);
    lo = p(0.02) - span * 0.02; hi = p(0.98) + span * 0.1 + 86400000;
  }
  let clamped = 0;
  for (const c of convs) {
    if (c.start < lo) { c.start = lo; clamped++; }
    else if (c.start > hi) { c.start = hi; clamped++; }
  }
  if (clamped) convs.sort((a, b) => a.start - b.start);
  return { convs, clamped };
}

// ── Layout helpers ───────────────────────────────────────────────────────────
function rank(items, keys) {
  const counts = new Map();
  items.forEach(it => keys(it).forEach(v => { if (v) counts.set(v, (counts.get(v) || 0) + 1); }));
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(e => e[0]);
}

const OTHER = '\u0001other';

// Flow types (Genesys `flowType`) → colour, legend label key and left-to-right order.
export const FLOW_TYPES = {
  INBOUNDCALL:  { color: '#3b82f6', order: 0 },
  SECURECALL:   { color: '#ec4899', order: 1 },
  BOT:          { color: '#22c55e', order: 1 },
  DIGITALBOT:   { color: '#22c55e', order: 1 },
  COMMONMODULE: { color: '#14b8a6', order: 2 },
  WORKFLOW:     { color: '#94a3b8', order: 2 },
  INQUEUECALL:  { color: '#a855f7', order: 3 },
};
const OTHER_TYPE = { color: '#8b95a5', order: 2 };
export const typeInfo = t => FLOW_TYPES[t] || OTHER_TYPE;
export const typeKey = t => (FLOW_TYPES[t] ? (t === 'DIGITALBOT' ? 'BOT' : t) : 'OTHER');
// Line colour per media type; voice keeps the neutral grey
export const MEDIA = {
  voice:    { color: null },
  email:    { color: '#f59e0b' },
  message:  { color: '#22d3ee' },
  callback: { color: '#c084fc' },
  other:    { color: '#fb7185' },
};
export const mediaKey = m => { m = String(m || '').toLowerCase(); return !m || m === 'voice' ? 'voice' : m === 'email' ? 'email' : /message|chat|sms|whatsapp|facebook|twitter|line|telegram|viber|instagram/.test(m) ? 'message' : m === 'callback' ? 'callback' : 'other'; };
const MAX_FLOW_COLS = 4;
let modelSeq = 0;

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Busiest `cap` names per column get their own node; everything else is merged into one
// "Other" node, so every conversation is still animated and counted.
function buildModel(convs, cap, maxCols = MAX_FLOW_COLS) {
  const nodes = new Map();
  const other = {};
  const add = (kind, all) => {
    const keep = all.slice(0, cap);
    const rest = all.length - keep.length;
    const list = keep.map(n => ({ name: n }));
    if (rest > 0) { list.push({ name: '', other: true, count: rest }); other[kind] = true; }   // label is added at draw time, so it follows the language
    list.forEach((it, i) => nodes.set(kind + ':' + (it.other ? OTHER : it.name), { key: kind + ':' + (it.other ? OTHER : it.name), kind, name: it.name, other: !!it.other, count: it.count || 0, i, n: list.length, ci: i, cn: list.length, col: 0, blue: 0, red: 0 }));
  };
  add('did', rank(convs, c => [c.did]));
  add('queue', rank(convs, c => [c.queue]));

  // Flows: type = most common flowType seen; stage = typical position in the call's flow sequence.
  const flowNames = rank(convs, c => c.flows);
  const keep = flowNames.slice(0, cap);
  const info = new Map(keep.map(n => [n, { pos: [], types: new Map() }]));
  for (const c of convs) c.flows.forEach((f, i) => {
    const e = info.get(f); if (!e) return;
    e.pos.push(i); const t = c.ftypes?.[i] || ''; e.types.set(t, (e.types.get(t) || 0) + 1);
  });
  const rows = keep.map((name, rankIdx) => {
    const e = info.get(name);
    const type = [...e.types.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
    return { name, type, stage: median(e.pos), rankIdx };
  });
  // A call can only be in an in-queue flow after its inbound flow
  const inboundStage = Math.max(-1, ...rows.filter(r => r.type === 'INBOUNDCALL').map(r => r.stage));
  rows.forEach(r => { if (r.type === 'INQUEUECALL' && r.stage <= inboundStage) r.stage = inboundStage + 1; });
  const stages = [...new Set(rows.map(r => r.stage))].sort((x, y) => x - y);
  rows.forEach(r => { r.col = Math.min(maxCols - 1, stages.indexOf(r.stage)); });
  const hasOther = flowNames.length > keep.length;
  const flowCols = Math.max(1, ...rows.map(r => r.col + 1));
  const byCol = Array.from({ length: flowCols }, () => []);
  rows.forEach(r => byCol[r.col].push(r));
  if (hasOther) { byCol[flowCols - 1].push({ name: '', other: true, count: flowNames.length - keep.length, type: '', col: flowCols - 1, rankIdx: 1e9 }); other.flow = true; }
  byCol.forEach((list, col) => {
    list.sort((x, y) => (typeInfo(x.type).order - typeInfo(y.type).order) || (x.rankIdx - y.rankIdx));
    list.forEach((r, ci) => nodes.set('flow:' + (r.other ? OTHER : r.name), { key: 'flow:' + (r.other ? OTHER : r.name), kind: 'flow', name: r.name, other: !!r.other, count: r.count || 0, type: r.type, i: ci, n: list.length, ci, cn: list.length, col, blue: 0, red: 0 }));
  });

  const edges = new Map();
  const m = { id: ++modelSeq, nodes, convs, edges, other, flowCols, types: [...new Set([...nodes.values()].filter(n => n.kind === 'flow').map(n => typeKey(n.type)))] };
  convs.forEach(c => { const p = pathOf(m, c), mk = mediaKey(c.media); for (let i = 0; i < p.length - 1; i++) { const k = p[i] + '>' + p[i + 1]; if (!edges.has(k)) edges.set(k, new Set()); edges.get(k).add(mk); } });
  m.media = [...new Set(convs.map(c => mediaKey(c.media)))].sort((a, b) => Object.keys(MEDIA).indexOf(a) - Object.keys(MEDIA).indexOf(b));
  return m;
}

function pathOf(model, c) {
  const p = [];
  const push = (kind, name) => {
    let k = kind + ':' + name;
    if (!model.nodes.has(k)) k = model.other[kind] ? kind + ':' + OTHER : '';
    if (k && p[p.length - 1] !== k) p.push(k);
  };
  push('did', c.did);
  c.flows.forEach(f => push('flow', f));
  if (c.queue) push('queue', c.queue);
  return p;
}

// ── View ─────────────────────────────────────────────────────────────────────
import * as gc from './genesys-auth.js';

export function initTraffic(root, i18n, toast, opts = {}) {
  root.innerHTML = `
    <div class="tr-bar"><div class="tr-row">
      <button class="btn" data-tr="play">▶</button>
      <button class="btn ghost" data-tr="restart">↺</button>
      <select data-tr="speed" title="${i18n('trafficSpeed')}">
        <option value="15000">${i18n('trafficWeekIn')} 15 s</option>
        <option value="30000">${i18n('trafficWeekIn')} 30 s</option>
        <option value="60000" selected>${i18n('trafficWeekIn')} 60 s</option>
        <option value="120000">${i18n('trafficWeekIn')} 2 min</option>
        <option value="300000">${i18n('trafficWeekIn')} 5 min</option>
      </select>
      <select data-tr="nodes" title="${i18n('trafficNodes')}">
        ${[8, 15, 25, 40].map(n => `<option value="${n}" ${n === 15 ? 'selected' : ''}>${i18n('trafficNodes')} ${n}</option>`).join('')}
      </select>
      <label class="tr-chk" data-tr="flowWrap" hidden><input type="checkbox" data-tr="flowOnly"><span data-tr="flowOnlyTxt"></span></label>
      <div class="tr-ms" data-tr="didWrap" hidden>
        <button class="btn" data-tr="didBtn" aria-haspopup="listbox"></button>
        <div class="tr-ms-panel" data-tr="didPanel" hidden>
          <input type="search" data-tr="didSearch" />
          <div class="tr-ms-actions"><button class="btn ghost" data-tr="didAll"></button><button class="btn ghost" data-tr="didNone"></button></div>
          <div class="tr-ms-list" data-tr="didList" role="listbox" aria-multiselectable="true"></div>
        </div>
      </div>
      <input type="range" data-tr="seek" min="0" max="1000" value="0" />
      <span class="tr-clock" data-tr="clock">—</span>
    </div><div class="tr-row">
      <select data-tr="period" title="${i18n('trafficPeriod')}">${PERIODS.map(k => `<option value="${k}">${i18n('trafficP_' + k)}</option>`).join('')}</select>
      <button class="btn" data-tr="live">${i18n('trafficLive')}</button>
      <button class="btn" data-tr="demo">${i18n('trafficDemo')}</button>
      <label class="btn primary tr-upload">${i18n('trafficLoad')}<input type="file" accept=".json,application/json" multiple hidden data-tr="file" /></label>
      <button class="btn" data-tr="paste">${i18n('trafficPaste')}</button>
      <button class="btn ghost" data-tr="help" title="${i18n('trafficHelpTitle')}">?</button>
      <span class="tr-spacer"></span>
      <span class="tr-who" data-tr="who"></span>
    </div></div>
    <div class="tr-paste" data-tr="pastePanel" hidden>
      <div>${i18n('trafficPasteHint')}</div>
      <textarea data-tr="pasteText" rows="5" spellcheck="false" placeholder='{"conversations":[ … ]}'></textarea>
      <div class="tr-paste-row"><button class="btn primary" data-tr="pasteAdd">${i18n('trafficPasteAdd')}</button><button class="btn ghost" data-tr="pasteClear">${i18n('trafficPasteClear')}</button><span data-tr="pasteInfo"></span></div>
    </div>
    <div class="tr-help" data-tr="helpPanel" hidden>${i18n('trafficHelpBody')}</div>
    <div class="tr-live" data-tr="livePanel" hidden></div>
    <div class="tr-stage"><canvas></canvas><div class="tr-empty">${i18n('trafficNoData')}</div></div>
    <div class="tr-chartbox" data-tr="chartBox" hidden>
      <div class="tr-chart-head">
        <b data-tr="chartTitle"></b>
        <select data-tr="bucket"></select>
        <span class="tr-chart-legend"><i style="background:${BLUE}"></i><span data-tr="lgOk"></span><i style="background:${RED}"></i><span data-tr="lgLost"></span></span>
      </div>
      <div class="tr-chart-wrap"><canvas data-tr="chart"></canvas></div>
    </div>
    <div class="tr-stats" data-tr="stats"></div>
    <div class="tr-modal" data-tr="modal" hidden>
      <div class="tr-card" role="dialog" aria-modal="true">
        <div class="tr-card-head">
          <div><h3 data-tr="mTitle"></h3><div class="tr-card-sub" data-tr="mSub"></div></div>
          <button class="btn ghost" data-tr="mClose" aria-label="Close">✕</button>
        </div>
        <div class="tr-card-tools">
          <select data-tr="mOutcome"></select>
          <select data-tr="mScope"></select>
          <input type="search" data-tr="mSearch" />
          <span class="tr-spacer"></span>
          <button class="btn" data-tr="mCopy"></button>
          <button class="btn primary" data-tr="mCsv"></button>
        </div>
        <div class="tr-grid-wrap" data-tr="mGrid"></div>
      </div>
    </div>`;

  const q = s => root.querySelector(`[data-tr="${s}"]`);
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const stage = root.querySelector('.tr-stage');
  const empty = root.querySelector('.tr-empty');

  let allConvs = [];
  const selDids = new Set();            // empty = all DIDs
  const flowOnly = () => q('flowOnly').checked;
  const byDid = list => (selDids.size ? list.filter(c => selDids.has(c.didFull)) : list);
  // Calls that never ran an Architect flow (e.g. direct calls to a person) are hidden when "only calls through a flow" is on
  const viewConvs = () => byDid(flowOnly() ? allConvs.filter(c => c.flows.length) : allConvs);
  const hiddenDirect = () => (flowOnly() ? byDid(allConvs).filter(c => !c.flows.length) : []);
  const nodeName = n => (n.special ? i18n('trafficDirectTitle') : n.other ? `${i18n('trafficOther_' + n.kind)} (${n.count})` : n.name);
  let model = null, t0 = 0, t1 = 0, simT = 0, playing = false, lastTs = 0, nextIdx = 0;
  let dots = [], totals = { blue: 0, red: 0 }, dpr = 1, W = 0, H = 0;
  // Narrow (e.g. the agent side panel): at most two flow columns, smaller text, queues against the right edge
  const NARROW = 560;
  let narrow = false;
  const maxCols = () => (narrow ? 2 : MAX_FLOW_COLS);
  const fontPx = () => (narrow ? 10 : 12);
  if (root.clientWidth && root.clientWidth < NARROW) q('nodes').value = '8';   // fewer boxes per column in a side panel

  const msPerWeek = () => +q('speed').value;
  const simPerRealMs = () => (t1 - t0) / msPerWeek();

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = stage.clientWidth; H = stage.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const was = narrow;
    narrow = root.clientWidth < NARROW;
    root.classList.toggle('tr-narrow', narrow);
    measureEntries();
    if (model && was !== narrow) rebuild();
  }
  new ResizeObserver(resize).observe(stage);

  // The entry-point column is as wide as its longest label (an e-mail address can be long)
  let entryW = 0;
  function measureEntries() {
    if (!model) return;
    ctx.save(); ctx.font = fontPx() + 'px system-ui, sans-serif';
    entryW = Math.max(0, ...[...model.nodes.values()].filter(n => n.kind === 'did').map(n => ctx.measureText(nodeName(n)).width));
    ctx.restore();
  }
  const entryX = () => (narrow ? Math.min(W * 0.24, Math.max(40, entryW + 6)) : Math.min(W * 0.27, Math.max(W * 0.09, entryW + 16)));
  // Narrow: queue boxes hug the right edge; flow columns share the room between the entry badges and the queues
  const narrowCols = () => {
    const qW = Math.min(120, W * 0.28), qx = W - qW / 2 - 2;
    return { qW, qx, left: entryX() + 30, right: qx - qW / 2 - 10 };
  };
  function pos(node, side) {
    const fc = model ? model.flowCols : 1;
    const nc = narrow ? narrowCols() : null;
    const dx = entryX(), qx = narrow ? nc.qx : W * 0.86, span = qx - dx;
    const x = node.kind === 'did' ? dx : node.kind === 'queue' ? qx
      : narrow ? nc.left + (node.col + 0.5) / fc * (nc.right - nc.left) : dx + (node.col + 1) / (fc + 1) * span;
    const ys = (node.ci + 0.5) / node.cn;
    const y = 36 + ys * (H - 36 - 70);
    const w = node.kind === 'did' ? 70
      : narrow ? (node.kind === 'queue' ? nc.qW : Math.max(40, Math.min(130, (nc.right - nc.left) / fc - 10)))
      : Math.max(60, Math.min(130, node.kind === 'flow' ? span / (fc + 1) * 0.84 : W * 0.17));
    const h = Math.max(12, Math.min(26, (H - 106) / node.cn - 5));
    return { x: side === 'in' ? x - w / 2 : side === 'out' ? x + w / 2 : x, y, w, h };
  }

  // ── Edge routes: lines bend through the gaps between boxes instead of running underneath them ──
  let routeSig = '', routes = new Map(), colRects = null;
  const flowColumns = () => {
    if (colRects) return colRects;
    const by = new Map();
    for (const n of model.nodes.values()) if (n.kind === 'flow') { const p = pos(n, 'c'); if (!by.has(n.col)) by.set(n.col, { x: p.x, w: p.w, boxes: [] }); by.get(n.col).boxes.push({ y: p.y, h: p.h }); }
    colRects = [...by.values()].sort((a, b) => a.x - b.x); colRects.forEach(c => c.boxes.sort((a, b) => a.y - b.y));
    return colRects;
  };
  // Records the points a canvas path would visit, so the same curve can be drawn and followed by the dots
  const recorder = () => {
    const pts = [];
    return { pts, moveTo: (x, y) => pts.push([x, y]), lineTo: (x, y) => pts.push([x, y]),
      bezierCurveTo(x1, y1, x2, y2, x, y) { const [x0, y0] = pts[pts.length - 1]; for (let i = 1; i <= 12; i++) { const t = i / 12, u = 1 - t;
        pts.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y]); } } };
  };
  function buildRoute(a, b) {
    const A = pos(a, 'out'), B = pos(b, 'in');
    const via = [[A.x, A.y]];
    for (const col of flowColumns()) {
      if (!(col.x - col.w / 2 > A.x && col.x + col.w / 2 < B.x)) continue;      // only columns strictly between the two boxes
      const ys = A.y + (B.y - A.y) * (col.x - A.x) / (B.x - A.x);
      if (!col.boxes.some(bx => Math.abs(ys - bx.y) < bx.h / 2 + 8)) { via.push([col.x, ys]); continue; }
      const cand = [col.boxes[0].y - col.boxes[0].h / 2 - 10, col.boxes[col.boxes.length - 1].y + col.boxes[col.boxes.length - 1].h / 2 + 10];
      for (let i = 0; i < col.boxes.length - 1; i++) {
        const lo = col.boxes[i].y + col.boxes[i].h / 2, hi = col.boxes[i + 1].y - col.boxes[i + 1].h / 2;
        if (hi - lo >= 12) cand.push((lo + hi) / 2);
      }
      via.push([col.x, cand.reduce((best, c) => (Math.abs(c - ys) < Math.abs(best - ys) ? c : best))]);
    }
    via.push([B.x, B.y]);
    const rec = recorder(); smooth(rec, via);
    const Ac = a.kind === 'did' ? A : pos(a, 'c'), Bc = b.kind === 'queue' ? B : pos(b, 'c');
    const full = [[Ac.x, Ac.y], ...rec.pts, [Bc.x, Bc.y]];
    const cum = [0]; for (let i = 1; i < full.length; i++) cum.push(cum[i - 1] + Math.hypot(full[i][0] - full[i - 1][0], full[i][1] - full[i - 1][1]));
    return { draw: rec.pts, full, cum, total: cum[cum.length - 1] || 1 };
  }
  function routeOf(ak, bk) {
    const sig = `${W}x${H}#${model.id}#${entryW}`;
    if (sig !== routeSig) { routes = new Map(); routeSig = sig; colRects = null; }
    const key = ak + '>' + bk; let r = routes.get(key);
    if (!r) { r = buildRoute(model.nodes.get(ak), model.nodes.get(bk)); routes.set(key, r); }
    return r;
  }
  function pointAt(r, e) {
    const d = e * r.total; let i = 1;
    while (i < r.cum.length - 1 && r.cum[i] < d) i++;
    const seg = (r.cum[i] - r.cum[i - 1]) || 1, t = (d - r.cum[i - 1]) / seg, p0 = r.full[i - 1], p1 = r.full[i];
    return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
  }

  let filterNote = '';
  function setData(convs, note = '', range = null) {
    filterNote = note;
    const { clamped } = clampToPeriod(convs, range);
    if (clamped) toast(`${clamped} ${i18n('trafficClamped')}`, 'ok');
    if (!convs.length) { toast(i18n('trafficBadFile'), 'err'); return; }
    allConvs = convs; selDids.clear();
    const hasFlow = convs.some(c => c.flows.length);
    q('flowOnly').checked = hasFlow && convs.some(c => !c.flows.length);   // only useful when there are direct calls to hide
    q('flowWrap').hidden = !convs.some(c => !c.flows.length) || !hasFlow;
    model = buildModel(viewConvs(), +q('nodes').value, maxCols());
    buildDidList(); q('didWrap').hidden = false; measureEntries();
    t0 = convs[0].start; t1 = convs[convs.length - 1].start + 1;
    empty.style.display = 'none';
    q('chartBox').hidden = false;
    nextIdx = 0; setupBuckets(); resizeChart();
    seek(0);
    play(true);
  }

  function reset(toT) {
    dots = []; totals = { blue: 0, red: 0 };
    model.nodes.forEach(n => { n.blue = 0; n.red = 0; n.runs = 0; });
    nextIdx = 0;
    // Count everything before toT instantly so a seek shows the right totals.
    while (nextIdx < model.convs.length && model.convs[nextIdx].start < toT) {
      arrive(model.convs[nextIdx]); addRuns(pathOf(model, model.convs[nextIdx])); nextIdx++;
    }
    if (bk.starts.length) fillChart(nextIdx);
  }

  // A flow "run" is counted when a call reaches the flow's box
  function addRuns(keys) { keys.forEach(k => { const nd = model.nodes.get(k); if (nd) nd.runs = (nd.runs || 0) + 1; }); }

  function arrive(c) {
    const p = pathOf(model, c);
    const end = model.nodes.get(p[p.length - 1]);
    if (end) end[c.blue ? 'blue' : 'red']++;
    totals[c.blue ? 'blue' : 'red']++;
  }

  function seek(frac) {
    if (!model) return;
    simT = t0 + (t1 - t0) * frac;
    reset(simT);
    q('seek').value = Math.round(frac * 1000);
    updateStats(); updateClock();
  }

  function play(on) {
    playing = on; lastTs = 0;
    q('play').textContent = on ? '⏸' : '▶';
  }

  function spawn(c, now) {
    addChart(c);
    const keys = pathOf(model, c);
    if (keys.length < 2 || dots.length > 1500) { arrive(c); addRuns(keys); return; }   // cap on-screen dots for big periods
    addRuns(keys.slice(0, 1));
    dots.push({ c, keys, ri: 0, born: now, jx: (Math.random() - 0.5) * 14, jy: (Math.random() - 0.5) * 14 });
  }

  function dotPos(d, now) {
    const el = now - d.born;
    const hops = d.keys.length - 1;
    const travel = hops * HOP_MS;
    const f = Math.min(el, travel) / HOP_MS;
    const i = Math.min(Math.floor(f), hops - 1);
    const u = f - i; const e = u * u * (3 - 2 * u);
    const [px, py] = pointAt(routeOf(d.keys[i], d.keys[i + 1]), e);
    return { x: px + d.jx, y: py + d.jy, done: el >= travel + LINGER_MS, arrived: el >= travel };
  }

  // Date + time in the app language's regional format (24 h clock in da/en-GB/fr/es/nl).
  function fmtTime(ms, full = false) {
    const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    if (full || t1 - t0 <= 86400000) opts.second = '2-digit';
    return new Date(ms).toLocaleString(i18n('locale'), opts);
  }
  function updateClock() { q('clock').textContent = fmtTime(simT); }

  function updateStats() {
    const tot = totals.blue + totals.red;
    const pb = tot ? Math.round(totals.blue / tot * 100) : 0;
    const pr = tot ? 100 - pb : 0;
    q('stats').innerHTML = `
      <div class="tr-meter"><span style="width:${pb}%;background:${BLUE}">${pb ? pb + '%' : ''}</span><span style="width:${pr}%;background:${RED}">${pr ? pr + '%' : ''}</span></div>
      <div class="tr-legend">
        <span><i style="background:${BLUE}"></i>${i18n('trafficWithConv')} <b>${totals.blue}</b></span>
        <span><i style="background:${RED}"></i>${i18n('trafficWithoutConv')} <b>${totals.red}</b></span>
        ${model && model.types.length > 1 ? model.types.map(k => `<span><i class="sq" style="background:${(FLOW_TYPES[k] || OTHER_TYPE).color}"></i>${i18n('trafficFT_' + k)}</span>`).join('') : ''}
        ${model && model.media && model.media.length > 1 ? model.media.map(k => `<span><i class="ln" style="background:${MEDIA[k].color || 'var(--ink-dim)'}"></i>${i18n('trafficM_' + k)}</span>`).join('') : ''}
        ${model && model.nodes.size && [...model.nodes.values()].some(n => n.kind === 'flow') ? `<span><i style="background:${GREEN}"></i>${i18n('trafficRuns')}</span>` : ''}
        ${hiddenDirect().length ? `<button class="tr-linkbtn" data-tr="hiddenBtn">${hiddenDirect().length} ${i18n('trafficHiddenDirect')}</button>` : ''}
        ${selDids.size ? `<span class="tr-filter">${i18n('trafficDid')}: ${selDids.size} / ${didCounts.length}</span>` : ''}
        ${filterNote ? `<span class="tr-filter">${i18n('trafficFilter')}: ${i18n('trafficFilter_' + filterNote)}</span>` : ''}
      </div>`;
  }

  q('stats').addEventListener('click', e => { if (e.target.closest('[data-tr="hiddenBtn"]')) openModal({ special: 'direct', kind: 'did', name: '', key: '' }); });

  function css(name, fb) { return getComputedStyle(root).getPropertyValue(name).trim() || fb; }

  // ── Calls over time (answered / lost), filled in as the replay advances ──
  const BUCKETS = ['auto', 'quarter', 'hour', 'day', 'off'];
  const chartCv = q('chart'), cctx = chartCv.getContext('2d');
  let bk = { starts: [], ms: 3600000, kind: 'hour' }, bOk = [], bLost = [], fullMax = 1, cW = 0, cH = 0, hoverX = null;

  function bucketKind() {
    const v = q('bucket').value, span = t1 - t0;
    let k = v === 'auto' ? (span <= 6 * 3600000 ? 'quarter' : span <= 72 * 3600000 ? 'hour' : 'day') : v;
    if (k === 'quarter' && span / 900000 > 1200) k = 'hour';
    if (k === 'hour' && span / 3600000 > 1500) k = 'day';
    return k;
  }
  function setupBuckets() {
    if (!model) return;
    const kind = bucketKind();
    const d = new Date(t0);
    if (kind === 'day') d.setHours(0, 0, 0, 0);
    else if (kind === 'hour') d.setMinutes(0, 0, 0);
    else d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
    const starts = [];
    for (let t = d.getTime(); t < t1; ) {
      starts.push(t);
      if (kind === 'day') { const n = new Date(t); n.setDate(n.getDate() + 1); t = n.getTime(); }
      else t += kind === 'hour' ? 3600000 : 900000;
    }
    bk = { starts, ms: kind === 'day' ? 86400000 : kind === 'hour' ? 3600000 : 900000, kind };
    showUnit();
    // full-period maximum, so the y-axis stays still while the graph fills in
    const ok = new Array(starts.length).fill(0), lost = new Array(starts.length).fill(0);
    for (const c of model.convs) (c.blue ? ok : lost)[bucketOf(c.start)]++;
    fullMax = Math.max(1, ...ok, ...lost);
    fillChart(nextIdx);
  }
  // Shows the resolution actually used (a long period is shown per day even if 15 min is chosen)
  function showUnit() { q('chartTitle').textContent = `${i18n('trafficChartTitle')} · ${i18n('trafficUnit_' + bk.kind)}`; }
  function bucketOf(t) {
    let lo = 0, hi = bk.starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bk.starts[m] <= t) lo = m; else hi = m - 1; }
    return lo;
  }
  function fillChart(n) {
    bOk = new Array(bk.starts.length).fill(0); bLost = new Array(bk.starts.length).fill(0);
    for (let i = 0; i < n && i < model.convs.length; i++) addChart(model.convs[i]);
  }
  function addChart(c) { (c.blue ? bOk : bLost)[bucketOf(c.start)]++; }

  function resizeChart() {
    const w = q('chart').parentElement;
    cW = w.clientWidth; cH = w.clientHeight;
    chartCv.width = cW * dpr; chartCv.height = cH * dpr;
    chartCv.style.width = cW + 'px'; chartCv.style.height = cH + 'px';
  }
  new ResizeObserver(resizeChart).observe(q('chart').parentElement);

  const niceMax = v => { const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(x => f <= x)) * p; };
  // Monotone cubic through the points (smooth, never overshoots below 0)
  function smooth(c, pts) {
    c.moveTo(pts[0][0], pts[0][1]);
    if (pts.length < 3) { pts.slice(1).forEach(p => c.lineTo(p[0], p[1])); return; }
    const n = pts.length, dx = [], m = [], t = new Array(n);
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1); }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], h = Math.hypot(a, b);
      if (h > 3) { t[i] = 3 * a / h * m[i]; t[i + 1] = 3 * b / h * m[i]; }
    }
    for (let i = 0; i < n - 1; i++) {
      const x0 = pts[i][0], y0 = pts[i][1], x1 = pts[i + 1][0], y1 = pts[i + 1][1], d = dx[i] / 3;
      c.bezierCurveTo(x0 + d, y0 + t[i] * d, x1 - d, y1 - t[i + 1] * d, x1, y1);
    }
  }
  function bucketLabel(t, withTime) {
    const o = bk.kind === 'day' ? { day: 'numeric', month: 'short' }
      : (t1 - t0 <= 36 * 3600000 ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return new Date(t).toLocaleString(i18n('locale'), withTime && bk.kind === 'day' ? { weekday: 'short', day: 'numeric', month: 'short' } : o);
  }

  function drawChart() {
    if (q('chartBox').hidden || !model || !cW) return;
    const c = cctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cW, cH);
    const faint = css('--ink-faint', '#888'), border = css('--border', '#ccc'), ink = css('--ink', '#222');
    const L = 40, R = 10, T = 8, B = 20, w = cW - L - R, h = cH - T - B;
    const ymax = niceMax(fullMax * 1.05);
    const X = t => L + (t - t0) / (t1 - t0) * w, Y = v => T + h - v / ymax * h;
    c.font = '10px system-ui, sans-serif'; c.textBaseline = 'middle';
    // grid + y labels
    c.textAlign = 'right';
    for (const v of [0, ymax / 2, ymax]) {
      c.strokeStyle = border; c.globalAlpha = 0.6; c.lineWidth = 1;
      c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(L + w, Y(v)); c.stroke(); c.globalAlpha = 1;
      c.fillStyle = faint; c.fillText(String(Math.round(v * 10) / 10), L - 6, Y(v));
    }
    // x labels
    c.textAlign = 'center'; c.textBaseline = 'top';
    const nt = Math.max(2, Math.floor(w / 95)), step = Math.max(1, Math.ceil(bk.starts.length / nt));
    for (let i = 0; i < bk.starts.length; i += step) { c.fillStyle = faint; c.fillText(bucketLabel(bk.starts[i]), Math.min(L + w - 24, Math.max(L + 20, X(bk.starts[i] + bk.ms / 2))), T + h + 5); }
    // series, only up to the buckets reached so far
    const last = bucketOf(Math.min(simT, t1));
    // Completed buckets are drawn as a smooth area; the bucket still in progress is a dashed
    // stub, so a half-filled bucket does not look like a drop in traffic.
    const series = (arr, col) => {
      const done = last, pts = []; for (let i = 0; i < done; i++) pts.push([X(bk.starts[i] + bk.ms / 2), Y(arr[i])]);
      const cur = [X(bk.starts[last] + bk.ms / 2), Y(arr[last])];
      if (pts.length > 1) {
        c.beginPath(); smooth(c, pts); c.lineTo(pts[pts.length - 1][0], T + h); c.lineTo(pts[0][0], T + h); c.closePath();
        const g = c.createLinearGradient(0, T, 0, T + h); g.addColorStop(0, col + '55'); g.addColorStop(1, col + '00');
        c.fillStyle = g; c.fill();
        c.beginPath(); smooth(c, pts); c.strokeStyle = col; c.lineWidth = 2; c.lineJoin = 'round'; c.stroke();
      }
      if (pts.length) {
        const q0 = pts[pts.length - 1];
        c.beginPath(); c.moveTo(q0[0], q0[1]); c.lineTo(cur[0], cur[1]); c.strokeStyle = col; c.lineWidth = 1.5; c.setLineDash([4, 3]); c.stroke(); c.setLineDash([]);
      }
      c.fillStyle = col; c.beginPath(); c.arc(cur[0], cur[1], 3, 0, 7); c.fill();
    };
    series(bLost, RED); series(bOk, BLUE);
    // playhead
    const px = X(Math.min(simT, t1));
    c.strokeStyle = faint; c.globalAlpha = 0.5; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(px, T); c.lineTo(px, T + h); c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
    // hover tooltip
    if (hoverX != null && hoverX >= L && hoverX <= L + w) {
      const t = t0 + (hoverX - L) / w * (t1 - t0), i = bucketOf(t);
      if (bk.starts[i] <= simT) {
        const lines = [bucketLabel(bk.starts[i], true) + (bk.kind === 'day' ? '' : ''), `${i18n('trafficAnswered')}: ${bOk[i]}`, `${i18n('trafficLost')}: ${bLost[i]}`];
        const bw = 128, bh = 50, bx = Math.min(Math.max(hoverX + 10, L), cW - bw - 4), by = T + 2;
        c.fillStyle = css('--panel', '#222'); c.strokeStyle = border; c.globalAlpha = 0.96;
        c.beginPath(); c.roundRect(bx, by, bw, bh, 6); c.fill(); c.stroke(); c.globalAlpha = 1;
        c.textAlign = 'left'; c.textBaseline = 'middle'; c.font = '11px system-ui, sans-serif';
        c.fillStyle = ink; c.fillText(lines[0], bx + 8, by + 12);
        c.fillStyle = BLUE; c.fillText(lines[1], bx + 8, by + 28); c.fillStyle = RED; c.fillText(lines[2], bx + 8, by + 42);
      }
    }
  }
  chartCv.addEventListener('mousemove', e => { hoverX = e.clientX - chartCv.getBoundingClientRect().left; });
  chartCv.addEventListener('mouseleave', () => { hoverX = null; });

  function fillBucketSelect() {
    const cur = q('bucket').value || 'auto';
    q('bucket').innerHTML = BUCKETS.map(k => `<option value="${k}">${i18n('trafficB_' + k)}</option>`).join('');
    q('bucket').value = cur;
    q('chartTitle').textContent = i18n('trafficChartTitle');
    if (model && bk.starts.length) showUnit();
    q('lgOk').textContent = i18n('trafficAnswered'); q('lgLost').textContent = i18n('trafficLost');
  }
  fillBucketSelect();
  q('bucket').addEventListener('change', () => {
    const off = q('bucket').value === 'off';
    q('chartBox').querySelector('.tr-chart-wrap').style.display = off ? 'none' : '';
    if (model && !off) { setupBuckets(); resizeChart(); }
  });

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!model) return;
    const ink = css('--ink', '#222'), faint = css('--ink-faint', '#888'), border = css('--border', '#ccc'), bg = css('--bg-2', '#fff');
    const fs = fontPx();
    ctx.font = fs + 'px system-ui, sans-serif'; ctx.textBaseline = 'middle';

    ctx.fillStyle = faint;
    if (narrow) {
      const nc = narrowCols();
      ctx.textAlign = 'left'; ctx.fillText(i18n('trafficHead_did'), 2, 14);
      ctx.textAlign = 'center'; ctx.fillText(i18n('trafficHead_flow'), (nc.left + nc.right) / 2, 14);
      ctx.textAlign = 'right'; ctx.fillText(i18n('trafficHead_queue'), W - 2, 14);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(i18n('trafficHead_did'), Math.max(60, entryX() - entryW / 2), 14); ctx.fillText(i18n('trafficHead_flow'), (entryX() + W * 0.86) / 2, 14); ctx.fillText(i18n('trafficHead_queue'), W * 0.86, 14);
    }

    // Edges used by the loaded conversations
    ctx.strokeStyle = css('--ink-dim', '#999'); ctx.lineWidth = 1.2; ctx.globalAlpha = 0.45;
    const dim = css('--ink-dim', '#999');
    model.edges.forEach((media, e) => {
      const [a, b] = e.split('>'); const r = routeOf(a, b), list = [...media].sort((x, y) => Object.keys(MEDIA).indexOf(x) - Object.keys(MEDIA).indexOf(y));
      list.forEach((mk, k) => {                         // one line per media type on a shared edge, slightly apart
        const off = (k - (list.length - 1) / 2) * 3, col = MEDIA[mk].color;
        ctx.strokeStyle = col || dim; ctx.globalAlpha = col ? 0.7 : 0.45;
        ctx.beginPath(); r.draw.forEach(([x, y], i) => (i ? ctx.lineTo(x, y + off) : ctx.moveTo(x, y + off))); ctx.stroke();
      });
    });
    ctx.globalAlpha = 1;

    // Nodes + end counters
    model.nodes.forEach(n => {
      const p = pos(n, 'c');
      // Counters go under the box only if there is room before the next box; otherwise to the right of it
      const dense = p.h < 20 || (H - 106) / n.cn - p.h < 17;
      ctx.font = (dense ? 10 : fs) + 'px system-ui, sans-serif';
      if (n.kind === 'did') {
        ctx.fillStyle = faint; ctx.textAlign = 'right'; {
          const label = nodeName(n), maxW = p.x - 8;
          let cut = 0; while (cut < label.length - 3 && ctx.measureText((cut ? '…' : '') + label.slice(cut)).width > maxW) cut++;   // keep the end (domain / last digits)
          ctx.fillText((cut ? '…' : '') + label.slice(cut), p.x - 1, p.y);
          if (n.runs) {                                                   // green: calls that entered here
            const t = String(n.runs); ctx.font = 'bold 10px system-ui, sans-serif';
            const bw = Math.max(18, ctx.measureText(t).width + 8), bx = p.x + 3;
            ctx.fillStyle = bg; ctx.strokeStyle = GREEN; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.roundRect(bx, p.y - 6, bw, 12, 6); ctx.fill(); ctx.stroke();
            ctx.fillStyle = GREEN; ctx.textAlign = 'center'; ctx.fillText(t, bx + bw / 2, p.y + 0.5);
          }
          return;
        }
      }
      ctx.fillStyle = bg; ctx.strokeStyle = n.kind === 'flow' ? typeInfo(n.type).color : '#d99a2b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, 6); ctx.fill(); ctx.stroke();
      // Narrow and no room under the box: the counters go inside it, at the right end
      const parts = [[n.blue, BLUE], [n.red, RED]].filter(x => x[0]);
      const inside = narrow && dense && parts.length > 0;
      const partW = v => 9 + ctx.measureText(String(v)).width + 4;
      const insideW = inside ? parts.reduce((a, [v]) => a + partW(v), 0) + 2 : 0;
      ctx.fillStyle = ink; ctx.textAlign = 'center'; {
        let label = nodeName(n); if (label.length > 22) label = label.slice(0, 21) + '…';
        const room = p.w - 8 - insideW;
        if (narrow) while (label.length > 1 && ctx.measureText(label).width > room) label = label.slice(0, -2) + '…';
        ctx.fillText(label, p.x - insideW / 2, p.y);
      }
      if (n.kind === 'flow' && n.runs) {                         // green: how many times the flow was run
        const t = String(n.runs); ctx.font = 'bold 10px system-ui, sans-serif';
        const bw = ctx.measureText(t).width + 8, bx = p.x + p.w / 2 - bw + 3, by = p.y - p.h / 2 - 6;
        ctx.fillStyle = bg; ctx.strokeStyle = GREEN; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.roundRect(bx, by, bw, 12, 6); ctx.fill(); ctx.stroke();
        ctx.fillStyle = GREEN; ctx.textAlign = 'center'; ctx.fillText(t, bx + bw / 2, by + 6.5);
        ctx.font = (dense ? 10 : fs) + 'px system-ui, sans-serif';
      }
      if (inside) {
        let x = p.x + p.w / 2 - insideW;
        parts.forEach(([v, col]) => {
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x + 3, p.y, 2.5, 0, 7); ctx.fill();
          ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.fillText(String(v), x + 8, p.y); x += partW(v);
        });
      } else if (parts.length) {
        // Roomy layout: counters under the box. Dense layout: to the right of the box.
        const step = narrow ? 30 : 38;
        let x = dense ? p.x + p.w / 2 + 6 : p.x - (parts.length * step) / 2;
        const cy = dense ? p.y : p.y + p.h / 2 + 9;
        parts.forEach(([v, col]) => {
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x + 4, cy, 3, 0, 7); ctx.fill();
          ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.fillText(String(v), x + 11, cy); x += step;
        });
      }
    });

    // Dots
    for (const d of dots) {
      const s = dotPos(d, now);
      ctx.fillStyle = d.c.blue ? BLUE : RED; ctx.globalAlpha = s.arrived ? 0.5 : 0.9;
      ctx.beginPath(); ctx.arc(s.x, s.y, 3.2, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!root.offsetParent) { lastTs = 0; return; }   // tab hidden
    if (playing && model) {
      if (lastTs) {
        simT = Math.min(t1, simT + (ts - lastTs) * simPerRealMs());
        while (nextIdx < model.convs.length && model.convs[nextIdx].start <= simT) { spawn(model.convs[nextIdx], ts); nextIdx++; }
        if (simT >= t1 && !dots.length) play(false);
      }
      lastTs = ts;
      q('seek').value = Math.round((simT - t0) / (t1 - t0) * 1000);
      updateClock();
    }
    // A dot that has reached the next box counts as one run of that flow
    for (const d of dots) {
      const r = Math.min(d.keys.length - 1, Math.floor((ts - d.born) / HOP_MS));
      while (d.ri < r) { d.ri++; addRuns([d.keys[d.ri]]); }
    }
    // Count arrivals once a dot finishes its journey
    let changed = false;
    dots = dots.filter(d => { const s = dotPos(d, ts); if (s.done) { arrive(d.c); changed = true; return false; } return true; });
    if (changed) updateStats();
    draw(ts); drawChart();
  }
  requestAnimationFrame(frame);

  q('play').addEventListener('click', () => { if (!model) return; if (simT >= t1) seek(0); play(!playing); });
  q('restart').addEventListener('click', () => { if (model) { seek(0); play(true); } });
  q('seek').addEventListener('input', e => { seek(+e.target.value / 1000); });
  q('help').addEventListener('click', () => { q('helpPanel').hidden = !q('helpPanel').hidden; });
  q('nodes').addEventListener('change', () => { if (!allConvs.length) return; rebuild(); });
  q('demo').addEventListener('click', () => setData(demoConversations()));

  // Several result pages can be combined: select/drop multiple files at once, or paste
  // page after page into the paste box. Conversations are de-duplicated by id.
  const pasted = [];
  function merge(pages) {
    const seen = new Set(), all = [];
    let more = false, raw = 0, outbound = 0;
    for (const obj of pages) {
      if (obj && !Array.isArray(obj) && obj.cursor) more = true;
      const list = listOf(obj);
      raw += list.length;
      outbound += list.filter(c => c?.originatingDirection && c.originatingDirection !== 'inbound').length;
      for (const c of parseConversations(obj)) {
        if (c.id) { if (seen.has(c.id)) continue; seen.add(c.id); }
        all.push(c);
      }
    }
    all.sort((x, y) => x.start - y.start);
    return { all, more, raw, outbound, keys: pages.map(o => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, 6).join(', ') : typeof o)) };
  }
  // Explains why nothing could be shown, so a bad file can be diagnosed from the message alone.
  const why = m => !m.raw ? i18n('trafficWhyNoList').replace('{0}', m.keys[0] || '')
    : i18n('trafficWhyNoInbound').replace('{0}', m.raw).replace('{1}', m.outbound);
  function showPages(pages) {
    const m = merge(pages), { all, more } = m;
    if (!all.length) { toast(`${i18n('trafficBadFile')}: ${why(m)}`, 'err'); return 0; }
    setData(all);
    if (all.length) toast(`${all.length} ${i18n('trafficPooled')} ${pages.length}`, 'ok');
    if (more && pages.length === 1) toast(i18n('trafficMorePages'), 'err');
    return all.length;
  }
  function loadFiles(files) {
    Promise.all([...files].map(f => new Promise(res => {
      const r = new FileReader();
      r.onload = ev => { try { res({ pages: readJsonLoose(ev.target.result) }); } catch (e) { res({ error: e.message, name: f.name }); } };
      r.onerror = () => res({ error: 'read', name: f.name });
      r.readAsText(f);
    }))).then(results => {
      results.filter(r => r.error).forEach(r => toast(`${r.name}: ${i18n('trafficBadFile')}: ${i18n('trafficWhyJson')} (${r.error.slice(0, 80)})`, 'err'));
      const pages = results.flatMap(r => r.pages || []);
      if (pages.length) showPages(pages);
    });
  }
  const pasteBox = () => root.querySelector('[data-tr="pasteText"]');
  const pasteInfo = () => root.querySelector('[data-tr="pasteInfo"]');
  q('paste').addEventListener('click', () => { q('pastePanel').hidden = !q('pastePanel').hidden; });
  q('pasteAdd').addEventListener('click', () => {
    try { pasted.push(...readJsonLoose(pasteBox().value)); } catch (e) { toast(`${i18n('trafficBadFile')}: ${i18n('trafficWhyJson')} (${e.message.slice(0, 80)})`, 'err'); return; }
    pasteBox().value = '';
    const n = showPages(pasted);
    pasteInfo().textContent = `${pasted.length} ${i18n('trafficPasteParts')} · ${n} ${i18n('trafficPooledShort')}`;
  });
  q('pasteClear').addEventListener('click', () => { pasted.length = 0; pasteBox().value = ''; pasteInfo().textContent = ''; });
  q('file').addEventListener('change', e => { if (e.target.files.length) loadFiles(e.target.files); e.target.value = ''; });
  if (!opts.live) {
    root.addEventListener('dragover', e => e.preventDefault());
    root.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });
  }

  // ── Live data (signed in through the Genesys org the widget runs in) ──
  const panel = q('livePanel');
  const periodSel = q('period');
  let liveMsg = '';
  periodSel.value = gc.loadPeriod();

  function renderLive() {
    panel.hidden = !liveMsg;
    panel.innerHTML = liveMsg ? `<div class="tr-msg">${esc(liveMsg)}</div>` : '';
  }
  const show = m => { liveMsg = m; renderLive(); };

  async function showWho() {
    if (!gc.getSession()) { q('who').textContent = ''; return; }
    try {
      const [org, me] = await Promise.all([gc.orgName().catch(() => ''), gc.whoAmI()]);
      q('who').textContent = [org, me.name].filter(Boolean).join(' · ');
    } catch { q('who').textContent = ''; }
  }

  // Pressing Live data while signed out logs in and then fetches without a second click.
  const login = () => { try { sessionStorage.setItem('tr-autofetch', '1'); } catch { /* ignore */ } gc.startLogin(); };
  const takeAutoFetch = () => { try { const v = sessionStorage.getItem('tr-autofetch'); sessionStorage.removeItem('tr-autofetch'); return !!v; } catch { return false; } };

  let fetching = false;
  async function doFetch() {
    if (fetching) return;
    const period = periodSel.value;
    gc.savePeriod(period);
    fetching = true; q('live').disabled = true; periodSel.disabled = true;
    try {
      const convs = await gc.fetchLiveConversations(period, (list, qn) => parseConversations({ conversations: list }, qn), (stage, n, ci, total) => {
        show(`${i18n('trafficFetching')}${total > 1 ? ` (${ci}/${total})` : ''}${stage === 'results' ? ' ' + n : ''}…`);
      });
      if (!convs.length) { show(i18n('trafficNoConvs')); return; }
      show('');
      setData(convs, convs.filterUsed || '', gc.periodRange(period));
    } catch (err) {
      // An expired token is renewed silently, unless a login just happened (avoids a redirect loop).
      if (err.message === 'auth' && !gc.recentLoginAttempt()) { login(); return; }
      show(err.message === 'forbidden' ? i18n('trafficNoPerm') : `${i18n('trafficLiveFailed')}: ${err.message === 'auth' ? i18n('trafficLogin') : err.message}`);
    } finally {
      fetching = false; q('live').disabled = false; periodSel.disabled = false;
    }
  }

  q('live').addEventListener('click', () => { if (gc.getSession()) doFetch(); else login(); });

  // Signed in through Genesys: the data comes from the org, so demo data, JSON files and the API help are left out.
  // Without sign-in (?demo) it is the other way round.
  [q('demo'), root.querySelector('.tr-upload'), q('paste'), q('help')].forEach(el => { el.hidden = !!opts.live; });
  [q('live'), periodSel].forEach(el => { el.hidden = !opts.live; });

  showWho();
  if (opts.message) show(opts.message);
  if (gc.getSession() && (takeAutoFetch() || opts.autoFetch)) doFetch();

  // ── DID filter (multi-select) ──
  let didCounts = [];                    // [{ did, n }] busiest first
  function buildDidList() {
    const m = new Map();
    allConvs.forEach(c => { if (c.didFull) m.set(c.didFull, (m.get(c.didFull) || 0) + 1); });
    didCounts = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([did, n]) => ({ did, n }));
    q('didSearch').value = '';
    renderDidList(); updateDidLabel();
  }
  function updateDidLabel() {
    const n = selDids.size;
    q('didBtn').textContent = `${i18n('trafficDid')}: ${n === 0 ? `${i18n('trafficDidAll')} (${didCounts.length})` : n === 1 ? [...selDids][0] : `${n} ${i18n('trafficDidSelected')}`} ▾`;
  }
  function renderDidList() {
    const term = q('didSearch').value.trim().toLowerCase(), MAX = 300;
    const rows = didCounts.filter(d => !term || d.did.toLowerCase().includes(term));
    q('didList').innerHTML = rows.slice(0, MAX).map(d =>
      `<label class="tr-ms-row"><input type="checkbox" value="${esc(d.did)}" ${selDids.has(d.did) ? 'checked' : ''}><span>${esc(d.did)}</span><em>${d.n}</em></label>`).join('')
      + (rows.length > MAX ? `<div class="tr-hint">${i18n('trafficShowing')} ${MAX} / ${rows.length} — ${i18n('trafficDidSearchHint')}</div>` : '')
      + (!rows.length ? `<div class="tr-hint">${i18n('trafficNoRows')}</div>` : '');
  }
  // Rebuilds boxes, counters, graph and grid for the selected DIDs, keeping the replay position.
  function rebuild() {
    const list = viewConvs();
    if (!list.length) toast(i18n('trafficNoRows'), 'err');
    const f = (simT - t0) / (t1 - t0);
    model = buildModel(list, +q('nodes').value, maxCols());
    measureEntries(); setupBuckets(); seek(f);
  }
  q('flowOnly').addEventListener('change', () => { rebuild(); });
  q('didBtn').addEventListener('click', e => { e.stopPropagation(); q('didPanel').hidden = !q('didPanel').hidden; if (!q('didPanel').hidden) q('didSearch').focus(); });
  q('didPanel').addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => { q('didPanel').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') q('didPanel').hidden = true; });
  q('flowOnlyTxt').textContent = i18n('trafficFlowOnly');
  q('didSearch').placeholder = i18n('trafficSearch'); q('didAll').textContent = i18n('trafficDidSelectAll'); q('didNone').textContent = i18n('trafficDidClear');
  q('didSearch').addEventListener('input', renderDidList);
  q('didList').addEventListener('change', e => {
    const v = e.target.value; if (e.target.checked) selDids.add(v); else selDids.delete(v);
    updateDidLabel(); rebuild();
  });
  q('didAll').addEventListener('click', () => {      // select what the search currently shows
    const term = q('didSearch').value.trim().toLowerCase();
    didCounts.filter(d => !term || d.did.toLowerCase().includes(term)).forEach(d => selDids.add(d.did));
    if (selDids.size === didCounts.length) selDids.clear();   // everything = no filter
    renderDidList(); updateDidLabel(); rebuild();
  });
  q('didNone').addEventListener('click', () => { selDids.clear(); renderDidList(); updateDidLabel(); rebuild(); });

  // ── Click a box → grid of the calls behind its numbers ──
  const COLS = [
    ['start', 'trafficColTime', c => fmtTime(c.start, true)],
    ['id', 'trafficColId', c => c.id],
    ['didFull', 'trafficColDid', c => c.didFull],
    ['media', 'trafficColMedia', c => c.media],
    ['path', 'trafficColPath', c => c.flows.join(' → ')],
    ['queue', 'trafficColQueue', c => c.queue],
    ['blue', 'trafficColResult', c => (c.blue ? i18n('trafficWithConv') : i18n('trafficWithoutConv'))],
    ['reason', 'trafficColReason', c => c.reason],
    ['dur', 'trafficColDur', c => (c.dur == null ? '' : fmtDur(c.dur))],
  ];
  const fmtDur = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  let modalNode = null, modalSort = { col: 'start', dir: 1 }, modalRows = [];

  function nodeAt(x, y) {
    if (!model) return null;
    for (const n of model.nodes.values()) {
      const p = pos(n, 'c');
      const hit = n.kind === 'did'
        ? x >= p.x - entryW - 12 && x <= p.x + p.w / 2 && Math.abs(y - p.y) <= 9
        : Math.abs(x - p.x) <= p.w / 2 && Math.abs(y - p.y) <= p.h / 2;
      if (hit) return n;
    }
    return null;
  }
  canvas.addEventListener('mousemove', e => {
    const r = canvas.getBoundingClientRect();
    canvas.style.cursor = nodeAt(e.clientX - r.left, e.clientY - r.top) ? 'pointer' : 'default';
  });
  canvas.addEventListener('click', e => {
    const r = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
    if (n) openModal(n);
  });

  function openModal(n) {
    modalNode = n;
    q('mOutcome').innerHTML = ['red', 'blue', 'all'].map(v => `<option value="${v}">${i18n('trafficF_' + v)}</option>`).join('');
    q('mScope').innerHTML = ['ended', 'passed'].map(v => `<option value="${v}">${i18n('trafficS_' + v)}</option>`).join('');
    q('mOutcome').value = n.special ? 'all' : 'red';
    q('mScope').value = n.kind === 'did' ? 'passed' : 'ended';
    q('mScope').hidden = !!n.special;
    q('mSearch').value = ''; q('mSearch').placeholder = i18n('trafficSearch');
    q('mCopy').textContent = i18n('trafficCopy'); q('mCsv').textContent = i18n('trafficCsv');
    modalSort = { col: 'start', dir: 1 };
    q('modal').hidden = false;
    renderGrid();
    q('mSearch').focus();
  }
  function openModalRelabel() {
    const o = q('mOutcome').value, sc = q('mScope').value;
    q('mOutcome').innerHTML = ['red', 'blue', 'all'].map(v => `<option value="${v}">${i18n('trafficF_' + v)}</option>`).join('');
    q('mScope').innerHTML = ['ended', 'passed'].map(v => `<option value="${v}">${i18n('trafficS_' + v)}</option>`).join('');
    q('mOutcome').value = o; q('mScope').value = sc;
    q('mSearch').placeholder = i18n('trafficSearch'); q('mCopy').textContent = i18n('trafficCopy'); q('mCsv').textContent = i18n('trafficCsv');
    renderGrid();
  }
  const closeModal = () => { q('modal').hidden = true; modalNode = null; };

  function renderGrid() {
    const n = modalNode; if (!n) return;
    const outcome = q('mOutcome').value, scope = q('mScope').value, term = q('mSearch').value.trim().toLowerCase();
    let rows = n.special ? byDid(allConvs).filter(c => !c.flows.length && (outcome === 'all' || (outcome === 'red') !== c.blue)) : model.convs.filter(c => {
      if (c.start > simT) return false;                         // same moment as the box counters
      const path = pathOf(model, c);
      if (scope === 'ended' ? path[path.length - 1] !== n.key : !path.includes(n.key)) return false;
      if (outcome === 'red' && c.blue) return false;
      if (outcome === 'blue' && !c.blue) return false;
      return true;
    });
    if (term) rows = rows.filter(c => COLS.some(([, , f]) => String(f(c)).toLowerCase().includes(term)));
    const val = { start: c => c.start, id: c => c.id, didFull: c => c.didFull, media: c => c.media, path: c => c.flows.join(' → '), queue: c => c.queue, blue: c => +c.blue, reason: c => c.reason, dur: c => c.dur ?? -1 }[modalSort.col];
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * modalSort.dir; });
    modalRows = rows;
    q('mTitle').textContent = nodeName(n);
    q('mSub').textContent = n.special ? `${rows.length} ${i18n('trafficCalls')}` : `${rows.length} ${i18n('trafficCalls')} · ${i18n('trafficUntil')} ${fmtTime(Math.min(simT, t1), true)}`;
    const MAX = 3000;
    const head = COLS.map(([k, key]) => `<th data-col="${k}">${esc(i18n(key))}${modalSort.col === k ? (modalSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = rows.slice(0, MAX).map(c => `<tr>${COLS.map(([k, , f]) => `<td${k === 'blue' ? ` class="${c.blue ? 'tr-b' : 'tr-r'}"` : ''}>${esc(f(c))}</td>`).join('')}</tr>`).join('');
    q('mGrid').innerHTML = rows.length
      ? `<table class="tr-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${rows.length > MAX ? `<div class="tr-hint">${i18n('trafficShowing')} ${MAX} / ${rows.length} — ${i18n('trafficExportAll')}</div>` : ''}`
      : `<div class="tr-empty-grid">${i18n('trafficNoRows')}</div>`;
    q('mGrid').querySelectorAll('th').forEach(th => th.onclick = () => {
      modalSort = { col: th.dataset.col, dir: modalSort.col === th.dataset.col ? -modalSort.dir : 1 };
      renderGrid();
    });
  }
  ['mOutcome', 'mScope'].forEach(k => q(k).addEventListener('change', renderGrid));
  q('mSearch').addEventListener('input', renderGrid);
  q('mClose').addEventListener('click', closeModal);
  q('modal').addEventListener('click', e => { if (e.target === q('modal')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !q('modal').hidden) closeModal(); });

  const table = sep => [COLS.map(([, key]) => i18n(key)), ...modalRows.map(c => COLS.map(([, , f]) => f(c)))]
    .map(r => r.map(v => sep === '\t' ? String(v).replace(/[\t\n]/g, ' ') : `"${String(v).replace(/"/g, '""')}"`).join(sep)).join('\n');
  q('mCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(table('\t')); toast(i18n('copied'), 'ok'); } catch { toast(i18n('trafficBadFile'), 'err'); }
  });
  q('mCsv').addEventListener('click', () => {
    const blob = new Blob(['\ufeff' + table(';')], { type: 'text/csv;charset=utf-8' });   // BOM + ; → opens correctly in Excel (da/nl/fr/es)
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `traffic-${(modalNode ? nodeName(modalNode) : 'calls').replace(/[^\w-]+/g, '_')}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // Re-apply texts after a language switch (the toolbar is built once).
  function relabel() {
    const setOpts = (sel, fn) => [...q(sel).options].forEach(o => { o.textContent = fn(o.value); });
    setOpts('speed', v => `${i18n('trafficWeekIn')} ${{ 15000: '15 s', 30000: '30 s', 60000: '60 s', 120000: '2 min', 300000: '5 min' }[v]}`);
    setOpts('nodes', v => `${i18n('trafficNodes')} ${v}`);
    setOpts('period', v => i18n('trafficP_' + v));
    q('speed').title = i18n('trafficSpeed'); q('nodes').title = i18n('trafficNodes'); q('period').title = i18n('trafficPeriod');
    q('live').textContent = i18n('trafficLive'); q('demo').textContent = i18n('trafficDemo');
    q('help').title = i18n('trafficHelpTitle');
    root.querySelector('.tr-upload').firstChild.textContent = i18n('trafficLoad');
    q('helpPanel').innerHTML = i18n('trafficHelpBody');
    q('paste').textContent = i18n('trafficPaste'); fillBucketSelect();
    q('flowOnlyTxt').textContent = i18n('trafficFlowOnly');
    q('didSearch').placeholder = i18n('trafficSearch'); q('didAll').textContent = i18n('trafficDidSelectAll'); q('didNone').textContent = i18n('trafficDidClear');
    if (didCounts.length) { updateDidLabel(); renderDidList(); }
    q('pasteAdd').textContent = i18n('trafficPasteAdd'); q('pasteClear').textContent = i18n('trafficPasteClear');
    q('pastePanel').firstElementChild.textContent = i18n('trafficPasteHint');
    root.querySelector('.tr-empty').textContent = i18n('trafficNoData');
    if (model) { measureEntries(); updateStats(); updateClock(); }
    if (!q('modal').hidden && modalNode) openModalRelabel();
  }

  return { resize, relabel };
}
