// The one movement function. Imported unchanged by the server and by the client's prediction,
// which is the whole reason reconciliation is usually a no-op. See docs/NETCODE.md §2.
//
// Integers only. Positions are in units where one tile is 256, so a tile coordinate is `x >> 8`.

import {
  UNITS_PER_TILE, HITBOX_UNITS, HITBOX_REDUCED_UNITS, CORNER_ASSIST_UNITS,
  SPEED_UNITS_PER_TICK, SLOWDOWN_NUM, SLOWDOWN_DEN,
  STAMINA_MAX, STAMINA_DRAIN_PER_TICK, STAMINA_REGEN_MOVING, STAMINA_REGEN_IDLE,
  STAMINA_RECOVER_UNITS, STAMINA_TIRED_NUM, STAMINA_TIRED_DEN, staminaMaxFor,
  DRUNK_SWAY_UNITS, DRUNK_SWAY_RATE_A, DRUNK_SWAY_RATE_B,
  DRUNK_STAGGER_EVERY, DRUNK_STAGGER_TICKS,
  PUDDLE_SPEED_NUM, PUDDLE_SPEED_DEN, PUDDLE_SLIDE_TICKS,
  IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, DIR_R, DIR_U, DIR_L, DIR_D, STATUS,
} from '../constants.js';
import { walkable, has, tileCentre } from './state.js';

const HALF_TILE = UNITS_PER_TILE >> 1;

/* Lane centring.
 *
 * Three limits, and all three matter:
 *
 *   ALIGN_RATE     never faster than the legs. At 2x it outran a deliberate move, and with
 *                  boots at 59 units a tick that was half a tile of sideways travel in ONE
 *                  tick — a snap, not an assist, and the commonest place to feel it is walking
 *                  off a bomb you just placed, where the tile turns solid underneath you.
 *   ALIGN_FRACTION a quarter of whatever is left, so it decelerates into the lane instead of
 *                  arriving at full speed and stopping dead. This is the part that reads as
 *                  smooth rather than as correct.
 *   ALIGN_MAX      an absolute ceiling in units, so a fast player is not centred faster than a
 *                  slow one. Speed should change how far you travel, not how hard the game
 *                  pushes you sideways.
 */
const ALIGN_RATE = 1;
const ALIGN_FRACTION = 24;       // move 1/24 of the remaining offset
const ALIGN_MIN_UNITS = 1;       // and never less than this, so it terminates
const ALIGN_MAX_UNITS = 1;       // one unit a tick: a tile takes eight seconds

/* Rounding a corner is a different job from tidying up a lane, and they used to share a rate.
 *
 * Corridor centring happens while you are walking along unobstructed and nothing is asking for
 * it — so it has to be invisible, and the numbers above make it so.
 *
 * Corner assist happens when you are PUSHING INTO a gap you are nearly lined up with and the
 * game is refusing the move. Every tick it takes is a tick of standing still against a doorway
 * you can plainly see you fit through, which is the single most infuriating thing a Bomberman
 * can do. It needs to be immediate, so it gets its own, much faster, rate.
 */
const ASSIST_FRACTION = 2;       // half the remaining offset each tick
const ASSIST_MIN_UNITS = 12;
const ASSIST_RATE = 2;           // and it may outrun the legs, because it is not travel

// Being shoved out of a solid tile eases rather than running at a constant rate: a fraction of
// whatever is left each tick, capped far below walking pace and floored so it still terminates.
//
// A fifteenth of walking pace, with a floor of three units a tick so a player with no boots is
// not left crawling out of a wall for seven seconds. Three units is a ninth of base pace: slow
// enough to read as drifting, fast enough that being entombed costs about a second. The far
// commoner case — a partial overlap from a wall regrowing beside you — is over in a few ticks.
//
// Bombs cannot reach this code at all; see the note in `unstick`.
//
// Deliberately much slower than the legs. Walking pace felt like being shoved, because it was
// the same speed as a deliberate move and the eye read it as the player suddenly sprinting
// sideways of their own accord. A twelfth of pace reads as the bomb easing you aside, which is
// what it is — and the commonest case by far is stepping off your own bomb, where any visible
// snap feels like the game taking the controls off you.
const UNSTICK_MIN_UNITS = 1;
const UNSTICK_MIN_PACE = 4;
const UNSTICK_EASE_SHIFT = 4;      // move 1/16 of the remaining gap each tick
const UNSTICK_PACE_NUM = 1, UNSTICK_PACE_DEN = 15;

