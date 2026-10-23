// The mascot's speech bubble.
//
// No DOM here: createQuips takes the element, the clock and the RNG, so the rules it enforces —
// the cooldown, the forced lines, the name substitution — are testable as plain functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuips, QUIPS, ON_DEATH, ON_SPAWN, MIN_GAP_MS, SHOW_MS } from '../public/client/quips.js';

function harness({ name = 'cobusvw', rolls = [] } = {}) {
  let t = 0;
  let i = 0;
  const shown = [];
  const el = {
    textContent: '', offsetWidth: 0,
    classList: { add: c => shown.push(`+${c}`), remove: c => shown.push(`-${c}`) },
  };
  const q = createQuips({
    el,
    nameOf: () => name,
    now: () => t,
    random: () => (i < rolls.length ? rolls[i++] : 0),
  });
  return { q, el, shown, advance: ms => { t += ms; }, at: () => t };
}

test('{n} is replaced with the player name, everywhere it appears', () => {
  for (const line of [...QUIPS, ...ON_SPAWN]) {
    const { q } = harness();
    const said = q.say([line]);
    assert.ok(!said.includes('{n}'), `"${line}" left a placeholder behind`);
  }
});

test('a player with no name yet still gets a sentence, not a hole', () => {
  const { q } = harness({ name: '' });
  assert.match(q.say(['Steady on, {n}.']), /Steady on, captain\./);
});

test('idle lines respect the cooldown; death and spawn never do', () => {
  // The cooldown is what stops the corner becoming a chatterbox. It must not apply to the two
  // lines that are reactions: a death quip swallowed by a timer looks like a broken feature.
  const { q, advance } = harness();
  assert.ok(q.say(QUIPS), 'the first line should always come out');
  advance(SHOW_MS + 10);
  assert.equal(q.say(QUIPS), null, 'a second idle line inside the gap must be dropped');
  assert.ok(q.died(), 'death is forced and must come out regardless');
  assert.ok(q.spawned(), 'so is respawning');
  advance(MIN_GAP_MS);
  assert.ok(q.say(QUIPS), 'past the gap, idle lines resume');
});

test('the bubble is shown, then hidden exactly SHOW_MS later', () => {
  const { q, el, shown, advance } = harness();
  q.died();
  assert.ok(ON_DEATH.includes(el.textContent), `unexpected death line ${el.textContent}`);
  // remove-then-add is what restarts the CSS animation; without it a second quip inside the
  // window would appear with no pop.
  assert.deepEqual(shown, ['-show', '+show']);

  q.tick();
  assert.deepEqual(shown, ['-show', '+show'], 'hidden early');
  advance(SHOW_MS);
  q.tick();
  assert.equal(shown.at(-1), '-show', 'the bubble never came down');
  q.tick();
  assert.equal(shown.filter(s => s === '-show').length, 2, 'hiding repeated every frame');
});

test('the same line never comes out twice running', () => {
  // Twenty lines feels like plenty until the birthday problem gets involved, and a repeat is the
  // one thing that makes a random line read as a bug.
  const { q } = harness({ rolls: [0, 0, 0.5] });
  const first = q.say(QUIPS, { force: true });
  const second = q.say(QUIPS, { force: true });
  assert.notEqual(second, first);
});

test('there are twenty idle lines and none of them are duplicates', () => {
  assert.equal(QUIPS.length, 20);
  assert.equal(new Set(QUIPS).size, 20);
  assert.ok(ON_DEATH.every(l => /oof/i.test(l)), 'the death line is meant to be "oof"');
  assert.ok(ON_SPAWN.some(l => /let's go/i.test(l)), 'the spawn line is meant to be "lets go"');
});
