// The latest use of an id wins the seat.
//
// Moving from laptop to phone, reloading before the old socket has been noticed as dead, or a
// half-open connection the server still believes in: all of them are one person, and all of them
// should land back in the seat they were already in, with their score. The guard is what stops
// that becoming a war between two clients that genuinely share an id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import { TAKEOVER_LIMIT, TAKEOVER_WINDOW_TICKS } from '../shared/constants.js';

const room = () => {
  const kicked = [];
  const r = createRoom({ onBroadcast: () => {}, onKick: (seat, why) => kicked.push({ seat, why }) });
  return { r, kicked };
};

test('a live seat is taken back by the same id, with its score intact', () => {
  const { r } = room();
  const first = r.join('p1', 'cobus');
  r.state.players[first.seat].score = 420;
  r.state.players[first.seat].kills = 7;

  const second = r.join('p1', 'cobus');
  assert.equal(second.seat, first.seat, 'the second sign-in got a different seat');
  assert.equal(second.resumed, true);
  assert.equal(second.replaced, true, 'should report that it displaced a live session');
  assert.equal(second.playerId, 'p1', 'the id should survive the takeover');
  assert.equal(r.state.players[first.seat].score, 420, 'score was reset by the takeover');
  assert.equal(r.state.players[first.seat].kills, 7);
});

test('a dropped seat is still resumed, and is not reported as a takeover', () => {
  const { r } = room();
  const first = r.join('p1', 'cobus');
  r.disconnect(first.seat);
  const back = r.join('p1', 'cobus');
  assert.equal(back.seat, first.seat);
  assert.equal(back.resumed, true);
  assert.equal(back.replaced, false, 'nothing live was displaced');
});

test('a new name on the takeover is adopted', () => {
  const { r } = room();
  const a = r.join('p1', 'cobus');
  r.join('p1', 'cobusvw');
  assert.equal(r.state.players[a.seat].name, 'cobusvw');
});

test('two clients fighting over one id stop being trusted', () => {
  // Each takeover kicks the other, the kicked one reconnects, and without this they flap forever.
  const { r } = room();
  const first = r.join('p1', 'ghost');
  for (let i = 0; i < TAKEOVER_LIMIT; i++) {
    const res = r.join('p1', 'ghost');
    assert.equal(res.seat, first.seat, `takeover ${i + 1} should still be allowed`);
  }
  const tooMany = r.join('p1', 'ghost');
  assert.notEqual(tooMany.seat, first.seat, 'the flapping client kept stealing the seat');
  assert.notEqual(tooMany.playerId, 'p1', 'it should have been given a fresh identity');
});

test('the takeover budget is a window, not a lifetime', () => {
  const { r } = room();
  const first = r.join('p1', 'cobus');
  for (let i = 0; i < TAKEOVER_LIMIT; i++) r.join('p1', 'cobus');

  // Somebody who signs in from a new device once an hour is not flapping.
  for (let i = 0; i < TAKEOVER_WINDOW_TICKS + 2; i++) r.tick();
  const later = r.join('p1', 'cobus');
  assert.equal(later.seat, first.seat, 'an honest sign-in was refused long after the window');
  assert.equal(later.playerId, 'p1');
});

test('an unknown id just takes a free seat', () => {
  const { r } = room();
  r.join('p1', 'a');
  const b = r.join('p2', 'b');
  assert.equal(b.resumed, false);
  assert.notEqual(b.seat, 0);
  assert.equal(b.playerId, 'p2');
});
