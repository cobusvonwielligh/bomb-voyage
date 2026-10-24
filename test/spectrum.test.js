// The analysis behind both visualisers and the reactive sea.
//
// This is the one piece of the audio stack that is pure arithmetic — no AudioContext, no canvas,
// no clock — so it is the one piece that can actually be tested rather than looked at. Every
// property below is something that LOOKS fine while being wrong: bars that fall at the wrong
// speed on a 144 Hz monitor, bands that all report the same value, caps that never come down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpectrum } from '../public/client/audio/spectrum.js';

/** A stand-in analyser whose bins you set directly. */
function fakeAnalyser(fill, { fftSize = 4096, sampleRate = 48000 } = {}) {
  const bins = fftSize / 2;
  return {
    fftSize,
    frequencyBinCount: bins,
    context: { sampleRate },
    getByteFrequencyData(out) {
      for (let i = 0; i < bins; i++) out[i] = fill(i, bins);
    },
  };
}

const flat = v => fakeAnalyser(() => v);
const silent = flat(0);

test('a band reports its loudest bin, not the average of them', () => {
  // One hot bin in an otherwise silent spectrum. With an average it would all but vanish; the
  // band it lands in should read loud, because that band contains a loud note.
  const s = createSpectrum({ bands: 8, tilt: 0 });
  // Bin 300 of 2048 at 48 kHz is about 3.5 kHz — comfortably inside the 55 Hz–14 kHz range the
  // bands cover. Picking one outside it reports zero everywhere, which is correct behaviour and
  // a useless test.
  const spike = fakeAnalyser((i) => (i === 300 ? 255 : 0));
  for (let i = 0; i < 60; i++) s.read(spike, 16.7);
  const loud = [...s.level].filter(v => v > 0.5);
  assert.equal(loud.length, 1, `expected exactly one loud band, got ${[...s.level].map(v => v.toFixed(2))}`);
});

test('every band owns at least one bin of its own', () => {
  /* The bug this guards, and it was real: linear FFT bins mean log-spaced bands below about
   * 500 Hz round to the SAME bin index, so several bars move in perfect lockstep. It reads as a
   * rendering fault and is really an arithmetic one — at fftSize 1024, twenty-two of forty
   * bands had one bin or less. The fix was a bigger FFT and a higher floor, not better drawing.
   *
   * Tested by sweeping a single hot bin across the whole range and counting how many DIFFERENT
   * bands ever light up. Any band that never lights has no bin to call its own. Not by feeding
   * a ramp and counting distinct values — a byte-valued ramp over 2048 bins is itself coarse
   * enough to produce duplicates, which measures the test data rather than the code. */
  const BANDS = 24;
  const lit = new Set();
  for (let bin = 1; bin < 1024; bin += 1) {
    const s = createSpectrum({ bands: BANDS, tilt: 0 });
    const spike = fakeAnalyser(i => (i === bin ? 255 : 0));
    s.read(spike, 16.7);
    let best = -1, bestV = 0.02;
    for (let b = 0; b < BANDS; b++) if (s.level[b] > bestV) { bestV = s.level[b]; best = b; }
    if (best >= 0) lit.add(best);
  }
  assert.equal(lit.size, BANDS,
    `only ${lit.size} of ${BANDS} bands can ever light — the rest share bins with a neighbour`);
});

test('the bands run low to high', () => {
  const s = createSpectrum({ bands: 12, tilt: 0 });
  const low = fakeAnalyser(i => (i < 12 ? 255 : 0));     // ~55-140 Hz
  const high = fakeAnalyser(i => (i > 900 ? 255 : 0));   // ~10 kHz up
  for (let i = 0; i < 30; i++) s.read(low, 16.7);
  assert.ok(s.level[0] > s.level[11], 'a bass-only signal is not lighting the bottom band');
  const t = createSpectrum({ bands: 12, tilt: 0 });
  for (let i = 0; i < 30; i++) t.read(high, 16.7);
  assert.ok(t.level[11] > t.level[0], 'a treble-only signal is not lighting the top band');
});

test('bars snap up and sag down — the asymmetry is the whole look', () => {
  const s = createSpectrum({ bands: 8, tilt: 0 });
  s.read(flat(255), 16.7);
  const afterOneLoudFrame = s.level[0];
  assert.ok(afterOneLoudFrame > 0.4, `rise is too slow: ${afterOneLoudFrame.toFixed(3)} after one frame`);

  for (let i = 0; i < 40; i++) s.read(flat(255), 16.7);
  const peak = s.level[0];
  s.read(silent, 16.7);
  const afterOneQuietFrame = s.level[0];
  const dropped = peak - afterOneQuietFrame;
  assert.ok(dropped < peak * 0.2, `fall is too fast: lost ${(dropped / peak * 100).toFixed(0)}% in one frame`);
});

