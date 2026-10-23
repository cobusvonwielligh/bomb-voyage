// Block damage, destruction, and the walls that grow back.

import {
  BLOCK, BLOCK_HP, BLOCK_DESTRUCTIBLE, BLOCK_WALKABLE, REGEN_EVERY_TICKS, REGEN_PER_CYCLE,
  REGEN_CLEAR_RADIUS_TILES, REGEN_MAX_FILL, SCORE,
  POWDER_MAX_PER_ROUND, POWDER_CHANCE_PER_CYCLE, POWDER_GUARANTEE_TICK,
} from '../constants.js';
import { tileAt, hpAt, setTile } from './state.js';
import { randInt } from '../util/rng.js';

/** One point of blast damage. A reinforced block therefore needs six separate blasts. */
export function damage(state, tx, ty, owner) {
  const type = tileAt(state.map, tx, ty);
  if (!BLOCK_DESTRUCTIBLE(type)) return null;

  const hp = hpAt(state.map, tx, ty) - 1;
  if (hp > 0) {
    setTile(state.map, tx, ty, type, hp);
    state.events.push({ e: 'blockhit', tick: state.tick, x: tx, y: ty, hp });
    return { destroyed: false, type };
  }

  setTile(state.map, tx, ty, BLOCK.FLOOR, 0);
  state.events.push({ e: 'blockdie', tick: state.tick, x: tx, y: ty });
  const p = state.players[owner];
  if (p) p.score += SCORE.BLOCK;
  return { destroyed: true, type };
}

/**
 * How much of the playable map is wall right now, as a fraction of every non-IRON tile.
 *
 * "Wall" is anything you cannot walk through, which is the thing that actually turns a map into a
 * maze — soft, reinforced, monolith, solid shrub and column all count; IRON is the fixed skeleton
 * and is not part of the denominator.
 *
 * This is a full scan of w*h cells. That is fine *here specifically*: `regenerate` returns
 * immediately on 599 of every 600 ticks, so this runs once every 20 seconds, not once per tick.
 * Do not lift it anywhere that runs more often.
 */
function wallFill(map) {
  let walls = 0, open = 0;
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const t = tileAt(map, tx, ty);
      if (t === BLOCK.IRON) continue;
      open++;
      if (!BLOCK_WALKABLE(t, false)) walls++;
    }
  }
  return open ? walls / open : 1;
}

/**
 * Game of Bombs rematerialises walls as a round runs, which stops a 16-minute map collapsing
 * into an empty field where nobody can hide. Cheap version: every 20s, turn a few quiet floor
 * tiles back into soft walls — never near a player, a bomb, fire or a dropped perk.
 *
 * Bounded at both ends. Unbounded growth was not a slow drift: three walls every 20 s is 144
 * walls over a round, which closes an open Arena into a maze nobody can cross. And a wall grown
 * on a spawn tile entombs whoever spawns there next, so spawns and their immediate neighbours are
 * off limits.
 */
export function regenerate(state) {
  if (state.tick === 0 || state.tick % REGEN_EVERY_TICKS !== 0) return;
  const fill = wallFill(state.map);

  const { w, h } = state.map;
  const R = REGEN_CLEAR_RADIUS_TILES;

  // A spawn ring, unlike the busy list, is a hard exclusion rather than a radius: respawn picks
  // the spawn furthest from the action, which is exactly the quiet corner this function likes.
  const spawns = state.map.spawns ?? [];
  const onSpawnRing = (tx, ty) =>
    spawns.some(([sx, sy]) => Math.abs(sx - tx) <= 1 && Math.abs(sy - ty) <= 1);

  const busy = [];
  for (const p of state.players) if (p && p.alive) busy.push([p.x >> 8, p.y >> 8]);
  for (const b of state.bombs) busy.push([b.tx, b.ty]);
  for (const f of state.fires) busy.push([f.tx, f.ty]);
  for (const k of state.perks) busy.push([k.tx, k.ty]);

  // How much grows back depends on how bare the map already is.
  //
  // A flat three a cycle is wrong at both ends: too slow to give an arena that has been chewed
  // open for eight minutes any cover back, and too fast on a map that is still mostly walls. So
  // the rate scales with emptiness — nothing much while there is still cover, and up to three
  // times the base rate once the place is a field. `fill` is walls over non-iron tiles, so
  // emptiness is simply its complement.
  const bare = 1 - fill;
  const want = Math.max(1, Math.round(REGEN_PER_CYCLE * (0.4 + 2.6 * Math.max(0, bare - 0.45))));

  // A quiet floor tile, or null if this cycle could not find one. Shared by the walls and the
  // kegs so neither can land on top of a player, a bomb, a fire, a perk or a spawn.
  const quietTile = tries => {
    for (let attempt = 0; attempt < tries; attempt++) {
      const tx = 1 + randInt(state.next, w - 2);
      const ty = 1 + randInt(state.next, h - 2);
      if (tileAt(state.map, tx, ty) !== BLOCK.FLOOR) continue;
      if (onSpawnRing(tx, ty)) continue;
      if (busy.some(([bx, by]) => Math.abs(bx - tx) <= R && Math.abs(by - ty) <= R)) continue;
      return [tx, ty];
    }
    return null;
  };

  // Kegs first, and ahead of the wall-fill cap.
  //
  // The cap stops a map silting up with walls, which has nothing to do with kegs — and a
  // guarantee that only fires on maps that happen to be open is not a guarantee. A full map is
  // also exactly when a keg is most wanted.
  maybePowder(state, quietTile);

  if (fill > REGEN_MAX_FILL) return;

  let placed = 0;
  for (let attempt = 0; attempt < want * 25 && placed < want; attempt++) {
    const at = quietTile(1);
    if (!at) continue;
    setTile(state.map, at[0], at[1], BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    state.events.push({ e: 'blocknew', tick: state.tick, x: at[0], y: at[1], b: BLOCK.SOFT });
    placed++;
  }
}

/**
 * Drop a powder keg, rarely.
 *
 * Two rules, and the second is the one that matters: at most POWDER_MAX_PER_ROUND in a round, and
 * at least one before the round is over. A rare event that *might* not happen is one players
 * never learn to look for, so once the guarantee tick passes the roll stops being a roll.
 *
 * Shares the regrowth cycle's quiet-tile test, so a keg can never appear next to somebody — that
 * would be a free kill with no reading of it possible.
 */
function maybePowder(state, quietTile) {
  if (state.powderPlaced >= POWDER_MAX_PER_ROUND) return;
  const overdue = state.powderPlaced === 0 && state.tick >= POWDER_GUARANTEE_TICK;
  if (!overdue && state.next() > POWDER_CHANCE_PER_CYCLE) return;

  // The guarantee is worth trying harder for than a coin flip is.
  const at = quietTile(overdue ? 400 : 60);
  if (!at) return;
  setTile(state.map, at[0], at[1], BLOCK.POWDER, BLOCK_HP[BLOCK.POWDER]);
  state.events.push({ e: 'blocknew', tick: state.tick, x: at[0], y: at[1], b: BLOCK.POWDER });
  state.powderPlaced++;
}
