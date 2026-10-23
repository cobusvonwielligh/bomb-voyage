// One id is one person, and one person plays once.
//
// A second window on the same identity is turned away rather than handed a second seat or
// allowed to steal the first: a sixteen-seat server where one person can hold two of them is a
// smaller server. Only a LIVE seat refuses — a socket that has actually gone is the reconnect
// case, and a wifi roam must never lock you out of your own score.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';

const room = () => createRoom({ onBroadcast: () => {} });

test('a second window on the same id is refused, with a reason', () => {
  const r = room();
  const first = r.join('p1', 'cobus');
  assert.ok(first.seat >= 0);

  const second = r.join('p1', 'cobus');
  assert.equal(second.seat, -1, 'the same identity got a second seat');
  assert.equal(second.why, 'already-playing', 'the client cannot offer a way out without this');
});

test('a dropped socket still reconnects into its own seat and score', () => {
  const r = room();
  const first = r.join('p1', 'cobus');
  r.state.players[first.seat].score = 310;
  r.disconnect(first.seat);

  const back = r.join('p1', 'cobus');
  assert.equal(back.seat, first.seat, 'a reconnect was treated as a duplicate');
  assert.equal(back.resumed, true);
  assert.equal(r.state.players[first.seat].score, 310);
});

test('signing out frees the seat and the name', () => {
  const r = room();
  const first = r.join('p1', 'cobus');
  assert.equal(r.logout(first.seat), true);
  assert.equal(r.state.players[first.seat], null, 'the seat was not released');

  const again = r.join('p1', 'cobus');
  assert.ok(again.seat >= 0, 'could not sign back in after signing out');
  assert.equal(again.resumed, false, 'should be a fresh session, not a resume');
});

test('signing out banks the score rather than discarding it', () => {
  const banked = [];
  const r = createRoom({
    onBroadcast: () => {},
    leaderboard: { record: (id, e) => banked.push({ id, ...e }), flush: () => {}, top: () => [], get: () => null },
  });
  const { seat } = r.join('p1', 'cobus');
  r.state.players[seat].score = 777;
  r.state.players[seat].kills = 5;
  r.logout(seat);
  assert.equal(banked.length, 1, 'signing out lost the round');
  assert.equal(banked[0].score, 777);
  assert.equal(banked[0].kills, 5);
});

test('signing out a seat that is not there does nothing', () => {
  const r = room();
  assert.equal(r.logout(3), false);
});

test('different ids are unaffected', () => {
  const r = room();
  const a = r.join('p1', 'a');
  const b = r.join('p2', 'b');
  assert.ok(b.seat >= 0);
  assert.notEqual(b.seat, a.seat);
});
