// The ear the sea listens with. An AnalyserNode is just "fill this array with bytes", so a fake
// one with a synthetic kit is enough to hold the promises that matter: beats land at the tempo
// of the music, the metronome keeps that tempo in phase, hats are their own event, what comes out
// is delayed by the output latency, and silence is still.
//
// Measured on the real tracks (offline, through a real AnalyserNode in Chrome): the theme, at 116
// BPM, came out at 118 detected beats a minute; the bands span roughly 0.3 to 0.9.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListener } from '../public/client/audio/listen.js';

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

test('paused or muted, the sea is still', () => {
  const { beats, out } = run(0.5, 5, { audible: false });
  assert.equal(beats, 0);
  for (const k of ['bass', 'mid', 'high', 'level']) assert.ok(out[k] < 0.01, `${k} is ${out[k]}`);
});
