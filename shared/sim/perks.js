// What falls out of a broken block, and what it does to you.

import {
  PERK, PERK_WEIGHTS, PERK_DROP_CHANCE_SOFT, PERK_DROP_ALWAYS, PERK_EXPIRE_TICKS,
  MAX_BOMBS_CARRIED, MAX_RADIUS, MAX_SKATES, MAX_SHIELDS, SCORE, BLOCK, HITBOX_UNITS, STATUS,
  PERKS_DROPPED_ON_DEATH, START_BOMBS, START_RADIUS, MAX_STAMINA_LEVELS,
  STATUS_TICKS,
  PERK_TARGET_PER_PLAYER, PERK_TARGET_MIN, PERK_SCARCE_BOOST, PERK_GLUT_FLOOR,
  PERK_TAKE_DECAY, PERK_DEMAND_BOOST, GOLD_MAX_PER_ROUND,
} from '../constants.js';
import { staminaMaxFor } from '../constants.js';
import { tileAt, toTile, applyStatus } from './state.js';
import { randInt } from '../util/rng.js';


const LIVE = Object.entries(PERK_WEIGHTS).filter(([, w]) => w > 0).map(([t, w]) => [+t, w]);
const TOTAL = LIVE.reduce((n, [, w]) => n + w, 0);

/** Weighted pick from the live table. Reserved perks sit at weight 0 and never come up. */
function roll(next) {
  let r = randInt(next, TOTAL);
  for (const [type, w] of LIVE) { if (r < w) return type; r -= w; }
  return PERK.BOMB;
}

/* Gold is the one type with a cap on top of its weight, so the roll has to be able to say no.
 *
 * Re-rolling rather than removing gold from the table once the cap is hit, because removing it
 * would silently redistribute its 2% across the other perks — a late round would have very
 * slightly more bombs and fire in it than an early one, for no reason anybody could name. One
 * re-roll keeps the other six at exactly their own weights and turns a capped coin into
 * "nothing special this time", which is what it should be.
 *
 * Bounded at two attempts: at 2% the chance of needing a third is one in two thousand, and an
 * unbounded loop inside the simulation is never worth the tail it saves. */
function rollDroppable(state) {
  let type = roll(state.next);
  if (type === PERK.GOLD && state.goldDropped >= GOLD_MAX_PER_ROUND) type = roll(state.next);
  if (type === PERK.GOLD && state.goldDropped >= GOLD_MAX_PER_ROUND) type = PERK.BOMB;
  return type;
}

/**
 * How many perks the board wants lying on it right now.
 *
 * Scaled by players alive, not by map size: the competition is for the perk, and sixteen players
 * sharing three drops is a different game to three players sharing three.
 */
export function perkTarget(state) {
  let alive = 0;
  for (const p of state.players) if (p && p.alive) alive++;
  return Math.max(PERK_TARGET_MIN, alive * PERK_TARGET_PER_PLAYER);
}

/**
 * The drop chance for this moment, from supply and demand.
 *
 * Supply pushes it between PERK_SCARCE_BOOST (bare floor) and PERK_GLUT_FLOOR (at or over
 * target). Demand lifts it by up to PERK_DEMAND_BOOST when perks are being taken faster than one
 * every few seconds. Both are multipliers on the base chance, so the tuning knob is still
 * PERK_DROP_CHANCE_SOFT and this only decides how far either side of it we are.
 */
export function dropChance(state) {
  const target = perkTarget(state);
  const fill = Math.min(1, state.perks.length / target);
  const supply = PERK_SCARCE_BOOST - (PERK_SCARCE_BOOST - PERK_GLUT_FLOOR) * fill;
  const demand = 1 + PERK_DEMAND_BOOST * Math.min(1, state.perkTakeRate / target);
  return Math.min(1, PERK_DROP_CHANCE_SOFT * supply * demand);
}

export function maybeDrop(state, tx, ty, blockType) {
  const always = PERK_DROP_ALWAYS.includes(blockType);
  if (!always && state.next() > dropChance(state)) return;
  drop(state, tx, ty, rollDroppable(state));
}

/**
 * @param capped false for a coin that was EARNED rather than rolled — a gull's — which must not
 *   use up one of the round's GOLD_MAX_PER_ROUND. See GULL_* in constants.js.
 */
