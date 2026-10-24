// The ear the sea listens with. An AnalyserNode is just "fill this array with bytes", so a fake
// one with a synthetic kit is enough to hold the promises that matter: beats land at the tempo
// of the music, the metronome keeps that tempo in phase, hats are their own event, what comes out
// is delayed by the output latency, and silence is still.
//
// Measured on the real tracks (offline, through a real AnalyserNode in Chrome): the theme, at 116
// BPM, came out at 118 detected beats a minute; the bands span roughly 0.3 to 0.9.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListener, EQ_BANDS } from '../public/client/audio/listen.js';

const FPS = 60, RATE = 44100, FFT = 2048;
const binHz = RATE / FFT;

/** A bed of noisy mid-level energy everywhere, a kick every `beatS`, hats on the off-beats. */
function fakeAnalyser(beatS, { hats = false, dropEvery = 0 } = {}) {
  let frame = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return {
    frequencyBinCount: FFT / 2, fftSize: FFT, context: { sampleRate: RATE },
    tick() { frame++; },
    getByteFrequencyData(arr) {
      const t = frame / FPS;
      const n = beatS ? Math.floor(t / beatS) : -1;
      const since = beatS ? t % beatS : 99;
      // Every `dropEvery`th kick is missing, the way a detector misses kicks under a fill.
      const kick = since < 0.12 && !(dropEvery && n % dropEvery === dropEvery - 1) ? 1 - since / 0.12 : 0;
      const off = beatS ? (t + beatS / 2) % beatS : 99;
      const hat = hats && off < 0.05 ? 1 - off / 0.05 : 0;
      for (let i = 0; i < arr.length; i++) {
        const hz = i * binHz;
        let v = 120 + rnd() * 14;
        if (hz >= 40 && hz <= 140) v += kick * 90;
        if (hz >= 5000 && hz <= 12000) v += hat * 80;
        arr[i] = Math.min(255, v);
      }
    },
  };
}

function run(beatS, seconds, { audible = true, latencyS = 0, ...opts } = {}) {
  const listen = createListener();
  const an = fakeAnalyser(beatS, opts);
  let beats = 0, sparks = 0, lastB = 0, lastS = 0, out;
  const beatFrames = [];
  const phaseAtKick = [];
  for (let f = 0; f < seconds * FPS; f++) {
    out = listen(an, audible, 1000 / FPS, latencyS);
    if (out.beats !== lastB) { beats++; lastB = out.beats; beatFrames.push(f); }
    if (out.sparks !== lastS) { sparks++; lastS = out.sparks; }
    // Where the metronome thinks it is at every real kick, after it has had time to lock.
    if (beatS && f > 10 * FPS && Math.floor(f / FPS / beatS) !== Math.floor((f - 1) / FPS / beatS)) {
      phaseAtKick.push(out.phase);
    }
    an.tick();
  }
  return { beats, sparks, out, beatFrames, phaseAtKick };
}

test('beats land at the tempo of the music', () => {
  for (const bpm of [90, 116, 140]) {
    const { beats } = run(60 / bpm, 30);
    const expected = bpm / 2;              // 30 seconds
    assert.ok(Math.abs(beats - expected) <= expected * 0.12,
      `${bpm} BPM: heard ${beats} beats in 30 s, expected about ${expected}`);
  }
});

test('the tempo is learned, and trusted once it is regular', () => {
  for (const bpm of [96, 116, 128]) {
    const { out } = run(60 / bpm, 20);
    assert.ok(Math.abs(out.bpm - bpm) / bpm < 0.05, `${bpm} BPM came out as ${out.bpm.toFixed(1)}`);
    assert.ok(out.lock > 0.7, `${bpm} BPM: lock only ${out.lock.toFixed(2)}`);
  }
});

test('the metronome is in phase with the kicks, even through missed ones', () => {
  // One kick in four missing: the sea must not skip a beat because the detector did.
  const { phaseAtKick } = run(60 / 116, 30, { dropEvery: 4 });
  // Circular distance from the downbeat, so 0.98 and 0.02 are both "on it".
  const off = phaseAtKick.map(p => Math.min(p, 1 - p));
  const mean = off.reduce((a, b) => a + b, 0) / off.length;
  assert.ok(mean < 0.08, `metronome is ${(mean * 100).toFixed(0)}% of a beat off the kicks`);
});

