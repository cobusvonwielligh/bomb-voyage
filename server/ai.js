// Bot brains for the in-game `/bots N` command.
//
// These are seats the server drives itself — no sockets, no second process. That makes them
// nearly free, and it means they exercise the simulation rather than the network. The separate
// `npm run bots` harness is the one that exercises the network; this is the one that gives you
// somebody to blow up on a Tuesday.
//
// A bot that plays well is not the goal; a bot that is alive long enough to be a target is. The
// three things that kept them from being that: a one-tile lookahead that fled *into* dead ends
// which were also in the blast, a bomb placed with no checked way out, and a direction committed
// to for up to thirty ticks, which turned every indecision into a visible shuffle.
//
// Everything here may use Math.random(). Bot thinking is not part of the simulation: room.js
// calls think() to produce an input bitmask, and the mask is all the sim ever sees — identical in
// kind to a mask that arrived over a socket. The browser never runs this file, so there is nothing
// for it to disagree with. The sim's own randomness is the seeded generator at state.next.

import {
  IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, IN_BOMB, BLOCK, FUSE_TICKS, FUSE_TICKS_FAST, FIRE_TICKS,
  POWDER_RADIUS,
  UNITS_PER_TILE, SPEED_UNITS_PER_TICK, SLOWDOWN_NUM, SLOWDOWN_DEN, STATUS,
  SHRUB_RADIUS_PENALTY, HITBOX_UNITS, HITBOX_REDUCED_UNITS, PUDDLE_SPEED_NUM, PUDDLE_SPEED_DEN,
} from '../shared/constants.js';
import { tileAt, walkable, toTile, has } from '../shared/sim/state.js';
import { bombTile } from '../shared/sim/bombs.js';
import { blocked, speedOf, inPuddle } from '../shared/sim/movement.js';

const DIRS = [
  { mask: IN_RIGHT, dx: 1, dy: 0 },
  { mask: IN_UP, dx: 0, dy: -1 },
  { mask: IN_LEFT, dx: -1, dy: 0 },
  { mask: IN_DOWN, dx: 0, dy: 1 },
];

const BACK = [2, 3, 0, 1];      // index of the opposite direction

// Node budget for the escape flood. Fifteen of these have to fit inside a 30 Hz tick, and 48
// nodes is a reach of roughly four tiles in open ground — further than any blast in the game.
const ESCAPE_NODES = 48;

const TRAIL_LEN = 8;            // tile changes remembered, for loop detection
const CYCLE_TILES = 3;          // that many distinct tiles across the trail means a cycle
const BORED_TICKS = 45;         // how long a noticed cycle suppresses the hunt bias
/* How good the bots are, 0..1. Everything that makes them sharp is scaled by it: how often they
 * head for a player, how soon they bomb again, and how reliably they move the instant a blast
 * is coming. 0.9 is ten percent dumber than they were, on request. */
export const BOT_SKILL = 0.7;
const BOMB_COOLDOWN = Math.round(45 / BOT_SKILL);
const HUNT_CHANCE = 0.7 * BOT_SKILL;
// A lapse: on noticing the floor is about to burn, sometimes they freeze for a moment first.
const LAPSE_CHANCE = (1 - BOT_SKILL);
const LAPSE_TICKS = 4;
/* Caught flat-footed by SOMEBODY ELSE'S bomb.
 *
 * A bot used to read a blast the tick its bomb landed and leave with most of the fuse to spare,
 * so the only bombs that ever caught one were the ones with no way out at all. Now, for a bomb it
 * did not place, it sometimes stands and stares until the fire is under half a second away, and
 * only then runs — out of a single blast with a side turning that is still enough, out of a
 * corridor it often is not. Waiting until 24 ticks were left changed nothing measurable: from
 * there a bot still makes the turning nearly every time. At 12 it does not.
 *
 * Measured (a "human" bomb dropped beside a bot every four seconds, plus botbench): caught 17% →
 * 24% of the time, bot kills 0.37 → 0.60 a minute, suicides slightly down. Its own bombs keep
 * the short lapse: a bot knows where it just put one, and carelessness there buys suicides. */
const SURPRISE_CHANCE = 0.4;
const SURPRISE_NOTICE_TICKS = 14;    // 0.4 s: barely more than a tile at base speed

const DESTRUCTIBLE = new Set([BLOCK.SOFT, BLOCK.REINFORCED, BLOCK.MONOLITH, BLOCK.ICE]);
const SHRUB = new Set([BLOCK.SHRUB_WALK, BLOCK.SHRUB_SOLID]);

