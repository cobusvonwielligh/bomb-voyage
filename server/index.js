// Bomb Voyage — process bootstrap: config, static files, health, TLS.
// The WebSocket hub lives in net.js. See docs/ARCHITECTURE.md §7.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachHub } from './net.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: +(process.env.PORT || 8080),
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  publicHost: process.env.PUBLIC_HOST || 'localhost',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  maxPlayers: +(process.env.MAX_PLAYERS || 16),
  lag: +(process.env.LAG || 0),
  jitter: +(process.env.JITTER || 0),
  redirectPort: +(process.env.REDIRECT_PORT || 80),
};

// The lag shim exists to make development honest, and would silently ruin a real session.
if (config.lag && config.tlsCert) {
  console.error('refusing to start: LAG is set while TLS is configured. That combination is a bug.');
  process.exit(1);
}

// ─── static files ─────────────────────────────────────────────────────────────
// Two mounts: public/ at `/`, and shared/ at `/shared` so the browser can import the exact
// simulation modules Node runs.

const MOUNTS = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// No external hosts, ever. This is most of why corporate proxies leave us alone, and it means a
// bug can never leak game state to a third party. Inline script/style are allowed because there
// is no build step; we never inject user strings as HTML (textContent only).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean.includes('\0') || clean.split('/').includes('..')) return null;
  for (const { prefix, dir } of MOUNTS) {
    if (!clean.startsWith(prefix)) continue;
    let rel = clean.slice(prefix.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, rel);
    // Belt and braces: path.join already collapsed `..`, this proves we stayed inside the mount.
    if (!file.startsWith(dir + path.sep) && file !== dir) return null;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

const started = Date.now();

function handle(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.url === '/healthz') {
    const body = JSON.stringify(hub.health({ uptimeS: Math.round((Date.now() - started) / 1000) }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(body);
  }

  const file = resolveFile(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  const ext = path.extname(file);
  // No content hashing (there is no build step), so never cache HTML and cache the rest briefly.
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
}

// ─── server ───────────────────────────────────────────────────────────────────

const useTls = Boolean(config.tlsCert && config.tlsKey);
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handle)
  : http.createServer(handle);

const hub = attachHub(server, config);

server.listen(config.port, () => {
  const scheme = useTls ? 'https' : 'http';
  console.log(`bomb-voyage listening on ${scheme}://${config.publicHost}:${config.port}`);
  if (config.lag) console.log(`LAG SHIM ACTIVE: ${config.lag}ms ±${config.jitter}ms`);
});

// Plain HTTP exists only to bounce people to HTTPS and to answer ACME challenges.
if (useTls && config.redirectPort) {
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${config.publicHost}${req.url}` });
    res.end();
  }).listen(config.redirectPort);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} — shutting down`);
    hub.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
