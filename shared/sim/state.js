// The simulation state. Plain objects and integers only — they clone cheaply, hash cheaply, and
// behave identically in Node and the browser. See docs/ARCHITECTURE.md §9.

import {
  MAX_PLAYERS, START_BOMBS, START_RADIUS, UNITS_PER_TILE, DIR_D, STATUS, STATUS_TICKS,
  STAMINA_MAX,
} from '../constants.js';
import { buildMap, cellType, cellHp, packCell } from '../maps.js';
import { BLOCK, BLOCK_WALKABLE } from '../constants.js';
import { rng } from '../util/rng.js';

export function createState(mapDef, seed = mapDef.seed) {
  const map = buildMap(mapDef);
  return {
    tick: 0,
    seed,
    map,
    // Fixed-length so a player's index is their seat for the whole round.
    players: new Array(MAX_PLAYERS).fill(null),
    bombs: [],
    fires: [],
    perks: [],
    // Melted ice: { tx, ty, at, until }. Not a tile type — the map stays the map, and a puddle is
    // just somewhere slow and slippery for a few seconds. See melt() in sim/blocks.js.
    puddles: [],
    nextBombId: 1,
    nextPerkId: 1,
    // Gold coins dropped so far this round. See GOLD_MAX_PER_ROUND — counted on the drop, so a
    // coin nobody reached still used up one of the five.
    goldDropped: 0,
    // Powder kegs placed so far this round. See POWDER_MAX_PER_ROUND.
    powderPlaced: 0,
    // Decaying count of recent pickups; drives the drop rate. See maybeDrop in sim/perks.js.
    perkTakeRate: 0,
    // Seeded, so drops and wall regrowth are reproducible. The sim never calls Math.random().
    next: rng(seed ^ 0x9e3779b9),
    events: [],
  };
}

export function createPlayer(i, name) {
  return {
    i,
    name,
    alive: false,
    x: 0, y: 0,
    dir: DIR_D,
    moving: false,
    bombs: START_BOMBS,
    radius: START_RADIUS,
    speed: 0,          // index into SPEED_UNITS_PER_TICK
    shields: 0,
    status: 0,         // bitmask
    statusUntil: {},   // STATUS bit -> tick
    score: 0, kills: 0, deaths: 0,
    /* Gold coins collected this life. Banked to the leaderboard like score and kills.
     *
     * `coins`, not `gold`. The leaderboard already had a `gold` — first-place finishes, one of
     * gold/silver/bronze — and the two features landed in the same field from opposite
     * branches: a coin pickup incremented the medal count and winning a round incremented the
     * coin counter. Both read perfectly and both were wrong. The trio is a coherent set, so the
     * one that renames is this one, and "coins" is what it actually is. */
    coins: 0,
    // Was the bomb key down last tick? Edge detection for placement — see bombs.place.
    bombHeld: false,
    stamina: STAMINA_MAX,
    staminaLevel: 0,   // Lung perks collected; raises the ceiling, see staminaMaxFor
    tired: false,
    // Ticks of slide left after letting go of the keys on water. See PUDDLE_SLIDE_TICKS.
    slide: 0,
    respawnAt: 0,
  };
}

// ─── map helpers ──────────────────────────────────────────────────────────────

export const tileAt = (map, tx, ty) =>
  (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) ? BLOCK.IRON : cellType(map.cells[ty * map.w + tx]);

export const hpAt = (map, tx, ty) =>
  (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) ? 0 : cellHp(map.cells[ty * map.w + tx]);

export function setTile(map, tx, ty, type, hp) {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return;
  map.cells[ty * map.w + tx] = packCell(type, hp);
}

export const walkable = (map, tx, ty, reduced = false) =>
  BLOCK_WALKABLE(tileAt(map, tx, ty), reduced);

/** Tile coordinate of a position in sim units. */
export const toTile = u => u >> 8;              // UNITS_PER_TILE === 256
export const tileCentre = t => t * UNITS_PER_TILE + (UNITS_PER_TILE >> 1);

// ─── statuses ─────────────────────────────────────────────────────────────────

export function applyStatus(state, p, bit, ticks = STATUS_TICKS[bit]) {
  p.status |= bit;
  p.statusUntil[bit] = Math.max(p.statusUntil[bit] || 0, state.tick + ticks);
}

export function expireStatuses(state, p) {
  if (!p.status) return;
  for (const bit of Object.values(STATUS)) {
    if ((p.status & bit) && state.tick >= (p.statusUntil[bit] || 0)) {
      p.status &= ~bit;
      delete p.statusUntil[bit];
    }
  }
}

export const has = (p, bit) => (p.status & bit) !== 0;

// ─── determinism check ────────────────────────────────────────────────────────

/**
 * FNV-1a over a canonical field order. Used by the determinism test, and available to log the
 * first diverging tick if client and server ever disagree (docs/PLAN.md §10).
 */
export function hashState(state) {
  let h = 0x811c9dc5;
  const mix = n => {
    h ^= n & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (n >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (n >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
  };
  mix(state.tick);
  for (const p of state.players) {
    if (!p) { mix(0xdeadbeef); continue; }
    mix(p.i); mix(p.x); mix(p.y); mix(p.dir);
    mix(p.alive ? 1 : 0); mix(p.bombs); mix(p.radius); mix(p.speed);
    mix(p.shields); mix(p.status); mix(p.score); mix(p.kills); mix(p.deaths);
  }
  for (const b of state.bombs) { mix(b.id); mix(b.tx); mix(b.ty); mix(b.owner); mix(b.radius); mix(b.at); }
  for (const k of state.perks) { mix(k.id); mix(k.tx); mix(k.ty); mix(k.type); }
  for (let i = 0; i < state.map.cells.length; i++) mix(state.map.cells[i]);
  return h >>> 0;
}