/**
 * Tile keys a bomb's fire could reach — pessimistically, and deliberately not `spread()`.
 *
 * `spread` is the truth for a blast resolved right now: the arm stops at the first destructible
 * wall. But bombs detonate in chains, within a single tick, in bomb-id order, and a wall broken
 * by the first link is already floor by the time the second link spreads. The tile behind a soft
 * wall is therefore not the shelter it looks like — and measured, that was almost all of what was
 * still killing these bots: forty of forty-two deaths happened with the danger map showing the
 * victim's tile completely clear on the previous tick.
 *
 * So an arm here carries on through the first destructible wall it meets. One wall deep, not
 * every wall: two would need two chain links lined up behind each other, and treating that as
 * dangerous makes a dense map look uniformly lethal with nowhere left to run to.
 */
function reach(map, bomb, push) {
  push(bomb.tx, bomb.ty);
  for (const d of DIRS) {
    let span = bomb.radius, step = 1, broken = 0;
    while (step <= span) {
      const tx = bomb.tx + d.dx * step, ty = bomb.ty + d.dy * step;
      const t = tileAt(map, tx, ty);
      if (t === BLOCK.IRON || t === BLOCK.WATER) break;
      push(tx, ty);
      if (DESTRUCTIBLE.has(t)) { if (++broken > 1) break; }
      else if (SHRUB.has(t)) span -= SHRUB_RADIUS_PENALTY;
      step++;
    }
  }
}

/** Whether one of this player's own bombs can reach this tile. */
function ownBombReaches(state, p, tx, ty) {
  for (const b of state.bombs) {
    if (b.owner !== p.i) continue;
    let hit = false;
    reach(state.map, b, (x, y) => { if (x === tx && y === ty) hit = true; });
    if (hit) return true;
  }
  return false;
}

export const createBrain = () => ({
  dir: (Math.random() * 4) | 0,
  hold: 0,
  cooldown: 0,
  trail: [],
  bored: 0,
});

/**
 * Everything about to be on fire, how soon, and where a bomb is standing.
 *
 * Computed once per tick in room.js and shared by every bot — it is the same answer for all of
 * them, and `spread` per bomb is the most expensive thing in here.
 *
 * A bomb's own fuse is not when it goes off. Anything caught in a blast detonates that same tick,
 * so a bomb due in sixty ticks fires NOW if a neighbour's arm reaches it — and that was most of
 * what was killing these bots. A fuse read straight off `at` told them a carpet of bombs was
 * sixty ticks of safety, and the first link in the chain took the lot with it before they had
 * taken a step. So every bomb's effective time is the soonest anything in its chain fires,
 * propagated the same way `detonate` resolves it, only in advance.
 */
export function dangerMap(state) {
  const w = state.map.w, h = state.map.h;
  const bombs = state.bombs;

  /* Powder kegs are bombs that have not been lit yet.
   *
   * They are blocks, so nothing in `state.bombs` knows about them — and a keg going off is a
   * radius-7 blast that appeared with no fuse, no warning and no bomb on the danger map. A bot
   * standing six tiles away was told its tile was perfectly clear right up until it was fire.
   *
   * So every keg joins the source list with an infinite time, meaning "not lit". The chain pass
   * below is what lights them: if a real bomb's arm reaches a keg, the keg inherits that bomb's
   * time and propagates in turn, exactly the way `detonate` resolves it. A keg nothing reaches
   * stays at Infinity and contributes nothing, which is correct — an unlit keg is a wall.
   */
  const sources = bombs.map(b => ({ tx: b.tx, ty: b.ty, radius: b.radius, at: b.at }));
  const bombCount = sources.length;
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (tileAt(state.map, tx, ty) !== BLOCK.POWDER) continue;
      sources.push({ tx, ty, radius: POWDER_RADIUS, at: null });
    }
  }

  const n = sources.length;
  const cells = new Array(n);
  const left = new Array(n);
  const solid = new Set();      // tile keys with a bomb on them: not walkable, for us
  const byTile = new Map();     // tile key -> source index; one per tile is a rule

  for (let i = 0; i < n; i++) {
    const b = sources[i];
    const keys = [];
    reach(state.map, b, (tx, ty) => keys.push(ty * w + tx));
    cells[i] = keys;
    left[i] = b.at === null ? Infinity : Math.max(0, b.at - state.tick);
    const key = b.ty * w + b.tx;
    if (i < bombCount) solid.add(key);     // a keg is already a wall; it is not "solid for us"
    byTile.set(key, i);
  }

  // Worklist, so the cost is in the links that actually exist rather than bombs squared. Bounded
  // for the same reason detonate is: a bomb carpet must not be able to stall the loop.
  const queue = [];
  for (let i = 0; i < n; i++) queue.push(i);
  const cap = n * 8 + 64;
  for (let head = 0; head < queue.length && head < cap; head++) {
    const i = queue[head];
    for (const key of cells[i]) {
      const j = byTile.get(key);
      // `>=` rather than `>`: two sources on the same tick are already settled, and a keg at
      // Infinity always loses to a real time, which is how it gets lit.
      if (j === undefined || j === i || left[i] >= left[j]) continue;
      left[j] = left[i];
      queue.push(j);
    }
  }

  const ticks = new Map();      // tile key -> ticks until this tile is on fire
  for (let i = 0; i < n; i++) {
    if (left[i] === Infinity) continue;   // an unlit keg threatens nothing
    for (const key of cells[i]) {
      const prev = ticks.get(key);
      if (prev === undefined || left[i] < prev) ticks.set(key, left[i]);
    }
  }
  // Fire already burning is maximally dangerous.
  for (const f of state.fires) ticks.set(f.ty * w + f.tx, 0);

  return { w, ticks, solid };
}

