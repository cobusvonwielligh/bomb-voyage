// The ear the sea listens with. An AnalyserNode is just "fill this array with bytes", so a fake
// one with a synthetic kick drum is enough to hold the two promises that matter: beats land at
// the tempo of the music, and silence is still.
//
// Measured on the real tracks (offline, through a real AnalyserNode in Chrome): the theme, at 116
// BPM, came out at 118 detected beats a minute; the bands span roughly 0.3 to 0.9.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListener } from '../public/client/audio/listen.js';

const FPS = 60, RATE = 44100, FFT = 2048;
const binHz = RATE / FFT;

/** A bed of noisy mid-level energy everywhere, plus a kick every `beatS` seconds. */
function fakeAnalyser(beatS) {
  let frame = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return {
    frequencyBinCount: FFT / 2, fftSize: FFT, context: { sampleRate: RATE },
    tick() { frame++; },
    getByteFrequencyData(arr) {
      const t = frame / FPS;
      const since = beatS ? t % beatS : 99;
      const kick = since < 0.12 ? 1 - since / 0.12 : 0;
      for (let i = 0; i < arr.length; i++) {
        const hz = i * binHz;
        let v = 120 + rnd() * 14;
        if (hz >= 40 && hz <= 140) v += kick * 90;
        arr[i] = Math.min(255, v);
      }
    },
  };
}

function run(beatS, seconds, audible = true) {
  const listen = createListener();
  const an = fakeAnalyser(beatS);
  let beats = 0, last = 0, out;
  for (let f = 0; f < seconds * FPS; f++) {
    out = listen(an, audible, 1000 / FPS);
    if (out.beats !== last) { beats++; last = out.beats; }
    an.tick();
  }
  return { beats, out };
}

test('beats land at the tempo of the music', () => {
  for (const bpm of [90, 116, 140]) {
    const { beats } = run(60 / bpm, 30);
    const expected = bpm / 2;              // 30 seconds
    assert.ok(Math.abs(beats - expected) <= expected * 0.12,
      `${bpm} BPM: heard ${beats} beats in 30 s, expected about ${expected}`);
  }
});

test('a steady bed with no kick is not a beat', () => {
  const { beats } = run(0, 20);
  assert.ok(beats <= 2, `heard ${beats} beats in a beatless bed`);
});

test('paused or muted, the sea is still', () => {
  const { beats, out } = run(0.5, 5, false);
  assert.equal(beats, 0);
  for (const k of ['bass', 'mid', 'high', 'level']) assert.ok(out[k] < 0.01, `${k} is ${out[k]}`);
});
