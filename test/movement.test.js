// Movement is the one piece of the game that cannot be "fixed later" — everything after M1
// inherits its feel, and both the client prediction and the server run this exact code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, setTile, tileCentre, hashState } from '../shared/sim/state.js';
import { step, blocked, speedOf } from '../shared/sim/movement.js';
import {
  BLOCK, IN_RIGHT, IN_LEFT, IN_DOWN, IN_UP, UNITS_PER_TILE, CORNER_ASSIST_UNITS,
  SPEED_UNITS_PER_TICK, STATUS, DIR_R,
} from '../shared/constants.js';
import { applyStatus } from '../shared/sim/state.js';

/** An empty room with an iron border, so tests only see the walls they place. */
function room(w = 9, h = 9) {
  const st = createState({ id: 't', name: 't', w, h, seed: 1, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  return st;
}

function spawn(st, tx, ty) {
  const p = createPlayer(0, 'p');
  p.alive = true;
  p.x = tileCentre(tx); p.y = tileCentre(ty);
  st.players[0] = p;
  return p;
}

test('movement', async t => {
  await t.test('walks at exactly the tabled speed', () => {
    const st = room(); const p = spawn(st, 2, 2);
    const before = p.x;
    step(st, p, IN_RIGHT);
    assert.equal(p.x - before, SPEED_UNITS_PER_TICK[0]);
    assert.equal(p.dir, DIR_R);
  });

  await t.test('roller-skates stack up to the cap and no further', () => {
    const p = createPlayer(0, 'p');
    const seen = [];
    for (let s = 0; s <= 8; s++) { p.speed = s; seen.push(speedOf(p)); }
    assert.deepEqual(seen.slice(0, 5), SPEED_UNITS_PER_TICK);
    assert.equal(seen[8], SPEED_UNITS_PER_TICK.at(-1), 'over-cap speed clamps');
  });

  await t.test('slowdown halves it', () => {
    const st = room(); const p = spawn(st, 2, 2);
    applyStatus(st, p, STATUS.SLOWDOWN);
    assert.equal(speedOf(p), (SPEED_UNITS_PER_TICK[0] / 2) | 0);
  });

  await t.test('stops at a wall instead of entering it', () => {
    const st = room(); const p = spawn(st, 2, 2);
    setTile(st.map, 3, 2, BLOCK.SOFT);
    for (let i = 0; i < 40; i++) step(st, p, IN_RIGHT);
    assert.ok(!blocked(st, p, p.x, p.y), 'never ends up inside a wall');
    assert.ok(p.x < tileCentre(3), 'did not pass into the wall tile');
    // And it slid flush rather than stopping a visible gap short.
    assert.ok(tileCentre(3) - p.x < UNITS_PER_TILE, 'ends up adjacent to the wall');
  });

  // A doorway: solid above and below, gap straight ahead on your own row. Walking at it slightly
  // off-centre, your hitbox clips the jamb. This is the case that makes a grid game feel good or
  // awful, and it is what RULES.md §2 specifies.
  const doorway = () => {
    const st = room();
    setTile(st.map, 3, 1, BLOCK.SOFT);
    setTile(st.map, 3, 3, BLOCK.SOFT);
    return st;
  };

  await t.test('corner assist straightens you through a doorway you are nearly lined up with', () => {
    const st = doorway(); const p = spawn(st, 2, 2);
    p.y = tileCentre(2) + CORNER_ASSIST_UNITS;      // clipping the lower jamb
    for (let i = 0; i < 30; i++) step(st, p, IN_RIGHT);
    assert.equal(p.y, tileCentre(2), 'straightened onto the doorway centre line');
    assert.ok(p.x > tileCentre(3), 'and went through');
  });

  await t.test('and does not when you are too far out of line', () => {
    const st = doorway(); const p = spawn(st, 2, 2);
    p.y = tileCentre(2) + CORNER_ASSIST_UNITS + 40; // beyond the window: aiming at the jamb
    for (let i = 0; i < 30; i++) step(st, p, IN_RIGHT);
    assert.ok(p.x < tileCentre(3), 'stopped at the wall, as it should');
  });

  await t.test('auto-centres onto a corridor while walking', () => {
    // A real corridor: walls above and below row 2, so there is nothing to corner into.
    const st = room();
    for (let x = 1; x <= 7; x++) { setTile(st.map, x, 1, BLOCK.SOFT); setTile(st.map, x, 3, BLOCK.SOFT); }
    const p = spawn(st, 2, 2);
    p.y = tileCentre(2) + 60;
    for (let i = 0; i < 20; i++) step(st, p, IN_RIGHT);
    assert.equal(p.y, tileCentre(2), 'drifted exactly onto the centre line');
  });

  await t.test('leaves you alone on open ground — centring must not fight the assist', () => {
    const st = room(); const p = spawn(st, 2, 2);
    p.y = tileCentre(2) + 60;                       // open above and below
    for (let i = 0; i < 5; i++) step(st, p, IN_RIGHT);
    assert.equal(p.y, tileCentre(2) + 60, 'held the line the player chose');
  });

  await t.test('changeling inverts both axes', () => {
    const st = room(); const p = spawn(st, 4, 4);
    applyStatus(st, p, STATUS.CHANGELING);
    const x0 = p.x;
    step(st, p, IN_RIGHT);
    assert.ok(p.x < x0, 'right went left');
  });

  await t.test('reduction fits through a column, normal size does not', () => {
    const st = room(); const p = spawn(st, 2, 2);
    setTile(st.map, 3, 2, BLOCK.COLUMN);
    for (let i = 0; i < 30; i++) step(st, p, IN_RIGHT);
    assert.ok(p.x < tileCentre(3), 'blocked by the column at full size');

    applyStatus(st, p, STATUS.REDUCTION);
    for (let i = 0; i < 40; i++) step(st, p, IN_RIGHT);
    assert.ok(p.x > tileCentre(3), 'squeezed through once reduced');
  });

  await t.test('diagonals do not stutter — it keeps the axis it is facing', () => {
    const st = room(); const p = spawn(st, 4, 4);
    step(st, p, IN_RIGHT);
    const dirAfterRight = p.dir;
    for (let i = 0; i < 5; i++) step(st, p, IN_RIGHT | IN_DOWN);
    assert.equal(p.dir, dirAfterRight, 'stayed on the axis it was already facing');
  });

  await t.test('is deterministic: same inputs, same state hash, twice', () => {
    const script = [IN_RIGHT, IN_RIGHT, IN_DOWN, IN_DOWN, IN_LEFT, IN_UP, 0, IN_RIGHT | IN_DOWN];
    const run = () => {
      const st = room(15, 15);
      const p = spawn(st, 3, 3);
      setTile(st.map, 5, 3, BLOCK.SOFT);
      setTile(st.map, 3, 6, BLOCK.REINFORCED);
      for (let i = 0; i < 300; i++) { step(st, p, script[i % script.length]); st.tick++; }
      return hashState(st);
    };
    assert.equal(run(), run());
  });
});
