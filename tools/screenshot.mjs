// Takes the README screenshot (docs/traffic-widget.png): the widget with demo data, wide on the
// left and as a narrow side panel on the right, part-way through the replay.
//
//   npm run screenshot
//
// Uses a locally installed Edge or Chrome in headless mode, driven over the DevTools protocol so
// the animation runs in real time. Set BROWSER=<path to msedge/chrome> if it is not found.
// No dependencies: a small static server is started for the duration of the run.
import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'traffic-widget.png');
const WIDTH = 1626, HEIGHT = 902;
const SEEK = 550;          // replay position (of 1000) to jump to once loaded
const SETTLE_MS = 9000;    // real time to let dots flow before the picture is taken
const LANG = process.env.LANG_TAG || 'da';

const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);

// Two frames of the widget side by side; once loaded, both jump part-way into the replay.
const SHOT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#e9ecf1}
.wrap{display:flex;gap:24px;padding:20px;align-items:flex-start}
iframe{border:1px solid #c9ced6;border-radius:10px;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.12)}
</style></head><body><div class="wrap">
<iframe src="index.html?demo&theme=light&lang=${LANG}" width="1180" height="860"></iframe>
<iframe src="index.html?demo&theme=light&lang=${LANG}" width="380" height="860"></iframe>
</div><script>
document.querySelectorAll('iframe').forEach(fr => fr.addEventListener('load', () => setTimeout(() => {
  const s = fr.contentDocument.querySelector('[data-tr="seek"]');
  s.value = ${SEEK}; s.dispatchEvent(new Event('input'));
}, 1500)));
</script></body></html>`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ALLOWED = /^\/(index\.html|css\/[\w.-]+\.css|js\/[\w.-]+\.js)$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = BROWSERS.find(p => existsSync(p));
if (!browser) { console.error('No Edge/Chrome found. Set BROWSER=<path>.'); process.exit(1); }

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/shot.html') { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); res.end(SHOT_PAGE); return; }
  if (!ALLOWED.test(path)) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'Content-Type': TYPES[extname(path)] }); res.end(await readFile(join(ROOT, normalize(path)))); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/shot.html`;

const profile = await mkdtemp(join(tmpdir(), 'traffic-shot-'));
const debugPort = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--no-first-run', `--window-size=${WIDTH},${HEIGHT}`, 'about:blank'], { stdio: 'ignore' });

try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch { await sleep(200); }
  }
  const page = targets?.find(t => t.type === 'page');
  if (!page) throw new Error('Could not reach the browser over DevTools');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(SETTLE_MS);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot.result?.data) throw new Error('Screenshot failed');
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log(`Saved ${OUT}`);
  ws.close();
} finally {
  proc.kill();
  server.close();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
