// The level curve.
//
// The brief is explicit: 100 hours to Veteran, and four named tiers at fixed levels. The exponent
// is derived from those rather than tuned, so these tests are what prove the derivation still
// lands where it is supposed to after anybody touches the scoring table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  xpForLevel, levelForXp, progressFor, tierForLevel,
  XP_PER_HOUR, HOURS_TO_VETERAN, VETERAN_LEVEL, SCORE,
} from '../shared/constants.js';

test('Veteran lands on exactly 100 hours', () => {
  const hours = xpForLevel(VETERAN_LEVEL) / XP_PER_HOUR;
  assert.equal(HOURS_TO_VETERAN, 100, 'the brief says 100 hours');
  assert.ok(Math.abs(hours - 100) < 0.5, `Veteran is at ${hours.toFixed(1)} hours`);
});

test('the tiers sit where the brief puts them', () => {
  for (const l of [0, 1, 5, 10]) assert.equal(tierForLevel(l), 'Rookie', `level ${l}`);
  for (const l of [11, 13, 15]) assert.equal(tierForLevel(l), 'Been around the block', `level ${l}`);
  for (const l of [16, 18, 19]) assert.equal(tierForLevel(l), 'Pro', `level ${l}`);
  for (const l of [20, 25, 60]) assert.equal(tierForLevel(l), 'Veteran', `level ${l}`);
});

test('levels only ever get harder', () => {
  let prev = -1, prevCost = -1;
  for (let l = 1; l <= 30; l++) {
    const total = xpForLevel(l);
    assert.ok(total > prev, `level ${l} is not past level ${l - 1}`);
    const cost = total - prev;
    assert.ok(cost > prevCost, `level ${l} costs less than the one before it`);
    prev = total; prevCost = cost;
  }
});

test('levelForXp is the exact inverse at every boundary', () => {
  for (let l = 0; l <= 40; l++) {
    const at = xpForLevel(l);
    assert.equal(levelForXp(at), l, `exactly ${at} XP should be level ${l}`);
    if (l > 0) assert.equal(levelForXp(at - 1), l - 1, `one short of ${at} should still be ${l - 1}`);
  }
});

test('a first level is a minute of play, not an afternoon', () => {
  const minutes = (xpForLevel(1) / XP_PER_HOUR) * 60;
  assert.ok(minutes < 5, `level 1 takes ${minutes.toFixed(1)} minutes`);
});

test('progressFor gives a bar that can actually be drawn', () => {
  const p = progressFor(60_000);
  assert.equal(p.level, levelForXp(60_000));
  assert.equal(p.into + xpForLevel(p.level), p.xp, 'into does not reconstruct the total');
  assert.equal(p.need, xpForLevel(p.level + 1) - xpForLevel(p.level));
  assert.ok(p.fraction >= 0 && p.fraction <= 1);
  assert.equal(p.tier, tierForLevel(p.level));
});

test('zero, negative and junk XP do not break the bar', () => {
  for (const xp of [0, -1, -999, NaN, undefined]) {
    const p = progressFor(xp);
    assert.equal(p.level, 0, `xp ${xp}`);
    assert.ok(Number.isFinite(p.fraction) && p.fraction >= 0, `xp ${xp} gave fraction ${p.fraction}`);
    assert.ok(p.need > 0, 'a zero-width bar would divide by zero somewhere downstream');
  }
});

test('the curve is calibrated against the real scoring table', () => {
  // If somebody doubles the value of a kill, XP_PER_HOUR is the number that has to move with it,
  // and this is the line that says so.
  const perRound = 20 * SCORE.KILL + 150 * SCORE.BLOCK + 40 * SCORE.PERK
                 + SCORE.SURVIVE_ROUND + 10 * SCORE.SUICIDE;
  const perHour = perRound * 6;            // six ten-minute rounds
  assert.ok(perHour > XP_PER_HOUR * 0.8 && perHour < XP_PER_HOUR * 1.5,
    `the scoring table now yields ~${perHour}/hour but the curve assumes ${XP_PER_HOUR}`);
});
