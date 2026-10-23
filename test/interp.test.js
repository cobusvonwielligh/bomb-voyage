// Picking the snapshot pair to draw a remote player between.
//
// The shipped version took the two newest, which is wrong in a way that is invisible in the code
// and very visible on screen: remote players teleported fifteen times a second and it looked
// exactly like a bad connection. These tests pin the shape of the real buffer — snapshots every
// SNAP_EVERY_TICKS, rendering INTERP_DELAY_TICKS behind — because that is where it broke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPair } from '../shared/util/interp.js';
import { SNAP_EVERY_TICKS, INTERP_DELAY_TICKS } from '../shared/constants.js';

const buf = ticks => ticks.map(t => ({ tick: t, x: t * 100, y: 0 }));

test('picks the pair that brackets the time, not the newest pair', () => {
  const b = buf([10, 12, 14, 16]);
  const got = pickPair(b, 13);
  assert.equal(got.a.tick, 12);
  assert.equal(got.b.tick, 14);
  assert.equal(got.f, 0.5);
});

test('the fraction sweeps 0 to 1 across a span', () => {
  const b = buf([10, 12]);
  assert.equal(pickPair(b, 10).f, 0);
  assert.equal(pickPair(b, 11).f, 0.5);
  assert.equal(pickPair(b, 12).f, 1);
});

test('it never pins — the real cadence produces motion every tick', () => {
  // The exact situation that broke: snapshots every 2 ticks, render 4 ticks behind, and the
  // newest snapshot therefore always starts AFTER the time being drawn.
  const ticks = [];
  for (let t = 0; t <= 40; t += SNAP_EVERY_TICKS) ticks.push(t);

  const positions = [];
  for (let now = 10; now <= 40; now++) {
    const window = ticks.filter(t => t <= now).slice(-6);
    if (window.length < 2) continue;
    const p = pickPair(buf(window), now - INTERP_DELAY_TICKS);
    assert.ok(p, 'no pair for a perfectly ordinary buffer');
    positions.push(p.a.x + (p.b.x - p.a.x) * p.f);
  }

  // Every step forward in time must move the drawn position forward too. The old code produced
  // long runs of the identical value — that run is the judder.
  let stalls = 0;
  for (let i = 1; i < positions.length; i++) if (positions[i] === positions[i - 1]) stalls++;
  assert.equal(stalls, 0, `the drawn position stood still on ${stalls}/${positions.length - 1} ticks`);

  // And it must be monotonic: a player walking one way never briefly walks back.
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] >= positions[i - 1], `went backwards at sample ${i}`);
  }
});

test('holds the newest position when the next snapshot is late, rather than extrapolating', () => {
  const b = buf([10, 12]);
  const late = pickPair(b, 20);
  assert.equal(late.a.tick, 12);
  assert.equal(late.b.tick, 12);
  assert.equal(late.f, 0);
});

test('holds the oldest rather than running backwards off the front of the buffer', () => {
  const b = buf([10, 12]);
  const early = pickPair(b, 2);
  assert.equal(early.a.tick, 10);
  assert.equal(early.f, 0);
});

test('degenerate buffers do not throw', () => {
  assert.equal(pickPair([], 5), null);
  assert.equal(pickPair(undefined, 5), null);
  assert.equal(pickPair(buf([7]), 9).a.tick, 7);
  // Two entries stamped with the same tick: a duplicate, not a zero-length span to divide by.
  const dup = pickPair(buf([8, 8]), 8);
  assert.ok(Number.isFinite(dup.f), 'produced a NaN fraction from a zero span');
});