test('the fall rate is the same at 60 Hz and at 144 Hz', () => {
  /* A per-frame constant — `level *= 0.9` — makes bars fall two and a half times faster on a
   * gaming monitor than on a laptop. Nobody notices until they switch machines, and then the
   * visualiser is simply "wrong on that computer" with no way to say why. */
  const run = (dtMs, frames) => {
    const s = createSpectrum({ bands: 4, tilt: 0 });
    for (let i = 0; i < 100; i++) s.read(flat(255), dtMs);
    for (let i = 0; i < frames; i++) s.read(silent, dtMs);
    return s.level[0];
  };
  const at60 = run(16.7, 30);        // half a second
  const at144 = run(6.94, 72);       // the same half second, more frames
  assert.ok(Math.abs(at60 - at144) < 0.04,
    `fall is frame-rate dependent: 60Hz left ${at60.toFixed(3)}, 144Hz left ${at144.toFixed(3)}`);
});

test('peaks hold above the bar and then come down', () => {
  const s = createSpectrum({ bands: 4, tilt: 0 });
  for (let i = 0; i < 40; i++) s.read(flat(255), 16.7);
  const high = s.peak[0];
  assert.ok(high > 0.8, 'peak did not reach the level');

  s.read(silent, 16.7);
  assert.ok(s.peak[0] >= s.level[0], 'the cap fell below the bar it is capping');

  /* Gravity, not a constant rate — measured EARLY, before it reaches the floor.
   *
   * Comparing two late windows measures the floor rather than the curve: a bounded quantity
   * that has already bottomed out loses nothing in the second window however fast it was
   * accelerating. Ten frames then ten frames, starting from full. */
  const start = s.peak[0];
  for (let i = 0; i < 10; i++) s.read(silent, 16.7);
  const mid = s.peak[0];
  for (let i = 0; i < 10; i++) s.read(silent, 16.7);
  const end = s.peak[0];
  assert.ok(mid > 0.2, `the cap fell too fast to measure: ${mid.toFixed(3)} after ten frames`);
  assert.ok(start - mid < mid - end, 'the cap falls linearly; it should accelerate');

  // Half a second in it should still be well clear of the floor — a cap that is gone before
  // the bar under it has finished falling is not holding anything.
  for (let i = 0; i < 10; i++) s.read(silent, 16.7);
  assert.ok(s.peak[0] > 0.4, `the cap is gone too soon: ${s.peak[0].toFixed(3)} after half a second`);
});

test('the tilt lifts the treble, because music never does', () => {
  const withTilt = createSpectrum({ bands: 16, tilt: 6 });
  const without = createSpectrum({ bands: 16, tilt: 0 });
  const even = flat(90);
  for (let i = 0; i < 60; i++) { withTilt.read(even, 16.7); without.read(even, 16.7); }
  assert.ok(withTilt.level[15] > without.level[15] * 1.2,
    'the tilt is not lifting the top band, so the right-hand half will look dead');
  assert.ok(Math.abs(withTilt.level[0] - without.level[0]) < 0.02,
    'the tilt is changing the BOTTOM band, which it must not: bass is already loud enough');
});

test('everything settles to silence rather than freezing mid-air', () => {
  const s = createSpectrum({ bands: 8, tilt: 0 });
  for (let i = 0; i < 40; i++) s.read(flat(255), 16.7);
  for (let i = 0; i < 300; i++) s.rest(16.7);
  assert.ok(Math.max(...s.level) < 0.01, 'bars did not settle when the music stopped');
  assert.ok(Math.max(...s.peak) < 0.01, 'caps did not settle when the music stopped');
});

test('reading nothing is safe, and the sea has something to fall back to', () => {
  const s = createSpectrum({ bands: 8 });
  assert.equal(s.read(null), false, 'read(null) should report that there was nothing to read');
  for (const k of ['bass', 'mid', 'treble', 'energy']) {
    assert.equal(typeof s[k], 'number', `${k} is not a number before anything has been read`);
    assert.ok(Number.isFinite(s[k]), `${k} is not finite`);
  }
});

test('render.js couples the sea to the music as multipliers, never as the value itself', () => {
  /* The test for whether a reactive effect is tasteful: set the gain to zero and the thing you
   * are driving must be exactly what it was. Every coupling in the sea is `x * (1 + audio)`,
   * so silence is the sea as it always was and there is no branch for the quiet case.
   *
   * The sea is driven by audio/listen.js now (beats and tempo, which this spectrum's smoothing
   * blurs away) rather than by this spectrum, but the promise is the same one. */
  const src = readFileSync(new URL('../public/client/render.js', import.meta.url), 'utf8');
  assert.match(src, /const CALM = \{/, 'there is no resting state for the sea');
  assert.match(src, /setSound\(fn\)/, 'the renderer no longer takes the music');
  // The multipliers start from 1, so silence leaves the water exactly as it was.
  for (const name of ['swell', 'surge']) {
    const assigns = [...src.matchAll(new RegExp(`\\b${name}\\s*=\\s*([^;]+);`, 'g'))].map(m => m[1].trim());
    assert.ok(assigns.length > 0, `the sea no longer uses ${name}`);
    for (const a of assigns) assert.match(a, /^1\b/, `${name} = ${a} is not a multiplier from 1`);
  }
  // The metronome's push is zero until a tempo is trusted, and scaled by how much it is.
  assert.match(src, /tempoA = sound\.lock \*/, 'the tempo wave no longer waits for a lock');
});