/**
 * Soonest anything under this player's feet burns.
 *
 * The hitbox is 160 units wide against a 256-unit tile, so a player mid-stride stands in two
 * tiles and dies to fire in either — `burns()` tests the box, not the centre. Asking only about
 * the centre tile let a bot think it had already made it out while half of it was still in the
 * blast.
 */
function threatUnderfoot(danger, p, x = p.x, y = p.y) {
  const half = (has(p, STATUS.REDUCTION) ? HITBOX_REDUCED_UNITS : HITBOX_UNITS) >> 1;
  const x1 = (x + half - 1) >> 8, y1 = (y + half - 1) >> 8;
  let soonest = Infinity;
  for (let ty = (y - half) >> 8; ty <= y1; ty++) {
    for (let tx = (x - half) >> 8; tx <= x1; tx++) {
      const t = threatAt(danger, null, tx, ty);
      if (t < soonest) soonest = t;
    }
  }
  return soonest;
}

/** Ticks until this tile burns. `extra` is an optional second layer: a bomb we are considering. */
function threatAt(danger, extra, tx, ty) {
  const key = ty * danger.w + tx;
  const a = danger.ticks.get(key) ?? Infinity;
  const b = extra?.get(key) ?? Infinity;
  return a < b ? a : b;
}

/**
 * Ticks this player needs to cross one tile. An escape that ignores speed is not an escape.
 *
 * Standing in water counts as half pace for the whole route. Pessimistic — the puddle is at most
 * a couple of tiles across — but an escape planned at full speed from a puddle is exactly the one
 * that comes up a tile short.
 */
function ticksPerTile(p, state = null) {
  const i = Math.max(0, Math.min(p.speed | 0, SPEED_UNITS_PER_TICK.length - 1));
  let speed = SPEED_UNITS_PER_TICK[i];
  if (has(p, STATUS.SLOWDOWN)) speed = Math.max(1, (speed * SLOWDOWN_NUM / SLOWDOWN_DEN) | 0);
  if (state && inPuddle(state, p)) {
    speed = Math.max(1, (speed * PUDDLE_SPEED_NUM / PUDDLE_SPEED_DEN) | 0);
  }
  return Math.ceil(UNITS_PER_TILE / speed);
}

/**
 * Breadth-first search out to the nearest tile that no blast covers, and the first step toward it.
 *
 * This is the single biggest difference between the old bots and these. One tile of lookahead
 * cannot tell a way out from the mouth of a dead end, so a bot would pick the neighbour that
 * happened to be less dangerous, sprint four tiles down a side corridor that was also in the
 * blast, and die at the end of it. A flood fill knows.
 *
 * Timing is part of the answer, not a refinement: a tile is only a stepping stone if this player,
 * at the speed this player actually moves, is off it before it lights. `slack` buys extra ticks on
 * top of that estimate, because the real crossing is slower than perTile whenever a corner is
 * involved — the auto-centring slide spends part of the move on the perpendicular axis.
 *
 * Only a tile that no blast covers at all counts as safe. "Somewhere with a second still left on
 * it" sounds more flexible and is a trap: the tile one step along your own blast has sixty ticks
 * left, so a bot accepts it, stops, and is still inside the blast when the fuse runs out — with
 * six tiles to cover and no time to do it. Measured, that one change tripled their suicides.
 *
 * @returns {{dir: number, clear: boolean}} first step, and whether it reached a safe tile. `dir`
 *   is still the best available direction when `clear` is false: heading for whatever has the
 *   most time left beats standing in a blast arguing about it.
 */
