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
      // Seat counts below are exact, so no automatic bots joining alongside the test client.
      MIN_BOTS: '0',
      // Never let a test actually redeploy anything.
      DEPLOY_SCRIPT: '/dev/null',
      // This file is about the deployment spine, not about signing in: with passwords on, every
      // `hello` below would be answered with "pick a password" instead of a welcome. The sign-in
      // handshake has its own end-to-end test — see test/password.test.js.
      REQUIRE_PASSWORD: '0',
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

  await t.test('a malformed URL is refused, not fatal', async () => {
    // `GET /%` used to throw out of decodeURIComponent, and the uncaught-exception handler then
    // exited the process: one request restarted the game for everybody.
    for (const p of ['/%', '/%E0%A4%A', '/shared/%zz']) {
      const res = await fetch(base + p);
      assert.ok(res.status >= 400 && res.status < 500, `${p} answered ${res.status}`);
    }
    assert.equal((await fetch(base + '/healthz')).status, 200, 'the server died');
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
    ws.send(JSON.stringify({ t: 'hello', name: '  smoke\x07test  ' }));

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

  await t.test('/logout signs out without taking the server with it', async () => {
    // The command once called helpers that only existed inside attachHub, so typing it threw a
    // ReferenceError out of the message handler and ended the process.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ t: 'hello', name: 'leaver' }));
    await once(ws, 'message');
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ t: 'chat', msg: '/logout' }));
    const [code] = await closed;
    assert.equal(code, 4002);
    assert.equal((await (await fetch(base + '/healthz')).json()).players, 0);
  });

  await t.test('ignores junk instead of dying', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await once(ws, 'open');
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'no-such-type', weird: true }));
    ws.send(JSON.stringify({ nope: 1 }));
    // Objects whose toString and valueOf are not functions: `String()` or `| 0` on one throws, and
    // each of these once ended the process.
    const poison = { toString: 1, valueOf: 1 };
    ws.send(JSON.stringify({ t: 'input', tick: poison, m: poison }));
    ws.send(JSON.stringify({ t: 'chat', msg: poison }));
    ws.send(JSON.stringify({ t: 'hello', name: poison, adminKey: poison }));
    const [raw] = await once(ws, 'message');
    assert.equal(JSON.parse(raw).t, 'welcome', 'still alive and seating after junk');
    ws.close();
    await once(ws, 'close');
  });
});
