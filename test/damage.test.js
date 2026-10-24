// Every blast is its own hit, and no hit waits for an earlier one to finish. See killInFire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRE_TICKS, BLOCK } from '../shared/constants.js';
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

test('two blasts in the same tick cost two shields', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5); blast(102, 6);
  step();
  assert.equal(p.alive, true);
  assert.equal(p.shields, 0);
});

test('a second blast while the first is still burning still lands, and the first never lands twice', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5);
  step();
  assert.equal(p.shields, 1, 'the first blast did not cost a shield');
  step(); step();
  assert.equal(p.shields, 1, 'one blast charged a shield twice');
  blast(102, 6);
  step();
  assert.equal(p.shields, 0, 'the second blast was swallowed by the first');
  assert.equal(p.alive, true);
});

test('more blasts than shields is a death, credited to the blast that got through', () => {
  const { s, p, blast, step } = arena({ shields: 1 });
  blast(101, 5); blast(102, 6);
  step();
  assert.equal(p.alive, false);
  const died = s.events.find(e => e.e === 'died');
  assert.equal(died.by, 6);
});
