// A player must always be able to move. These are the ways they used to end up unable to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, tileCentre, setTile } from '../shared/sim/state.js';
import { step, blocked, unstick } from '../shared/sim/movement.js';
import { tick } from '../shared/sim/round.js';
import { BLOCK, BLOCK_HP, IN_RIGHT, IN_BOMB, FUSE_TICKS } from '../shared/constants.js';

// A hand-authored empty room. The generated maps put an indestructible pillar on every even/even
// tile, so a clear 3x3 does not exist on any of them by construction — and these tests need room
// to move in every direction without a pillar deciding the answer for them.
const ROOM = {
  id: 'room', name: 'Test Room', w: 9, h: 9, seed: 1,
  rows: [
    '#########',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########',
  ],
};

/** A player standing in the middle of the empty room. */
const world = () => ({ s: createState(ROOM), tx: 4, ty: 4 });

const seat = (s, i, tx, ty) => {
  const p = createPlayer(i, `p${i}`);
  p.x = tileCentre(tx); p.y = tileCentre(ty); p.alive = true;
  s.players[i] = p;
  return p;
};

test('a wall growing on top of you does not entomb you', () => {
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);

  setTile(s.map, tx, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  assert.ok(blocked(s, p, p.x, p.y), 'setup failed: the player should be inside a wall');

  assert.equal(unstick(s, p), true, 'unstick should report that it intervened');

  // It slides rather than teleporting, so freedom takes a few ticks — but a bounded few. One
  // tile at a quarter tile a tick is four; ten is generous and still catches a stall.
  let ticks = 1;
  while (blocked(s, p, p.x, p.y) && ticks < 10) { unstick(s, p); ticks++; }
  assert.ok(!blocked(s, p, p.x, p.y), `still inside a wall after ${ticks} ticks`);
  assert.ok(ticks > 1, 'it teleported — the whole point is that it slides');

  // And it is a neighbour, not a jump across the map.
  assert.ok(Math.abs((p.x >> 8) - tx) <= 1 && Math.abs((p.y >> 8) - ty) <= 1);
});

test('unstick is a no-op from a legal position', () => {
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  const before = { x: p.x, y: p.y };
  assert.equal(unstick(s, p), false);
  assert.deepEqual({ x: p.x, y: p.y }, before, 'it moved somebody who was perfectly fine');
});

test('both machines unstick the same way', () => {
  // The client predicts movement with this exact function. If the escape were not deterministic,
  // reconciliation would fight it every tick for as long as the player was stuck.
  const a = world(), b = world();
  const pa = seat(a.s, 0, a.tx, a.ty), pb = seat(b.s, 0, b.tx, b.ty);
  setTile(a.s.map, a.tx, a.ty, BLOCK.SOFT, 1);
  setTile(b.s.map, b.tx, b.ty, BLOCK.SOFT, 1);
  for (let i = 0; i < 6; i++) { unstick(a.s, pa); unstick(b.s, pb); }
  assert.deepEqual({ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y });
});

test('a bomb dropped on you is not an unavoidable kill', () => {
  // Two players on one tile. One drops a bomb and walks off; the other used to find every
  // direction blocked — the bomb was solid to them immediately, with no grace for already being
  // inside it — and burned to death with no counterplay for the whole 72-tick fuse.
  const { s, tx, ty } = world();
  const victim = seat(s, 0, tx, ty);
  seat(s, 1, tx, ty);

  const inputs = new Array(16).fill(0);
  inputs[1] = IN_BOMB;
  tick(s, inputs);
  assert.equal(s.bombs.length, 1, 'setup failed: no bomb was placed');

  inputs[1] = 0;
  inputs[0] = IN_RIGHT;
  const startX = victim.x;
  for (let i = 0; i < FUSE_TICKS - 1; i++) tick(s, inputs);

  assert.ok(victim.x > startX + 256, `victim only moved ${victim.x - startX} units — still trapped`);
  assert.equal(victim.alive, true, 'victim died to a bomb they could not escape');
});

test('step() unsticks before it reads the position', () => {
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  setTile(s.map, tx, ty, BLOCK.SOFT, 1);
  for (let i = 0; i < 8; i++) step(s, p, IN_RIGHT);
  assert.ok(!blocked(s, p, p.x, p.y));
});
