// The count-in is a rule, not a caption: nobody moves until it reaches zero.
//
// It is also the one rule in the project that every other room test opts out of (`countIn: 0`),
// so this file is the only thing standing between "five seconds of fairness at the top of a
// round" and "a number on the screen that means nothing".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IN_RIGHT, IN_BOMB, COUNT_IN_TICKS, TICK_HZ, ROUND_TICKS } from '../shared/constants.js';
import { createRoom } from '../server/room.js';
import { AUTO_BOTS_MIN } from '../shared/constants.js';

const room = opts => createRoom({ onBroadcast: () => {}, ...opts });

test('a person cannot move or bomb until the count-in is over', () => {
  const r = room({});
  try {
    const { seat } = r.join('p1', 'cobus');
    const me = r.state.players[seat];
    const from = { x: me.x, y: me.y };

    // Hold right and the bomb key for the whole count-in.
    for (let i = 0; i < COUNT_IN_TICKS; i++) {
      r.input(seat, r.state.tick, IN_RIGHT | IN_BOMB);
      r.tick();
    }
    assert.equal(me.x, from.x, 'moved during the count-in');
    assert.equal(me.y, from.y, 'moved during the count-in');
    assert.equal(r.state.bombs.length, 0, 'placed a bomb during the count-in');

    // And the moment it lifts, the same input works.
    for (let i = 0; i < 6; i++) {
      r.input(seat, r.state.tick, IN_RIGHT);
      r.tick();
    }
    assert.ok(me.x > from.x, 'still frozen after the count-in');
  } finally { r.stop(); }
});

test('the bots are frozen too, which is the whole point of freezing anybody', () => {
  const r = room({ minBots: AUTO_BOTS_MIN });
  try {
    r.join('p1', 'cobus');
    const bots = r.state.players
      .map((p, i) => (p && r.isBot(i) ? p : null))
      .filter(Boolean);
    assert.ok(bots.length >= 2, 'no bots to freeze');
    const before = bots.map(p => ({ x: p.x, y: p.y }));

    for (let i = 0; i < COUNT_IN_TICKS; i++) r.tick();
    for (const [n, p] of bots.entries()) {
      assert.equal(p.x, before[n].x, `bot ${n} moved during the count-in`);
      assert.equal(p.y, before[n].y, `bot ${n} moved during the count-in`);
    }
    assert.equal(r.state.bombs.length, 0, 'a bot bombed during the count-in');

    // Freeing them again is the other half: a bot that stays frozen is worse than one that never
    // was, and "they did not move" would pass for both.
    for (let i = 0; i < 2 * TICK_HZ; i++) r.tick();
    const moved = bots.some((p, n) => p.x !== before[n].x || p.y !== before[n].y);
    assert.ok(moved, 'the bots never came back to life');
  } finally { r.stop(); }
});

test('the round is a full round of PLAY, not of play minus the count-in', () => {
  const r = room({});
  try {
    const { seat } = r.join('p1', 'cobus');
    // What the client counts down to, and what the room ends on, have to be the same number —
    // otherwise the clock on screen reads 9:55 at the whistle, or runs out before it.
    const w = r.welcomeFor(seat);
    assert.equal(w.startsAtTick, COUNT_IN_TICKS, 'the client is told the wrong start tick');
    assert.equal(w.roundEndsAtTick, ROUND_TICKS + COUNT_IN_TICKS,
      'the round clock does not account for the count-in');
  } finally { r.stop(); }
});

test('countIn: 0 is the old behaviour, exactly', () => {
  // Every other room test depends on this, so it is worth asserting rather than assuming.
  const r = room({ countIn: 0 });
  try {
    const { seat } = r.join('p1', 'cobus');
    const me = r.state.players[seat];
    const x0 = me.x;
    for (let i = 0; i < 6; i++) {
      r.input(seat, r.state.tick, IN_RIGHT);
      r.tick();
    }
    assert.ok(me.x > x0, 'a room with no count-in still froze somebody');
    assert.equal(r.welcomeFor(seat).startsAtTick, 0);
  } finally { r.stop(); }
});

test('nobody is kicked for the silence the freeze asks them for', () => {
  // The client is told not to send inputs while the board is frozen. If the idle clock ran during
  // the count-in, a long one would kick the very players who were doing as they were told.
  const r = room({});
  try {
    const { seat } = r.join('p1', 'cobus');
    for (let i = 0; i < COUNT_IN_TICKS; i++) r.tick();      // not one input sent
    assert.ok(r.state.players[seat], 'the count-in kicked somebody for being frozen');
  } finally { r.stop(); }
});
