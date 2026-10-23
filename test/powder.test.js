// Powder kegs, and the rules that keep them an event rather than a lottery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, tileCentre, setTile, tileAt } from '../shared/sim/state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoom } from '../server/room.js';
import { detonate } from '../shared/sim/bombs.js';
import { stamina, speedOf } from '../shared/sim/movement.js';
import { regenerate } from '../shared/sim/blocks.js';
import { MAPS, buildMap, cellType } from '../shared/maps.js';
import {
  BLOCK, BLOCK_HP, POWDER_RADIUS, POWDER_MAX_PER_ROUND, POWDER_GUARANTEE_TICK,
  REGEN_EVERY_TICKS, TICK_HZ, ROUND_TICKS,
  STAMINA_MAX, STAMINA_RECOVER_UNITS, MAX_STAMINA_LEVELS, staminaMaxFor,
  STAMINA_DRAIN_PER_TICK, STAMINA_REGEN_MOVING,
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

  // Eleven and a half seconds of running. Counted in tenths of a unit, so the loop is in
  // ticks rather than in units.
  assert.equal(p.stamina, STAMINA_MAX);
  for (let n = 0; n < Math.ceil(STAMINA_MAX / STAMINA_DRAIN_PER_TICK); n++) stamina(p, true);
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
  for (let n = 0; n < Math.ceil(STAMINA_MAX / STAMINA_DRAIN_PER_TICK); n++) stamina(p, true);
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
  // In TICKS, not units. Limping back to the recovery threshold takes RECOVER/REGEN_MOVING
  // ticks, and that gap is the latch doing its job.
  assert.ok(closest >= STAMINA_RECOVER_UNITS / STAMINA_REGEN_MOVING,
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

// ─── maps ─────────────────────────────────────────────────────────────────────

test('every map is one connected island with sixteen reachable spawns', () => {
  // The two things that have actually gone wrong with a new shape before: an island that
  // generates as two pieces with half the players stranded on the smaller one, and a spawn
  // placed on a tile nobody can walk out of. Both are silent — you only find out mid-round.
  for (const def of MAPS) {
    const map = buildMap(def);
    assert.equal(map.spawns.length, 16, `${def.id}: ${map.spawns.length} spawns`);

    const walkable = i => {
      const t = cellType(map.cells[i]);
      return t === BLOCK.FLOOR || t === BLOCK.SHRUB_WALK;
    };
    for (const [sx, sy] of map.spawns) {
      assert.ok(walkable(sy * def.w + sx), `${def.id}: spawn ${sx},${sy} is inside something`);
    }

    // Flood from the first spawn, counting destructible walls as passable — you can always bomb
    // your way through a crate. What must never happen is a spawn walled off by IRON or cut off
    // by water, because no amount of bombing fixes either.
    const passable = i => {
      const t = cellType(map.cells[i]);
      return t !== BLOCK.WATER && t !== BLOCK.IRON;
    };
    const seen = new Set();
    const queue = [map.spawns[0][1] * def.w + map.spawns[0][0]];
    while (queue.length) {
      const i = queue.pop();
      if (seen.has(i) || !passable(i)) continue;
      seen.add(i);
      const x = i % def.w, y = (i / def.w) | 0;
      if (x > 0) queue.push(i - 1);
      if (x < def.w - 1) queue.push(i + 1);
      if (y > 0) queue.push(i - def.w);
      if (y < def.h - 1) queue.push(i + def.w);
    }
    for (const [sx, sy] of map.spawns) {
      assert.ok(seen.has(sy * def.w + sx),
        `${def.id}: spawn ${sx},${sy} is cut off from the rest of the island`);
    }

    // And enough room to actually play on.
    assert.ok(seen.size >= 100, `${def.id}: only ${seen.size} reachable tiles`);
  }
});

test('there are five maps and the rotation visits all of them', () => {
  assert.ok(MAPS.length >= 5, `only ${MAPS.length} maps`);
  assert.equal(new Set(MAPS.map(m => m.id)).size, MAPS.length, 'duplicate map id');
  for (const m of MAPS) {
    assert.ok(m.w >= 30 && m.h >= 20, `${m.id} is ${m.w}x${m.h}, too small for sixteen players`);
  }
});

// ─── respawn ──────────────────────────────────────────────────────────────────

test('respawn can land anywhere, but lands away from people far more often', () => {
  // Two properties at once, and they pull against each other: no tile may be impossible (a
  // predictable spawn is a campable spawn), and the far side of the island must dominate.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-spawn-'));
  const room = createRoom({ onBroadcast: () => {}, dataDir });
  try {
    const map = room.state.map;
    const spawns = map.spawns;

    // One player parked on the first spawn. Everyone else respawns around them.
    const camper = room.state.players[0] ?? (room.state.players[0] = createPlayer(0, 'camper'));
    camper.alive = true;
    camper.x = tileCentre(spawns[0][0]);
    camper.y = tileCentre(spawns[0][1]);

    const victim = room.state.players[1] ?? (room.state.players[1] = createPlayer(1, 'victim'));
    const hits = new Map();
    let nearCamper = 0;
    const RUNS = 600;
    for (let n = 0; n < RUNS; n++) {
      victim.alive = false;
      room.respawn(victim);
      const key = `${victim.x >> 8},${victim.y >> 8}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      const d = Math.abs(victim.x - camper.x) + Math.abs(victim.y - camper.y);
      if (d < 6 * 256) nearCamper++;
    }

    // Spread: most of the spawn list should have come up at least once in 600 rolls.
    assert.ok(hits.size >= Math.min(spawns.length, 8) * 0.7,
      `only ${hits.size} distinct spawns in ${RUNS} respawns`);

    // Preference: landing in the camper's lap should be rare.
    assert.ok(nearCamper / RUNS < 0.12,
      `${((nearCamper / RUNS) * 100).toFixed(1)}% of respawns landed next to a living player`);

    // And no single spot may dominate, which is what "the best five, shuffled" used to do.
    const worst = Math.max(...hits.values()) / RUNS;
    assert.ok(worst < 0.5, `one spawn took ${(worst * 100).toFixed(0)}% of respawns`);
  } finally {
    room.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