export function drop(state, tx, ty, type, capped = true) {
  if (state.perks.some(k => k.tx === tx && k.ty === ty)) return;
  // Counted on the DROP, not on the pickup: the cap is on how much gold a round contains, and a
  // coin that expires on the floor was still gold this round had in it.
  if (type === PERK.GOLD && capped) state.goldDropped = (state.goldDropped || 0) + 1;
  const perk = { id: state.nextPerkId++, tx, ty, type, until: state.tick + PERK_EXPIRE_TICKS };
  state.perks.push(perk);
  state.events.push({ e: 'perkadd', tick: state.tick, id: perk.id, x: tx, y: ty, p: type });
}

/**
 * Caps still pay out — a late-round pickup should never be nothing at all.
 *
 * Bombs cap at MAX_BOMBS_CARRIED, not the MAX_BOMBS safety valve: the HUD shows n/8 next to n/6
 * fire and n/4 speed, so the number has to be a real limit rather than a number the player can
 * walk past.
 */
function apply(state, p, type) {
  switch (type) {
    case PERK.BOMB:   if (p.bombs  < MAX_BOMBS_CARRIED) { p.bombs++; return true; } return false;
    case PERK.FIRE:   if (p.radius < MAX_RADIUS) { p.radius++; return true; } return false;
    case PERK.SKATE:  if (p.speed  < MAX_SKATES) { p.speed++;  return true; } return false;
    case PERK.SHIELD: if (p.shields < MAX_SHIELDS) { p.shields++; return true; } return false;
    // A Stim. Tops you up as well as raising the ceiling, because a perk that
    // only pays off the next time you stop running does not feel like a pickup.
    /* Rum. Fire's arms stop killing you; only the bomb's own tile still does.
     *
     * Not "half damage" — there is no health here, so the only way to take less of something
     * that kills you outright is to be killed by less of it. Standing in the middle of a blast
     * is still fatal; being caught by the end of an arm is not, and that is exactly the kind
     * of death the rum is meant to save you from.
     *
     * Paid for in control: see DRUNK in movement.js. A defensive perk with no cost is just a
     * better perk, and this is supposed to be a decision.
     */
    case PERK.RUM:
      applyStatus(state, p, STATUS.DRUNK, STATUS_TICKS[STATUS.DRUNK]);
      return true;

    /* Gold changes nothing. That is the design, not an omission.
     *
     * Every other perk makes you better at the round you are in, which means every other perk
     * is a reason to take a risk NOW. A coin is a reason to take a risk for later, and the two
     * feel different precisely because this one does nothing for you today. Returning true pays
     * SCORE.GOLD rather than SCORE.PERK_CAPPED — it is always "gained", it can never be capped,
     * and there is no ceiling to walk past. */
    case PERK.GOLD:
      p.coins = (p.coins || 0) + 1;
      return true;

    case PERK.STAMINA:
      if ((p.staminaLevel ?? 0) >= MAX_STAMINA_LEVELS) return false;
      p.staminaLevel = (p.staminaLevel ?? 0) + 1;
      p.stamina = staminaMaxFor(p);
      p.tired = false;
      return true;
    default: return false;                      // reserved types: inert until given a weight
  }
}

export function collect(state) {
  // Decays every tick, including the ones where nothing is picked up and the early return below
  // would otherwise skip it — a rate that only decays while perks exist never falls to zero.
  state.perkTakeRate *= PERK_TAKE_DECAY;
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
      p.score += perk.type === PERK.GOLD ? SCORE.GOLD
        : gained ? SCORE.PERK : SCORE.PERK_CAPPED;
      state.perks.splice(k, 1);
      state.perkTakeRate += 1;
      state.events.push({ e: 'perkget', tick: state.tick, id: perk.id, i: p.i });
    }
  }

  state.perks = state.perks.filter(k => {
    if (k.until > state.tick) return true;
    state.events.push({ e: 'perkgone', tick: state.tick, id: k.id });
    return false;
  });
}

/**
 * Perks are FIREPROOF, on purpose.
 *
 * They used to burn, on the reasoning that a tile with a perk on it should not become the safest
 * square on the map. In practice it did the opposite of what it was for: the only way to open a
 * wall is with a bomb, and the bomb that opens it is usually still burning when the perk appears,
 * so the player who did the work watched their own blast eat the reward. Chain reactions made it
 * worse — a four-bomb chain could clear half the drops on the board in one tick, and there is
 * nothing to outplay there.
 *
 * Nothing replaces it: PERK_EXPIRE_TICKS already stops a contested drop sitting there forever.
 */

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
