// Blast shape. Pure: (map, bomb) in, cells out. No state, no randomness, no clock.
//
// This purity is what lets the client draw an explosion on exactly the same tick the server
// does, from nothing but the bomb list — see docs/NETCODE.md §1a. It is also why there is no
// rollback anywhere in this project.

import { BLOCK, SHRUB_RADIUS_PENALTY } from '../constants.js';
import { tileAt } from './state.js';

const DIRS = [[1, 0], [0, -1], [-1, 0], [0, 1]];   // right, up, left, down — matches DIR_* order

// Anything a blast arm damages and then stops at. A powder keg is one of these, which is the
// whole reason a blast reaching one sets it off: the arm registers a hit, damage() destroys it,
// and detonate() turns the destruction into a bomb.
const DESTRUCTIBLE = new Set([BLOCK.SOFT, BLOCK.REINFORCED, BLOCK.MONOLITH, BLOCK.POWDER]);
const SHRUB = new Set([BLOCK.SHRUB_WALK, BLOCK.SHRUB_SOLID]);

/**
 * @returns {{cells: Array<{tx,ty,kind,rot}>, hits: Array<{tx,ty}>}}
 *   `cells` is what to draw and what kills; `hits` is the blocks that take a point of damage.
 */
export function spread(map, bomb) {
  const cells = [{ tx: bomb.tx, ty: bomb.ty, kind: 'core', rot: 0 }];
  const hits = [];

  for (let d = 0; d < 4; d++) {
    const [dx, dy] = DIRS[d];
    let reach = bomb.radius;
    let step = 1;

    while (step <= reach) {
      const tx = bomb.tx + dx * step;
      const ty = bomb.ty + dy * step;
      const t = tileAt(map, tx, ty);

      if (t === BLOCK.IRON || t === BLOCK.WATER) break;   // stops before it

      if (DESTRUCTIBLE.has(t)) {                       // damages it, burns the tile, stops
        hits.push({ tx, ty });
        cells.push({ tx, ty, kind: 'tip', rot: d });
        break;
      }

      if (SHRUB.has(t)) reach -= SHRUB_RADIUS_PENALTY;  // passes through, weakened

      cells.push({ tx, ty, kind: step >= reach ? 'tip' : 'arm', rot: d });
      step++;
    }
  }

  return { cells, hits };
}

/** Does this player's hitbox overlap any of these fire tiles? */
export function burns(fireCells, px, py, half) {
  const x0 = (px - half) >> 8, x1 = (px + half - 1) >> 8;
  const y0 = (py - half) >> 8, y1 = (py + half - 1) >> 8;
  for (const c of fireCells) {
    if (c.tx >= x0 && c.tx <= x1 && c.ty >= y0 && c.ty <= y1) return true;
  }
  return false;
}
