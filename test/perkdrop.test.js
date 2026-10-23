// Perks are fireproof, and the drop rate answers to the board.
//
// The two are related: once a blast can no longer eat a drop, the only thing stopping the floor
// filling up with perks is the rate itself, so the rate has to actually respond.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick as stepRound } from '../shared/sim/round.js';
import { createState } from '../shared/sim/state.js';
import { dropChance, perkTarget, collect, drop } from '../shared/sim/perks.js';
import * as perks from '../shared/sim/perks.js';
import {
  PERK, PERK_DROP_CHANCE_SOFT, PERK_GLUT_FLOOR, PERK_SCARCE_BOOST, PERK_TARGET_MIN,
  HITBOX_UNITS, TICK_HZ, PERK_EXPIRE_TICKS, PERK_FADE_TICKS,
} from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';

const fresh = () => createState(MAPS[0], 99);

test('nothing burns perks any more', () => {
  // The whole mechanic is gone, not merely disabled: a dormant burnPerks sitting in the module
  // is one import away from coming back.
  assert.equal(perks.burnPerks, undefined, 'burnPerks is still exported');
});

test('a perk sitting in a blast survives it', () => {
  const s = fresh();
  s.perks.push({ id: 1, tx: 5, ty: 5, type: PERK.FIRE, until: s.tick + 10_000 });
  s.fires.push({ tx: 5, ty: 5, until: s.tick + 30 });
  for (let n = 0; n < 5; n++) stepRound(s, []);
  assert.equal(s.perks.length, 1, 'the fire ate the perk');
});

test('an empty floor drops far more often than a full one', () => {
  const s = fresh();
  const bare = dropChance(s);
  assert.ok(bare > PERK_DROP_CHANCE_SOFT,
    `an empty board should beat the base rate, got ${bare} vs ${PERK_DROP_CHANCE_SOFT}`);

  // Past target. The target floors at PERK_TARGET_MIN with nobody alive.
  assert.equal(perkTarget(s), PERK_TARGET_MIN);
  for (let i = 0; i < PERK_TARGET_MIN + 2; i++) {
    s.perks.push({ id: i + 1, tx: i, ty: 1, type: PERK.BOMB, until: s.tick + 10_000 });
  }
  const glut = dropChance(s);
  assert.ok(glut < bare, 'a full board should drop less than an empty one');
  assert.ok(glut <= PERK_DROP_CHANCE_SOFT * PERK_GLUT_FLOOR * 1.81,
    `a glutted board is still dropping at ${glut}`);
  assert.ok(bare <= PERK_DROP_CHANCE_SOFT * PERK_SCARCE_BOOST * 1.81,
    'the boost has exceeded supply x demand');
});

test('the target scales with players alive, so sixteen people see more perks than three', () => {
  const s = fresh();
  const mk = i => ({ i, alive: true, x: 0, y: 0, bombs: 1, radius: 1, speed: 0, shields: 0, score: 0 });
  s.players = Array.from({ length: 3 }, (_, i) => mk(i));
  const few = perkTarget(s);
  s.players = Array.from({ length: 16 }, (_, i) => mk(i));
  assert.ok(perkTarget(s) > few, 'the target ignored the extra thirteen players');
});

test('picking perks up lifts the rate, and it decays back down', () => {
  const s = fresh();
  const quiet = dropChance(s);

  // One player standing on four perks in turn.
  const p = { i: 0, alive: true, x: HITBOX_UNITS, y: HITBOX_UNITS, bombs: 1, radius: 1, speed: 0, shields: 0, score: 0 };
  s.players = [p];
  const tx = p.x >> 8, ty = p.y >> 8;
  for (let n = 0; n < 4; n++) {
    s.perks.length = 0;
    drop(s, tx, ty, PERK.BOMB);
    collect(s);
  }
  assert.equal(s.perks.length, 0, 'the perks were not actually collected');
  const busy = dropChance(s);
  assert.ok(busy > quiet, `demand did not lift the rate: ${busy} vs ${quiet}`);

  // A minute of nobody taking anything puts it back to within a percent of the quiet rate.
  for (let n = 0; n < 60 * TICK_HZ; n++) collect(s);
  assert.ok(Math.abs(dropChance(s) - quiet) / quiet < 0.01,
    `the take rate never decayed back, still ${dropChance(s)} against ${quiet}`);
});

test('the rate decays even while the floor is bare', () => {
  // collect() returns early with no perks on the board. If the decay sat after that return, a
  // board stripped clean would keep its demand boost forever.
  const s = fresh();
  s.perkTakeRate = 10;
  for (let n = 0; n < 8 * TICK_HZ; n++) collect(s);
  assert.ok(s.perkTakeRate < 5.1, `rate stuck at ${s.perkTakeRate} with an empty floor`);
});

test('the wire carries `until`, which is what the fade is drawn from', () => {
  // render.js fades a perk over its last PERK_FADE_TICKS. That is only possible because the
  // whole perk object goes out in the snapshot; trimming it to {id,tx,ty,type} to save bytes
  // would silently turn the fade off rather than break anything loudly.
  const s = fresh();
  drop(s, 4, 4, PERK.FIRE);
  const [k] = s.perks;
  assert.ok(Number.isFinite(k.until), 'a dropped perk has no expiry');
  assert.equal(k.until, s.tick + PERK_EXPIRE_TICKS);
  assert.ok(PERK_FADE_TICKS < PERK_EXPIRE_TICKS, 'a perk would be fading from the moment it lands');
});
