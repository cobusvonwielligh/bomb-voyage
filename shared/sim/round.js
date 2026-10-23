// The tick, in order.
//
// This is the only place that decides the order of operations, and the order is part of the
// rules — reordering these changes outcomes, and a new step in the wrong place is the classic
// cause of "it desyncs after about a minute". docs/ARCHITECTURE.md §4.

import {
  IN_BOMB, SCORE, STATUS, STATUS_TICKS, INVULN_TICKS_SHIELD, HITBOX_UNITS,
  HITBOX_REDUCED_UNITS, START_BOMBS, START_RADIUS,
} from '../constants.js';
import { expireStatuses, applyStatus, has, toTile } from './state.js';
import { stepAll } from './movement.js';
import { place, detonate, expireFires } from './bombs.js';
import { collect, scatterOnDeath } from './perks.js';
import { regenerate } from './blocks.js';
import { burns } from './fire.js';
import { spread as spreadStatuses } from './statuses.js';

export function tick(state, inputs, { onRespawn } = {}) {
  // 1. statuses expire before anything reads them
  for (const p of state.players) if (p) expireStatuses(state, p);

  // 2. movement
  stepAll(state, inputs);

  // 3. bombs placed, ascending seat so a tie on one tile is resolved the same way everywhere
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p) place(state, p, inputs[i] | 0);
  }

  // 4 & 5. fuses and chains, resolved together in one tick
  detonate(state);

  // 6. fire damage: blocks were already hit inside detonate, players die here
  killInFire(state);

  // 7. pickups
  collect(state);

  // 8. statuses spread on contact
  spreadStatuses(state);

  // 9. walls grow back
  regenerate(state);

  // respawn requests, and fire that has burned out
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p && !p.alive && (inputs[i] & IN_BOMB) && state.tick >= p.respawnAt) onRespawn?.(p);
  }
  expireFires(state);

  state.tick++;
}

/**
 * Anyone standing in fire dies, unless they are invulnerable or spend a shield.
 *
 * Kill credit goes to the owner of the fire tile, which is why ordering inside `detonate` is
 * deterministic — in a chain, two players' bombs can both be burning the same square.
 */
function killInFire(state) {
  if (!state.fires.length) return;

  for (const p of state.players) {
    if (!p || !p.alive) continue;
    if (has(p, STATUS.INVULN)) continue;

    const half = (has(p, STATUS.REDUCTION) ? HITBOX_REDUCED_UNITS : HITBOX_UNITS) >> 1;
    const fresh = state.fires.filter(f => f.until > state.tick);
    if (!burns(fresh, p.x, p.y, half)) continue;

    if (p.shields > 0) {
      p.shields--;
      applyStatus(state, p, STATUS.INVULN, INVULN_TICKS_SHIELD);
      state.events.push({ e: 'shield', tick: state.tick, i: p.i });
      continue;
    }

    const tx = toTile(p.x), ty = toTile(p.y);
    const fire = fresh.find(f => f.tx === tx && f.ty === ty) || fresh[0];
    const killer = fire?.owner ?? p.i;

    scatterOnDeath(state, p);

    p.alive = false;
    p.deaths++;
    p.bombs = START_BOMBS;
    p.radius = START_RADIUS;
    p.speed = 0;
    p.shields = 0;
    p.status = 0;
    p.statusUntil = {};
    p.respawnAt = state.tick;          // SPACE respawns immediately; no forced wait at 12 players

    if (killer === p.i) {
      p.score = Math.max(0, p.score + SCORE.SUICIDE);
    } else {
      const k = state.players[killer];
      if (k) { k.kills++; k.score += SCORE.KILL; }
    }
    state.events.push({ e: 'died', tick: state.tick, i: p.i, by: killer, x: p.x, y: p.y });
  }
}

