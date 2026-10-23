// Bomb Voyage — synthwave loop. Synthesised, no audio files anywhere in this project.
//
// Four bars of Am - F - C - G at 96 BPM: saw bass, detuned pad, delayed arpeggio, and a simple
// kit. Deliberately repetitive and quiet. The real acceptance test is in docs/ART-AUDIO.md §6:
// listen to it for a full sixteen-minute round without wanting to mute it.
//
// Scheduling uses the standard look-ahead pattern — a timer that only ever queues notes a little
// way into the future, with the AudioContext clock doing the actual timing. setTimeout per note
// drifts audibly within seconds.

import { VOLUME_MUSIC_DEFAULT } from '/shared/constants.js';

const BPM = 96;
const STEPS_PER_BAR = 16;          // sixteenth notes
const BARS = 4;
const TOTAL_STEPS = STEPS_PER_BAR * BARS;
const LOOKAHEAD_S = 0.12;          // how far ahead we queue
const TIMER_MS = 25;               // how often we top up the queue

// Am - F - C - G. bass is the root an octave or two down; voices are the chord tones we arpeggiate.
const CHORDS = [
  { bass: 45, notes: [57, 60, 64] }, // Am
  { bass: 41, notes: [53, 57, 60] }, // F
  { bass: 48, notes: [55, 60, 64] }, // C
  { bass: 43, notes: [55, 59, 62] }, // G
];

const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);

