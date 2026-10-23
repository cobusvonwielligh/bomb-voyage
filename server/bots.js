// Headless load-test clients — docs/PLAN.md task NET-6.
//
// `node server/bots.js 15` plus one real browser fills the room, which is the only honest way to
// see what 16 players does to tick time before 16 actual people are waiting on it. The bots play
// badly on purpose: the point is traffic shape, not skill. Dev tool, not product.
//
// Usage: node server/bots.js [count] [url]

import { WebSocket } from 'ws';
import { IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, IN_BOMB, TICK_MS, PING_EVERY_MS } from '../shared/constants.js';

const COUNT = Math.max(1, Number(process.argv[2]) || 15);
const URL = process.argv[3] || 'ws://localhost:8080/ws';

const DIRS = [IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN];
const INPUT_MS = Math.round(TICK_MS);            // 33 ms, near enough for a load generator
const STAGGER_MS = 100;                          // so 15 hellos do not land in one tick
const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

const stats = { everConnected: new Set(), snaps: 0, snapBytes: 0, rtts: [] };
const bots = [];
let stopping = false;

function createBot(n) {
  const name = `bot-${n}`;
  let ws = null;
  let inputTimer = null, pingTimer = null;
  let tick = 0, seat = -1, x = 0, y = 0;
  let mask = DIRS[rand(0, 3)], hold = rand(10, 30);
  let retired = false;                           // a `reject` means do not come back

  const stopTimers = () => {
    clearInterval(inputTimer); clearInterval(pingTimer);
    inputTimer = pingTimer = null;
  };

  const send = msg => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  /** Hold a direction for a while, then pick another. Anything twitchier is just noise. */
  const wander = () => {
    if (--hold <= 0) { mask = DIRS[rand(0, 3)]; hold = rand(10, 30); }
    return mask | (Math.random() < 1 / 60 ? IN_BOMB : 0);
  };

  function startSending() {
    stopTimers();
    inputTimer = setInterval(() => {
      tick++;
      send({ t: 'input', tick, m: wander(), x, y });
    }, INPUT_MS);
    pingTimer = setInterval(() => send({ t: 'ping', c: Date.now() }), PING_EVERY_MS);
  }

  function onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m?.t) {
      case 'welcome':
        seat = m.you;
        // A local counter seeded a couple of ticks ahead of the server: inputs labelled at or
        // behind the server tick are dropped as already simulated (server/room.js `input`).
        tick = (m.tick | 0) + 2;
        stats.everConnected.add(name);
        startSending();
        break;
      case 'snap': {
        stats.snaps++;
        stats.snapBytes += Buffer.byteLength(raw);
        const me = m.players?.find(p => p.i === seat);
        if (me) { x = me.x; y = me.y; }          // so our position echo is plausible, not zero
        break;
      }
      case 'pong':
        stats.rtts.push(Date.now() - m.c);
        tick = Math.max(tick, (m.tick | 0) + 2);
        break;
      case 'reject':
        console.log(`${name} rejected: ${m.why}`);
        retired = true;
        ws.close();
        break;
      // Anything else is ignored, which is what docs/PROTOCOL.md §6 asks of every client.
    }
  }

  function connect() {
    ws = new WebSocket(URL);
    ws.on('open', () => send({ t: 'hello', name, playerId: null, clientVersion: 1 }));
    ws.on('message', onMessage);
    ws.on('error', () => {});                    // close always follows; report it there
    ws.on('close', () => {
      stopTimers();
      if (stopping || retired) return;
      setTimeout(connect, rand(1000, 2000));
    });
  }

  return {
    name,
    connect,
    close() { stopping = true; stopTimers(); ws?.close(); },
  };
}

function summary() {
  const rtts = stats.rtts.slice().sort((a, b) => a - b);
  const median = rtts.length ? rtts[rtts.length >> 1] : 0;
  const avgBytes = stats.snaps ? Math.round(stats.snapBytes / stats.snaps) : 0;
  console.log('');
  console.log(`bots connected      ${stats.everConnected.size}/${COUNT}`);
  console.log(`snapshots received  ${stats.snaps}`);
  console.log(`avg snapshot bytes  ${avgBytes}`);
  console.log(rtts.length
    ? `rtt ms min/med/max  ${rtts[0]}/${median}/${rtts.at(-1)}  (${rtts.length} samples)`
    : 'rtt ms min/med/max  no samples');
}

console.log(`${COUNT} bots -> ${URL}`);
for (let n = 0; n < COUNT; n++) {
  const bot = createBot(n);
  bots.push(bot);
  setTimeout(bot.connect, n * STAGGER_MS);
}

process.on('SIGINT', () => {
  stopping = true;
  for (const bot of bots) bot.close();
  summary();
  // Give the close frames a moment to go out rather than killing the sockets mid-handshake.
  setTimeout(() => process.exit(0), 250);
});
