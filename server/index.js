// Bomb Voyage — process bootstrap: config, static files, health, TLS, self-update webhook.
// The WebSocket hub lives in net.js. See docs/ARCHITECTURE.md §7.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { attachHub } from './net.js';
import { config, usingTls, ROOT } from './config.js';
import { createLeaderboard } from './leaderboard.js';

// The lag shim exists to make development honest, and would silently ruin a real session.
if (config.lag && usingTls) {
  console.error('refusing to start: lag is set while TLS is configured. That combination is a bug.');
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

// ─── self-update webhook ──────────────────────────────────────────────────────
// GitHub Actions cannot SSH in — port 22 is restricted to one IP on purpose, and runners have
// dynamic addresses. So CD is pull-based: Actions proves the tests pass, then pokes this, and
// the box updates itself over its own outbound HTTPS. No inbound SSH, no private key in GitHub.

let lastDeploy = 0;
const DEPLOY_COOLDOWN_MS = 10_000;

function handleDeploy(req, res) {
  // No token configured (any laptop) means the endpoint does not exist at all.
  if (!config.deployToken) return false;

  const given = req.headers['x-deploy-token'];
  const want = config.deployToken;
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(want);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  const who = req.socket.remoteAddress;
  if (req.method !== 'POST' || !ok) {
    // Deliberately a 404, not a 401: an unauthenticated caller learns nothing about the endpoint.
    console.warn(`deploy: rejected from ${who}`);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return true;
  }
  if (Date.now() - lastDeploy < DEPLOY_COOLDOWN_MS) {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('too soon');
    return true;
  }
  lastDeploy = Date.now();

  console.log(`deploy: accepted from ${who}, self-update starting`);
  // Detached, because the script restarts this very process. Answer first, then die.
  const child = spawn('bash', [config.deployScript], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });
  child.unref();

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, updating: true }));
  return true;
}

// ─── request handling ─────────────────────────────────────────────────────────

const started = Date.now();

function handle(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const url = req.url.split('?')[0];

  if (url === '/deploy' && handleDeploy(req, res)) return;

  if (url === '/healthz') {
    const body = JSON.stringify(hub.health({
      uptimeS: Math.round((Date.now() - started) / 1000),
      version: version(),
      top: leaderboard.top(5),
    }));
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

/**
 * What is actually running, for /healthz.
 *
 * `.version` is written by infra/deploy.sh and wins, because a manual deploy rsyncs the working
 * tree without touching `.git` — reading the git sha alone would report the last *pulled*
 * commit, not the code on disk. Falls back to .git/HEAD for a self-update, and to null locally.
 */
let cachedVersion;
function version() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion = fs.readFileSync(path.join(ROOT, '.version'), 'utf8').trim() || null;
    return cachedVersion;
  } catch { /* not a manual deploy; try git */ }
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git/HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? fs.readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim() : head;
    cachedVersion = sha.slice(0, 7);
  } catch { cachedVersion = null; }
  return cachedVersion;
}

// ─── server ───────────────────────────────────────────────────────────────────

const server = usingTls
  ? https.createServer(
      { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handle)
  : http.createServer(handle);

const leaderboard = createLeaderboard({ dataDir: config.dataDir });
const hub = attachHub(server, { ...config, leaderboard });

server.listen(config.port, () => {
  console.log(`bomb-voyage listening on ${usingTls ? 'https' : 'http'}://${config.publicHost}:${config.port}`);
  console.log(`config: ${config.iniPath || 'defaults + environment only'}`);
  if (config.lag) console.log(`LAG SHIM ACTIVE: ${config.lag}ms +/-${config.jitter}ms`);
  if (config.deployToken) console.log('self-update webhook enabled at POST /deploy');
});

// Plain HTTP exists only to bounce people to HTTPS and to answer ACME challenges.
if (usingTls && config.redirectPort) {
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${config.publicHost}${req.url}` });
    res.end();
  }).listen(config.redirectPort);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} — shutting down`);
    hub.shutdown();
    leaderboard.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
