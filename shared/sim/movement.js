// The one movement function. Imported unchanged by the server and by the client's prediction,
// which is the whole reason reconciliation is usually a no-op. See docs/NETCODE.md §2.
//
// Integers only. Positions are in units where one tile is 256, so a tile coordinate is `x >> 8`.

import {
  UNITS_PER_TILE, HITBOX_UNITS, HITBOX_REDUCED_UNITS, CORNER_ASSIST_UNITS,
  SPEED_UNITS_PER_TICK, SLOWDOWN_NUM, SLOWDOWN_DEN,
  IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, DIR_R, DIR_U, DIR_L, DIR_D, STATUS,
} from '../constants.js';
import { walkable, has, tileCentre } from './state.js';

const HALF_TILE = UNITS_PER_TILE >> 1;

// How much faster than walking pace a player slides sideways onto a lane centre line. Sideways
// drift is assistance, not travel, so it is allowed to outrun the legs.
const ALIGN_RATE = 2;

// How fast being shoved out of a solid tile goes. A quarter tile a tick clears one in four ticks
// — fast enough that nobody dies waiting, slow enough that it reads as motion rather than as the
// game glitching.
const UNSTICK_UNITS_PER_TICK = UNITS_PER_TILE >> 2;

export function speedOf(p) {
  let s = SPEED_UNITS_PER_TICK[Math.min(p.speed, SPEED_UNITS_PER_TICK.length - 1)];
  if (has(p, STATUS.SLOWDOWN)) s = ((s * SLOWDOWN_NUM) / SLOWDOWN_DEN) | 0;
  return Math.max(1, s);
}

const halfBox = p => (has(p, STATUS.REDUCTION) ? HITBOX_REDUCED_UNITS : HITBOX_UNITS) >> 1;

/**
 * A bomb is solid to anyone whose centre is outside its tile — and to nobody who is already
 * standing on it, whoever placed it.
 *
 * The owner test this used to have made a non-owner's bomb solid the instant it appeared, with
 * no grace for a player whose hitbox was already inside that tile. Every candidate position was
 * then blocked too, so dropping a bomb on someone standing next to you froze them in place for
 * the whole 72-tick fuse: an unavoidable kill with no counterplay. Tile occupancy is observable
 * from the bomb record alone, so both sides agree without the bomb carrying any extra state.
 *
 * Inlined rather than imported from bombs.js: that module imports fire.js and blocks.js, and
 * movement has no business pulling in the whole blast chain.
 */
function bombSolid(state, p, tx, ty) {
  if (!state.bombs) return false;
  for (const b of state.bombs) {
    if (b.tx !== tx || b.ty !== ty) continue;
    return !((p.x >> 8) === tx && (p.y >> 8) === ty);
  }
  return false;
}

/** Would the hitbox centred on (x, y) overlap anything solid? */
export function blocked(state, p, x, y) {
  const h = halfBox(p);
  const reduced = has(p, STATUS.REDUCTION);
  const x0 = (x - h) >> 8, x1 = (x + h - 1) >> 8;
  const y0 = (y - h) >> 8, y1 = (y + h - 1) >> 8;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (!walkable(state.map, tx, ty, reduced)) return true;
      if (bombSolid(state, p, tx, ty)) return true;
    }
  return false;
}

/** Signed distance from the centre of the tile this coordinate sits in. */
const offsetFromCentre = u => (u & (UNITS_PER_TILE - 1)) - HALF_TILE;

/** Is the tile at (primary, lane) walkable, for whichever axis we are moving along? */
const laneWalkable = (state, horizontal, primaryTile, laneTile, reduced) =>
  horizontal ? walkable(state.map, primaryTile, laneTile, reduced)
             : walkable(state.map, laneTile, primaryTile, reduced);

/**
 * Move along one axis.
 *
 * Grid games need two behaviours that sound unrelated and are actually the same decision:
 *
 *  - **auto-centring** — walking a corridor, drift onto its centre line so you never scrape;
 *  - **corner assist** — pushing into a wall while *nearly* lined up with the gap beside it,
 *    slide into the gap rather than stopping dead.
 *
 * Implemented separately they fight: centring drags you off the gap before you ever reach the
 * wall, so the assist never fires. So instead there is one question asked every tick — *which
 * lane do I want to be in?* — and the answer drives a single sideways drift:
 *
 *   way ahead is clear          -> stay in this lane
 *   blocked, gap beside, close  -> the adjacent lane  (corner assist)
 *   blocked, no gap, walled in  -> this lane's centre (corridor centring)
 *   open ground beside you      -> no drift at all, leave the player where they put themselves
 *
 * That last case is what makes the assist possible: never pull someone away from an opening
 * they might be aiming for.
 */