function flood(state, p, danger, extra, slack = 0) {
  const map = state.map, w = map.w;
  const perTile = ticksPerTile(p, state);
  const start = toTile(p.y) * w + toTile(p.x);

  const queue = [start];
  const depth = new Map([[start, 0]]);
  const first = new Map([[start, -1]]);
  let head = 0;
  let bestDir = -1, bestMargin = -Infinity;

  while (head < queue.length && depth.size < ESCAPE_NODES) {
    const key = queue[head++];
    const d = depth.get(key);
    const tx = key % w, ty = (key - tx) / w;

    if (d > 0) {
      const t = threatAt(danger, extra, tx, ty);
      if (t === Infinity) return { dir: first.get(key), clear: true };
      const margin = t - d * perTile;
      if (margin > bestMargin) { bestMargin = margin; bestDir = first.get(key); }
    }

    for (let i = 0; i < 4; i++) {
      const nx = tx + DIRS[i].dx, ny = ty + DIRS[i].dy;
      const nk = ny * w + nx;
      if (depth.has(nk) || !walkable(map, nx, ny) || danger.solid.has(nk)) continue;
      // Arrive at (d+1)*perTile, leave one tile later. Burning before then makes it a wall.
      if (threatAt(danger, extra, nx, ny) <= (d + 2) * perTile + slack) continue;
      depth.set(nk, d + 1);
      first.set(nk, d === 0 ? i : first.get(key));
      queue.push(nk);
    }
  }
  return { dir: bestDir, clear: false };
}

/**
 * The blast a bomb placed here would make, as a second danger layer for the flood.
 *
 * Follows the chain: a bomb whose reach touches one of ours sets it off, that one's reach sets
 * off the next, and the whole lot lands on the same tick. Leaving that out is how a bot with
 * eight bombs in hand walks confidently to a tile that one of its own earlier bombs covers.
 */
function hypothetical(state, p, tx, ty) {
  const w = state.map.w;
  const fuse = has(p, STATUS.FAST_DET) ? FUSE_TICKS_FAST : FUSE_TICKS;
  const extra = new Map();
  const queue = [{ tx, ty, radius: p.radius }];

  for (let head = 0; head < queue.length && head < 16; head++) {
    reach(state.map, queue[head], (cx, cy) => {
      const key = cy * w + cx;
      extra.set(key, fuse);
      const b = state.bombs.find(o => o.tx === cx && o.ty === cy);
      if (b && !queue.some(q => q.tx === b.tx && q.ty === b.ty)) queue.push(b);
    });
  }
  return extra;
}

