// End-to-end: two real WebSocket clients against a real server. This is the M1 gate — input
// reaches the simulation and comes back in snapshots — and the seat-resume behaviour that
// replaces reconnect pain. docs/PLAN.md §4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { IN_RIGHT, IN_DOWN } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8097;
let server;

const startServer = () => new Promise((resolve, reject) => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), LAG: '0', DEPLOY_TOKEN: '' },
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
});

/** A minimal client: connects, collects snapshots, can drive inputs. */
async function client(name, playerId = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await once(ws, 'open');
  const c = { ws, name, welcome: null, snaps: [], chats: [] };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'snap') c.snaps.push(m);
    if (m.t === 'chat') c.chats.push(m);
  });
  ws.send(JSON.stringify({ t: 'hello', name, playerId }));
  while (!c.welcome) await new Promise(r => setTimeout(r, 10));
  c.me = () => {
    const last = c.snaps.at(-1);
    return last?.players.find(p => p.i === c.welcome.you);
  };
  c.drive = (fromTick, mask, ticks) => {
    for (let i = 0; i < ticks; i++) {
      ws.send(JSON.stringify({ t: 'input', tick: fromTick + i, m: mask }));
    }
  };
  return c;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

test('room end to end', async t => {
  await startServer();
  t.after(async () => { server.kill('SIGTERM'); await once(server, 'exit'); });

  const a = await client('alpha');
  const b = await client('bravo');

  await t.test('two clients get distinct seats and see each other', async () => {
    assert.notEqual(a.welcome.you, b.welcome.you);
    assert.ok(a.welcome.map.cells.length > 100, 'map arrived');
    assert.equal(a.welcome.map.spawns.length, 16);
    await wait(200);
    const names = a.snaps.at(-1).players.map(p => p.i).sort();
    assert.ok(names.length >= 2, 'both players present in snapshots');
  });

  await t.test('spawns are far apart, not stacked', async () => {
    await wait(150);
    // Read a snapshot, not `welcome` — alpha's welcome predates bravo existing.
    const snap = a.snaps.at(-1);
    const pa = snap.players.find(p => p.i === a.welcome.you);
    const pb = snap.players.find(p => p.i === b.welcome.you);
    const d = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
    assert.ok(d > 256 * 8, `spawned only ${d} units apart`);
  });

  await t.test('input moves you, and only you', async () => {
    await wait(100);
    const start = a.snaps.at(-1);
    const aBefore = start.players.find(p => p.i === a.welcome.you);
    const bBefore = start.players.find(p => p.i === b.welcome.you);

    a.drive(start.tick + 2, IN_RIGHT, 40);
    await wait(900);

    const aAfter = a.me();
    const bAfter = a.snaps.at(-1).players.find(p => p.i === b.welcome.you);
    assert.ok(aAfter.x > aBefore.x, `alpha moved right (${aBefore.x} -> ${aAfter.x})`);
    assert.equal(bAfter.x, bBefore.x, 'bravo did not move');
    assert.equal(bAfter.y, bBefore.y);
  });

  await t.test('acks advance so the client can retire pending inputs', async () => {
    const snap = a.snaps.at(-1);
    assert.ok(snap.ack > 0, 'server reports what it has processed');
    assert.ok(snap.ack <= snap.tick);
  });

  await t.test('walls stop you — nobody leaves the map', async () => {
    const start = a.snaps.at(-1);
    a.drive(start.tick + 2, IN_DOWN, 400);
    await wait(1200);
    const me = a.me();
    const h = a.welcome.map.h;
    assert.ok(me.y < h * 256, 'still inside the map');
    assert.ok(me.y > 0);
  });

  await t.test('chat relays, and is attributed', async () => {
    a.ws.send(JSON.stringify({ t: 'chat', msg: 'behind you' }));
    await wait(200);
    const got = b.chats.find(m => m.msg === 'behind you');
    assert.ok(got, 'bravo received it');
    assert.equal(got.name, 'alpha');
  });

  await t.test('chat is rate limited', async () => {
    const before = b.chats.length;
    for (let i = 0; i < 5; i++) a.ws.send(JSON.stringify({ t: 'chat', msg: `spam ${i}` }));
    await wait(300);
    assert.ok(b.chats.length - before <= 1, 'at most one got through');
  });

  await t.test('a dropped socket keeps your seat, score and position', async () => {
    const seat = a.welcome.you;
    const id = a.welcome.playerId;
    const before = a.me();

    a.ws.close();
    await once(a.ws, 'close');
    await wait(150);

    const again = await client('alpha', id);
    assert.equal(again.welcome.you, seat, 'same seat back');
    assert.equal(again.welcome.resumed, true);
    const after = again.welcome.players.find(p => p.i === seat);
    assert.ok(Math.abs(after.x - before.x) < 256, 'roughly where we left off');
    assert.ok(Math.abs(after.y - before.y) < 256);
    again.ws.close();
  });

  await t.test('a different player does not inherit the seat', async () => {
    const c = await client('charlie');
    assert.notEqual(c.welcome.you, a.welcome.you);
    assert.notEqual(c.welcome.you, b.welcome.you);
    c.ws.close();
  });

  b.ws.close();
});
