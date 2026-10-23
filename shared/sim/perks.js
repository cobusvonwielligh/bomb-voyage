// What falls out of a broken block, and what it does to you.

import {
  PERK, PERK_WEIGHTS, PERK_DROP_CHANCE_SOFT, PERK_DROP_ALWAYS, PERK_EXPIRE_TICKS,
  MAX_BOMBS, MAX_RADIUS, MAX_SKATES, MAX_SHIELDS, SCORE, BLOCK, HITBOX_UNITS, STATUS,
  PERKS_DROPPED_ON_DEATH, START_BOMBS, START_RADIUS, GIFT_DISEASE_CHANCE,
} from '../constants.js';
import { tileAt, toTile } from './state.js';
import { infect } from './statuses.js';
import { randInt } from '../util/rng.js';


const LIVE = Object.entries(PERK_WEIGHTS).filter(([, w]) => w > 0).map(([t, w]) => [+t, w]);
const TOTAL = LIVE.reduce((n, [, w]) => n + w, 0);

/** Weighted pick from the live table. Reserved perks sit at weight 0 and never come up. */
function roll(next, exclude = 0) {
  const pool = LIVE.filter(([t]) => t !== exclude);
  const total = pool.reduce((n, [, w]) => n + w, 0);
  let r = randInt(next, total);
  for (const [type, w] of pool) { if (r < w) return type; r -= w; }
  return PERK.BOMB;
}

export function maybeDrop(state, tx, ty, blockType) {
  const always = PERK_DROP_ALWAYS.includes(blockType);
  if (!always && state.next() > PERK_DROP_CHANCE_SOFT) return;
  drop(state, tx, ty, roll(state.next));
}

export function drop(state, tx, ty, type) {
  if (state.perks.some(k => k.tx === tx && k.ty === ty)) return;
  const perk = { id: state.nextPerkId++, tx, ty, type, until: state.tick + PERK_EXPIRE_TICKS };
  state.perks.push(perk);
  state.events.push({ e: 'perkadd', tick: state.tick, id: perk.id, x: tx, y: ty, p: type });
}

/** Caps still pay out — a late-round pickup should never be nothing at all. */
function apply(state, p, type) {
  switch (type) {
    case PERK.BOMB:   if (p.bombs  < MAX_BOMBS)  { p.bombs++;  return true; } return false;
    case PERK.FIRE:   if (p.radius < MAX_RADIUS) { p.radius++; return true; } return false;
    case PERK.SKATE:  if (p.speed  < MAX_SKATES) { p.speed++;  return true; } return false;
    case PERK.SHIELD: if (p.shields < MAX_SHIELDS) { p.shields++; return true; } return false;
    // A Gift is a gamble, which is the point of it. Most of the time it is a real upgrade;
    // sometimes you catch something, and then you hand it to whoever you run past next.
    case PERK.GIFT:
      if (state.next() < GIFT_DISEASE_CHANCE && infect(state, p, state.next)) return true;
      return apply(state, p, roll(state.next, PERK.GIFT));
    default: return false;                      // reserved types: inert until given a weight
  }
}

export function collect(state) {
  if (!state.perks.length) return;
  const half = HITBOX_UNITS >> 1;

  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (!p || !p.alive) continue;
    const x0 = (p.x - half) >> 8, x1 = (p.x + half - 1) >> 8;
    const y0 = (p.y - half) >> 8, y1 = (p.y + half - 1) >> 8;

    for (let k = state.perks.length - 1; k >= 0; k--) {
      const perk = state.perks[k];
      if (perk.tx < x0 || perk.tx > x1 || perk.ty < y0 || perk.ty > y1) continue;
      const gained = apply(state, p, perk.type);
      p.score += gained ? SCORE.PERK : SCORE.PERK_CAPPED;
      state.perks.splice(k, 1);
      state.events.push({ e: 'perkget', tick: state.tick, id: perk.id, i: p.i });
    }
  }

  state.perks = state.perks.filter(k => {
    if (k.until > state.tick) return true;
    state.events.push({ e: 'perkgone', tick: state.tick, id: k.id });
    return false;
  });
}

/** A good kill should be worth something: scatter a few of the dead player's upgrades. */
export function scatterOnDeath(state, p) {
  const carried = [];
  for (let n = 0; n < p.bombs - START_BOMBS; n++) carried.push(PERK.BOMB);
  for (let n = 0; n < p.radius - START_RADIUS; n++) carried.push(PERK.FIRE);
  for (let n = 0; n < p.speed; n++) carried.push(PERK.SKATE);

  const tx = toTile(p.x), ty = toTile(p.y);
  let placed = 0;
  for (let ring = 0; ring <= 2 && placed < PERKS_DROPPED_ON_DEATH && carried.length; ring++) {
    for (let dy = -ring; dy <= ring && placed < PERKS_DROPPED_ON_DEATH; dy++) {
      for (let dx = -ring; dx <= ring && placed < PERKS_DROPPED_ON_DEATH; dx++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const x = tx + dx, y = ty + dy;
        if (tileAt(state.map, x, y) !== BLOCK.FLOOR) continue;
        if (state.perks.some(k => k.tx === x && k.ty === y)) continue;
        drop(state, x, y, carried.pop());
        placed++;
      }
    }
  }
}
