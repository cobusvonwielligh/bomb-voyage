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
import { canonicalTarget } from './canonical.js';
import { createLeaderboard } from './leaderboard.js';
import { startWebTransport } from './webtransport.js';

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
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

// No external hosts, ever. This is most of why corporate proxies leave us alone, and it means a
// bug can never leak game state to a third party. Inline script/style are allowed because there
// is no build step; we never inject user strings as HTML (textContent only).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
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

  // Before anything else: www, the sslip.io name and the bare IP all bounce to the canonical one.
  const to = canonicalTarget({ host: req.headers.host, url: req.url, want: config.publicHost, tls: usingTls });
  if (to) {
    res.writeHead(301, { Location: to, 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url === '/deploy' && handleDeploy(req, res)) return;

  if (url === '/healthz') {
    const body = JSON.stringify(hub.health({
      uptimeS: Math.round((Date.now() - started) / 1000),
      version: version(),
      transports: { ...hub.transportCounts, webtransport: wt ? hub.transportCounts.webtransport : null },
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
  const stat = fs.statSync(file);
  const size = stat.size;
  /* Caching, with no build step and no content hashes.
   *
   * CODE IS NEVER SERVED STALE. It used to be: everything that was not HTML got five minutes of
   * max-age, so for five minutes after every deploy a browser could be running a MIX of old and
   * new modules — each file cached on its own clock. That is how ice "did not render": a fresh
   * art.js beside a cached constants.js (or the reverse) and the block type the server was sending
   * had no drawing code, so the tile drew as nothing and the sea showed through the hole. On a day
   * with several deploys that is not an edge case.
   *
   * So code — .js, .css, .json, .html — is `no-cache`: always revalidated, never trusted. With an
   * ETag (size and mtime; rsync -a preserves mtimes, so it changes only when the file did) an
   * unchanged file costs a 304 with no body, which on one hostname over one connection is
   * nothing. Images and fonts keep a short max-age plus the ETag; the music, which never changes
   * within a deploy and is megabytes, keeps a day. */
  const etag = `W/"${size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const code = ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.json';
  const head = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': code ? 'no-cache'
      : ext === '.mp3' ? 'public, max-age=86400'
      : 'public, max-age=300',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  if (!req.headers.range && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'Cache-Control': head['Cache-Control'], ETag: etag });
    return res.end();
  }

  /* Byte ranges.
   *
   * Only media ever asks for one, but it is not optional for media: Safari will not play an
   * <audio> source AT ALL from a server that answers a Range request with a 200 and the whole
   * file. It issues `bytes=0-1`, expects a 206, and gives up on the element when it does not get
   * one. Chrome is forgiving, which is exactly how this ships broken for half the office. */
  const asked = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range || '').trim());
  if (asked && size > 0) {
    const [, rawStart, rawEnd] = asked;
    let start, end;
    if (rawStart === '') {
      // A suffix range: the LAST n bytes. `bytes=-500` is not "from 0 to 500".
      const n = Number(rawEnd);
      if (!rawEnd || !Number.isFinite(n)) return range416(res, size);
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return range416(res, size);
    }
    res.writeHead(206, {
      ...head,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...head, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

function range416(res, size) {
  res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Type': 'text/plain' });
  res.end('range not satisfiable');
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

/**
 * WebTransport on UDP/443, beside the WebSocket on TCP/443.
 *
 * Only with real TLS: WebTransport demands a publicly trusted certificate unless the client pins
 * a hash, and there is no sane way to hand a pinned hash to sixteen colleagues. Locally that
 * means WebSocket only, which is the correct local setup anyway.
 *
 * Failure here is never fatal. A missing native binary, a taken port, a kernel that will not give
 * us UDP — all of them end as "WebSocket only", which is the configuration a good share of
 * players behind a corporate firewall will be in no matter what we do.
 */
let wt = null;
if (usingTls) {
  startWebTransport({
    port: config.port,
    cert: fs.readFileSync(config.tlsCert, 'utf8'),
    privKey: fs.readFileSync(config.tlsKey, 'utf8'),
    onSocket: ws => hub.attachSocket(ws),
  }).then(h => { wt = h; }).catch(err => console.warn(`webtransport: ${err.message}`));
}

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

/* Shutting down has to finish writing before it exits.
 *
 * Two bugs lived here. The scores of everyone still playing were only ever written at a round
 * boundary, so a deploy in the middle of a ten-minute round discarded it — and on a build day
 * that is most deploys. And `leaderboard.stop()` returns a promise that nothing awaited, while
 * `server.close` could call `process.exit` first, so even the writes that were queued could be
 * cut off halfway.
 *
 * Now: bank the round, await the save, then exit. The three-second backstop stays, because a
 * shutdown that hangs is worse than one that loses a few points.
 */
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${sig} — shutting down`);
    setTimeout(() => process.exit(0), 3000).unref();
    try {
      hub.bankScores();
      await leaderboard.stop();
      console.log('leaderboard saved');
    } catch (err) {
      console.warn(`leaderboard: save on shutdown failed (${err.message})`);
    }
    hub.shutdown();
    wt?.stop();
    server.close(() => process.exit(0));
  });
}
