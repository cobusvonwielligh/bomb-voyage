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
import { createRoom } from '../server/room.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8097;
let server;

const startServer = () => new Promise((resolve, reject) => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    // MIN_BOTS=0: these tests are about two people, and auto-bots would make it eight.
    env: { ...process.env,
      PORT: String(PORT), LAG: '0', DEPLOY_TOKEN: '', MIN_BOTS: '0',
      // About the room, not about signing in. See test/password.test.js for that.
      REQUIRE_PASSWORD: '0' },
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
    // Not stacked — which is all this can assert now. Respawn weights every legal spawn by
    // distance rather than always taking the furthest, so two players CAN land near each other;
    // a busy spot is unlikely, never impossible. The distribution is tested properly in
    // test/powder.test.js, over six hundred respawns, where it can be measured rather than
    // guessed at from one sample.
    const d = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
    assert.ok(d > 256 * 2, `spawned only ${d} units apart — effectively on top of each other`);
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

test('spectators take no seat, and a full server still lets them in', async () => {
  // The whole point: watching costs nobody a place. If a spectator consumed a seat it would be
  // indistinguishable from playing badly on purpose.
  const sent = [];
  const room = createRoom({ onBroadcast: m => sent.push(typeof m === 'function' ? m(-1) : m) });
  try {
    room.setBots(15);
    const before = room.state.players.filter(Boolean).length;

    // The server builds a spectator's welcome for seat -1; it must not throw and must not seat.
    const welcome = room.welcomeFor(-1);
    assert.equal(welcome.t, 'welcome');
    assert.ok(Array.isArray(welcome.players), 'a spectator needs the player list');
    assert.ok(welcome.map, 'a spectator needs the map');
    assert.equal(room.state.players.filter(Boolean).length, before, 'spectating seated somebody');

    // And the per-seat snapshot builder has to tolerate -1, because that is what a spectator
    // is handed. An ack of undefined would be sent as JSON null and confuse the clock.
    room.start();
    await new Promise(r => setTimeout(r, 120));
    const snap = sent.filter(m => m.t === 'snap').at(-1);
    assert.ok(snap, 'no snapshot was broadcast');
    assert.equal(typeof snap.ack, 'number', `ack for a spectator was ${snap.ack}`);
  } finally {
    room.stop();
  }
});
