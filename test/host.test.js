// Who is in charge, and what happens when they leave.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import { STATUS } from '../shared/constants.js';

const room = (adminName = '') => createRoom({ countIn: 0, onBroadcast: () => {}, adminName });

test('the first player is the host', () => {
  const r = room();
  const a = r.join('p1', 'ann');
  assert.equal(r.hostSeat(), a.seat);
});

test('the only player is the host', () => {
  const r = room();
  r.join('p1', 'solo');
  assert.equal(r.hostSeat(), 0);
});

test('it passes to the next player when the host leaves', () => {
  const r = room();
  const a = r.join('p1', 'ann');
  const b = r.join('p2', 'bob');
  assert.equal(r.hostSeat(), a.seat);
  r.logout(a.seat);
  assert.equal(r.hostSeat(), b.seat, 'nobody inherited the room');
});

test('a host who merely drops keeps nothing: the room still has one', () => {
  // Disconnected is not gone — the seat is held — but somebody present has to be able to run the
  // round, or a dropped host freezes the room for the length of the reconnect grace.
  const r = room();
  const a = r.join('p1', 'ann');
  const b = r.join('p2', 'bob');
  r.disconnect(a.seat);
  assert.equal(r.hostSeat(), b.seat);
});

test('the named admin outranks seat order wherever they sit', () => {
  const r = room('cobusvw');
  r.join('p1', 'ann');
  const me = r.join('p2', 'cobusvw');
  assert.equal(r.hostSeat(), me.seat, 'the admin should be host regardless of who joined first');
});

test('the admin key outranks seat order, and the name alone does not', () => {
  // With a key configured net.js passes no adminName, so typing the name gets you nothing.
  const r = room();
  r.join('p1', 'ann');
  const squatter = r.join('p2', 'cobusvw');
  assert.notEqual(r.hostSeat(), squatter.seat, 'a borrowed name made somebody host');
  const me = r.join('p3', 'whoever', { admin: true });
  assert.equal(r.hostSeat(), me.seat);
});

test('the key is checked again on every reconnect', () => {
  const r = room();
  r.join('p1', 'ann');
  const me = r.join('p2', 'cobus', { admin: true });
  r.disconnect(me.seat);
  r.join('p2', 'cobus');
  assert.notEqual(r.hostSeat(), me.seat, 'a resume without the key kept the privilege');
});

test('bots are never the host', () => {
  const r = room();
  r.setBots(3);
  assert.equal(r.hostSeat(), -1, 'a room of only bots has no host');
  const human = r.join('p1', 'ann');
  assert.equal(r.hostSeat(), human.seat);
});

test('an empty room has no host, and says so rather than guessing', () => {
  assert.equal(room().hostSeat(), -1);
});

test('godmode survives a death and a new round', () => {
  /* It used to live on the player object, which a respawn clears and a round replaces outright.
   * The admin switched it on, played one round, and was mortal again from the next one with
   * nothing said. The flag belongs to the seat; the body only carries it. */
  const r = room('cobusvw');
  const me = r.join('p1', 'cobusvw');
  assert.equal(r.toggleGod(me.seat), true);
  assert.equal(r.state.players[me.seat].status & STATUS.INVULN, STATUS.INVULN);

  r.respawn(r.state.players[me.seat]);
  assert.ok(r.state.players[me.seat].god, 'a respawn dropped godmode');
  assert.equal(r.state.players[me.seat].status & STATUS.INVULN, STATUS.INVULN);

  r.restartRound();
  assert.ok(r.state.players[me.seat].god, 'a new round dropped godmode');
  assert.equal(r.state.players[me.seat].status & STATUS.INVULN, STATUS.INVULN,
    'godmode survived in name only: the status is gone');

  assert.equal(r.toggleGod(me.seat), false);
  assert.equal(r.state.players[me.seat].status & STATUS.INVULN, 0);
  r.restartRound();
  assert.ok(!r.state.players[me.seat].god, 'switching it off did not stick across a round');
});
