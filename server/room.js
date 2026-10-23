// One round: the authoritative loop, the seats, and the snapshots.
//
// The loop is the only thing in the project allowed to decide the order of operations — see
// docs/ARCHITECTURE.md §4. Everything it calls is a pure-ish system from shared/sim.

import {
  TICK_MS, TICK_HZ, SNAP_EVERY_TICKS, MAX_PLAYERS, ROUND_TICKS, STATUS, STATUS_TICKS,
  TILE_PX, UNITS_PER_TILE, FUSE_TICKS, FIRE_TICKS, playerColor,
} from '../shared/constants.js';
import { MAPS, encodeCells } from '../shared/maps.js';
import { createState, createPlayer, expireStatuses, applyStatus, tileCentre } from '../shared/sim/state.js';
import { stepAll } from '../shared/sim/movement.js';

// How long a seat is held for someone who vanished. A closed laptop lid, a wifi roam or a tunnel
// all look identical to a crash, and losing your stats to a two-second blip is maddening.
const RECONNECT_GRACE_TICKS = 45 * 30;      // 45 seconds
const INPUT_BUFFER_TICKS = 64;

export function createRoom({ onBroadcast, maxPlayers = MAX_PLAYERS }) {
  let mapIndex = 0;
  let state = createState(MAPS[mapIndex]);

  // seat -> { playerId, name, mask, inputs, lastAckTick, connected, goneSince }
  const seats = new Array(maxPlayers).fill(null);
  let timer = null;
  let nextDeadline = 0;
  const tickTimes = [];

  // ─── seating ────────────────────────────────────────────────────────────────

  const findSeatByPlayerId = id => (id ? seats.findIndex(s => s && s.playerId === id) : -1);

  function join(playerId, name) {
    // Resume takes priority: same playerId gets the same seat, score and position back.
    const existing = findSeatByPlayerId(playerId);
    if (existing >= 0) {
      seats[existing].connected = true;
      seats[existing].goneSince = 0;
      seats[existing].name = name || seats[existing].name;
      state.players[existing].name = seats[existing].name;
      return { seat: existing, resumed: true };
    }

    const seat = seats.findIndex(s => s === null);
    if (seat === -1) return { seat: -1, resumed: false };

    seats[seat] = {
      playerId, name, mask: 0, inputs: new Map(), lastAckTick: 0,
      connected: true, goneSince: 0,
    };
    const p = createPlayer(seat, name);
    state.players[seat] = p;
    respawn(p);
    return { seat, resumed: false };
  }

  function disconnect(seat) {
    const s = seats[seat];
    if (!s) return;
    s.connected = false;
    s.goneSince = state.tick;
    s.mask = 0;                 // stop walking into a wall while you are away
  }

  function release(seat) {
    seats[seat] = null;
    state.players[seat] = null;
  }

  // ─── input ──────────────────────────────────────────────────────────────────

  function input(seat, tick, mask) {
    const s = seats[seat];
    if (!s) return;
    if (tick <= s.lastAckTick) return;                 // already simulated; too late to matter
    s.inputs.set(tick, mask & 0x1f);
    if (s.inputs.size > INPUT_BUFFER_TICKS) {
      // Drop the oldest rather than growing without bound if a client floods us.
      const oldest = Math.min(...s.inputs.keys());
      s.inputs.delete(oldest);
    }
  }

  // ─── spawning ───────────────────────────────────────────────────────────────

  /** Spawn as far as possible from the nearest living player, so nobody lands in a firefight. */
  function respawn(p) {
    const spawns = state.map.spawns;
    let best = spawns[0], bestScore = -1;
    for (const [tx, ty] of spawns) {
      let nearest = Infinity;
      for (const q of state.players) {
        if (!q || !q.alive || q === p) continue;
        const d = Math.abs(q.x - tileCentre(tx)) + Math.abs(q.y - tileCentre(ty));
        if (d < nearest) nearest = d;
      }
      if (nearest > bestScore) { bestScore = nearest; best = [tx, ty]; }
    }
    p.x = tileCentre(best[0]);
    p.y = tileCentre(best[1]);
    p.alive = true;
    p.status = 0;
    p.statusUntil = {};
    applyStatus(state, p, STATUS.INVULN, STATUS_TICKS[STATUS.INVULN]);
    state.events.push({ e: 'spawn', tick: state.tick, i: p.i, x: p.x, y: p.y });
  }

  // ─── the tick ───────────────────────────────────────────────────────────────

  function tick() {
    const t0 = performance.now();
    const inputs = new Array(maxPlayers).fill(0);

    for (let i = 0; i < maxPlayers; i++) {
      const s = seats[i];
      if (!s) continue;
      if (s.inputs.has(state.tick)) {
        s.mask = s.inputs.get(state.tick);
        s.inputs.delete(state.tick);
      }
      // Missing input repeats the last mask. A dropped packet should not make you stutter.
      s.lastAckTick = state.tick;
      inputs[i] = s.mask;

      if (!s.connected && state.tick - s.goneSince > RECONNECT_GRACE_TICKS) release(i);
    }

    for (const p of state.players) if (p) expireStatuses(state, p);
    stepAll(state, inputs);

    state.tick++;

    const ms = performance.now() - t0;
    tickTimes.push(ms);
    if (tickTimes.length > 300) tickTimes.shift();
    if (ms > 20) console.warn(`slow tick: ${ms.toFixed(1)}ms at ${state.tick}`);

    if (state.tick % SNAP_EVERY_TICKS === 0) emitSnapshot();
    state.events.length = 0;

    if (state.tick >= ROUND_TICKS) nextRound();
  }

  function nextRound() {
    mapIndex = (mapIndex + 1) % MAPS.length;
    const carried = seats.map(s => (s ? { ...s, inputs: new Map() } : null));
    const scores = state.players.map(p => (p ? { score: p.score, kills: p.kills, deaths: p.deaths } : null));
    state = createState(MAPS[mapIndex]);
    for (let i = 0; i < maxPlayers; i++) {
      seats[i] = carried[i];
      if (!carried[i]) continue;
      const p = createPlayer(i, carried[i].name);
      state.players[i] = p;
      respawn(p);
      // Round score resets; the session totals are what the leaderboard reads.
      p.kills = scores[i]?.kills || 0;
      p.deaths = scores[i]?.deaths || 0;
    }
    onBroadcast({ t: 'roundend', nextMap: MAPS[mapIndex].id, startsInMs: 0 });
    onBroadcast(welcomePayloadBase());
  }

  // ─── snapshots ──────────────────────────────────────────────────────────────

  const playerWire = p => ({
    i: p.i, x: p.x, y: p.y, d: p.dir, st: p.alive ? 1 : 0,
    b: p.bombs, f: p.radius, sp: p.speed, sh: p.shields,
    s: p.score, k: p.kills, dd: p.deaths, stat: p.status,
  });

  function emitSnapshot() {
    const players = [];
    for (const p of state.players) if (p) players.push(playerWire(p));
    const ev = state.events.slice();
    onBroadcast(seat => ({
      t: 'snap',
      tick: state.tick,
      ack: seats[seat]?.lastAckTick ?? 0,
      players,
      bombs: state.bombs,
      ev,
    }));
  }

  const welcomePayloadBase = () => ({
    t: 'mapchange',
    map: {
      id: state.map.id, name: state.map.name, w: state.map.w, h: state.map.h,
      cells: encodeCells(state.map.cells), spawns: state.map.spawns,
    },
  });

  function welcomeFor(seat) {
    const players = [];
    for (const p of state.players) if (p) players.push({ ...playerWire(p), name: p.name, c: p.i });
    return {
      t: 'welcome',
      you: seat,
      tick: state.tick,
      roundEndsAtTick: ROUND_TICKS,
      color: playerColor(seat),
      map: welcomePayloadBase().map,
      players,
      bombs: state.bombs,
      perks: state.perks,
      // Every rule constant the client needs, so a server tuning change needs no client deploy.
      config: {
        tickHz: TICK_HZ, snapEvery: SNAP_EVERY_TICKS, tileSize: TILE_PX,
        unitsPerTile: UNITS_PER_TILE, maxPlayers, fuseTicks: FUSE_TICKS, fireTicks: FIRE_TICKS,
      },
    };
  }

  // ─── loop ───────────────────────────────────────────────────────────────────

  function start() {
    if (timer) return;
    nextDeadline = performance.now() + TICK_MS;
    timer = setInterval(() => {
      const now = performance.now();
      // Absolute deadlines, so the tick rate does not drift. Capped catch-up, so a long GC pause
      // cannot trigger a storm of ticks that makes everyone teleport.
      let guard = 0;
      while (now >= nextDeadline && guard < 3) {
        tick();
        nextDeadline += TICK_MS;
        guard++;
      }
      if (now > nextDeadline + TICK_MS * 10) nextDeadline = now + TICK_MS;   // way behind: resync
    }, Math.max(1, Math.floor(TICK_MS / 2)));
  }

  const stop = () => { clearInterval(timer); timer = null; };

  const stats = () => {
    const sorted = [...tickTimes].sort((a, b) => a - b);
    return {
      tick: state.tick,
      map: state.map.id,
      players: seats.filter(s => s && s.connected).length,
      reserved: seats.filter(s => s && !s.connected).length,
      tickMsP50: +(sorted[sorted.length >> 1] || 0).toFixed(2),
      tickMsP99: +(sorted[Math.floor(sorted.length * 0.99)] || 0).toFixed(2),
    };
  };

  return { start, stop, join, disconnect, input, welcomeFor, stats, get state() { return state; } };
}
