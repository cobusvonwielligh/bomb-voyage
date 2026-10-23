// Three ambient beds for in-game, synthesised.
//
// All three now have a produced file in /assets/audio named after them, and that file is what
// actually plays — see createFileTrack in music.js. What is below is the FALLBACK, and it is
// also the specification: it defines each slot, its name, and what it is supposed to sound
// like, which is why the tests still hold it to that and why it is worth reading.
//
// The main theme has a kit, a lead and an opinion. These are the opposite, on purpose: a round
// lasts sixteen minutes and the thing playing underneath it has to survive being heard sixty
// times. The acceptance test in docs/ART-AUDIO.md is the right one — if you would mute it after
// sixteen minutes, it is too busy — so there is no drum kit, no melody, and six or seven notes a
// bar instead of sixteen.
//
// What makes a bed atmospheric rather than melodic is the overlap. Every arpeggio note has a long
// release and feeds a dotted-eighth delay, so by the third note you are hearing a chord rather
// than a line, and there is nothing to follow. The arpeggio index is also rotated by the bar, so
// four bars on one chord are four different contours; because every note in a voicing is a chord
// tone, any rotation is still the same harmony and no tune can emerge from the rotation.
//
// Each bed exposes the same shape as the main theme — steps, stepDur, repeats, a fader and a
// schedule(step, time) — so music.js can cycle all four through one sequencer and main.js never
// learns that more than one track exists.

import { audioContext, createDelayLine, envelope, hz } from './engine.js';

const STEPS_PER_BAR = 16;          // sixteenth notes, same grid as the main theme

// Rests are null. Notes are indices into the chord's `voice`, which is why a pattern can be
// reused across chords without any of them going out of key.
//
// `drift` climbs and falls in loose eighths. `suspend` wanders — 0 3 1 4 2 5 is deliberately not
// a scale shape, so it reads as motion without direction. `undertow` descends, which is the
// single cheapest way to make a bed feel like it is sinking.
const DRIFT_ARP = [0, null, 2, null, 4, null, null, 3, 5, null, null, 2, 4, null, null, null];
const SUSPEND_ARP = [0, null, null, 3, null, 1, null, null, 4, null, 2, null, null, 5, null, 1];
const UNDERTOW_ARP = [5, null, null, 4, null, null, 3, null, 2, null, null, 1, null, 0, null, null];

/**
 * The three beds. They have to be audibly different from each other, not just differently
 * spelled, so each one differs in tempo, waveform, register, filter and harmonic language —
 * major and open, thirdless and unresolved, minor and modal.
 */
const BEDS = [
  {
    name: 'drift',
    // Airy major in C. Triangle waves and a high cutoff put it well above the gameplay, where it
    // reads as light rather than as something happening.
    bpm: 64,
    bars: 16,
    repeats: 2,
    wave: 'triangle',
    cutoff: 3200,
    q: 1,
    release: 1.6,
    peak: 0.075,
    padPeak: 0.05,
    padTop: 2200,
    pulse: false,
    arp: DRIFT_ARP,
    chords: [
      { bass: 36, voice: [60, 64, 67, 71, 74, 79] },   // Cmaj9
      { bass: 41, voice: [60, 65, 69, 72, 76, 81] },   // Fmaj7
      { bass: 45, voice: [59, 64, 67, 72, 76, 79] },   // Am9
      { bass: 43, voice: [59, 64, 67, 71, 76, 79] },   // G6
    ],
  },
  {
    // Not one third anywhere in it. A chord with no third cannot be major or minor, so this bed
    // has nowhere to resolve to and can hang indefinitely without sounding like it is waiting.
    // Twelve bars rather than sixteen, so it does not sit on the same grid as the other two.
    name: 'suspend',
    bpm: 58,
    bars: 12,
    repeats: 2,
    wave: 'sine',
    cutoff: 2400,
    q: 1,
    release: 2.4,
    peak: 0.085,
    padPeak: 0.045,
    padTop: 1600,
    pulse: false,
    arp: SUSPEND_ARP,
    chords: [
      { bass: 45, voice: [59, 64, 69, 71, 76, 81] },   // Asus2
      { bass: 38, voice: [57, 62, 64, 69, 74, 76] },   // Dsus2
      { bass: 40, voice: [57, 59, 64, 69, 71, 76] },   // Esus4
    ],
  },
  {
    // Dark and modal: D minor with a flat second, which is the interval that makes it sound
    // uneasy rather than merely sad. Lowpassed sawtooth an octave below the other two beds, and
    // the only bed with a pulse — just a sub thump on the bar, because something this slow needs
    // one reference point or it stops reading as music at all.
    name: 'undertow',
    bpm: 50,
    bars: 16,
    repeats: 2,
    wave: 'sawtooth',
    cutoff: 1100,
    q: 3,
    release: 2,
    peak: 0.06,
    padPeak: 0.055,
    padTop: 1200,
    pulse: true,
    arp: UNDERTOW_ARP,
    chords: [
      { bass: 38, voice: [50, 57, 62, 65, 69, 74] },   // Dm
      { bass: 39, voice: [51, 58, 63, 67, 70, 75] },   // Ebmaj7, the Phrygian second
      { bass: 43, voice: [50, 55, 58, 62, 65, 70] },   // Gm7
      { bass: 38, voice: [52, 57, 62, 65, 69, 72] },   // Dm add9
    ],
  },
];

