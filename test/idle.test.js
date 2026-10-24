// A seat held by a backgrounded tab is a person who cannot join.
//
// Sixteen is a hard cap, so the server reclaims a seat that has gone silent. A playing client
// sends an input every tick — including a mask of zero while standing still — so silence means
// the tab is hidden, frozen, or on a sleeping laptop, not that somebody is thinking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import { IDLE_KICK_TICKS } from '../shared/constants.js';

/** Drive the room by hand: no timers, no wall clock, exactly as many ticks as we ask for. */
function room() {
  const kicked = [];
  const chat = [];
  const r = createRoom({ countIn: 0,
    onBroadcast: m => {
      const x = typeof m === 'function' ? m(0) : m;
      if (x.t === 'chat') chat.push(x.msg);
    },
    onKick: (seat, why) => kicked.push({ seat, why }),
  });
  return { r, kicked, chat };
}

const run = (r, n) => { for (let i = 0; i < n; i++) r.tick(); };

test('a silent seat is reclaimed, and the socket is told', () => {
  const { r, kicked, chat } = room();
  const { seat } = r.join('p1', 'ghost');
  assert.equal(seat, 0);

  run(r, IDLE_KICK_TICKS + 2);

  assert.deepEqual(kicked, [{ seat: 0, why: 'idle' }]);
  assert.ok(chat.some(m => m.includes('ghost') && m.includes('idle')), `chat was ${chat}`);
  assert.equal(r.state.players[0], null, 'the seat was not actually freed');
});

test('a player who keeps sending input is never reclaimed, even standing still', () => {
  const { r, kicked } = room();
  const { seat } = r.join('p1', 'afk-looking');
  // Mask 0 the whole way: standing still is still playing.
  for (let i = 0; i < IDLE_KICK_TICKS * 2; i++) {
    r.input(seat, r.state.tick + 1, 0);
    r.tick();
  }
  assert.deepEqual(kicked, [], 'kicked somebody who was sending input');
  assert.ok(r.state.players[0], 'the seat was freed under a live player');
});

test('bots are not kicked for being quiet', () => {
  const { r, kicked } = room();
  r.setBots(2);
  run(r, IDLE_KICK_TICKS + 2);
  assert.deepEqual(kicked, []);
  assert.equal(r.botCount(), 2);
});

test('the idle clock restarts when a seat is resumed', () => {
  const { r, kicked } = room();
  const { seat } = r.join('p1', 'flaky');
  run(r, IDLE_KICK_TICKS - 10);
  r.disconnect(seat);
  r.join('p1', 'flaky');                 // same id: resumes the held seat
  run(r, 20);
  assert.deepEqual(kicked, [], 'reclaimed a seat that had just come back');
});

test('a freed seat can be taken by somebody new', () => {
  const { r } = room();
  r.join('p1', 'ghost');
  run(r, IDLE_KICK_TICKS + 2);
  const next = r.join('p2', 'newcomer');
  assert.equal(next.seat, 0, 'the reclaimed seat was not reusable');
  assert.equal(r.state.players[0].name, 'newcomer');
});
