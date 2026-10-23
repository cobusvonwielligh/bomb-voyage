// Smoke test for the deployment spine: static files, the /shared mount, path traversal,
// health, and a real WebSocket join. If this passes, a deploy that boots is a deploy that works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099;
const base = `http://127.0.0.1:${PORT}`;

let server;

const DEPLOY_TOKEN = 'test-token-not-a-real-secret';

const startServer = () => new Promise((resolve, reject) => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      LAG: '0',
      DEPLOY_TOKEN,
      // Never let a test actually redeploy anything.
      DEPLOY_SCRIPT: '/dev/null',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const bail = setTimeout(() => reject(new Error('server did not come up in 10s')), 10_000);
  const onData = chunk => {
    if (!String(chunk).includes('listening')) return;
    clearTimeout(bail);
    server.stdout.off('data', onData);
    server.stdout.resume(); // keep draining, or the pipe fills and the server blocks on console.log
    resolve();
  };
  server.stdout.on('data', onData);
  server.once('exit', code => { clearTimeout(bail); reject(new Error(`server exited early (${code})`)); });
});

test('deployment spine', async t => {
  await startServer();
  t.after(async () => { server.kill('SIGTERM'); await once(server, 'exit'); });

  await t.test('serves the page', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await res.text(), /Bomb Voyage/);
  });

  await t.test('serves shared modules to the browser', async () => {
    const res = await fetch(base + '/shared/constants.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.match(await res.text(), /TICK_HZ/);
  });

  await t.test('refuses to escape a mount', async () => {
    for (const p of ['/../package.json', '/shared/../package.json', '/%2e%2e/package.json']) {
      assert.equal((await fetch(base + p, { redirect: 'manual' })).status, 404, p);
    }
  });

  await t.test('health reports players', async () => {
    const h = await (await fetch(base + '/healthz')).json();
    assert.equal(h.ok, true);
    assert.equal(h.players, 0);
    assert.equal(h.maxPlayers, 16);
  });

  await t.test('websocket seats a player and frees the seat on close', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ t: 'hello', name: '  smoketest  ' }));

    const [raw] = await once(ws, 'message');
    const welcome = JSON.parse(raw);
    assert.equal(welcome.t, 'welcome');
    assert.equal(welcome.you, 0);
    assert.equal(welcome.players[0].name, 'smoketest', 'control chars stripped, trimmed');
    assert.ok(welcome.playerId);

    assert.equal((await (await fetch(base + '/healthz')).json()).players, 1);

    ws.close();
    await once(ws, 'close');
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await (await fetch(base + '/healthz')).json()).players, 0);
  });

  await t.test('deploy webhook rejects everything but a correct POST', async () => {
    const post = (headers = {}) => fetch(base + '/deploy', { method: 'POST', headers });

    assert.equal((await post()).status, 404, 'no token');
    assert.equal((await post({ 'x-deploy-token': 'wrong' })).status, 404, 'wrong token');
    assert.equal((await post({ 'x-deploy-token': DEPLOY_TOKEN + 'x' })).status, 404,
      'right prefix, wrong length');
    assert.equal(
      (await fetch(base + '/deploy', { headers: { 'x-deploy-token': DEPLOY_TOKEN } })).status,
      404, 'GET with a valid token is still a 404');

    const ok = await post({ 'x-deploy-token': DEPLOY_TOKEN });
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).updating, true);

    // Cooldown stops a stuck workflow from restarting the box in a loop.
    assert.equal((await post({ 'x-deploy-token': DEPLOY_TOKEN })).status, 429);
  });

  await t.test('health reports the running version', async () => {
    const h = await (await fetch(base + '/healthz')).json();
    assert.ok('version' in h, 'CI compares this against the commit it pushed');
  });

  await t.test('ignores junk instead of dying', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await once(ws, 'open');
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'no-such-type', weird: true }));
    ws.send(JSON.stringify({ nope: 1 }));
    ws.send(JSON.stringify({ t: 'hello', name: null }));
    const [raw] = await once(ws, 'message');
    assert.equal(JSON.parse(raw).t, 'welcome', 'still alive and seating after junk');
    ws.close();
    await once(ws, 'close');
  });
});