export function speedOf(p) {
  let s = SPEED_UNITS_PER_TICK[Math.min(p.speed, SPEED_UNITS_PER_TICK.length - 1)];
  if (has(p, STATUS.SLOWDOWN)) s = ((s * SLOWDOWN_NUM) / SLOWDOWN_DEN) | 0;
  if (p.tired) s = ((s * STAMINA_TIRED_NUM) / STAMINA_TIRED_DEN) | 0;
  return Math.max(1, s);
}

/**
 * Stamina, once per tick per player.
 *
 * Runs for everyone alive, moving or not, and runs BEFORE the move so the speed used this tick
 * reflects the state this tick. `tired` is a latch with hysteresis: it is set at zero and only
 * cleared once a third of the bar is back. Without the latch the exhausted flag flips every tick
 * at the boundary — the player stutters between full and half pace, and it reads as packet loss
 * rather than as a mechanic.
 */
export function stamina(p, moving) {
  if (p.stamina === undefined) { p.stamina = STAMINA_MAX; p.tired = false; }
  const max = staminaMaxFor(p);

  if (moving && !p.tired) {
    p.stamina -= STAMINA_DRAIN_PER_TICK;
    if (p.stamina <= 0) { p.stamina = 0; p.tired = true; }
    return;
  }

  // Standing still is twice as good as limping, which is what makes stopping a decision.
  p.stamina = Math.min(max, p.stamina + (moving ? STAMINA_REGEN_MOVING : STAMINA_REGEN_IDLE));
  if (p.tired && p.stamina >= STAMINA_RECOVER_UNITS) p.tired = false;
}

/**
 * Is this player standing in a puddle? By the tile their centre is in — the same test fire,
 * pickups and every other per-tile rule use. `state` is the server's state or the client's
 * world; both carry the puddle list, which is what lets prediction agree.
 */
export function inPuddle(state, p) {
  const ps = state.puddles;
  if (!ps || !ps.length) return false;
  const tx = p.x >> 8, ty = p.y >> 8;
  for (const q of ps) if (q.tx === tx && q.ty === ty && q.until > state.tick) return true;
  return false;
}

const DIR_VEC = { [DIR_R]: [1, 0], [DIR_U]: [0, -1], [DIR_L]: [-1, 0], [DIR_D]: [0, 1] };

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
    /* Still touching it? Then it is not solid to you yet.
     *
     * The test used to be whether your CENTRE had left the tile, and that is where the shove
     * came from: the instant the centre crossed the line, eighty units of hitbox were suddenly
     * inside a solid tile, and `unstick` had to push all of it back out. A third of a tile of
     * movement you did not ask for, every single time you walked off a bomb you had just
     * placed — which is the most common thing anybody does in this game.
     *
     * Testing the HITBOX instead means the bomb becomes solid at the exact moment you are
     * clear of it, so there is nothing left to push out and the unstick never fires at all.
     * The rule stays observable from the bomb record alone, so both machines still agree.
     */
    // Three quarters of the box, not all of it. At the full width the bomb only turned solid
    // once you were completely clear, so there was never anything to push and stepping off one
    // had no weight to it at all. At three quarters it firms up a few units early, which is a
    // nudge you can feel and still nowhere near the third of a tile it used to shove you.
    const half = (halfBox(p) * 3) >> 2;
    const overlaps = ((p.x - half) >> 8) <= tx && ((p.x + half - 1) >> 8) >= tx
                  && ((p.y - half) >> 8) <= ty && ((p.y + half - 1) >> 8) >= ty;
    return !overlaps;
  }
  return false;
}

/** Would the hitbox centred on (x, y) overlap anything solid? */
/**
 * @param bombsCount false to ask about terrain only — see `unstick`.
 */
