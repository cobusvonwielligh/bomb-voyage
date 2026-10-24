// The tick, in order.
//
// This is the only place that decides the order of operations, and the order is part of the
// rules — reordering these changes outcomes, and a new step in the wrong place is the classic
// cause of "it desyncs after about a minute". docs/ARCHITECTURE.md §4.

import {
  IN_BOMB, SCORE, STATUS, HITBOX_UNITS,
  HITBOX_REDUCED_UNITS, START_BOMBS, START_RADIUS, RESPAWN_DELAY_TICKS,
  FIRE_TICKS, FIRE_LETHAL_TICKS, SHIELD_GRACE_TICKS,
} from '../constants.js';
import { expireStatuses, has, toTile } from './state.js';
import { stepAll } from './movement.js';
import { place, detonate, expireFires } from './bombs.js';
import { collect, scatterOnDeath } from './perks.js';
import { regenerate, expirePuddles } from './blocks.js';
import { burns } from './fire.js';
import { spread as spreadStatuses, daze } from './statuses.js';
import { gulls } from './gulls.js';

export function tick(state, inputs, { onRespawn } = {}) {
  // 1. statuses expire before anything reads them
  for (const p of state.players) if (p) expireStatuses(state, p);

  // 2. movement
  stepAll(state, inputs);

  // 2b. anybody a slide went through, while the overlap that proves it still exists. Before the
  // bombs, so a pirate knocked silly this tick cannot place one on the way down.
  daze(state);

  // 3. bombs placed, ascending seat so a tie on one tile is resolved the same way everywhere
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p) place(state, p, inputs[i] | 0);
  }

  // 4 & 5. fuses and chains, resolved together in one tick
  detonate(state);

  // 6. fire damage: blocks were already hit inside detonate, players die here
  killInFire(state);

  // 6b. gulls overhead, and any that dived into this tick's fire. After the fire and before the
  // pickups, so a coin knocked out of one lands on a floor everyone is about to check.
  gulls(state);

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

    /* One shield per blast, and never two in one instant. See SHIELD_GRACE_TICKS.
     *
     * Two mechanisms, and they answer two different questions. `hitBy` is MEMORY: it holds the
     * blasts you have already paid for, so a single explosion cannot charge you once per tick for
     * the ten ticks it burns. `shieldGrace` is a TIMER: once a shield has absorbed something, the
     * next six tenths of a second cannot take the next one, however many bombs arrive in it.
     *
     * Without the timer a chain reaction stripped both shields in the same frame, which is the
     * thing the second shield exists to prevent. With it, surviving a crossfire costs exactly one
     * shield and the second is still there for the next mistake — and because the grace outlasts
     * a blast's lethal window, the explosion that triggered it can never come back for more. */
    if (p.shieldGrace && state.tick < p.shieldGrace) continue;
    const live = new Set(fresh.map(f => f.src));
    p.hitBy = (p.hitBy || []).filter(src => live.has(src));
    const inBox = f =>
      f.tx >= (p.x - half) >> 8 && f.tx <= (p.x + half - 1) >> 8 &&
      f.ty >= (p.y - half) >> 8 && f.ty <= (p.y + half - 1) >> 8;
    // One entry per blast reaching you this tick that you have not already paid for — the blast
    // on your centre tile first, because that is who the kill goes to (RULES.md §3).
    const ctx = toTile(p.x), cty = toTile(p.y);
    const ordered = [...lethal.filter(f => f.tx === ctx && f.ty === cty), ...lethal];
    const newHits = [];
    for (const f of ordered) {
      if (!inBox(f) || p.hitBy.includes(f.src) || newHits.some(g => g.src === f.src)) continue;
      newHits.push(f);
    }
    if (!newHits.length) continue;

    /* The first new hit decides everything: a shield eats it, or it kills.
     *
     * Not a loop over every blast any more. Spending one shield opens the grace window, and the
     * grace window is precisely the statement that nothing else lands until it closes — so
     * charging the rest of this tick's blasts against the remaining shields would contradict it.
     * The blasts that are being shrugged off still go into `hitBy`, or they would each be a fresh
     * hit again the moment the grace expires, which would spend the second shield on an
     * explosion that finished burning half a second ago.
     */
    const first = newHits[0];
    let fatal = null;
    if (p.shields > 0) {
      p.shields--;
      p.shieldGrace = state.tick + SHIELD_GRACE_TICKS;
      for (const f of newHits) p.hitBy.push(f.src);
      state.events.push({ e: 'shield', tick: state.tick, i: p.i, left: p.shields });
    } else {
      fatal = first;
    }
    if (!fatal) continue;

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
    //
    // With shields in play the answer is narrower still: the blast that got past them. Shields
    // spent on earlier blasts this tick do not hand those blasts the kill. `newHits` is already
    // in that order — centre tile first, then the rest as `detonate` pushed them.
    const killer = fatal.owner;
    p.hitBy = [];

    scatterOnDeath(state, p);

    p.alive = false;
    p.deaths++;
    p.shieldGrace = 0;
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

