// Ice, and the puddle it melts into: rare, five tiles at most, gone in seconds, and slow and
// slippery while it lasts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, tileCentre, setTile, tileAt } from '../shared/sim/state.js';
import { detonate } from '../shared/sim/bombs.js';
import { expirePuddles } from '../shared/sim/blocks.js';
import { step, speedOf, inPuddle } from '../shared/sim/movement.js';
import { MAPS, buildMap, cellType } from '../shared/maps.js';
import {
  BLOCK, BLOCK_HP, ICE_CHANCE, PUDDLE_TICKS, PUDDLE_SLIDE_TICKS, IN_RIGHT, DIR_R,
} from '../shared/constants.js';

const ROOM = {
  id: 'room', name: 'Ice Room', w: 15, h: 9, seed: 5,
  rows: [
    '###############',
    '#.............#',
    '#.............#',
    '#.............#',
    '#.............#',
    '#.............#',
    '#.............#',
    '#.............#',
    '###############',
  ],
};

const meltAt = (s, tx, ty) => {
  setTile(s.map, tx, ty, BLOCK.ICE, BLOCK_HP[BLOCK.ICE]);
  s.bombs.push({ id: s.nextBombId++, tx: tx - 2, ty, owner: 0, radius: 3, at: s.tick });
  detonate(s);
};

test('ice is about one soft wall in twenty', () => {
  let ice = 0, soft = 0;
  for (const def of MAPS) {
    const m = buildMap(def);
    for (const c of m.cells) {
      const t = cellType(c);
      if (t === BLOCK.ICE) ice++;
      if (t === BLOCK.SOFT) soft++;
    }
  }
  const share = ice / (ice + soft);
  assert.ok(ice > 0, 'no map has any ice');
  assert.ok(Math.abs(share - ICE_CHANCE) < 0.03, `ice is ${(share * 100).toFixed(1)}% of soft walls`);
});

test('a blast melts ice into a plus of water, five tiles at most', () => {
  const s = createState(ROOM);
  meltAt(s, 6, 4);

  assert.equal(tileAt(s.map, 6, 4), BLOCK.FLOOR, 'the ice is still standing');
  const wet = s.puddles.map(q => `${q.tx},${q.ty}`).sort();
  assert.deepEqual(wet, ['5,4', '6,3', '6,4', '6,5', '7,4'].sort());
  assert.ok(s.events.some(e => e.e === 'melt' && e.x === 6 && e.y === 4), 'no melt event');
  assert.equal(s.perks.length, 0, 'ice dropped a perk; the water is the drop');
});

test('water never lands on a wall', () => {
  const s = createState(ROOM);
  setTile(s.map, 6, 3, BLOCK.SOFT, 1);
  setTile(s.map, 7, 4, BLOCK.IRON, 0);
  meltAt(s, 6, 4);
  const wet = s.puddles.map(q => `${q.tx},${q.ty}`).sort();
  assert.deepEqual(wet, ['5,4', '6,4', '6,5'].sort());
});

test('puddles dry up after PUDDLE_TICKS', () => {
  const s = createState(ROOM);
  meltAt(s, 6, 4);
  s.tick += PUDDLE_TICKS - 1;
  expirePuddles(s);
  assert.equal(s.puddles.length, 5, 'dried early');
  s.tick += 1;
  expirePuddles(s);
  assert.equal(s.puddles.length, 0, 'still wet');
});

test('water halves your pace', () => {
  const dry = createState(ROOM), wet = createState(ROOM);
  meltAt(wet, 6, 4);
  for (const s of [dry, wet]) {
    const p = createPlayer(0, 'a');
    p.alive = true; p.x = tileCentre(6); p.y = tileCentre(4);
    s.players[0] = p;
    step(s, p, IN_RIGHT);
  }
  const moved = s => s.players[0].x - tileCentre(6);
  assert.ok(inPuddle(wet, wet.players[0]), 'the test player is not in the water');
  assert.equal(moved(wet), (speedOf(wet.players[0]) / 2) | 0);
  assert.equal(moved(dry), speedOf(dry.players[0]));
});

test('let go on water and you slide, then stop', () => {
  const s = createState(ROOM);
  // A long puddle, so the slide runs out before the water does.
  for (const x of [4, 6, 8, 10]) meltAt(s, x, 4);
  const p = createPlayer(0, 'a');
  p.alive = true; p.x = tileCentre(5); p.y = tileCentre(4);
  s.players[0] = p;

  step(s, p, IN_RIGHT);
  assert.equal(p.dir, DIR_R);
  let slid = 0;
  for (let i = 0; i < PUDDLE_SLIDE_TICKS + 4; i++) {
    const before = p.x;
    step(s, p, 0);
    if (p.x !== before) slid++;
  }
  assert.equal(slid, PUDDLE_SLIDE_TICKS, `slid for ${slid} ticks`);
});

test('dry floor does not slide', () => {
  const s = createState(ROOM);
  const p = createPlayer(0, 'a');
  p.alive = true; p.x = tileCentre(5); p.y = tileCentre(4);
  s.players[0] = p;
  step(s, p, IN_RIGHT);
  const at = p.x;
  step(s, p, 0);
  assert.equal(p.x, at);
});