export function blocked(state, p, x, y, bombsCount = true) {
  const h = halfBox(p);
  const reduced = has(p, STATUS.REDUCTION);
  const x0 = (x - h) >> 8, x1 = (x + h - 1) >> 8;
  const y0 = (y - h) >> 8, y1 = (y + h - 1) >> 8;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (!walkable(state.map, tx, ty, reduced)) return true;
      if (bombsCount && bombSolid(state, p, tx, ty)) return true;
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
   * Eased rather than flat out: a quarter of the remaining offset each tick, floored so it
   * finishes and capped so it is never a lurch. From a third of a tile out that is about a
   * dozen ticks, decelerating the whole way — you feel the game tidy you up, not shove you.
   */
  const straighten = (urgent = false) => {
    const delta = -off;
    const mag = Math.abs(delta);
    const step = urgent
      ? Math.min(mag, Math.max(ASSIST_MIN_UNITS, (mag / ASSIST_FRACTION) | 0), speed * ASSIST_RATE)
      : Math.min(
        mag,
        Math.max(ALIGN_MIN_UNITS, (mag / ALIGN_FRACTION) | 0),
        ALIGN_MAX_UNITS,
        speed * ALIGN_RATE,
      );
    const pull = Math.sign(delta) * step;
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
    if (straighten(true)) return true;
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
  /* Terrain only. A bomb never pushes anybody, ever.
   *
   * This is the seatbelt for positions that are illegal and cannot be walked out of: a wall
   * grown on top of you, Reduction expiring while you stand in a column, a map change, a spawn
   * that is no longer clear. Every one of those is genuinely inescapable without help.
   *
   * A bomb is not. `bombSolid` already treats one you are touching as passable, so you can
   * always simply walk off it — and a shove on top of that is the game moving you when you were
   * perfectly capable of moving yourself. Passing `false` here makes that structural rather
   * than a property of the current tuning: even if bomb solidity changes again, the unstick
   * cannot start pushing people off bombs as a side effect.
   */
  const stuckInTerrain = blocked(state, p, p.x, p.y, false);
  if (!stuckInTerrain) {
    /* Not in a wall, but possibly a few units inside a bomb that has just firmed up.
     *
     * Worth a nudge rather than nothing: a bomb you are standing fractionally inside should
     * ease you out so it feels like an object, and the distance involved is a handful of units
     * rather than the eighty the old centre-based rule produced. Half the terrain pace, because
     * this one is cosmetic and a wall is not.
     */
    if (!blocked(state, p, p.x, p.y)) return false;
    const gentle = Math.max(1, UNSTICK_MIN_PACE >> 1);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = p.x + dx * gentle, ny = p.y + dy * gentle;
      if (blocked(state, p, nx, ny)) continue;
      p.x = nx; p.y = ny;
      return true;
    }
    return false;
  }

  const tx = p.x >> 8, ty = p.y >> 8;
  // Nearest first, and in a fixed order so two machines always pick the same way out.
  const ring = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (const [dx, dy] of ring) {
    const nx = tileCentre(tx + dx), ny = tileCentre(ty + dy);
    // The destination ignores bombs too: a bomb is somewhere you can stand your way out of,
    // and refusing a tile because of one can leave a genuinely entombed player with nowhere.
    if (blocked(state, p, nx, ny, false)) continue;

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
    const left = Math.abs(gap);
    const pace = Math.max(UNSTICK_MIN_PACE, ((speedOf(p) * UNSTICK_PACE_NUM) / UNSTICK_PACE_DEN) | 0);
    const rate = Math.min(Math.max(left >> UNSTICK_EASE_SHIFT, UNSTICK_MIN_UNITS), pace);
    const move = Math.sign(gap) * Math.min(left, rate);
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

  /* Water: half pace, and you slide.
   *
   * Every tick you walk in a puddle tops the slide up; let go and you keep going the way you are
   * facing until it runs out. Facing, not "the keys you last held", because facing is already on
   * the wire and is always the axis you actually travelled — so the client replays the slide
   * from nothing but `slide` and `dir`. Leaving the water ends it at once: the floor is not wet.
   */
  const wet = inPuddle(state, p);
  let coasting = false;
  if (!wet) p.slide = 0;
  else if (dx || dy) p.slide = PUDDLE_SLIDE_TICKS;
  else if (p.slide > 0) {
    p.slide--;
    [dx, dy] = DIR_VEC[p.dir] ?? DIR_VEC[DIR_D];
    coasting = true;
  }

  if (!dx && !dy) { p.moving = false; stamina(p, false); return; }

  let speed = speedOf(p);
  if (wet) speed = Math.max(1, ((speed * PUDDLE_SPEED_NUM) / PUDDLE_SPEED_DEN) | 0);
  // Sliding is not running: it costs no stamina.
  stamina(p, !coasting);
  p.moving = true;

  /* Drunk: you wander across the line you are walking along.
   *
   * Two sines on the tick, at rates that do not divide into each other, seeded by seat so no
   * two drunks stagger in step. Deterministic in (tick, seat) on purpose — the client replays
   * the same arithmetic, so a drunk player is predicted exactly like a sober one and the whole
   * thing costs nothing in reconciliation.
   *
   * Across the direction of travel rather than along it. Inverting the controls would be
   * "broken", and slowing you down is already what Slowdown does; wandering is the only one of
   * the three that reads as being drunk rather than as being punished — and it is genuinely
   * hard to thread a corridor with, which is the point.
   */
  if (has(p, STATUS.DRUNK)) {
    const t = state.tick + p.i * 37;
    // The stagger: briefly, you go the way you were NOT pointing. Only ever sideways — a
    // reversal would read as broken controls, where a lurch into the wall beside you reads as
    // being unable to walk straight, which is the thing being modelled.
    if (t % DRUNK_STAGGER_EVERY < DRUNK_STAGGER_TICKS) {
      const lurch = ((t / DRUNK_STAGGER_EVERY) | 0) % 2 ? 1 : -1;
      if (dx) { dy = lurch; dx = 0; } else { dx = lurch; dy = 0; }
      p.dir = dx > 0 ? DIR_R : dx < 0 ? DIR_L : dy < 0 ? DIR_U : DIR_D;
    }
    const sway = Math.round(
      (Math.sin(t * DRUNK_SWAY_RATE_A) + Math.sin(t * DRUNK_SWAY_RATE_B)) * (DRUNK_SWAY_UNITS / 2),
    );
    if (sway) {
      // Nudge the axis you are NOT travelling on. moveAxis sorts out the legality.
      const nx = dx ? p.x : p.x + sway;
      const ny = dx ? p.y + sway : p.y;
      if (!blocked(state, p, nx, ny)) { p.x = nx; p.y = ny; }
    }
  }

  /* Diagonals: one axis a tick, but the one that WORKS.
   *
   * Movement stays axis-locked — that is what keeps a tile game feeling like a tile game, and
   * what lets the remote interpolation draw an L instead of a diagonal. What changes is which
   * axis is chosen when you are holding two.
   *
   * Before, it committed to whichever way you were already facing and stopped dead if that way
   * was blocked: holding down-left against a wall below you did nothing at all, even though
   * left was wide open. Now the preferred axis is tried first and the other is the fallback, so
   * holding a diagonal into any obstacle slides you along it. Pressed against a corner where
   * neither works you stop, which is correct.
   *
   * The preference is still the way you are facing, so holding a diagonal down a clear corridor
   * does not stutter between the two axes.
   */
  if (dx && dy) {
    const facingH = p.dir === DIR_L || p.dir === DIR_R;
    let first = facingH ? [dx, 0] : [0, dy];
    let second = facingH ? [0, dy] : [dx, 0];

    /* Swap when the preferred axis is walled and the other is not.
     *
     * The test has to be "is the full step legal", not "did moveAxis return true" — moveAxis
     * reports success for sliding flush against a wall, which is movement but not progress. A
     * player holding down-left against a floor below them would spend every tick re-seating
     * themselves against that floor and never go left at all.
     */
    const open = ([ax, ay]) => !blocked(state, p, p.x + ax * speed, p.y + ay * speed);
    if (!open(first) && open(second)) [first, second] = [second, first];

    // Face the axis actually travelled, so the sprite and the next tick's preference agree with
    // what happened rather than with what was asked for.
    const faceOf = ([ax, ay]) => (ax > 0 ? DIR_R : ax < 0 ? DIR_L : ay < 0 ? DIR_U : DIR_D);
    if (moveAxis(state, p, first[0], first[1], speed)) { p.dir = faceOf(first); return; }
    if (moveAxis(state, p, second[0], second[1], speed)) p.dir = faceOf(second);
    return;
  }

  p.dir = dx > 0 ? DIR_R : dx < 0 ? DIR_L : dy < 0 ? DIR_U : DIR_D;
  moveAxis(state, p, dx, dy, speed);
}

/** Every alive player, in seat order. Order is part of determinism — never iterate a Map here. */
export function stepAll(state, inputs) {
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p && p.alive) step(state, p, inputs[i] | 0);
  }
}
