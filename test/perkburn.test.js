// Fire destroys dropped perks.
//
// Without it a perk sitting in a blast is immune, which makes the tile it is on the safest square
// on the map and turns every contested drop into a standoff nobody can break.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, tileCentre } from '../shared/sim/state.js';
import { burnPerks, collect } from '../shared/sim/perks.js';
import { PERK, FIRE_TICKS, HITBOX_UNITS } from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';

const world = () => createState(MAPS[0]);
const perk = (s, tx, ty, type = PERK.FIRE) => {
  const k = { id: s.nextPerkId++, tx, ty, type, until: s.tick + 10_000 };
  s.perks.push(k);
  return k;
};
const fire = (s, tx, ty) => s.fires.push({ tx, ty, kind: 'core', rot: 0, until: s.tick + FIRE_TICKS, owner: 0 });

test('a perk in the fire is destroyed, and says so', () => {
  const s = world();
  perk(s, 5, 5);
  fire(s, 5, 5);
  burnPerks(s);
  assert.equal(s.perks.length, 0);
  assert.equal(s.events.filter(e => e.e === 'perkburn').length, 1);
});

test('a perk one tile away survives', () => {
  const s = world();
  perk(s, 5, 5);
  fire(s, 6, 5);
  burnPerks(s);
  assert.equal(s.perks.length, 1);
});

test('fire that has already burned out destroys nothing', () => {
  const s = world();
  perk(s, 5, 5);
  s.fires.push({ tx: 5, ty: 5, kind: 'core', rot: 0, until: s.tick, owner: 0 });
  burnPerks(s);
  assert.equal(s.perks.length, 1, 'a dead fire still took the perk');
});

test('getting there first beats the fire', () => {
  // round.js runs collect() before burnPerks() on purpose: reaching a perk on the tick it burns
  // should count, because the alternative punishes the player who took the risk.
  const s = world();
  const p = createPlayer(0, 'a');
  p.x = tileCentre(5); p.y = tileCentre(5); p.alive = true;
  s.players[0] = p;
  const before = p.radius;
  perk(s, 5, 5, PERK.FIRE);
  fire(s, 5, 5);

  collect(s);
  burnPerks(s);

  assert.equal(s.perks.length, 0);
  assert.ok(p.radius > before, 'the player was standing on it and did not get it');
  assert.equal(s.events.filter(e => e.e === 'perkget').length, 1);
  assert.equal(s.events.filter(e => e.e === 'perkburn').length, 0, 'burned a perk already taken');
});

test('does nothing, cheaply, when there is no fire or no perks', () => {
  const s = world();
  perk(s, 5, 5);
  burnPerks(s);
  assert.equal(s.perks.length, 1);

  const t = world();
  fire(t, 5, 5);
  burnPerks(t);
  assert.equal(t.perks.length, 0);
  assert.equal(t.events.length, 0);
});

test('one blast clears every perk it covers', () => {
  const s = world();
  for (let x = 3; x <= 7; x++) perk(s, x, 5);
  for (let x = 4; x <= 6; x++) fire(s, x, 5);
  burnPerks(s);
  assert.deepEqual(s.perks.map(k => k.tx), [3, 7]);
  assert.ok(HITBOX_UNITS > 0);
});