/** Closest living player that is not me, by Manhattan distance in units. */
function nearestPlayer(state, me) {
  let best = null, bestD = Infinity;
  for (const q of state.players) {
    if (!q || q === me || !q.alive) continue;
    const d = Math.abs(q.x - me.x) + Math.abs(q.y - me.y);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

/** Something to break, or somebody to catch, measured at the tile the bomb would LAND on. */
function worthBombing(state, p, tx, ty) {
  for (const d of DIRS) {
    const t = tileAt(state.map, tx + d.dx, ty + d.dy);
    if (DESTRUCTIBLE.has(t)) return true;
  }
  for (const q of state.players) {
    if (!q || q === p || !q.alive) continue;
    if (Math.abs(toTile(q.x) - tx) + Math.abs(toTile(q.y) - ty) <= 3) return true;
  }
  return false;
}

/**
 * Loop detection.
 *
 * Visiting only two or three distinct tiles across the last eight tile *changes* is a cycle. The
 * common one is a corner the bot keeps rounding: the hunt bias points diagonally, the corridor
 * only offers one axis at a time, and the two choices alternate forever. Counting tile changes
 * rather than ticks means standing still does not look like progress, and it means the check only
 * runs when the bot actually moves somewhere.
 *
 * @returns true if a cycle was just noticed
 */
function noteTile(brain, key) {
  const trail = brain.trail;
  if (trail[trail.length - 1] === key) return false;
  trail.push(key);
  if (trail.length > TRAIL_LEN) trail.shift();
  if (trail.length < TRAIL_LEN) return false;

  // indexOf over eight entries beats allocating a Set on every tile change.
  let distinct = 0;
  for (let i = 0; i < trail.length; i++) if (trail.indexOf(trail[i]) === i) distinct++;
  if (distinct > CYCLE_TILES) return false;

  trail.length = 0;
  return true;
}

/** Pick a direction to walk. Safe tiles first, never reversing unless there is no alternative. */
function chooseDir(state, p, brain, danger, tx, ty) {
  const map = state.map;
  const perTile = ticksPerTile(p, state);
  const safe = [], risky = [];

  for (let i = 0; i < 4; i++) {
    const nx = tx + DIRS[i].dx, ny = ty + DIRS[i].dy;
    if (!walkable(map, nx, ny) || danger.solid.has(ny * map.w + nx)) continue;
    const threat = threatAt(danger, null, nx, ny);
    if (threat === Infinity) safe.push(i);
    else if (threat > perTile * 3) risky.push(i);       // crossable, but do not loiter
  }

  let options = safe.length ? safe : risky;
  // Boxed in by danger. This only runs while our own tile is safe (the flee branch has it
  // otherwise), so the right move is none: keeping the old heading walked a bot that was standing
  // somewhere perfectly safe straight into the blast around it.
  if (!options.length) return -1;

  // Reversing *is* the oscillation. A longer commitment only made each half of it longer, which
  // is why the old 10-30 tick hold did not help; refusing to turn back does.
  if (options.length > 1) {
    const forward = options.filter(i => i !== BACK[brain.dir]);
    if (forward.length) options = forward;
  }

  const pick = list => list[(Math.random() * list.length) | 0];

  // A bot that has been shuffling between three tiles needs to do something different, not the
  // same weighted choice that produced the shuffle.
  if (brain.bored > 0 || Math.random() > HUNT_CHANCE) return pick(options);

  // Head roughly toward the nearest player rather than purely at random. Without this they
  // diffuse into the far corners of a 41x29 map and you never see them again — they are there to
  // be fought, not to explore.
  const target = nearestPlayer(state, p);
  if (target) {
    const tdx = Math.sign(toTile(target.x) - tx);
    const tdy = Math.sign(toTile(target.y) - ty);
    const toward = options.filter(i => (tdx && DIRS[i].dx === tdx) || (tdy && DIRS[i].dy === tdy));
    if (toward.length) return pick(toward);
  }
  return pick(options);
}

/**
 * The keys to press to actually go `dir` from where this bot is standing.
 *
 * Everything above reasons in tiles; the body does not live in tiles. A bot that has just crossed
 * into a tile is ~128 units off its centre line, and corner assist only helps within
 * CORNER_ASSIST_UNITS (112) of it — so turning into a gap from there pushes the hitbox flat into
 * the wall beside the gap and nothing moves. The bot then re-derives the same direction from the
 * same tile on the next tick, and the next, until its own fuse runs out. Measured: that was 45% of
 * every bot death, the single largest cause by far.
 *
 * A person nudges back toward the lane without thinking about it, so the bot does too: if the
 * move is blocked and we are off the centre line across it, slide toward the centre first.
 * Movement rules are untouched — this is only which keys are pressed.
 */
function steer(state, p, dir) {
  const d = DIRS[dir];
  const speed = speedOf(p);
  if (!blocked(state, p, p.x + d.dx * speed, p.y + d.dy * speed)) return d.mask;
  const off = d.dx ? (p.y & 255) - 128 : (p.x & 255) - 128;
  if (off === 0) return d.mask;                    // squarely facing a wall; nothing to line up
  if (d.dx) return off > 0 ? IN_UP : IN_DOWN;
  return off > 0 ? IN_LEFT : IN_RIGHT;
}

/**
 * @returns input bitmask for this bot this tick
 */
export function think(state, p, brain, danger) {
  if (!p.alive) {
    // Dead: press the respawn button now and then rather than every tick.
    return (state.tick % 30 === 0) ? IN_BOMB : 0;
  }

  const map = state.map;
  const tx = toTile(p.x), ty = toTile(p.y);
  const here = threatUnderfoot(danger, p);

  if (brain.bored > 0) brain.bored--;
  if (brain.cooldown > 0) brain.cooldown--;
  if (noteTile(brain, ty * map.w + tx)) brain.bored = BORED_TICKS;

  // 1. This tile is going to burn — any blast, however distant its fuse. Standing in one is the
  //    only way a bot ever takes damage, so leaving is always the first priority.
  if (here !== Infinity) {
    // The moment it notices, it may hesitate (see LAPSE_CHANCE). Rolled once per danger, not
    // per tick, so a lapse is a short freeze rather than a coin toss every frame.
    if (!brain.inDanger) {
      brain.inDanger = true;
      brain.lapse = Math.random() < LAPSE_CHANCE ? LAPSE_TICKS : 0;
      brain.surprised = !ownBombReaches(state, p, tx, ty) && Math.random() < SURPRISE_CHANCE;
    }
    if (brain.surprised && here > SURPRISE_NOTICE_TICKS) return 0;
    if (brain.lapse > 0) { brain.lapse--; return 0; }
    const { dir } = flood(state, p, danger, null);
    if (dir >= 0) {
      brain.dir = dir;
      brain.hold = 3;
      return steer(state, p, dir);
    }
    // Nowhere to go. Fall through and keep moving rather than standing still and accepting it.
  } else brain.inDanger = false;

  // 2. Bombing, with a verified way out of the blast we are about to make. Verified means a
  //    genuinely clear tile, reachable with a blast's worth of slack in hand — a best-effort
  //    direction is good enough to flee along and nowhere near good enough to bet on.
  //
  //    The mask carries no direction. `place` runs AFTER movement in the tick, so a bomb thrown
  //    in alongside a direction lands on whatever tile the step finished in — not the tile the
  //    escape was worked out for. That is how a bot dropped a bomb into a blast it had already
  //    checked itself out of, chain-detonated it instantly, and died with no warning at all. It
  //    costs one tick of standing still; the flee branch takes over on the next one, because by
  //    then the bomb is in the danger map.
  // Bombs land on the tile you are FACING, not the one underfoot — see bombTile. Everything
  // the bot reasons about a bomb has to use that tile, or it checks its escape from the wrong
  // blast and walks confidently into the real one.
  const drop = bombTile(state, p);
  if (here === Infinity && brain.cooldown === 0 && worthBombing(state, p, drop.tx, drop.ty)) {
    const extra = hypothetical(state, p, drop.tx, drop.ty);
    const { dir, clear } = flood(state, p, danger, extra, FIRE_TICKS * 3);
    if (clear) {
      brain.dir = dir;
      brain.hold = 4;
      brain.cooldown = BOMB_COOLDOWN;
      return IN_BOMB;
    }
    // No escape, so no bomb. A short cooldown stops us re-running the flood every tick for as
    // long as we stand in a spot where bombing would be suicide.
    brain.cooldown = 10;
  }

  /* 3. Walk. A short commitment keeps them in corridors instead of vibrating on the spot.
   *
   * The commitment has to break on DANGER as well as on walls, and that was the whole bug.
   * Measured over three minutes with fifteen bots, three quarters of all deaths happened on a
   * tile the danger map already showed burning in under ten ticks — so they were not blind, they
   * were committed. A bot picks a direction, holds it for five to eleven ticks, and in that
   * window somebody drops a bomb in the corridor ahead. Nothing re-read the map until the bot
   * was standing in the blast, and by then it was several tiles deep with no time to get out.
   *
   * The flee branch above is the cure and this is the prevention: treat a tile that is about to
   * burn as a wall, so the walk never enters one in the first place.
   */
  const ahead = DIRS[brain.dir];
  const ax = tx + ahead.dx, ay = ty + ahead.dy;
  // The whole body one tile on, not just the tile in front of its centre. Off the centre line the
  // hitbox spans two lanes, and the diagonal it is about to drag itself into was never checked —
  // that was the commonest way a bot walked into fire it had been told about.
  const aheadThreat = threatUnderfoot(danger, p, p.x + ahead.dx * 256, p.y + ahead.dy * 256);
  const blockedAhead = !walkable(map, ax, ay) ||
    danger.solid.has(ay * map.w + ax) ||
    aheadThreat <= ticksPerTile(p, state) * 4;
  if (brain.hold <= 0 || blockedAhead) {
    const dir = chooseDir(state, p, brain, danger, tx, ty);
    // Boxed in on a safe tile: stay. Boxed in on a burning one — the flood found nothing — keep
    // moving, because standing still in a blast is the one choice that is certainly fatal.
    if (dir < 0 && here === Infinity) { brain.hold = 0; return 0; }
    if (dir >= 0) brain.dir = dir;
    brain.hold = 5 + ((Math.random() * 6) | 0);
  }
  brain.hold--;

  return steer(state, p, brain.dir);
}
