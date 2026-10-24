// Sound effects cannot run in Node — they need an AudioContext — so this checks the one thing
// that actually breaks: a name mismatch. `sfx.play('bom')` is silent, throws nothing, and looks
// exactly like working code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERK } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const sfxSrc = read('public/client/audio/sfx.js');
const mainSrc = read('public/client/main.js');

/** Voice names, taken from the VOICES object literal — bounded, or this also catches the
 *  public surface further down the file, whose members sit at the same indentation. */
function declaredVoices() {
  const from = sfxSrc.indexOf('const VOICES = {');
  assert.ok(from > 0, 'VOICES not found');
  const to = sfxSrc.indexOf('\n  };', from);
  assert.ok(to > from, 'end of VOICES not found');
  const body = sfxSrc.slice(from, to);
  // Top-level keys: a name at four-space indentation followed by `(`.
  return new Set([...body.matchAll(/^ {4}([a-zA-Z]\w*)\(/gm)].map(m => m[1]));
}

// Two sounds are triggered by name rather than by a literal: `boom` through world.onBoom, and
// the block sounds through `sfx.play(e.e, ...)` where the event name IS the sound name.
const DYNAMIC = ['boom', 'blockdie', 'blocknew'];

/**
 * Every name main.js asks for, from either play() or playAtUnits().
 *
 * Reads the whole FIRST ARGUMENT and pulls every quoted string out of it, rather than matching a
 * bare literal right after the paren. The naive version missed
 * `sfx.play(mentioned ? 'mention' : 'chat')` entirely and reported both voices as dead code —
 * which is exactly backwards, and the sort of false positive that gets a test deleted.
 */
function requestedVoices() {
  const names = new Set();
  for (const m of mainSrc.matchAll(/\bsfx\.play(?:AtUnits)?\(([^,)]*)/g)) {
    for (const q of m[1].matchAll(/'([a-zA-Z]\w*)'/g)) names.add(q[1]);
  }
  return names;
}

test('the dynamic sound names line up with the events that trigger them', () => {
  // `sfx.play(e.e, ...)` is only correct while the sim's event names and the voice names agree.
  for (const n of ['blockdie', 'blocknew']) {
    assert.ok(declaredVoices().has(n), `no voice named ${n}`);
    assert.ok(read('shared/sim/blocks.js').includes(`e: '${n}'`),
      `main.js plays sounds by event name, but no event is called ${n}`);
  }
});

test('every sound main.js asks for exists', () => {
  const have = declaredVoices();
  const want = requestedVoices();
  assert.ok(want.size >= 10, `expected main.js to use the sound set; found ${want.size}`);
  const missing = [...want].filter(n => !have.has(n));
  assert.deepEqual(missing, [], `main.js plays sounds that sfx.js does not define: ${missing}`);
});

test('every sound sfx.js defines is actually used', () => {
  const have = declaredVoices();
  const want = requestedVoices();
  for (const n of DYNAMIC) want.add(n);
  const unused = [...have].filter(n => !want.has(n));
  assert.deepEqual(unused, [], `sfx.js defines sounds nothing plays: ${unused}`);
});

test('CLOSE_UP names are all real voices', () => {
  const have = declaredVoices();
  const block = sfxSrc.match(/const CLOSE_UP = new Set\(\[([^\]]*)\]/s);
  assert.ok(block, 'CLOSE_UP set not found');
  const names = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(names.length > 0);
  assert.deepEqual(names.filter(n => !have.has(n)), [],
    'CLOSE_UP lists a sound that does not exist, so it would be panned after all');
});

test('MAX_PER_FRAME keys are all real voices', () => {
  const have = declaredVoices();
  const block = sfxSrc.match(/const MAX_PER_FRAME = \{([^}]*)\}/s);
  assert.ok(block, 'MAX_PER_FRAME not found');
  const names = [...block[1].matchAll(/(\w+):/g)].map(m => m[1]);
  assert.deepEqual(names.filter(n => !have.has(n)), [],
    'MAX_PER_FRAME caps a sound that does not exist, so the real one is uncapped');
});

test('every perk that can drop has its own pickup interval', () => {
  // A perk with no entry falls back to a generic two-note blip, which is fine — but the four
  // original upgrades should each be distinguishable. Rum has its own voice (glug).
  const block = sfxSrc.slice(sfxSrc.indexOf('const PERK_NOTES = {'));
  for (const name of ['BOMB', 'FIRE', 'SKATE', 'SHIELD']) {
    assert.ok(block.includes(`[PERK.${name}]`), `no pickup sound for ${name}`);
    assert.ok(PERK[name] !== undefined, `PERK.${name} does not exist`);
  }
});

test('hz() is only ever given a MIDI note number', () => {
  // hz(midi) is 440 * 2^((midi-69)/12). Handing it a frequency compiles, stays finite in JS,
  // and then overflows float32 inside the AudioParam: hz(5000) is 1e126, which the browser
  // rejects as "non-finite" at the setValueAtTime call. MIDI stops at 127, so anything above
  // that is a frequency somebody passed to the wrong function.
  const bad = [...sfxSrc.matchAll(/\bhz\(\s*([\d.]+)/g)]
    .map(m => Number(m[1]))
    .filter(n => n > 127);
  assert.deepEqual(bad, [], `hz() called with frequencies, not MIDI notes: ${bad}`);
});

test('no AudioParam ramp or set is given a value that cannot survive float32', () => {
  // The same failure, caught at the other end: a literal too big for a 32-bit float becomes
  // Infinity the moment it reaches the audio graph.
  const calls = [...sfxSrc.matchAll(/(?:setValueAtTime|exponentialRampToValueAtTime|linearRampToValueAtTime)\(\s*([\d.e+]+)/g)]
    .map(m => Number(m[1]))
    .filter(n => Number.isFinite(n) && !Number.isFinite(Math.fround(n)));
  assert.deepEqual(calls, [], `AudioParam values overflow float32: ${calls}`);
});
