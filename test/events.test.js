// Regression: every event the simulation produces must reach a snapshot.
//
// The room generates events every tick but only emits a snapshot every second tick. It used to
// clear the event list unconditionally, so half of everything was silently discarded: deaths with
// no death screen, blocks that broke on the server and stayed drawn in the browser, and — because
// wall regrowth always lands on an even tick — regenerated walls no client ever heard about, which
// prediction then happily walked straight through.
//
// The bots are seated before the loop starts, so their spawn events are stamped tick 0. An even
// tick is precisely what used to be thrown away, and the count is exact rather than timing
// dependent — which is the assertion that matters here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

test('no event is dropped between snapshots', async () => {
  const events = [];
  const room = createRoom({ countIn: 0,
    onBroadcast: msgOrFn => {
      const m = typeof msgOrFn === 'function' ? msgOrFn(0) : msgOrFn;
      if (m.t === 'snap') events.push(...(m.ev || []));
    },
  });

  room.setBots(12);
  room.start();
  await wait(3200);        // long enough for a 72-tick fuse to actually go off
  room.stop();

  assert.equal(events.filter(e => e.e === 'spawn' && e.tick === 0).length, 12,
    'the tick-0 spawns never reached a snapshot');
  assert.ok(events.some(e => e.e === 'bomb'), 'bots placed no bombs');
  assert.ok(events.some(e => e.e === 'boom'), 'nothing exploded in three seconds');
});
