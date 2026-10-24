// Seagulls, and the room keeping bots topped up. Both are rules with a "hard on purpose" or a
// "never argue with the host" in them, which is exactly the kind of rule that quietly erodes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GULL_FIRST_TICK, GULL_MAX, GULL_LOW_ALT, FIRE_TICKS, PERK, AUTO_BOTS_MIN, UNITS_PER_TILE,
} from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { createState } from '../shared/sim/state.js';
import { gulls, gullAt, gullAltitude } from '../shared/sim/gulls.js';
import { rng } from '../shared/util/rng.js';
import { createRoom } from '../server/room.js';

const fresh = () => createState(MAPS[0]);

/** Run the gull system alone until one is in the air. */
function withGull() {
  const s = fresh();
  s.tick = GULL_FIRST_TICK;
  gulls(s);
  assert.equal(s.gulls.length, 1, 'no gull arrived at GULL_FIRST_TICK');
  return s;
}

/** The first tick, from `from`, at which the gull is low and over a floor tile. */
function lowOverFloor(s, g) {
  for (let t = s.tick; t < g.t0 + g.dur; t++) {
    const at = gullAt(g, t);
    if (at.alt > GULL_LOW_ALT) continue;
    const tx = Math.floor(at.x / UNITS_PER_TILE), ty = Math.floor(at.y / UNITS_PER_TILE);
    if (tx < 0 || ty < 0 || tx >= s.map.w || ty >= s.map.h) continue;
    return { t, tx, ty };
  }
  return null;
}

test('a gull enters and leaves off the map, and dives on the way', () => {
  const s = withGull();
  const g = s.gulls[0];
  const W = s.map.w * UNITS_PER_TILE, H = s.map.h * UNITS_PER_TILE;
  const off = p => p.x < 0 || p.y < 0 || p.x > W || p.y > H;
  assert.ok(off(gullAt(g, g.t0)), 'it appeared over the island');
  assert.ok(off(gullAt(g, g.t0 + g.dur)), 'it vanished over the island');
  assert.equal(gullAltitude(g, g.t0), 1, 'it should enter high, not mid-dive');
  let low = 0;
  for (let t = g.t0; t < g.t0 + g.dur; t++) if (gullAt(g, t).alt <= GULL_LOW_ALT) low++;
  const share = low / g.dur;
  // Catchable, and rarely: the whole point is that this is a hard shot.
  assert.ok(share > 0.05 && share < 0.2, `low for ${(share * 100).toFixed(1)}% of its flight`);
});

test('never more than GULL_MAX in the air, and they leave', () => {
  const s = fresh();
  let most = 0;
  for (s.tick = 0; s.tick < 20 * 60 * 30; s.tick++) {
    gulls(s);
    most = Math.max(most, s.gulls.length);
  }
  assert.ok(most >= 1, 'twenty minutes and not one gull');
  assert.ok(most <= GULL_MAX);
});

test('gulls have their own random stream, so drops and regrowth are unchanged', () => {
  const s = fresh();
  const shadow = rng(s.seed ^ 0x9e3779b9);
  for (s.tick = 0; s.tick < GULL_FIRST_TICK + 10; s.tick++) gulls(s);
  assert.equal(s.next(), shadow(), 'the gulls drew from the simulation\'s main stream');
});

test('a gull diving into live fire is downed and drops a coin that does not use the cap', () => {
  const s = withGull();
  const g = s.gulls[0];
  const shot = lowOverFloor(s, g);
  assert.ok(shot, 'this flight never went low over the island');
  s.tick = shot.t;
  s.fires = [{ tx: shot.tx, ty: shot.ty, kind: 'arm', rot: 0, until: s.tick + FIRE_TICKS, owner: 3 }];
  s.events.length = 0;
  gulls(s);
  assert.equal(s.gulls.length, 0, 'it flew on through the fire');
  const hit = s.events.find(e => e.e === 'gullhit');
  assert.ok(hit, 'no gullhit event');
  assert.equal(hit.by, 3);
  assert.ok(s.perks.some(k => k.type === PERK.GOLD), 'no coin');
  assert.equal(s.goldDropped, 0, 'an earned coin counted against the round\'s random gold');
});

