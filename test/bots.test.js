// Bots, measured the way STATUS.md quotes them: per bot per minute, over every map.
//
// Thresholds are loose on purpose — bot thinking uses Math.random, so this is a tripwire for a
// regression of the size that matters, not a benchmark. For real numbers: node server/botbench.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { bench } from '../server/botbench.js';

test('bots mostly die to each other, not to themselves', () => {
  // Measured: 0.17 suicides and 0.45 kills per bot per minute. Before the steering fix in ai.js
  // it was 2.3 suicides and 0.33 kills — 87% of all deaths were self-inflicted.
  const { totals } = bench({ minutes: 2, bots: 15 });
  const perMin = n => n / totals.botMinutes;
  assert.ok(perMin(totals.suicides) < 0.6, `suicides ${perMin(totals.suicides).toFixed(2)}/bot/min`);
  assert.ok(perMin(totals.kills) > 0.2, `kills ${perMin(totals.kills).toFixed(2)}/bot/min — bots stopped fighting`);
});