test('a steady bed with no kick is not a beat, and builds no tempo', () => {
  const { beats, out } = run(0, 20);
  assert.ok(beats <= 2, `heard ${beats} beats in a beatless bed`);
  assert.ok(out.lock < 0.1, `trusted a tempo in a beatless bed (lock ${out.lock.toFixed(2)})`);
});

test('hats are their own event', () => {
  const { sparks } = run(60 / 120, 10, { hats: true });
  assert.ok(sparks >= 15 && sparks <= 22, `${sparks} hat sparks in 10 s of off-beat hats at 120`);
  const { sparks: none } = run(60 / 120, 10);
  assert.ok(none <= 2, `${none} sparks with no hats at all`);
});

test('everything comes out delayed by the output latency', () => {
  const a = run(0.5, 6).beatFrames;
  const b = run(0.5, 6, { latencyS: 0.1 }).beatFrames;
  assert.ok(a.length > 5);
  // From the second beat: the first lands on frame 0, before there is any history to delay.
  const shift = b.slice(1, 5).map((f, i) => f - a[i + 1]);
  for (const s of shift) assert.ok(s >= 5 && s <= 7, `delayed by ${s} frames, expected 6 (100 ms)`);
});

test('the equaliser moves with the music, band by band, and never jumps', () => {
  // A kick every half second lives in the bottom bands: they must swing far more than the top.
  // And smoothly — the coast is scenery, not a meter, and the fast version read as jumpy.
  const listen = createListener();
  const an = fakeAnalyser(0.5);
  const lo = [], hi = [];
  let prev = null, maxStep = 0;
  // Thirty seconds, measured over the last ten: each band's sense of "usual" takes a few
  // seconds to settle, and before then every band is still sliding toward it.
  for (let f = 0; f < 30 * FPS; f++) {
    const out = listen(an, true, 1000 / FPS);
    assert.equal(out.eq.length, EQ_BANDS);
    if (f > 20 * FPS) {
      lo.push(out.eq[2]); hi.push(out.eq[EQ_BANDS - 3]);
      if (prev) for (let b = 0; b < EQ_BANDS; b++) maxStep = Math.max(maxStep, Math.abs(out.eq[b] - prev[b]));
      prev = Float32Array.from(out.eq);
    }
    an.tick();
  }
  const range = a => Math.max(...a) - Math.min(...a);
  assert.ok(range(lo) > 0.05, `bass bar only moved ${range(lo).toFixed(2)}`);
  assert.ok(range(lo) > range(hi) * 2, 'the treble bar moved as much as the bass bar on a kick');
  assert.ok(maxStep < 0.02, `a band moved ${maxStep.toFixed(3)} in one frame — that is a jump`);
});

test('accents answer musical events that are not kicks', () => {
  // The in-game beds have almost no kicks. A chord arriving across the mids must still count.
  const listen = createListener();
  let frame = 0, seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const an = {
    frequencyBinCount: FFT / 2, fftSize: FFT, context: { sampleRate: RATE },
    getByteFrequencyData(arr) {
      const since = (frame / FPS) % 1.2;            // a chord every 1.2 s, nothing below 300 Hz
      const swell = since < 0.25 ? 1 - since / 0.25 : 0;
      for (let i = 0; i < arr.length; i++) {
        const hz = i * binHz;
        arr[i] = Math.min(255, 120 + rnd() * 14 + (hz > 300 && hz < 3000 ? swell * 70 : 0));
      }
    },
  };
  let accents = 0, beats = 0, lastA = 0, lastB = 0;
  for (; frame < 24 * FPS; frame++) {
    const out = listen(an, true, 1000 / FPS);
    if (out.accents !== lastA) { accents++; lastA = out.accents; }
    if (out.beats !== lastB) { beats++; lastB = out.beats; }
  }
  assert.ok(beats <= 2, `${beats} kicks heard in music with no kick`);
  assert.ok(accents >= 16 && accents <= 22, `${accents} accents for 20 chords`);
});

test('paused or muted, the sea is still', () => {
  const { beats, out } = run(0.5, 5, { audible: false });
  assert.equal(beats, 0);
  for (const k of ['bass', 'mid', 'high', 'level']) assert.ok(out[k] < 0.01, `${k} is ${out[k]}`);
});