test('the same fire does nothing to a gull cruising overhead, or to one in a blast\'s embers', () => {
  const s = withGull();
  const g = s.gulls[0];
  // Cruising: a high tick over the map, fire right under it.
  let t = g.t0;
  while (gullAt(g, t).alt < 1 || gullAt(g, t).x < 0 || gullAt(g, t).y < 0) t++;
  const at = gullAt(g, t);
  s.tick = t;
  s.fires = [{ tx: Math.floor(at.x / 256), ty: Math.floor(at.y / 256), kind: 'core', rot: 0,
    until: t + FIRE_TICKS, owner: 0 }];
  gulls(s);
  assert.equal(s.gulls.length, 1, 'a gull at cruising height was burned');

  // Embers: low, but the fire is past its lethal window.
  const shot = lowOverFloor(s, g);
  s.tick = shot.t;
  s.fires = [{ tx: shot.tx, ty: shot.ty, kind: 'arm', rot: 0, until: s.tick + 2, owner: 0 }];
  gulls(s);
  assert.equal(s.gulls.length, 1, 'smoke at the end of a blast brought a gull down');
});

// ─── bots ─────────────────────────────────────────────────────────────────────

const room = () => createRoom({ onBroadcast: () => {}, minBots: AUTO_BOTS_MIN });

/** Play out one (six-second) round, then start the next by hand. */
function round(r) {
  r.setRoundTime(0.1);
  for (let i = 0; i < 400 && !r.roundInfo().between; i++) r.tick();
  assert.ok(r.roundInfo().between, 'the round did not end');
  r.restartRound();
}

test('a person joining is met by at least AUTO_BOTS_MIN bots', () => {
  const r = room();
  try {
    assert.equal(r.botCount(), 0, 'bots before anyone came');
    r.join('a', 'alice');
    assert.equal(r.botCount(), AUTO_BOTS_MIN);
    r.join('b', 'bob');
    assert.equal(r.botCount(), AUTO_BOTS_MIN, 'a second person should not add more');
  } finally { r.stop(); }
});

test('two empty rounds send the bots home', () => {
  const r = room();
  try {
    const { seat } = r.join('a', 'alice');
    r.disconnect(seat);
    round(r);                     // alice was here for this one
    assert.equal(r.botCount(), AUTO_BOTS_MIN);
    round(r);                     // empty
    assert.equal(r.botCount(), AUTO_BOTS_MIN, 'gone after one empty round');
    round(r);                     // empty again
    assert.equal(r.botCount(), 0, 'still here after two empty rounds');
  } finally { r.stop(); }
});

test('a host removing bots by hand is not overruled until the room has emptied', () => {
  const r = room();
  try {
    r.join('a', 'alice');
    const bot = r.state.players.findIndex((p, i) => p && r.isBot(i));
    r.kickSeat(bot);
    assert.equal(r.autoBots, false);
    r.join('b', 'bob');
    assert.equal(r.botCount(), AUTO_BOTS_MIN - 1, 'the top-up put the kicked bot straight back');

    r.setBots(10, { byHand: true });
    assert.equal(r.botCount(), 10, 'asking for MORE by hand is fine');
    r.setBots(2, { byHand: true });
    assert.equal(r.botCount(), 2);

    // Everyone leaves; two empty rounds later the policy is back.
    for (let i = 0; i < 16; i++) if (r.state.players[i] && !r.isBot(i)) r.disconnect(i);
    round(r); round(r); round(r);
    assert.equal(r.autoBots, true);
    assert.equal(r.botCount(), 0);
    r.join('c', 'carol');
    assert.equal(r.botCount(), AUTO_BOTS_MIN);
  } finally { r.stop(); }
});
