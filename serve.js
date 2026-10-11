// Minimal static server for trying the widget locally (no dependencies).
// Genesys Cloud only embeds HTTPS pages, so host the files on an HTTPS static host for real use.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ALLOWED = /^\/(index\.html|css\/[\w.-]+\.css|js\/[\w.-]+\.js)$/;

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  if (!ALLOWED.test(path)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(join(ROOT, normalize(path)));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, () => {
  const base = `http://localhost:${PORT}/`;
  console.log(`Traffic widget, demo data:  ${base}?demo`);
  // Live data: CLIENT_ID and REGION give a ready-made URL. The OAuth client needs the redirect URI below.
  const { CLIENT_ID, REGION } = process.env;
  const live = CLIENT_ID && REGION ? `${base}?clientId=${encodeURIComponent(CLIENT_ID)}&region=${encodeURIComponent(REGION)}` : base;
  console.log(`Traffic widget, live data:  ${live}${CLIENT_ID && REGION ? '' : '  (enter client ID and region there, or set CLIENT_ID and REGION)'}`);
  console.log(`OAuth redirect URI:         ${base}`);
});
