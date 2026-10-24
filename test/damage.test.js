// One shield per blast, and never two in one instant. See killInFire and SHIELD_GRACE_TICKS.
//
// The rule these tests used to assert was the opposite — two blasts on one tick cost two shields —
// and it was changed on purpose: a chain reaction is one event to the player, and a second shield
// that can be lost in the same frame as the first is not a second chance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRE_TICKS, SHIELD_GRACE_TICKS, BLOCK } from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { createState, createPlayer, tileCentre, tileAt } from '../shared/sim/state.js';
import { tick } from '../shared/sim/round.js';

function arena({ shields }) {
  const s = createState(MAPS[0]);
  let at = null;
  for (let ty = 1; ty < s.map.h - 1 && !at; ty++) {
    for (let tx = 1; tx < s.map.w - 1; tx++) if (tileAt(s.map, tx, ty) === BLOCK.FLOOR) { at = { tx, ty }; break; }
  }
  const p = createPlayer(0, 'you');
  p.alive = true; p.x = tileCentre(at.tx); p.y = tileCentre(at.ty); p.shields = shields;
  s.players[0] = p;
  for (const n of [5, 6]) { const q = createPlayer(n, `p${n}`); s.players[n] = q; }
  const blast = (src, owner) =>
    s.fires.push({ tx: at.tx, ty: at.ty, kind: 'arm', rot: 0, until: s.tick + FIRE_TICKS, owner, src });
  const step = () => tick(s, new Array(16).fill(0));
  return { s, p, blast, step };
}

test('two blasts in the same tick cost ONE shield, not both', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5); blast(102, 6);
  step();
  assert.equal(p.alive, true);
  assert.equal(p.shields, 1, 'a crossfire took both shields at once');
});

test('a crossfire cannot take the second shield once the grace runs out either', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5); blast(102, 6);
  step();
  // Both blasts are already paid for, so the far side of the grace window must not re-charge
  // for fire that has been burning the whole time.
  for (let i = 0; i < SHIELD_GRACE_TICKS + 4; i++) step();
  assert.equal(p.shields, 1, 'the same two blasts came back for the second shield');
  assert.equal(p.alive, true);
});

test('a blast after the grace does take the next shield', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5);
  step();
  assert.equal(p.shields, 1, 'the first blast did not cost a shield');

  // Inside the window: nothing lands, whatever arrives.
  blast(102, 6);
  step();
  assert.equal(p.shields, 1, 'a blast inside the grace window took a shield');

  for (let i = 0; i < SHIELD_GRACE_TICKS; i++) step();
  blast(103, 6);
  step();
  assert.equal(p.shields, 0, 'a blast after the grace was swallowed');
  assert.equal(p.alive, true);
});

test('one blast never charges a shield twice', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5);
  for (let i = 0; i < SHIELD_GRACE_TICKS + 4; i++) step();
  assert.equal(p.shields, 1, 'one blast charged a shield twice');
});

test('no shields left is a death, credited to the blast on the tile', () => {
  const { s, p, blast, step } = arena({ shields: 0 });
  blast(101, 5); blast(102, 6);
  step();
  assert.equal(p.alive, false);
  const died = s.events.find(e => e.e === 'died');
  assert.equal(died.by, 5, 'the kill went to the wrong blast');
});

test('the shield that saved you does not also save you from the next bomb', () => {
  const { p, blast, step } = arena({ shields: 1 });
  blast(101, 5);
  step();
  assert.equal(p.shields, 0);
  for (let i = 0; i < SHIELD_GRACE_TICKS; i++) step();
  blast(102, 6);
  step();
  assert.equal(p.alive, false, 'the grace outlived the shield that bought it');
});
