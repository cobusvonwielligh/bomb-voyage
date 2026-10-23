// Powder kegs, and the rules that keep them an event rather than a lottery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, tileCentre, setTile, tileAt } from '../shared/sim/state.js';
import { detonate } from '../shared/sim/bombs.js';
import { stamina, speedOf } from '../shared/sim/movement.js';
import { regenerate } from '../shared/sim/blocks.js';
import { MAPS } from '../shared/maps.js';
import {
  BLOCK, BLOCK_HP, POWDER_RADIUS, POWDER_MAX_PER_ROUND, POWDER_GUARANTEE_TICK,
  REGEN_EVERY_TICKS, TICK_HZ, ROUND_TICKS,
  STAMINA_MAX, STAMINA_RECOVER_UNITS, MAX_STAMINA_LEVELS, staminaMaxFor,
} from '../shared/constants.js';

// A wide empty room, so a blast arm is stopped by a keg and nothing else.
const ROOM = {
  id: 'room', name: 'Powder Room', w: 25, h: 9, seed: 5,
  rows: [
    '#########################',
    '#.......................#',
    '#.......................#',
    '#.......................#',
    '#.......................#',
    '#.......................#',
    '#.......................#',
    '#.......................#',
    '#########################',
  ],
};

test('a keg detonates on the tick it breaks, with a blast of its own', () => {
  const s = createState(ROOM);
  setTile(s.map, 6, 4, BLOCK.POWDER, BLOCK_HP[BLOCK.POWDER]);
  s.bombs.push({ id: s.nextBombId++, tx: 4, ty: 4, owner: 0, radius: 3, at: 0 });

  detonate(s);

  const booms = s.events.filter(e => e.e === 'boom');
  assert.equal(booms.length, 2, `expected the bomb and the keg, got ${booms.length}`);
  assert.equal(booms[0].r, 3, 'the first boom should be the bomb that lit it');
  assert.equal(booms[1].r, POWDER_RADIUS, 'the keg did not blast at its own radius');
  assert.deepEqual([booms[1].x, booms[1].y], [6, 4], 'the keg blasted somewhere else');
  assert.equal(booms[1].tick, booms[0].tick, 'the keg waited a fuse instead of going off now');

  // Reach: POWDER_RADIUS tiles each way from the keg, in an empty room.
  assert.ok(s.fires.some(f => f.tx === 6 + POWDER_RADIUS && f.ty === 4),
    'the keg blast did not reach its full radius');
  assert.equal(tileAt(s.map, 6, 4), BLOCK.FLOOR, 'the keg is still standing');
});

test('kegs chain into each other', () => {
  // Two kegs in a line is the thing that makes them worth hunting for, and it falls out of
  // putting the keg on the same queue as any other chained bomb rather than being coded for.
  const s = createState(ROOM);
  setTile(s.map, 6, 4, BLOCK.POWDER, BLOCK_HP[BLOCK.POWDER]);
  setTile(s.map, 6 + POWDER_RADIUS, 4, BLOCK.POWDER, BLOCK_HP[BLOCK.POWDER]);
  s.bombs.push({ id: s.nextBombId++, tx: 4, ty: 4, owner: 0, radius: 3, at: 0 });

  detonate(s);
  const booms = s.events.filter(e => e.e === 'boom');
  assert.equal(booms.length, 3, `the second keg did not chain (${booms.length} booms)`);
});

test('a keg drops no perk — it holds powder', () => {
  const s = createState(ROOM);
  setTile(s.map, 6, 4, BLOCK.POWDER, BLOCK_HP[BLOCK.POWDER]);
  s.bombs.push({ id: s.nextBombId++, tx: 4, ty: 4, owner: 0, radius: 3, at: 0 });
  detonate(s);
  assert.equal(s.perks.filter(k => k.tx === 6 && k.ty === 4).length, 0);
});

test('at most two a round, and never more however long it runs', () => {
  const s = createState(ROOM);
  // Run a whole round's worth of regrowth cycles with nobody on the map.
  for (let t = 0; t <= ROUND_TICKS; t += REGEN_EVERY_TICKS) {
    s.tick = t;
    regenerate(s);
  }
  assert.ok(s.powderPlaced <= POWDER_MAX_PER_ROUND,
    `placed ${s.powderPlaced}, cap is ${POWDER_MAX_PER_ROUND}`);
});

