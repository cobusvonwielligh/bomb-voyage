// Bomb Voyage — the soundtrack. Synthesised, no audio files anywhere in this project.
//
// Eight bars at 77 BPM, built on I–V–vi–IV and its brighter cousin: major, open, and more
// pleased with itself than the minor loop this started as. Two halves that differ, a lead that
// only shows up in the second half, and a fill before the loop comes round, so sixteen minutes
// of it does not drill a hole in anyone.
//
// Scheduling uses the standard look-ahead pattern — a timer that only ever queues notes a little
// way into the future, with the AudioContext clock doing the actual timing. setTimeout per note
// drifts audibly within seconds.

import { VOLUME_MUSIC_DEFAULT } from '/shared/constants.js';
import { audioContext, unlock, noiseSource } from './engine.js';

const BPM = 77;
const STEPS_PER_BAR = 16;          // sixteenth notes
const BARS = 8;
const TOTAL_STEPS = STEPS_PER_BAR * BARS;
const LOOKAHEAD_S = 0.12;
const TIMER_MS = 25;

// C G Am F | C G F G. Major, and the last bar leans on the dominant so the loop pulls round
// again instead of simply stopping and restarting.
const CHORDS = [
  { bass: 48, notes: [60, 64, 67] },   // C
  { bass: 43, notes: [59, 62, 67] },   // G
  { bass: 45, notes: [60, 64, 69] },   // Am
  { bass: 41, notes: [60, 65, 69] },   // F
  { bass: 48, notes: [60, 64, 67] },   // C
  { bass: 43, notes: [59, 62, 67] },   // G
  { bass: 41, notes: [60, 65, 69] },   // F
  { bass: 43, notes: [62, 67, 71] },   // G, voiced high to lift into the repeat
];

// A full arpeggio runs the chord across three octaves rather than noodling on three notes.
// Pattern A climbs; pattern B climbs and comes back down, so the two halves of the loop move
// differently without needing different harmony.
const ARP_UP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1];
const ARP_ROLL = [0, 2, 4, 6, 8, 6, 7, 5, 3, 1, 2, 4, 6, 4, 2, 1];

// A simple singable line over the back half. Nulls are rests — a melody needs to breathe.
const LEAD = [
  76, null, 74, null, 72, null, null, 74,
  76, null, 79, null, 76, null, null, null,
  74, null, 72, null, 71, null, null, 72,
  74, null, 72, null, 67, null, null, null,
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
    // Shared with the sound effects. One context, so one user gesture unlocks both and turning
    // the music off cannot take the sound effects down with it.
    ctx = audioContext();

    // A gentle limiter on the end of the chain. Five voices plus a delay stack up, and clipping
    // is the fastest way to make a soft loop sound nasty.
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

    // Dotted-eighth feedback delay: the sound that makes an arpeggio feel like synthwave.
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
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
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
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(800, t);
    f.frequency.linearRampToValueAtTime(1700, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(800, t + dur);
    f.Q.value = 2;
    env(g, t, { a: dur * 0.3, d: 0.1, s: 0.9, hold: dur * 0.4, r: dur * 0.4, peak: 0.07 });
    for (const n of notes) {
      for (const detune of [-7, 7]) {
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

  function arp(t, note, gain = 0.055) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = hz(note);
    env(g, t, { a: 0.003, d: 0.14, peak: gain });
    o.connect(g);
    g.connect(musicGain);
    g.connect(delay);
    o.start(t); o.stop(t + 0.25);
  }

  function lead(t, note) {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator();
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'triangle'; o2.type = 'sawtooth';
    o.frequency.value = hz(note);
    o2.frequency.value = hz(note);
    o2.detune.value = 8;
    f.type = 'lowpass'; f.frequency.value = 2600;
    env(g, t, { a: 0.02, d: 0.1, s: 0.8, hold: 0.18, r: 0.22, peak: 0.075 });
    o.connect(f); o2.connect(f); f.connect(g);
    g.connect(musicGain); g.connect(delay);
    o.start(t); o2.start(t);
    o.stop(t + 0.7); o2.stop(t + 0.7);
  }

  function kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    env(g, t, { a: 0.002, d: 0.18, peak: 0.42 });
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + 0.3);
  }

  const noise = noiseSource;   // engine.js owns the buffer; the sfx bus shares it

  function snare(t, gain = 0.12) {
    const s = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.9;
    env(g, t, { a: 0.002, d: 0.16, peak: gain });
    s.connect(f); f.connect(g); g.connect(musicGain);
    s.start(t); s.stop(t + 0.3);
  }

  function hat(t, open) {
    const s = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'highpass'; f.frequency.value = 7000;
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
    const secondHalf = bar >= 4;

    if (n === 0) pad(t, chord.notes, d * STEPS_PER_BAR);

    if (n % 4 === 0) kick(t);
    if (n === 4 || n === 12) snare(t);
    if (n % 2 === 1) hat(t, n === 7 || n === 15);

    // A fill at the end of each half, so the loop has a shape instead of a seam.
    if ((bar === 3 || bar === 7) && n >= 12) snare(t, 0.05 + (n - 12) * 0.03);

    if (n % 2 === 0) {
      const up = n === 6 || n === 14;
      bass(t, chord.bass + (up ? 12 : 0), d * 1.6);
    }

    // The arpeggio walks the chord across three octaves. Pattern changes at the halfway point.
    const pattern = secondHalf ? ARP_ROLL : ARP_UP;
    const idx = pattern[n];
    if (idx !== undefined) {
      const octave = Math.floor(idx / 3);
      arp(t, chord.notes[idx % 3] + octave * 12, secondHalf ? 0.045 : 0.055);
    }

    if (secondHalf) {
      const note = LEAD[(bar - 4) * 8 + (n >> 1)];
      if (note && n % 2 === 0) lead(t, note);
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
      if (!await unlock()) return false;
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