function moveAxis(state, p, ax, ay, speed) {
  const horizontal = ax !== 0;
  const dir = horizontal ? ax : ay;
  const half = halfBox(p);
  const reduced = has(p, STATUS.REDUCTION);

  const perp = horizontal ? p.y : p.x;
  const lead = horizontal ? p.x : p.y;
  const lane = perp >> 8;
  const off = offsetFromCentre(perp);
  const leadTile = lead >> 8;

  const nx = horizontal ? p.x + dir * speed : p.x;
  const ny = horizontal ? p.y : p.y + dir * speed;
  const wayBlocked = blocked(state, p, nx, ny);

  /**
   * Slide toward the centre line of the lane we are already in.
   *
   * At `speed` units a tick, correcting a third of a tile of misalignment takes three or four
   * ticks of visibly scraping along the wall before the gap opens. ALIGN_RATE makes it one or
   * two, which is the difference between "it caught the corner for me" and "it stuck".
   */
  const straighten = () => {
    const delta = -off;
    const pull = Math.sign(delta) * Math.min(Math.abs(delta), speed * ALIGN_RATE);
    const cx = horizontal ? p.x : p.x + pull;
    const cy = horizontal ? p.y + pull : p.y;
    if (blocked(state, p, cx, cy)) return false;
    p.x = cx; p.y = cy;
    return true;
  };

  // Corner assist. You are heading for a gap you *are* lined up with, but your hitbox is clipping
  // the solid tile next to it. Straighten up and you fit. Beyond the window, you are genuinely
  // aiming at a wall and deserve to stop.
  if (wayBlocked && off !== 0 && Math.abs(off) <= CORNER_ASSIST_UNITS) {
    if (straighten()) return true;
  }

  if (!wayBlocked) {
    p.x = nx; p.y = ny;
    // Corridor centring: drift onto the centre line, but only where there is nothing beside you
    // to aim at. On open ground, leave the player exactly where they put themselves — pulling
    // them around would fight every attempt to line up with a gap.
    if (off !== 0) {
      const adj = lane + Math.sign(off);
      if (!laneWalkable(state, horizontal, leadTile, adj, reduced)) straighten();
    }
    return true;
  }

  // Blocked: slide flush to the wall rather than stopping a few units short, which would leave
  // you unable to turn into a gap you look like you are standing in.
  const edge = dir > 0
    ? ((((horizontal ? p.x : p.y) + half) >> 8) + 1) * UNITS_PER_TILE - half - 1
    : ((((horizontal ? p.x : p.y) - half) >> 8)) * UNITS_PER_TILE + half;
  const ex = horizontal ? edge : p.x;
  const ey = horizontal ? p.y : edge;
  const forward = dir > 0 ? edge > (horizontal ? p.x : p.y) : edge < (horizontal ? p.x : p.y);
  if (forward && !blocked(state, p, ex, ey)) { p.x = ex; p.y = ey; return true; }
  return false;
}

/**
 * Nothing may leave a player unable to move. Ever.
 *
 * `moveAxis` assumes you start from a legal position and only ever asks whether the *next* one is
 * legal — so a player who somehow ends up overlapping a solid tile finds every candidate blocked,
 * including the flush-to-wall slide, and is frozen for good. The ways in are all rare and all
 * real: a wall regrowing on top of you, Reduction expiring while you stand inside a column, a map
 * change, a spawn point that is no longer clear.
 *
 * So: if the position we are *already* in is illegal, leave for the nearest legal tile centre.
 * This runs off nothing but the shared state, so the client predicts the identical escape and
 * reconciliation stays a no-op. It never fires in normal play — if it is firing, something else
 * is wrong and this is the seatbelt, not the fix.
 *
 * @returns true if it had to intervene
 */
export function unstick(state, p) {
  if (!blocked(state, p, p.x, p.y)) return false;

  const tx = p.x >> 8, ty = p.y >> 8;
  // Nearest first, and in a fixed order so two machines always pick the same way out.
  const ring = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (const [dx, dy] of ring) {
    const nx = tileCentre(tx + dx), ny = tileCentre(ty + dy);
    if (blocked(state, p, nx, ny)) continue;

    // Slide out, do not teleport out.
    //
    // Snapping straight to the target was correct and felt awful: a wall growing on you threw you
    // a whole tile in one frame, and the rendered position had to be hard-cut to follow. Walking
    // out over a few ticks reads as being shoved, which is what it is. It stays deterministic —
    // same state, same arithmetic, same answer on both machines — so prediction still agrees.
    //
    // One axis at a time, matching the rest of movement, and the larger gap first so the escape
    // always makes progress rather than dithering between two half-steps.
    const gx = nx - p.x, gy = ny - p.y;
    const horizontal = Math.abs(gx) >= Math.abs(gy);
    const gap = horizontal ? gx : gy;
    const move = Math.sign(gap) * Math.min(Math.abs(gap), UNSTICK_UNITS_PER_TICK);
    if (horizontal) p.x += move; else p.y += move;
    return true;
  }
  return false;     // boxed in on all nine tiles; the blast that caused it will resolve it
}

/**
 * Advance one player by one tick. `mask` is the input bitmask from docs/PROTOCOL.md §3.
 * Pure in everything that matters: same player, same map, same mask -> same result, every time.
 */
export function step(state, p, mask) {
  if (!p || !p.alive) return;

  // Before anything reads the position, make sure it is one we could legally be standing in.
  unstick(state, p);

  let dx = ((mask & IN_RIGHT) ? 1 : 0) - ((mask & IN_LEFT) ? 1 : 0);
  let dy = ((mask & IN_DOWN) ? 1 : 0) - ((mask & IN_UP) ? 1 : 0);

  if (has(p, STATUS.CHANGELING)) { dx = -dx; dy = -dy; }

  if (!dx && !dy) { p.moving = false; return; }

  // Both axes held: keep moving along the one already facing, so holding a diagonal into a
  // corner does not stutter between the two.
  if (dx && dy) {
    const facingH = p.dir === DIR_L || p.dir === DIR_R;
    if (facingH) dy = 0; else dx = 0;
  }

  p.dir = dx > 0 ? DIR_R : dx < 0 ? DIR_L : dy < 0 ? DIR_U : DIR_D;
  p.moving = true;

  const speed = speedOf(p);
  moveAxis(state, p, dx, dy, speed);
}

/** Every alive player, in seat order. Order is part of determinism — never iterate a Map here. */
export function stepAll(state, inputs) {
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p && p.alive) step(state, p, inputs[i] | 0);
  }
}
