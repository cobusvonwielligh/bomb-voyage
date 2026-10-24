// Signing in, over a real socket, against a real server.
//
// server/accounts.js is unit-tested next door; this is the half that has burned every project
// that ever added a login to something that did not have one — the HANDSHAKE. The questions it
// answers: does a new name get asked, does the right password get in, does the wrong one stay
// out, and does the browser that signed in once stop being asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8101;
const PW = 'a decent password';

let server;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-pw-'));

const startServer = () => new Promise((resolve, reject) => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      LAG: '0',
      MIN_BOTS: '0',
      DEPLOY_TOKEN: '',
      // Its own accounts.json, so a test run never touches the real one.
      DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const bail = setTimeout(() => reject(new Error('server did not come up')), 10_000);
  const onData = c => {
    if (!String(c).includes('listening')) return;
    clearTimeout(bail);
    server.stdout.off('data', onData);
    server.stdout.resume();
    resolve();
  };
  server.stdout.on('data', onData);
  server.once('exit', code => { clearTimeout(bail); reject(new Error(`server exited early (${code})`)); });
});

/** Say hello and return the server's first answer: a welcome, or a rejection. */
async function hello(fields) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'hello', ...fields }));
  const [raw] = await once(ws, 'message');
  return { ws, msg: JSON.parse(raw) };
}

/** Say hello, read the answer, and leave. */
async function once_(fields) {
  const { ws, msg } = await hello(fields);
  ws.close();
  return msg;
}

test('signing in', async t => {
  await startServer();
  t.after(async () => { server.kill('SIGTERM'); await once(server, 'exit'); });

  let token = null;

  await t.test('a name nobody has claimed is asked to pick a password', async () => {
    const msg = await once_({ name: 'cobus' });
    assert.equal(msg.t, 'reject');
    assert.equal(msg.auth, 'signup', 'a new name was not offered a sign-up');
    assert.match(msg.why, /password/);
  });

  await t.test('a password that is too short is refused, with a reason', async () => {
    const msg = await once_({ name: 'cobus', pw: 'short' });
    assert.equal(msg.auth, 'signup');
    assert.match(msg.why, /characters/);
  });

  await t.test('claiming it seats the player and hands the browser a token', async () => {
    const { ws, msg } = await hello({ name: 'cobus', pw: PW });
    assert.equal(msg.t, 'welcome', `expected a welcome, got ${msg.why ?? msg.t}`);
    assert.equal(msg.you, 0);
    assert.ok(msg.trust, 'no trusted-browser token came back with the welcome');
    token = msg.trust;
    ws.close();
    await once(ws, 'close');
    await new Promise(r => setTimeout(r, 60));      // let the seat go
  });

  await t.test('the same name from an unknown browser is asked for its password', async () => {
    const msg = await once_({ name: 'cobus' });
    assert.equal(msg.t, 'reject');
    assert.equal(msg.auth, 'need', 'a claimed name let somebody in without a password');
  });

  await t.test('the wrong password never gets in', async () => {
    for (const wrong of ['nearly the password', PW.toUpperCase(), '']) {
      const msg = await once_({ name: 'cobus', pw: wrong });
      assert.equal(msg.t, 'reject', `"${wrong}" was accepted`);
      assert.ok(msg.auth === 'bad' || msg.auth === 'need' || msg.auth === 'wait');
    }
  });

  await t.test('the token gets in with no password at all', async () => {
    const { ws, msg } = await hello({ name: 'cobus', trust: token });
    assert.equal(msg.t, 'welcome', `the trusted browser was asked again: ${msg.why ?? ''}`);
    ws.close();
    await once(ws, 'close');
    await new Promise(r => setTimeout(r, 60));
  });

  await t.test('somebody else"s token is worth nothing', async () => {
    const msg = await once_({ name: 'tango', trust: token });
    assert.equal(msg.t, 'reject');
    assert.equal(msg.auth, 'signup', 'a token vouched for a name it was not issued for');
  });

  await t.test('watching needs no password — the way back in when you forget one', async () => {
    const { ws, msg } = await hello({ name: 'cobus', observe: true });
    assert.equal(msg.t, 'welcome');
    assert.equal(msg.observing, true);
    assert.equal(msg.you, -1, 'a spectator took a seat');
    ws.close();
  });

  await t.test('the password never appears in what the server sends back', async () => {
    const { ws, msg } = await hello({ name: 'hoist', pw: PW });
    assert.equal(msg.t, 'welcome');
    assert.ok(!JSON.stringify(msg).includes(PW), 'THE PASSWORD CAME BACK OVER THE WIRE');
    ws.close();
  });

  await t.test('and it is not in the accounts file either', async () => {
    const raw = fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8');
    assert.ok(!raw.includes(PW), 'THE PASSWORD IS ON DISK IN PLAINTEXT');
    assert.ok(!raw.includes(token), 'a device token is on disk in plaintext');
  });
});
