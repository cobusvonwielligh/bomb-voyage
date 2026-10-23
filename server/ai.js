// Bot brains for the in-game `/bots N` command.
//
// These are seats the server drives itself — no sockets, no second process. That makes them
// nearly free, and it means they exercise the simulation rather than the network. The separate
// `npm run bots` harness is the one that exercises the network; this is the one that gives you
// somebody to blow up on a Tuesday.
//
// Deliberately simple: wander, keep away from things about to explode, bomb walls and people.
// A bot that plays well is not the goal; a bot that is alive long enough to be a target is.

import {
  IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, IN_BOMB, BLOCK, FUSE_TICKS,
} from '../shared/constants.js';
import { tileAt, walkable, toTile } from '../shared/sim/state.js';
import { spread } from '../shared/sim/fire.js';

const DIRS = [
  { mask: IN_RIGHT, dx: 1, dy: 0 },
  { mask: IN_UP, dx: 0, dy: -1 },
  { mask: IN_LEFT, dx: -1, dy: 0 },
  { mask: IN_DOWN, dx: 0, dy: 1 },
];

export const createBrain = () => ({ dir: (Math.random() * 4) | 0, hold: 0, cooldown: 0 });

/** Every tile that is about to be on fire, with how soon. */
function dangerMap(state) {
  const danger = new Map();
  for (const b of state.bombs) {
    const ticks = Math.max(0, b.at - state.tick);
    for (const c of spread(state.map, b).cells) {
      const key = c.ty * state.map.w + c.tx;
      danger.set(key, Math.min(danger.get(key) ?? Infinity, ticks));
    }
  }
  // Fire already burning is maximally dangerous.
  for (const f of state.fires) danger.set(f.ty * state.map.w + f.tx, 0);
  return danger;
}

const dangerAt = (danger, map, tx, ty) => danger.get(ty * map.w + tx) ?? Infinity;

/** Closest living player that is not me, by Manhattan distance in tiles. */
function nearestPlayer(state, me) {
  let best = null, bestD = Infinity;
  for (const q of state.players) {
    if (!q || q === me || !q.alive) continue;
    const d = Math.abs(q.x - me.x) + Math.abs(q.y - me.y);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
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
  const here = dangerAt(danger, map, tx, ty);

  // In the blast of something with a short fuse: get out, any direction that is safer.
  if (here < FUSE_TICKS) {
    let best = null, bestScore = here;
    for (const d of DIRS) {
      const nx = tx + d.dx, ny = ty + d.dy;
      if (!walkable(map, nx, ny)) continue;
      const score = dangerAt(danger, map, nx, ny);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (best) { brain.dir = DIRS.indexOf(best); brain.hold = 6; return best.mask; }
    // Nowhere better: keep moving rather than standing still and accepting it.
  }

  // Commit to a direction for a while, so bots walk corridors instead of vibrating.
  if (brain.hold <= 0 || !walkable(map, tx + DIRS[brain.dir].dx, ty + DIRS[brain.dir].dy)) {
    const options = DIRS
      .map((d, i) => ({ i, d }))
      .filter(({ d }) => walkable(map, tx + d.dx, ty + d.dy)
        && dangerAt(danger, map, tx + d.dx, ty + d.dy) > FUSE_TICKS);

    if (options.length) {
      // Head roughly toward the nearest player rather than purely at random. Without this they
      // diffuse into the far corners of a 41x29 map and you never see them again — they are
      // there to be fought, not to explore.
      const target = nearestPlayer(state, p);
      if (target && Math.random() < 0.7) {
        const tdx = Math.sign(toTile(target.x) - tx);
        const tdy = Math.sign(toTile(target.y) - ty);
        const toward = options.filter(({ d }) =>
          (tdx && d.dx === tdx) || (tdy && d.dy === tdy));
        const pickFrom = toward.length ? toward : options;
        brain.dir = pickFrom[(Math.random() * pickFrom.length) | 0].i;
      } else {
        brain.dir = options[(Math.random() * options.length) | 0].i;
      }
    }
    brain.hold = 10 + ((Math.random() * 20) | 0);
  }
  brain.hold--;

  let mask = DIRS[brain.dir].mask;

  // Bomb when there is something worth bombing and an escape exists. Checking for an escape is
  // the difference between a bot that plays and a bot that suicides within ten seconds.
  if (brain.cooldown > 0) brain.cooldown--;
  else if (here === Infinity) {
    const adjacentWall = DIRS.some(d => {
      const t = tileAt(map, tx + d.dx, ty + d.dy);
      return t === BLOCK.SOFT || t === BLOCK.REINFORCED;
    });
    const nearPlayer = state.players.some(q =>
      q && q !== p && q.alive && Math.abs(toTile(q.x) - tx) + Math.abs(toTile(q.y) - ty) <= 3);
    const escape = DIRS.filter(d => walkable(map, tx + d.dx, ty + d.dy)).length >= 2;

    if ((adjacentWall || nearPlayer) && escape) {
      mask |= IN_BOMB;
      brain.cooldown = 45;
    }
  }

  return mask;
}

export { dangerMap };
