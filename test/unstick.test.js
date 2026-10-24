// A player must always be able to move. These are the ways they used to end up unable to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, tileCentre, setTile } from '../shared/sim/state.js';
import { step, blocked, unstick, speedOf } from '../shared/sim/movement.js';
import { place } from '../shared/sim/bombs.js';
import { tick } from '../shared/sim/round.js';
import {
  BLOCK, BLOCK_HP, IN_RIGHT, IN_DOWN, IN_BOMB, FUSE_TICKS, DIR_R, DIR_D,
} from '../shared/constants.js';

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

  // It drifts rather than teleporting, so freedom takes a while — but a bounded while. A
  // twelfth of walking pace clears a whole tile in about 111 ticks, or 3.7 s, and that is the
  // worst case: being fully entombed. Stepping off your own bomb is a sliver of that. 250 is
  // generous and still catches a stall.
  let ticks = 1;
  while (blocked(s, p, p.x, p.y) && ticks < 250) { unstick(s, p); ticks++; }
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
  for (let i = 0; i < 25; i++) { unstick(a.s, pa); unstick(b.s, pb); }
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
  for (let i = 0; i < 30; i++) step(s, p, IN_RIGHT);
  assert.ok(!blocked(s, p, p.x, p.y));
});

test('lane centring is imperceptible, and corner assist is not', () => {
  /* Two jobs, two rates, and conflating them was the bug.
   *
   * Corridor centring happens while you walk along unobstructed and nothing asked for it, so it
   * has to be invisible — a unit a tick. Corner assist happens when you are pushing into a gap
   * the game is refusing you, where every tick is a tick of standing still against a doorway you
   * can see you fit through. That one has to be immediate.
   */
  const { s } = world();
  const p = seat(s, 0, 2, 4);
  p.speed = 4;                                   // fully booted: the worst case
  // A corridor, so centring fires at all, with an offset small enough that the hitbox stays
  // clear of the walls — otherwise this measures the assist instead.
  for (let x = 1; x <= 7; x++) {
    setTile(s.map, x, 3, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    setTile(s.map, x, 5, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  }
  p.y = tileCentre(4) + 24;

  const offsets = [];
  for (let n = 0; n < 40; n++) {
    step(s, p, IN_RIGHT);
    offsets.push(Math.abs((((p.y % 256) + 256) % 256) - 128));
  }
  const steps = offsets.slice(0, -1).map((o, i) => o - offsets[i + 1]).filter(d => d > 0);
  assert.ok(steps.length, 'centring never fired');
  const biggest = Math.max(...steps);
  // 2 rather than 1: the very last step rounds off whatever fraction of a unit is left.
  assert.ok(biggest <= 2, `gentle centring moved ${biggest} units in one tick`);
  assert.ok(biggest < speedOf(p), 'sideways drift outran walking');

  // And the assist: pressed into the jamb, it must clear a near-miss in a handful of ticks.
  const { s: s2 } = world();
  const q = seat(s2, 0, 2, 4);
  for (let x = 1; x <= 7; x++) {
    if (x !== 4) { setTile(s2.map, x, 3, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]); }
    setTile(s2.map, x, 5, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  }
  setTile(s2.map, 3, 4, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);   // something to be refused by
  q.y = tileCentre(4) + 100;
  let ticks = 0;
  while (Math.abs((((q.y % 256) + 256) % 256) - 128) > 0 && ticks < 200) { step(s2, q, IN_RIGHT); ticks++; }
  assert.ok(ticks <= 40, `corner assist took ${ticks} ticks to line up — that is a stuck player`);
});


test('walking off your own bomb never pushes you', () => {
  /* The commonest action in the game, and it used to shove you a third of a tile.
   *
   * A bomb became solid the instant your CENTRE left its tile, which left eighty units of
   * hitbox suddenly inside a solid square for `unstick` to push back out. Testing the hitbox
   * instead means it becomes solid exactly when you are clear of it, so there is nothing to
   * push and the unstick never runs.
   */
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  // Facing a wall, so the bomb lands underneath — which is the case this test is about.
  setTile(s.map, tx + 1, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  p.dir = DIR_R;
  place(s, p, IN_BOMB);
  assert.deepEqual([s.bombs[0]?.tx, s.bombs[0]?.ty], [tx, ty], 'setup failed: bomb not underfoot');

  const pace = speedOf(p);
  let biggest = 0;
  for (let n = 0; n < 60; n++) {
    const before = p.x;
    step(s, p, IN_RIGHT);
    biggest = Math.max(biggest, p.x - before);
    assert.ok(!blocked(s, p, p.x, p.y), `ended up inside something on tick ${n}`);
  }
  assert.ok(biggest <= pace, `moved ${biggest} units in a tick against a walking pace of ${pace}`);
  assert.ok(p.x > tileCentre(tx), 'did not actually walk away');
});

test('a bomb is still solid once you are clear of it', () => {
  // The other half: it has to become a wall, or you could walk back onto your own bomb and
  // stand on it indefinitely.
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  p.dir = DIR_D;
  place(s, p, IN_BOMB);                      // lands on the tile below
  assert.deepEqual([s.bombs[0]?.tx, s.bombs[0]?.ty], [tx, ty + 1]);
  for (let n = 0; n < 60; n++) step(s, p, IN_DOWN);
  assert.ok((p.y >> 8) === ty, 'walked onto a bomb it should have been stopped by');
});

test('standing on a bomb is never a shove, and standing in a wall always is', () => {
  // A bomb you are squarely on top of must not push you anywhere: you can walk off it, and
  // being moved when you were perfectly capable of moving yourself is the complaint this whole
  // area exists to answer. A wall grown on top of you is the opposite — inescapable without
  // help — and still gets the full seatbelt.
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  setTile(s.map, tx + 1, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  p.dir = DIR_R;
  place(s, p, IN_BOMB);                      // falls back to the tile underfoot
  assert.deepEqual([s.bombs[0]?.tx, s.bombs[0]?.ty], [tx, ty]);
  assert.equal(unstick(s, p), false, 'pushed by a bomb it is standing in the middle of');

  setTile(s.map, tx, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  assert.equal(unstick(s, p), true, 'a wall grown on top of you must still move you');
});

test('easing off the edge of a bomb is a nudge, not a shove', () => {
  // The bomb firms up a few units before you are completely clear, so there is something to
  // ease out of and stepping off one has a little weight. What must never come back is the
  // third of a tile the old centre-based rule produced.
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  setTile(s.map, tx, ty + 1, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  p.dir = DIR_D;
  place(s, p, IN_BOMB);
  assert.deepEqual([s.bombs[0]?.tx, s.bombs[0]?.ty], [tx, ty]);

  let nudges = 0, travelled = 0;
  for (let n = 0; n < 60; n++) {
    const before = p.x;
    if (unstick(s, p)) { nudges++; travelled += Math.abs(p.x - before); }
    step(s, p, IN_RIGHT);
  }
  assert.ok(travelled <= 24, `eased ${travelled} units off a bomb — that is a shove`);
  assert.ok(!blocked(s, p, p.x, p.y), 'left inside something');
});