test('one is guaranteed, even when every roll goes against it', () => {
  // Past the guarantee tick the roll must stop being a roll, or a round can pass with nothing.
  //
  // A real map, not the test room: sixteen spawn rings in a 23x7 box cover almost every tile in
  // it, so "no quiet tile anywhere" would be a property of that fixture rather than of the rule.
  const s = createState(MAPS[0]);
  // The first next() of a cycle is the 12% roll, so force that one to fail every time and leave
  // the rest alone — tile selection still needs usable randomness, and an rng clamped to half
  // the range would starve it rather than test the guarantee.
  const real = s.next;
  let firstOfCycle = true;
  s.next = () => {
    if (firstOfCycle) { firstOfCycle = false; return 0.99; }
    return real();
  };
  for (let t = 0; t <= ROUND_TICKS; t += REGEN_EVERY_TICKS) {
    s.tick = t;
    firstOfCycle = true;
    regenerate(s);
  }
  assert.ok(s.powderPlaced >= 1, 'a whole round passed without a single keg');
  assert.ok(POWDER_GUARANTEE_TICK < ROUND_TICKS, 'the guarantee lands after the round ends');
});

test('a keg never lands on top of somebody', () => {
  // Being handed a free kill you could not have read is worse than never seeing a keg at all.
  const s = createState(ROOM);
  const p = createPlayer(0, 'p0');
  p.x = tileCentre(12); p.y = tileCentre(4); p.alive = true;
  s.players[0] = p;
  s.next = () => 0;                      // every roll succeeds: place as many as allowed
  for (let t = REGEN_EVERY_TICKS; t <= ROUND_TICKS; t += REGEN_EVERY_TICKS) {
    s.tick = t;
    regenerate(s);
  }
  for (let ty = 0; ty < ROOM.h; ty++) {
    for (let tx = 0; tx < ROOM.w; tx++) {
      if (tileAt(s.map, tx, ty) !== BLOCK.POWDER) continue;
      assert.ok(Math.abs(tx - 12) > 1 || Math.abs(ty - 4) > 1,
        `a keg appeared at ${tx},${ty}, right next to the player at 12,4`);
    }
  }
});

// ─── stamina ──────────────────────────────────────────────────────────────────

test('running empties it, and standing still refills twice as fast as limping', () => {
  const s = createState(ROOM);
  const p = createPlayer(0, 'p0');
  p.x = tileCentre(3); p.y = tileCentre(4); p.alive = true;
  s.players[0] = p;

  // Ten seconds of running at one a tick.
  assert.equal(p.stamina, STAMINA_MAX);
  for (let n = 0; n < STAMINA_MAX; n++) stamina(p, true);
  assert.equal(p.stamina, 0);
  assert.equal(p.tired, true, 'empty but not tired');

  // Limping refills, slowly. Standing still refills faster.
  const limp = (() => { const before = p.stamina; stamina(p, true); return p.stamina - before; })();
  const rest = (() => { const before = p.stamina; stamina(p, false); return p.stamina - before; })();
  assert.ok(rest > limp, `resting (${rest}) should beat limping (${limp})`);
});

test('tired has hysteresis, so the speed cannot flip every tick', () => {
  // Without the latch, "zero means slow" toggles on and off at the boundary: one tick you
  // regain a point and sprint, the next you spend it and crawl. It reads as packet loss.
  const s = createState(ROOM);
  const p = createPlayer(0, 'p0');
  for (let n = 0; n < STAMINA_MAX; n++) stamina(p, true);
  assert.equal(p.tired, true);

  // Over a long run it legitimately flips more than once: you recover to the threshold, sprint
  // the recovery away, and tire again. What must never happen is two flips close together.
  let was = p.tired, lastFlip = -999, closest = Infinity;
  for (let n = 0; n < 600; n++) {
    stamina(p, true);
    if (p.tired === was) continue;
    closest = Math.min(closest, n - lastFlip);
    lastFlip = n;
    was = p.tired;
  }
  assert.ok(closest >= STAMINA_RECOVER_UNITS,
    `tired flipped twice only ${closest} ticks apart; the latch is not holding`);
});

test('being tired halves your pace, and stim raises the ceiling', () => {
  const fresh = createPlayer(0, 'p0');
  const tired = createPlayer(1, 'p1');
  tired.tired = true;
  assert.ok(speedOf(tired) < speedOf(fresh), 'exhaustion did not slow anybody down');

  const stimmed = createPlayer(2, 'p2');
  assert.equal(staminaMaxFor(stimmed), STAMINA_MAX);
  stimmed.staminaLevel = MAX_STAMINA_LEVELS;
  assert.ok(staminaMaxFor(stimmed) > STAMINA_MAX, 'stim did nothing');
  // And the cap holds however many are collected.
  stimmed.staminaLevel = MAX_STAMINA_LEVELS + 5;
  assert.equal(staminaMaxFor(stimmed), staminaMaxFor({ staminaLevel: MAX_STAMINA_LEVELS }));
});
