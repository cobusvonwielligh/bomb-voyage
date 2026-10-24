// The slide, and what it does to whoever is in the way.
//
// Three properties are worth defending with a test, because all three are things a later tuning
// pass could quietly break: a slide must cost real stamina, it must be a commitment rather than a
// faster walk, and barging through somebody must take their bombs away for a moment — which is the
// only reason to use it on a person rather than on a corridor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IN_RIGHT, IN_LEFT, IN_SLIDE, IN_BOMB, UNITS_PER_TILE, BLOCK, STATUS,
  SLIDE_STAMINA_COST, SLIDE_COOLDOWN_TICKS, STAMINA_MAX, DIR_R,
} from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { createState, createPlayer, tileCentre, tileAt, has } from '../shared/sim/state.js';
import { step, speedOf } from '../shared/sim/movement.js';
import { tick } from '../shared/sim/round.js';

/** A player on a floor tile with clear ground to the right, on an empty map. */
function arena() {
  const s = createState(MAPS[0]);
  // A clear horizontal run: three floor tiles in a row, so a slide has somewhere to go.
  let at = null;
  for (let ty = 1; ty < s.map.h - 1 && !at; ty++) {
    for (let tx = 1; tx < s.map.w - 4; tx++) {
      const clear = [0, 1, 2, 3].every(d => tileAt(s.map, tx + d, ty) === BLOCK.FLOOR);
      if (clear) { at = { tx, ty }; break; }
    }
  }
  assert.ok(at, 'no clear run of floor on this map');
  const p = createPlayer(0, 'you');
  p.alive = true;
  p.x = tileCentre(at.tx); p.y = tileCentre(at.ty);
  p.dir = DIR_R;
  s.players[0] = p;
  return { s, p, at };
}

test('a double-tap costs stamina up front and covers more ground than running', () => {
  const { s, p } = arena();
  const start = p.x;

  step(s, p, IN_RIGHT | IN_SLIDE);
  assert.equal(p.stamina, STAMINA_MAX - SLIDE_STAMINA_COST, 'the slide was not paid for');
  assert.ok(p.slideV > speedOf(p), 'the launch was no faster than a walk');

  // Let it run itself out. The keys are released on purpose: a slide steers nothing.
  let ticks = 1;
  while (p.slideV > 0 && ticks < 60) { step(s, p, 0); ticks++; }
  const slid = p.x - start;

  // The same number of ticks spent running, from the same spot, for the comparison that matters:
  // a slide has to be worth more than the ticks it occupies, or it is a stamina cost for nothing.
  const walker = arena();
  for (let i = 0; i < ticks; i++) step(walker.s, walker.p, IN_RIGHT);
  const walked = walker.p.x - walker.at.tx * UNITS_PER_TILE - (UNITS_PER_TILE >> 1);

  assert.ok(slid > walked * 1.5,
    `a slide covered ${slid} units against ${walked} walking the same ${ticks} ticks`);
  assert.ok(ticks < 30, `the slide ran for ${ticks} ticks — that is a vehicle, not a slide`);
});

test('it cannot be chained, and cannot be bought without the wind for it', () => {
  const { s, p } = arena();
  step(s, p, IN_RIGHT | IN_SLIDE);
  while (p.slideV > 0) step(s, p, 0);
  assert.ok(p.slideCool > 0, 'no cooldown after a slide');

  const before = p.stamina;
  step(s, p, IN_RIGHT | IN_SLIDE);
  assert.equal(p.slideV, 0, 'a slide was chained straight out of the last one');
  assert.equal(p.stamina > before - SLIDE_STAMINA_COST, true, 'a refused slide still charged for it');

  // Run the cooldown off, then empty the tank: still refused, for a different reason.
  for (let i = 0; i < SLIDE_COOLDOWN_TICKS + 1; i++) step(s, p, 0);
  p.stamina = SLIDE_STAMINA_COST - 1;
  step(s, p, IN_RIGHT | IN_SLIDE);
  assert.equal(p.slideV, 0, 'a slide was launched on stamina that was not there');
});

test('a slide stops at a wall rather than carrying its momentum into it', () => {
  const s = createState(MAPS[0]);
  // Find a floor tile with solid ground immediately to its right.
  let at = null;
  for (let ty = 1; ty < s.map.h - 1 && !at; ty++) {
    for (let tx = 1; tx < s.map.w - 2; tx++) {
      if (tileAt(s.map, tx, ty) === BLOCK.FLOOR && tileAt(s.map, tx + 1, ty) === BLOCK.IRON) {
        at = { tx, ty }; break;
      }
    }
  }
  if (!at) return;                     // no such pair on this map: nothing to assert
  const p = createPlayer(0, 'you');
  p.alive = true;
  p.x = tileCentre(at.tx); p.y = tileCentre(at.ty); p.dir = DIR_R;
  s.players[0] = p;

  step(s, p, IN_RIGHT | IN_SLIDE);
  for (let i = 0; i < 4; i++) step(s, p, 0);
  assert.equal(p.slideV, 0, 'the slide kept its velocity while pressed against stone');
});

test('sliding through somebody leaves them confused, slower, and unable to bomb', () => {
  const { s, p, at } = arena();
  // A victim standing one tile to the right, in the slide's path.
  const victim = createPlayer(1, 'them');
  victim.alive = true;
  victim.x = tileCentre(at.tx + 1);
  victim.y = tileCentre(at.ty);
  s.players[1] = victim;
  const theirPace = speedOf(victim);

  const inputs = new Array(16).fill(0);
  inputs[0] = IN_RIGHT | IN_SLIDE;
  // A few ticks, because the victim is a tile away: the slide has to reach them first, and the
  // tick it arrives is the tick the overlap exists.
  for (let i = 0; i < 8 && !has(victim, STATUS.CONFUSED); i++) {
    tick(s, inputs);
    inputs[0] = 0;                     // the slide carries on by itself
  }

  assert.ok(has(victim, STATUS.CONFUSED), 'the slide went straight through without a mark');
  assert.ok(speedOf(victim) < theirPace, 'a confused player is no slower');

  // Now they try to answer with a bomb. A fresh PRESS, because placement is edge-triggered —
  // holding the key through the barge would have placed one before the slide ever arrived.
  const bombing = new Array(16).fill(0);
  bombing[1] = IN_BOMB;
  tick(s, bombing);
  assert.equal(s.bombs.length, 0, 'a confused player still placed a bomb');

  // And it wears off: the status has a short timer and nothing renews it.
  const empty = new Array(16).fill(0);
  for (let i = 0; i < 60; i++) tick(s, empty);
  assert.equal(has(victim, STATUS.CONFUSED), false, 'the confusion never wore off');
});

test('the slider keeps their own hands full: no bomb mid-slide', () => {
  const { s, p } = arena();
  const inputs = new Array(16).fill(0);
  inputs[0] = IN_RIGHT | IN_SLIDE | IN_BOMB;
  tick(s, inputs);
  assert.equal(s.bombs.length, 0, 'a bomb was dropped from inside a slide');
});

test('a slide is deterministic: the same state and mask twice gives the same answer', () => {
  // The client replays this exact function over the server's state (see reconcile in world.js),
  // so a slide that depended on anything but (state, player, mask) would rubber-band every time.
  const a = arena();
  const b = arena();
  for (let i = 0; i < 20; i++) {
    const mask = i === 0 ? IN_LEFT | IN_SLIDE : 0;
    step(a.s, a.p, mask);
    step(b.s, b.p, mask);
    assert.equal(a.p.x, b.p.x);
    assert.equal(a.p.slideV, b.p.slideV);
  }
});
