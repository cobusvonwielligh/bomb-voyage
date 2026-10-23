// Block damage, destruction, and the walls that grow back.

import {
  BLOCK, BLOCK_HP, BLOCK_DESTRUCTIBLE, REGEN_EVERY_TICKS, REGEN_PER_CYCLE,
  REGEN_CLEAR_RADIUS_TILES, SCORE,
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
 * Game of Bombs rematerialises walls as a round runs, which stops a 16-minute map collapsing
 * into an empty field where nobody can hide. Cheap version: every 20s, turn a few quiet floor
 * tiles back into soft walls — never near a player, a bomb, fire or a dropped perk.
 */
export function regenerate(state) {
  if (state.tick === 0 || state.tick % REGEN_EVERY_TICKS !== 0) return;

  const { w, h } = state.map;
  const R = REGEN_CLEAR_RADIUS_TILES;

  const busy = [];
  for (const p of state.players) if (p && p.alive) busy.push([p.x >> 8, p.y >> 8]);
  for (const b of state.bombs) busy.push([b.tx, b.ty]);
  for (const f of state.fires) busy.push([f.tx, f.ty]);
  for (const k of state.perks) busy.push([k.tx, k.ty]);

  let placed = 0;
  for (let attempt = 0; attempt < 60 && placed < REGEN_PER_CYCLE; attempt++) {
    const tx = 1 + randInt(state.next, w - 2);
    const ty = 1 + randInt(state.next, h - 2);
    if (tileAt(state.map, tx, ty) !== BLOCK.FLOOR) continue;
    if (busy.some(([bx, by]) => Math.abs(bx - tx) <= R && Math.abs(by - ty) <= R)) continue;
    setTile(state.map, tx, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    state.events.push({ e: 'blocknew', tick: state.tick, x: tx, y: ty, b: BLOCK.SOFT });
    placed++;
  }
}