/** One track object per bed, all feeding `bus`. Order is the order they cycle in. */
export function createAmbient({ bus }) {
  return BEDS.map(def => createBed({ bus, def }));
}

function createBed({ bus, def }) {
  const ctx = audioContext();
  const stepDur = 60 / def.bpm / 4;
  const barsPerChord = def.bars / def.chords.length;

  // The fader starts silent: music.js brings whichever track is current up to full and owns the
  // crossfades, so a bed that has never been reached makes no sound even though it is wired up.
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(bus);

  // Dotted eighth at this bed's own tempo. More feedback and more wet than the main theme gets,
  // because here the delay is not an effect on the arpeggio — it IS most of the arpeggio.
  const delay = createDelayLine((60 / def.bpm) * 0.75, gain, { feedback: 0.42, mix: 0.6 });

  /**
   * The arpeggio voice, and the only thing that plays more than once a bar. The long release is
   * the whole design: shorten it and the overlapping notes stop fusing into a chord, a line
   * appears, and the bed starts competing with the game for attention.
   */
  function pluck(t, note) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = def.wave;
    o.frequency.value = hz(note);
    f.type = 'lowpass';
    f.frequency.value = def.cutoff;
    f.Q.value = def.q;
    envelope(g, t, { a: 0.02, d: 0.25, s: 0.35, hold: 0.1, r: def.release, peak: def.peak });
    o.connect(f);
    f.connect(g);
    g.connect(gain);
    g.connect(delay);
    o.start(t);
    o.stop(t + 0.8 + def.release);
  }

  /**
   * One slow wash per chord. Detuned pairs rather than one oscillator per note: with no beating
   * between voices a pad sounds like a cheap organ, and the beating is what reads as air.
   */
  function pad(t, notes, dur) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(420, t);
    f.frequency.linearRampToValueAtTime(def.padTop, t + dur * 0.55);
    f.frequency.linearRampToValueAtTime(420, t + dur);
    f.Q.value = 1.5;
    envelope(g, t, {
      a: dur * 0.35, d: 0.2, s: 0.92, hold: dur * 0.25, r: dur * 0.4, peak: def.padPeak,
    });
    for (const n of notes) {
      for (const detune of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(n);
        o.detune.value = detune;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 1.2);
      }
    }
    f.connect(g);
    g.connect(gain);
  }

  /** A sub under the chord. Not a bass line — it moves once every four bars and never walks. */
  function drone(t, note, dur) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = hz(note);
    envelope(g, t, { a: dur * 0.2, d: 0.2, s: 0.9, hold: dur * 0.4, r: dur * 0.35, peak: 0.1 });
    o.connect(g);
    g.connect(gain);
    o.start(t);
    o.stop(t + dur + 1);
  }

  /** `undertow` only, and barely there: a pulse to hang on, not a kick drum. */
  function pulse(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.14);
    envelope(g, t, { a: 0.01, d: 0.3, peak: 0.08 });
    o.connect(g);
    g.connect(gain);
    o.start(t);
    o.stop(t + 0.45);
  }

  function schedule(s, t) {
    const bar = Math.floor(s / STEPS_PER_BAR);
    const n = s % STEPS_PER_BAR;
    const chord = def.chords[Math.floor(bar / barsPerChord)];
    const barInChord = bar % barsPerChord;

    if (n === 0 && barInChord === 0) {
      const dur = stepDur * STEPS_PER_BAR * barsPerChord;
      // The pad takes the bottom three notes of the voicing; the arpeggio has the top of it to
      // itself, which is the only reason both can be this quiet and still be heard.
      pad(t, chord.voice.slice(0, 3), dur);
      drone(t, chord.bass, dur);
    }
    if (def.pulse && n === 0) pulse(t);

    const slot = def.arp[n];
    if (slot !== null) pluck(t, chord.voice[(slot + barInChord) % chord.voice.length]);
  }

  return {
    name: def.name,
    steps: def.bars * STEPS_PER_BAR,
    stepDur,
    repeats: def.repeats,
    gain,
    schedule,
  };
}
