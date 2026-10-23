// The contagious diseases. Contagion is the rule most likely to be quietly wrong — it is the
// only system where one player's state writes another's — so it gets its own suite.
// docs/RULES.md §7.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, createPlayer, setTile, tileCentre, applyStatus, has,
} from '../shared/sim/state.js';
import { spread as spreadStatuses, CONTAGIOUS_LIST } from '../shared/sim/statuses.js';
import { step, speedOf } from '../shared/sim/movement.js';
import { place } from '../shared/sim/bombs.js';
import { tick } from '../shared/sim/round.js';
import {
  BLOCK, IN_RIGHT, IN_BOMB, STATUS, STATUS_TICKS, CONTAGIOUS, CONTAGION_COOLDOWN_TICKS,
  MAX_PLAYERS, SPEED_UNITS_PER_TICK,
} from '../shared/constants.js';

/** An empty room with an iron border, so tests only see the walls they place. */
function room(w = 15, h = 15) {
  const st = createState({ id: 't', name: 't', w, h, seed: 3, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  return st;
}

function spawn(st, seat, tx, ty) {
  const p = createPlayer(seat, `p${seat}`);
  p.alive = true;
  p.x = tileCentre(tx); p.y = tileCentre(ty);
  st.players[seat] = p;
  return p;
}

const run = (st, n, inputs = []) => { for (let i = 0; i < n; i++) tick(st, inputs); };
const statusEvents = st => st.events.filter(e => e.e === 'status');

test('contagion', async t => {
  await t.test('passes to a touching player, and the carrier keeps it', () => {
    const st = room();
    const a = spawn(st, 0, 3, 3);
    const b = spawn(st, 1, 3, 3);
    applyStatus(st, a, STATUS.PACIFISM);

    spreadStatuses(st);
    assert.ok(has(b, STATUS.PACIFISM), 'caught it');
    assert.ok(has(a, STATUS.PACIFISM), 'and it is contagion, not a trade');

    const ev = statusEvents(st);
    assert.equal(ev.length, 1);
    assert.deepEqual({ i: ev[0].i, s: ev[0].s }, { i: 1, s: STATUS.PACIFISM });
  });

  await t.test('you catch what is left of it, not a fresh dose', () => {
    const st = room();
    const a = spawn(st, 0, 3, 3);
    const b = spawn(st, 1, 3, 3);
    applyStatus(st, a, STATUS.SLOWDOWN);              // until tick 300
    st.tick = 100;

    spreadStatuses(st);
    assert.equal(b.statusUntil[STATUS.SLOWDOWN], a.statusUntil[STATUS.SLOWDOWN]);
    assert.ok(b.statusUntil[STATUS.SLOWDOWN] < st.tick + STATUS_TICKS[STATUS.SLOWDOWN],
      'a late catch does not restart the clock');
  });

  await t.test('players who are not overlapping infect nobody', () => {
    const st = room();
    const a = spawn(st, 0, 3, 3);
    const b = spawn(st, 1, 4, 3);                     // one tile away: hitboxes do not meet
    applyStatus(st, a, STATUS.CHANGELING);

    spreadStatuses(st);
    assert.equal(b.status, 0);
    assert.equal(statusEvents(st).length, 0);
  });

  await t.test('invulnerability neither spreads nor lets anything in', () => {
    const st = room();
    const a = spawn(st, 0, 3, 3);
    const b = spawn(st, 1, 3, 3);
    applyStatus(st, a, STATUS.INVULN);
    applyStatus(st, a, STATUS.REDUCTION);

    spreadStatuses(st);
    assert.ok(has(b, STATUS.REDUCTION), 'the disease travelled');
    assert.ok(!has(b, STATUS.INVULN), 'the protection did not');

    // And the other way round: a fresh respawn walking into a plague pit keeps its spawn
    // protection's point only if invulnerability also blocks catching.
    const st2 = room();
    const carrier = spawn(st2, 0, 3, 3);
    const shielded = spawn(st2, 1, 3, 3);
    applyStatus(st2, carrier, STATUS.PACIFISM);
    applyStatus(st2, shielded, STATUS.INVULN);

    spreadStatuses(st2);
    assert.equal(shielded.status, STATUS.INVULN, 'caught nothing');
    assert.equal(statusEvents(st2).length, 0);
  });

  await t.test('a pair cannot re-infect on the very next tick', () => {
    const st = room();
    const a = spawn(st, 0, 3, 3);
    const b = spawn(st, 1, 3, 3);
    applyStatus(st, a, STATUS.PACIFISM, 5000);

    spreadStatuses(st);
    assert.equal(statusEvents(st).length, 1);

    b.status = 0; b.statusUntil = {};
    st.events.length = 0;
    st.tick += CONTAGION_COOLDOWN_TICKS - 1;
    spreadStatuses(st);
    assert.equal(statusEvents(st).length, 0, 'still inside the pair cooldown');

    st.tick += 1;
    spreadStatuses(st);
    assert.equal(statusEvents(st).length, 1, 'and open again once it lapses');
  });

  await t.test('the cooldown bounds how often a scrum can fire', () => {
    const st = room();
    const a = spawn(st, 0, 3, 3);
    const b = spawn(st, 1, 3, 3);
    applyStatus(st, a, STATUS.SLOWDOWN, 5000);

    const TICKS = 600;
    let count = 0;
    for (let n = 0; n < TICKS; n++) {
      // Worst case for the cooldown: pretend b shakes it off every single tick, so the cooldown
      // is the only thing between us and one event per tick.
      b.status = 0; b.statusUntil = {};
      st.events.length = 0;
      spreadStatuses(st);
      count += statusEvents(st).length;
      st.tick++;
    }
    assert.ok(count <= TICKS / CONTAGION_COOLDOWN_TICKS + 1,
      `${count} events over ${TICKS} ticks — the pair cooldown is not holding`);
    assert.ok(count > 1, 'and it is not blocking contagion outright');
  });

  await t.test('sixteen players on one tile stay bounded', () => {
    const st = room();
    for (let i = 0; i < MAX_PLAYERS; i++) spawn(st, i, 7, 7);
    for (const bit of CONTAGIOUS_LIST) applyStatus(st, st.players[0], bit, 5000);

    // Each player can only *gain* a given bit once per tick, whoever passes it, so this is the
    // real ceiling on the event burst a pile-up can produce.
    const ceiling = MAX_PLAYERS * CONTAGIOUS_LIST.length;
    let worst = 0;
    for (let n = 0; n < 120; n++) {
      st.events.length = 0;
      tick(st, []);
      worst = Math.max(worst, statusEvents(st).length);
    }
    assert.equal(st.tick, 120, 'the loop finished');
    assert.ok(worst <= ceiling, `one tick produced ${worst} status events, ceiling is ${ceiling}`);
    for (const p of st.players) assert.equal(p.status & CONTAGIOUS, CONTAGIOUS, 'everyone caught everything');
  });
});

test('statuses change what you can do', async t => {
  await t.test('expire on schedule, and the bit goes with them', () => {
    const st = room();
    const p = spawn(st, 0, 3, 3);
    applyStatus(st, p, STATUS.SLOWDOWN, 10);

    run(st, 10);
    assert.ok(has(p, STATUS.SLOWDOWN), 'still running at the last tick it covers');
    run(st, 1);
    assert.equal(p.status & STATUS.SLOWDOWN, 0, 'bit cleared');
    assert.equal(p.statusUntil[STATUS.SLOWDOWN], undefined, 'and the deadline with it');
  });

  await t.test('slowdown halves your speed', () => {
    const st = room();
    const fast = spawn(st, 0, 3, 3);
    const slow = spawn(st, 1, 3, 9);
    applyStatus(st, slow, STATUS.SLOWDOWN);
    assert.equal(speedOf(slow), (SPEED_UNITS_PER_TICK[0] / 2) | 0);

    step(st, fast, IN_RIGHT);
    step(st, slow, IN_RIGHT);
    assert.equal(slow.x - tileCentre(3), ((fast.x - tileCentre(3)) / 2) | 0, 'and it shows on the ground');
  });

  await t.test('pacifism blocks placing a bomb', () => {
    const st = room();
    const p = spawn(st, 0, 3, 3);
    applyStatus(st, p, STATUS.PACIFISM);
    place(st, p, IN_BOMB);
    assert.equal(st.bombs.length, 0);

    p.status = 0; p.statusUntil = {};
    place(st, p, IN_BOMB);
    assert.equal(st.bombs.length, 1, 'and only while it lasts');
  });

  await t.test('changeling inverts your input', () => {
    const st = room();
    const p = spawn(st, 0, 5, 5);
    applyStatus(st, p, STATUS.CHANGELING);
    const x0 = p.x;
    step(st, p, IN_RIGHT);
    assert.ok(p.x < x0, 'right went left');
  });

  await t.test('reduction fits you through a column', () => {
    const st = room();
    const p = spawn(st, 0, 2, 2);
    setTile(st.map, 3, 2, BLOCK.COLUMN);
    for (let i = 0; i < 30; i++) step(st, p, IN_RIGHT);
    assert.ok(p.x < tileCentre(3), 'blocked at full size');

    applyStatus(st, p, STATUS.REDUCTION);
    for (let i = 0; i < 40; i++) step(st, p, IN_RIGHT);
    assert.ok(p.x > tileCentre(3), 'squeezed through once reduced');
  });
});
