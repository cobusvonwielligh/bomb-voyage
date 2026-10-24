// Perks are fireproof, and the drop rate answers to the board.
//
// The two are related: once a blast can no longer eat a drop, the only thing stopping the floor
// filling up with perks is the rate itself, so the rate has to actually respond.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick as stepRound } from '../shared/sim/round.js';
import { createState } from '../shared/sim/state.js';
import { dropChance, perkTarget, collect, drop, maybeDrop } from '../shared/sim/perks.js';
import { tileCentre, createPlayer } from '../shared/sim/state.js';
import * as perks from '../shared/sim/perks.js';
import {
  PERK, PERK_DROP_CHANCE_SOFT, PERK_GLUT_FLOOR, PERK_SCARCE_BOOST, PERK_TARGET_MIN,
  HITBOX_UNITS, TICK_HZ, PERK_EXPIRE_TICKS, PERK_FADE_TICKS,
  GOLD_MAX_PER_ROUND, SCORE,
} from '../shared/constants.js';
import { MAPS, buildMap, cellType } from '../shared/maps.js';
import { PERK_WEIGHTS, BLOCK } from '../shared/constants.js';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const fresh = () => createState(MAPS[0], 99);

test('nothing burns perks any more', () => {
  // The whole mechanic is gone, not merely disabled: a dormant burnPerks sitting in the module
  // is one import away from coming back.
  assert.equal(perks.burnPerks, undefined, 'burnPerks is still exported');
});

test('a perk sitting in a blast survives it', () => {
  const s = fresh();
  s.perks.push({ id: 1, tx: 5, ty: 5, type: PERK.FIRE, until: s.tick + 10_000 });
  s.fires.push({ tx: 5, ty: 5, until: s.tick + 30 });
  for (let n = 0; n < 5; n++) stepRound(s, []);
  assert.equal(s.perks.length, 1, 'the fire ate the perk');
});

test('an empty floor drops far more often than a full one', () => {
  const s = fresh();
  const bare = dropChance(s);
  assert.ok(bare > PERK_DROP_CHANCE_SOFT,
    `an empty board should beat the base rate, got ${bare} vs ${PERK_DROP_CHANCE_SOFT}`);

  // Past target. The target floors at PERK_TARGET_MIN with nobody alive.
  assert.equal(perkTarget(s), PERK_TARGET_MIN);
  for (let i = 0; i < PERK_TARGET_MIN + 2; i++) {
    s.perks.push({ id: i + 1, tx: i, ty: 1, type: PERK.BOMB, until: s.tick + 10_000 });
  }
  const glut = dropChance(s);
  assert.ok(glut < bare, 'a full board should drop less than an empty one');
  assert.ok(glut <= PERK_DROP_CHANCE_SOFT * PERK_GLUT_FLOOR * 1.81,
    `a glutted board is still dropping at ${glut}`);
  assert.ok(bare <= PERK_DROP_CHANCE_SOFT * PERK_SCARCE_BOOST * 1.81,
    'the boost has exceeded supply x demand');
});

test('the target scales with players alive, so sixteen people see more perks than three', () => {
  const s = fresh();
  const mk = i => ({ i, alive: true, x: 0, y: 0, bombs: 1, radius: 1, speed: 0, shields: 0, score: 0 });
  s.players = Array.from({ length: 3 }, (_, i) => mk(i));
  const few = perkTarget(s);
  s.players = Array.from({ length: 16 }, (_, i) => mk(i));
  assert.ok(perkTarget(s) > few, 'the target ignored the extra thirteen players');
});

test('picking perks up lifts the rate, and it decays back down', () => {
  const s = fresh();
  const quiet = dropChance(s);

  // One player standing on four perks in turn.
  const p = { i: 0, alive: true, x: HITBOX_UNITS, y: HITBOX_UNITS, bombs: 1, radius: 1, speed: 0, shields: 0, score: 0 };
  s.players = [p];
  const tx = p.x >> 8, ty = p.y >> 8;
  for (let n = 0; n < 4; n++) {
    s.perks.length = 0;
    drop(s, tx, ty, PERK.BOMB);
    collect(s);
  }
  assert.equal(s.perks.length, 0, 'the perks were not actually collected');
  const busy = dropChance(s);
  assert.ok(busy > quiet, `demand did not lift the rate: ${busy} vs ${quiet}`);

  // A minute of nobody taking anything puts it back to within a percent of the quiet rate.
  for (let n = 0; n < 60 * TICK_HZ; n++) collect(s);
  assert.ok(Math.abs(dropChance(s) - quiet) / quiet < 0.01,
    `the take rate never decayed back, still ${dropChance(s)} against ${quiet}`);
});