export function createMusic() {
  let ctx = null, timer = null, step = 0, nextTime = 0;
  let master, musicGain, comp, delay, delayFb, delayMix;
  let volume = readVolume();
  let playing = false;

  function readVolume() {
    const v = parseFloat(localStorage.getItem('bv.music'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : VOLUME_MUSIC_DEFAULT;
  }

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // A gentle limiter on the end of the chain. Four voices plus a delay can stack up, and
    // clipping is the fastest way to make a soft loop sound nasty.
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;

    master = ctx.createGain();
    master.gain.value = 1;

    musicGain = ctx.createGain();
    musicGain.gain.value = volume;

    musicGain.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);

    // Dotted-eighth feedback delay, the sound that makes an arpeggio feel like synthwave.
    delay = ctx.createDelay(1);
    delay.delayTime.value = (60 / BPM) * 0.75;
    delayFb = ctx.createGain();
    delayFb.gain.value = 0.34;
    delayMix = ctx.createGain();
    delayMix.gain.value = 0.5;
    delay.connect(delayFb);
    delayFb.connect(delay);
    delay.connect(delayMix);
    delayMix.connect(musicGain);
  }

  // ─── voices ─────────────────────────────────────────────────────────────────

  function env(node, t, { a = 0.005, d = 0.1, s = 0, r = 0.1, peak = 1, hold = 0 }) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + a);
    if (s > 0) {
      g.exponentialRampToValueAtTime(Math.max(0.0001, peak * s), t + a + d);
      g.setValueAtTime(Math.max(0.0001, peak * s), t + a + d + hold);
      g.exponentialRampToValueAtTime(0.0001, t + a + d + hold + r);
    } else {
      g.exponentialRampToValueAtTime(0.0001, t + a + d);
    }
  }

  function bass(t, note, dur) {
    const o = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = hz(note);
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(260, t + dur);
    f.Q.value = 6;
    env(g, t, { a: 0.006, d: 0.08, s: 0.7, hold: dur * 0.5, r: 0.09, peak: 0.26 });
    o.connect(f); f.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + dur + 0.25);
  }

  function pad(t, notes, dur) {
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(1500, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(700, t + dur);
    f.Q.value = 2;
    env(g, t, { a: dur * 0.3, d: 0.1, s: 0.9, hold: dur * 0.4, r: dur * 0.4, peak: 0.075 });
    for (const n of notes) {
      for (const detune of [-7, 7]) {           // two slightly detuned saws per note
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(n);
        o.detune.value = detune;
        o.connect(f);
        o.start(t); o.stop(t + dur + 0.6);
      }
    }
    f.connect(g); g.connect(musicGain);
  }

  function arp(t, note) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = hz(note);
    env(g, t, { a: 0.003, d: 0.14, peak: 0.055 });
    o.connect(g);
    g.connect(musicGain);
    g.connect(delay);                            // send to the dotted-eighth delay
    o.start(t); o.stop(t + 0.25);
  }

  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    env(g, t, { a: 0.002, d: 0.18, peak: 0.42 });
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + 0.3);
  }

  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    return s;
  }

  function snare(t) {
    const s = noise();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 0.9;
    // The long tail is the gated-reverb cliché, and it is the cliché for a reason.
    env(g, t, { a: 0.002, d: 0.16, peak: 0.12 });
    s.connect(f); f.connect(g); g.connect(musicGain);
    s.start(t); s.stop(t + 0.3);
  }

  function hat(t, open) {
    const s = noise();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    f.type = 'highpass';
    f.frequency.value = 7000;
    env(g, t, { a: 0.001, d: open ? 0.1 : 0.03, peak: 0.035 });
    s.connect(f); f.connect(g); g.connect(musicGain);
    s.start(t); s.stop(t + 0.2);
  }

  // ─── sequencer ──────────────────────────────────────────────────────────────

  const stepDur = () => 60 / BPM / 4;

  function playStep(s, t) {
    const bar = Math.floor(s / STEPS_PER_BAR);
    const n = s % STEPS_PER_BAR;
    const chord = CHORDS[bar];
    const d = stepDur();

    if (n === 0) pad(t, chord.notes, d * STEPS_PER_BAR);

    if (n % 4 === 0) kick(t);                         // four on the floor
    if (n === 4 || n === 12) snare(t);
    if (n % 2 === 1) hat(t, n === 7 || n === 15);

    if (n % 2 === 0) {
      // Root on the beat, octave up on the last eighth of each half bar: the walking feel.
      const up = n === 6 || n === 14;
      bass(t, chord.bass + (up ? 12 : 0), d * 1.6);
    }

    // Arpeggio: up through the chord across two octaves, skipping a couple of steps per bar so
    // it breathes instead of machine-gunning.
    if (n !== 3 && n !== 11) {
      const idx = s % 6;
      arp(t, chord.notes[idx % 3] + (idx >= 3 ? 12 : 0) + 12);
    }
  }

  function scheduler() {
    while (nextTime < ctx.currentTime + LOOKAHEAD_S) {
      playStep(step, nextTime);
      nextTime += stepDur();
      step = (step + 1) % TOTAL_STEPS;
    }
  }

  // ─── public surface ─────────────────────────────────────────────────────────

  return {
    get playing() { return playing; },
    get volume() { return volume; },

    /** Must be called from a user gesture the first time — browsers block audio otherwise. */
    async start() {
      if (playing) return true;
      if (!ctx) build();
      if (ctx.state === 'suspended') await ctx.resume();
      if (ctx.state !== 'running') return false;    // still blocked; caller shows the prompt
      step = 0;
      nextTime = ctx.currentTime + 0.08;
      timer = setInterval(scheduler, TIMER_MS);
      playing = true;
      return true;
    },

    stop() {
      clearInterval(timer);
      timer = null;
      playing = false;
      if (musicGain) musicGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    },

    async toggle() { return playing ? (this.stop(), false) : this.start(); },

    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      localStorage.setItem('bv.music', String(volume));
      if (musicGain && playing) musicGain.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
    },

    /** Ducked while chat is focused, per docs/ART-AUDIO.md §6. */
    duck(on) {
      if (!musicGain || !playing) return;
      musicGain.gain.setTargetAtTime(volume * (on ? 0.4 : 1), ctx.currentTime, 0.08);
    },
  };
}
