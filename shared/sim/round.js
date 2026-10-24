// The tick, in order.
//
// This is the only place that decides the order of operations, and the order is part of the
// rules — reordering these changes outcomes, and a new step in the wrong place is the classic
// cause of "it desyncs after about a minute". docs/ARCHITECTURE.md §4.

import {
  IN_BOMB, SCORE, STATUS, STATUS_TICKS, INVULN_TICKS_SHIELD, HITBOX_UNITS,
  HITBOX_REDUCED_UNITS, START_BOMBS, START_RADIUS, RESPAWN_DELAY_TICKS,
  FIRE_TICKS, FIRE_LETHAL_TICKS,
} from '../constants.js';
import { expireStatuses, applyStatus, has, toTile } from './state.js';
import { stepAll } from './movement.js';
import { place, detonate, expireFires } from './bombs.js';
import { collect, scatterOnDeath } from './perks.js';
import { regenerate, expirePuddles } from './blocks.js';
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

  // 7. pickups. Perks are fireproof — see the note in perks.js.
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
  expirePuddles(state);

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
  // Only fire that is still in its lethal window, not merely still on screen. A blast is drawn
  // for FIRE_TICKS and kills for the first two thirds of that; the tail is embers.
  const deadline = state.tick + (FIRE_TICKS - FIRE_LETHAL_TICKS);
  const fresh = state.fires.filter(f => f.until > deadline);
  if (!fresh.length) return;
  // Rum: the arms stop hurting, the core still does. Computed once rather than per player.
  const cores = fresh.filter(f => f.kind === 'core');

  for (const p of state.players) {
    if (!p || !p.alive) continue;
    if (has(p, STATUS.INVULN)) continue;

    const half = (has(p, STATUS.REDUCTION) ? HITBOX_REDUCED_UNITS : HITBOX_UNITS) >> 1;
    // Drunk: only the tile the bomb itself was on. Everything else in the blast is survivable.
    const lethal = has(p, STATUS.DRUNK) ? cores : fresh;
    if (!lethal.length || !burns(lethal, p.x, p.y, half)) continue;

    if (p.shields > 0) {
      p.shields--;
      applyStatus(state, p, STATUS.INVULN, INVULN_TICKS_SHIELD);
      state.events.push({ e: 'shield', tick: state.tick, i: p.i });
      continue;
    }

    // Who gets the kill.
    //
    // The centre tile is the documented rule (RULES.md §3) and stays the first choice, so every
    // outcome that was already right is unchanged. The fallback used to be `fresh[0]` — the oldest
    // still-burning fire ANYWHERE on the map — which handed +100 and the kill-feed line to a
    // player who was not involved, or scored a suicide when that stray fire happened to be the
    // victim's own. A 160-unit hitbox straddles a tile boundary most of the time, so the centre
    // tile misses often and the wrong fallback fired often.
    //
    // So: fall back to the fire the hitbox actually overlaps, scanning `fresh` in array order,
    // which is `detonate` push order and therefore deterministic. One of them must match, because
    // `burns()` just returned true for the identical box.
    const tx = toTile(p.x), ty = toTile(p.y);
    const overlapped = lethal.find(f =>
      f.tx >= (p.x - half) >> 8 && f.tx <= (p.x + half - 1) >> 8 &&
      f.ty >= (p.y - half) >> 8 && f.ty <= (p.y + half - 1) >> 8);
    const fire = fresh.find(f => f.tx === tx && f.ty === ty) || overlapped;
    const killer = fire.owner;

    scatterOnDeath(state, p);

    p.alive = false;
    p.deaths++;
    p.bombs = START_BOMBS;
    p.radius = START_RADIUS;
    p.speed = 0;
    p.shields = 0;
    p.status = 0;
    p.statusUntil = {};
    p.respawnAt = state.tick + RESPAWN_DELAY_TICKS;

    if (killer === p.i) {
      p.score = Math.max(0, p.score + SCORE.SUICIDE);
    } else {
      const k = state.players[killer];
      if (k) { k.kills++; k.score += SCORE.KILL; }
    }
    state.events.push({ e: 'died', tick: state.tick, i: p.i, by: killer, x: p.x, y: p.y });
  }
}