test('the rate decays even while the floor is bare', () => {
  // collect() returns early with no perks on the board. If the decay sat after that return, a
  // board stripped clean would keep its demand boost forever.
  const s = fresh();
  s.perkTakeRate = 10;
  for (let n = 0; n < 8 * TICK_HZ; n++) collect(s);
  assert.ok(s.perkTakeRate < 5.1, `rate stuck at ${s.perkTakeRate} with an empty floor`);
});

test('the wire carries `until`, which is what the fade is drawn from', () => {
  // render.js fades a perk over its last PERK_FADE_TICKS. That is only possible because the
  // whole perk object goes out in the snapshot; trimming it to {id,tx,ty,type} to save bytes
  // would silently turn the fade off rather than break anything loudly.
  const s = fresh();
  drop(s, 4, 4, PERK.FIRE);
  const [k] = s.perks;
  assert.ok(Number.isFinite(k.until), 'a dropped perk has no expiry');
  assert.equal(k.until, s.tick + PERK_EXPIRE_TICKS);
  assert.ok(PERK_FADE_TICKS < PERK_EXPIRE_TICKS, 'a perk would be fading from the moment it lands');
});

test('every perk that can drop has its own colour, silhouette and floating label', () => {
  // Three independent channels, because each one fails at a different distance: hue survives
  // the zoom floor, the silhouette survives a dark tile, the detail only works up close. If two
  // perks ever shared a skin they would be indistinguishable in exactly the situation that
  // matters — glancing at the floor mid-chase.
  // art.js is read as text, not imported: it uses the browser's /shared/... absolute specifier,
  // which Node cannot resolve.
  const art = read('public/assets/art.js');
  const main = read('public/client/main.js');
  const droppable = Object.entries(PERK_WEIGHTS).filter(([, w]) => w > 0).map(([t]) => +t);
  assert.ok(droppable.length >= 3, `only ${droppable.length} perks are live`);

  const skins = new Set();
  for (const t of droppable) {
    assert.match(art, new RegExp(`\\n  ${t}: c =>`), `perk ${t} has no icon`);
    assert.match(art, new RegExp(`\\n  ${t}: \\{ dark:`), `perk ${t} has no plinth skin`);
    const label = main.match(new RegExp(t + ": \\{ text: '([^']+)', colour: '([^']+)' \\}"));
    assert.ok(label, `perk ${t} has no floating label in main.js`);
    assert.ok(label[1].length <= 9, `"${label[1]}" is too long to read in passing`);
    skins.add(label[2]);
  }
  assert.equal(skins.size, droppable.length, 'two perks share a colour');
});

