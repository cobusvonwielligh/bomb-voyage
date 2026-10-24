// The contagious diseases. Game of Bombs' most distinctive idea: most statuses spread by
// touch, so a crowded corridor changes how everyone plays for the next ten seconds.
//
// docs/RULES.md §7.

import {
  STATUS, CONTAGIOUS, CONTAGION_COOLDOWN_TICKS, HITBOX_UNITS, HITBOX_REDUCED_UNITS,
} from '../constants.js';
import { has, applyStatus } from './state.js';

/** Every contagious status, as a list, in a fixed order — iteration order is part of the sim. */
export const CONTAGIOUS_LIST = [
  STATUS.PACIFISM, STATUS.SLOWDOWN, STATUS.INVISIBLE,
  STATUS.CHANGELING, STATUS.REDUCTION, STATUS.FAST_DET,
];

const half = p => (has(p, STATUS.REDUCTION) ? HITBOX_REDUCED_UNITS : HITBOX_UNITS) >> 1;

const overlapping = (a, b) =>
  Math.abs(a.x - b.x) < half(a) + half(b) && Math.abs(a.y - b.y) < half(a) + half(b);

/**
 * Pass statuses between touching players.
 *
 * The carrier keeps theirs — this is contagion, not a trade. The per-pair cooldown stops a scrum
 * from ping-ponging the same status back and forth every tick, which would both spam the event
 * log and make the status effectively permanent for everyone in the pile.
 *
 * O(n²) over 16 players is 120 comparisons a tick. That is nothing, and the alternative (a
 * spatial index) would be a lot of machinery for a number that small.
 */
export function spread(state) {
  const players = state.players;
  state.contagion ??= new Map();

  for (let i = 0; i < players.length; i++) {
    const a = players[i];
    if (!a || !a.alive || !(a.status & CONTAGIOUS)) continue;

    for (let j = 0; j < players.length; j++) {
      if (i === j) continue;
      const b = players[j];
      if (!b || !b.alive) continue;
      // Invulnerability protects you from catching things too, which is what stops a fresh
      // respawn walking straight into a plague pit and losing the spawn protection's point.
      if (has(b, STATUS.INVULN)) continue;
      if (!overlapping(a, b)) continue;

      const key = i * 16 + j;
      if (state.tick < (state.contagion.get(key) || 0)) continue;

      let passed = false;
      for (const bit of CONTAGIOUS_LIST) {
        if (!(a.status & bit) || (b.status & bit)) continue;
        const remaining = (a.statusUntil[bit] || 0) - state.tick;
        if (remaining <= 0) continue;
        applyStatus(state, b, bit, remaining);        // you catch what is left of it
        state.events.push({ e: 'status', tick: state.tick, i: b.i, s: bit, until: state.tick + remaining });
        passed = true;
      }
      if (passed) state.contagion.set(key, state.tick + CONTAGION_COOLDOWN_TICKS);
    }
  }

  // The cooldown map is keyed by seat pair, so it is bounded at 256 entries. Still worth
  // clearing out the dead ones rather than letting it sit full of stale ticks.
  if (state.contagion.size > 64) {
    for (const [k, until] of state.contagion) if (until < state.tick) state.contagion.delete(k);
  }
}