test('the zoom frames the island, not the grid it is drawn in', () => {
  // Every map but Arena is a shape inside its rectangle, and the rest of the grid is WATER.
  // Fitting the rectangle fits a frame of ocean that is already several tiles thick before the
  // margin is added, which is what made Cove render a small island in a sea of empty blue.
  const render = read('public/client/render.js');
  assert.match(render, /function landBounds\(\)/, 'render.js no longer measures the land');
  assert.match(render, /const \[, , lw, lh\] = landBounds\(\)/,
    'recomputeZoom is not using the land bounds');
  assert.ok(!/view\.w \/ \(\(world\.map\.w \+ m\)/.test(render),
    'the zoom is still fitted to the map rectangle');

  // And the numbers, measured from the real maps.
  const worst = MAPS.map(m => {
    const map = buildMap(m);
    let x0 = m.w, y0 = m.h, x1 = -1, y1 = -1;
    for (let ty = 0; ty < m.h; ty++) {
      for (let tx = 0; tx < m.w; tx++) {
        if (cellType(map.cells[ty * m.w + tx]) === BLOCK.WATER) continue;
        if (tx < x0) x0 = tx; if (tx > x1) x1 = tx;
        if (ty < y0) y0 = ty; if (ty > y1) y1 = ty;
      }
    }
    return { id: m.id, slackW: m.w - (x1 - x0 + 1), slackH: m.h - (y1 - y0 + 1) };
  });
  // At least one map has real slack, or this change would be pointless and the test vacuous.
  assert.ok(worst.some(w => w.slackW >= 4 || w.slackH >= 4),
    `no map has unused grid; measured ${JSON.stringify(worst)}`);
});

test('the sea boulders are placed against the view, with a visibility guarantee', () => {
  // Dropping them a fixed distance beyond the island put them off the frame entirely on a wide
  // window and on top of the coast on a narrow one. The rule is now explicit: one entirely on
  // screen, the rest at least a fifth on screen.
  const render = read('public/client/render.js');
  assert.match(render, /const ROCK_FULLY_VISIBLE = 1;/);
  assert.match(render, /const ROCK_MIN_VISIBLE = 0\.2;/);
  assert.match(render, /const SEA_ROCKS = 3;/, 'never more than three');
  // The fully-visible one must take the axis with the most room, or the guarantee fails the
  // moment the window is wider than it is tall.
  assert.match(render, /const widest = bandOn\(0\) >= bandOn\(1\)/,
    'the fully-visible rock no longer picks the roomiest side');
  // And its slide along the shore must be clamped, which is the easy way to lose a guarantee
  // you only checked on one axis.
  assert.match(render, /Math\.max\(0, spread - r\)/, 'the along-shore slide is unclamped');
});

// ─── gold coins ───────────────────────────────────────────────────────────────

test('gold is capped per round, and the cap counts drops rather than pickups', () => {
  /* Two limits do two jobs. The WEIGHT makes any one coin a surprise; the CAP makes the
   * surprise finite, so a long round on a wall-heavy map cannot pay out five times what a short
   * one on a sparse map does. Without the cap the reward is a function of the map.
   *
   * Counted on the DROP: a coin nobody reached was still gold this round contained. Counting
   * pickups instead would let an expired coin quietly refund itself, and a round could hand out
   * far more than five.
   */
  const s = fresh();
  for (let i = 0; i < GOLD_MAX_PER_ROUND + 4; i++) drop(s, 1 + i * 2, 1, PERK.GOLD);
  assert.equal(s.goldDropped, GOLD_MAX_PER_ROUND + 4,
    'drop() is the primitive and does not enforce the cap — the roll does');

  // The roll is where the cap lives. Once it is hit, no amount of breaking walls produces gold.
  const r = fresh();
  r.goldDropped = GOLD_MAX_PER_ROUND;
  let coins = 0;
  for (let i = 0; i < 4000; i++) {
    const before = r.perks.length;
    maybeDrop(r, (i % 30) + 2, ((i / 30) | 0) + 2, BLOCK.SOFT);
    if (r.perks.length > before && r.perks[r.perks.length - 1].type === PERK.GOLD) coins++;
    r.perks.length = 0;                      // keep the supply-and-demand rate out of it
  }
  assert.equal(coins, 0, `${coins} coins dropped after the cap was reached`);
});

test('gold is rare, and rarer than rum', () => {
  const total = Object.values(PERK_WEIGHTS).reduce((n, w) => n + w, 0);
  const share = PERK_WEIGHTS[PERK.GOLD] / total;
  assert.ok(share > 0.015 && share < 0.03, `gold is ${(share * 100).toFixed(2)}% of drops, wanted ~2%`);
  assert.ok(PERK_WEIGHTS[PERK.GOLD] < PERK_WEIGHTS[PERK.RUM],
    'gold should be the rarest thing on the board');
});

test('a coin pays XP and changes nothing else about you', () => {
  // The whole design: every other perk makes you better at THIS round, and this one does not.
  const s = fresh();
  const p = createPlayer(0, 'p');
  p.alive = true;
  p.x = tileCentre(3); p.y = tileCentre(3);
  s.players[0] = p;
  const before = {
    bombs: p.bombs, radius: p.radius, speed: p.speed, shields: p.shields,
    stamina: p.stamina, status: p.status,
  };
  drop(s, 3, 3, PERK.GOLD);
  collect(s);

  assert.equal(p.gold, 1, 'the coin was not collected');
  assert.equal(p.score, SCORE.GOLD, `a coin paid ${p.score}, wanted ${SCORE.GOLD}`);
  for (const [k, v] of Object.entries(before)) {
    assert.equal(p[k], v, `collecting gold changed ${k}, which it must not`);
  }
});
