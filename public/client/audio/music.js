// Bomb Voyage — the music. Synthesised, no audio files anywhere in this project.
//
// This module owns everything that counts as "the music": the main theme below, the three ambient
// beds in ./ambient.js, and the cycling between them. They all sit behind one public surface, so
// main.js still only ever says start / stop / toggle / setVolume / duck and never learns that
// there is more than one track.
//
// The theme is eight bars at 116 BPM in two halves that do not sound alike.
//
// Bars 1-4 are a relaxed four-on-the-floor funk vamp: Am7 Cmaj7 Em7 D9 — a vi-I-iii-II shape —
// over a bass that walks down A G E D, with a muted guitar chank on the offbeats and dry disco
// hats. The major II at the end wants to go somewhere and the loop goes back to the Am7 instead,
// which is what lets four bars repeat without ever sounding finished. There is no lead here and
// no arpeggio: in funk the guitar is the movement, and anything else on top of it is clutter.
//
// Bars 5-8 are the pirate half: Dm Bb F C, a three-octave sixteenth arpeggio, and a hook built
// like a shanty — one rhythmic cell stated, answered, then restated a fourth higher, landing on
// the tonic with a bar of air after it. D natural minor, flat 7, no raised leading note: that
// one accidental is the whole difference between a sea shanty and a vampire film.
//
// Holding both back until bar 5 is what makes the melody an event rather than something that
// was always there.
//
// Scheduling uses the standard look-ahead pattern — a timer that only ever queues notes a little
// way into the future, with the AudioContext clock doing the actual timing. setTimeout per note
// drifts audibly within seconds.

import { VOLUME_MUSIC_DEFAULT } from '/shared/constants.js';
import {
  audioContext, createDelayLine, createMusicBus, envelope, hz, noiseSource, unlock,
} from './engine.js';
import { createAmbient } from './ambient.js';

// 116 BPM, not the 77 this started at. The Get Lucky pocket only exists around here: a
// four-on-the-floor at 77 is a funeral march, and putting the kick on the eighths instead makes
// it 154, which is drum and bass. The back half is the same notes as before, just livelier.
const BPM = 116;
const SECONDS_PER_BEAT = 60 / BPM;
const STEP_DUR = SECONDS_PER_BEAT / 4;
const STEPS_PER_BAR = 16;          // sixteenth notes
const BARS = 8;
const TOTAL_STEPS = STEPS_PER_BAR * BARS;

const LOOKAHEAD_S = 0.12;
const TIMER_MS = 25;

// Long enough to be a change of scene rather than a seam, short enough that nobody sits through
// a track they cannot hear yet.
const XFADE_S = 2.5;

// `notes` is the pad and arpeggio voicing, `chank` the guitar cluster, and `bass` the root the
// walking pattern is measured from. Sevenths and ninths rather than triads throughout the first
// half: the maj7/min7 colour is most of what makes this read as funk instead of as rock.
const CHORDS = [
  { bass: 45, notes: [60, 64, 67], chank: [64, 67, 72] },   // Am7
  { bass: 43, notes: [64, 67, 71], chank: [64, 67, 71] },   // Cmaj7
  { bass: 40, notes: [62, 67, 71], chank: [62, 67, 71] },   // Em7
  { bass: 38, notes: [66, 69, 76], chank: [64, 66, 69] },   // D9
  // The back half moves to D minor. The arpeggio engine is unchanged — it is the chords under
  // it that decide whether a sea shanty or a car advert comes out, and Dm-Bb-F-C is the
  // progression every pirate tune ever written sits on.
  { bass: 38, notes: [62, 65, 69] },   // Dm
  { bass: 34, notes: [62, 65, 70] },   // Bb
  { bass: 41, notes: [60, 65, 69] },   // F
  { bass: 36, notes: [60, 64, 67] },   // C, pulling back round to the Dm
];

// Semitones above the bar's root; null is a rest. The root lands on the downbeat and then the
// line leaves it alone — a disco bass that sits on the root turns the groove into a march. The
// last bar climbs 9-7-5-4 so the loop is pulled back round to the Am7 rather than stopping.
const FUNK_BASS = [
  [0, null, null, 0, null, null, 12, null, null, 7, null, null, 10, null, 0, null],
  [0, null, null, 0, null, 12, null, null, 7, null, null, 4, null, null, 0, null],
  [0, null, null, 0, null, null, 12, null, null, 10, null, 7, null, null, 0, null],
  [0, null, null, 0, null, 12, null, null, 9, null, null, 7, null, 5, null, 4],
];

// Where the guitar chank lands. Never on a downbeat — step 0, 4, 8 and 12 belong to the kick, and
// a chank on top of one stops being an offbeat and becomes a chord stab. The gaps carry this
// pattern more than the hits do; filling them in is what turns funk into strumming.
const CHANK = [
  [0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 0],
  [0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0],
  [0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0],
  [0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1],
];

/* The synthwave engine room. Indices into a three-octave stack of the bar's chord.
 *
 * Sixteenths, never repeating a note two steps running, and shaped as a long climb with a
 * stumble back on the way up. A pure up-down ramp is an exercise; the small reversals are what
 * make it a riff you can follow — your ear tracks the pattern, is wrong twice a bar, and that
 * is what keeps it interesting on the fortieth loop.
 */
const ARP_ROLL = [0, 2, 4, 7, 5, 4, 6, 8, 7, 5, 3, 4, 2, 5, 3, 1];

/* The hook. Eight eighth-notes a bar, four bars, nulls are rests.
 *
 * The old line was four long notes a bar — correct, inoffensive, and not a tune. What makes a
 * shanty singable is three things, and all of them are deliberate here:
 *
 *   1. **A rhythmic cell that repeats.** Bars 1 and 3 share the same three-quaver pickup into
 *      a held note. Repetition is what a hook IS; a melody that never says the same thing
 *      twice is a solo.
 *   2. **Leaps, not steps.** D up to A is a fifth and F up to D is a sixth. Stepwise lines are
 *      what you write when you are being careful, and nobody has ever hummed one.
 *   3. **It lands on the tonic at the end of the phrase and rests there.** The silence in bar 4
 *      is the part people sing along to.
 *
 * D natural minor throughout, over Dm-Bb-F-C. The raised 7th (C#) is deliberately absent: the
 * flat 7 is the whole difference between a sea shanty and a vampire film.
 */
const LEAD = [
  null, 62, 62, 69, null, 69, 67, 69,   // Dm — pickup, then hammer the fifth. This is the hook.
  null, 70, 69, 67, 65, null, null, null, // Bb — answer it falling, and leave a bar of air
  null, 60, 60, 69, null, 69, 72, 69,   // F  — the SAME cell a fourth up: repetition is the hook
  74, 72, 69, 67, 65, null, 62, null,   // C  — run home down the scale, land on the tonic
];

/* An octave shout on the strong beats of bars 1 and 3.
 *
 * Doubling a melody an octave up on its accents is the oldest trick in synthwave and the only
 * one that turns a line into a chorus. Restricted to the two bars that carry the hook: double
 * everything and it stops being an accent.
 */
const LEAD_OCTAVE = [
  0, 0, 0, 1, 0, 1, 0, 1,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 1, 0, 1, 1, 1,
  0, 0, 0, 0, 0, 0, 0, 0,
];

/**
 * The main theme as a track: same shape as an ambient bed, so one sequencer drives either.
 */
function createTheme({ bus }) {
  const ctx = audioContext();

  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(bus);

  const delay = createDelayLine(SECONDS_PER_BEAT * 0.75, gain);

  function bass(t, note, dur) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = hz(note);
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(260, t + dur);
    f.Q.value = 6;
    envelope(g, t, { a: 0.006, d: 0.08, s: 0.7, hold: dur * 0.5, r: 0.09, peak: 0.26 });
    o.connect(f);
    f.connect(g);
    g.connect(gain);
    o.start(t);
    o.stop(t + dur + 0.25);
  }

  function pad(t, notes, dur) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(800, t);
    f.frequency.linearRampToValueAtTime(1700, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(800, t + dur);
    f.Q.value = 2;
    envelope(g, t, { a: dur * 0.3, d: 0.1, s: 0.9, hold: dur * 0.4, r: dur * 0.4, peak: 0.07 });
    for (const n of notes) {
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(n);
        o.detune.value = detune;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.6);
      }
    }
    f.connect(g);
    g.connect(gain);
  }

  /**
   * The muted funk guitar — the "chank". Three things make it, and all three are load-bearing:
   * a 40 ms gate, a high-Q band around 1.9 kHz, and no body underneath. Lengthen the envelope and
   * it becomes a pad; drop the Q and it becomes a synth stab; keep the low end and it fights the
   * bass. It deliberately does not feed the delay, because a dotted-eighth echo on a sixteenth
   * note pattern this dense is mud.
   */
  function chank(t, notes) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 5;
    envelope(g, t, { a: 0.004, d: 0.042, peak: 0.1 });
    for (const [i, n] of notes.entries()) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(n);
      // A few cents apart so the cluster sounds plucked rather than pressed by a machine.
      o.detune.value = (i - 1) * 7;
      o.connect(f);
      o.start(t);
      o.stop(t + 0.09);
    }
    f.connect(g);
    g.connect(gain);
  }

  function arp(t, note, level = 0.045) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = hz(note);
    envelope(g, t, { a: 0.003, d: 0.14, peak: level });
    o.connect(g);
    g.connect(gain);
    g.connect(delay);
    o.start(t);
    o.stop(t + 0.25);
  }

  /**
   * @param level quieter for the octave doubling, which is an accent and not a second melody.
   *
   * Two detuned saws rather than a triangle and a saw: the beating between them is the entire
   * synthwave lead sound, and at eight cents it was too narrow to hear. Eighteen is wide enough
   * to shimmer and narrow enough not to sound broken.
   */
  function lead(t, note, level = 0.085) {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator();
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth';
    o2.type = 'sawtooth';
    o.frequency.value = hz(note);
    o2.frequency.value = hz(note);
    o.detune.value = -9;
    o2.detune.value = 18;
    f.type = 'lowpass';
    // A filter that opens on the attack: the brightness arriving a moment after the note is
    // what a real synth lead does and what a fixed cutoff never sounds like.
    f.frequency.setValueAtTime(900, t);
    f.frequency.linearRampToValueAtTime(3400, t + 0.07);
    f.frequency.linearRampToValueAtTime(1800, t + 0.4);
    f.Q.value = 3;
    envelope(g, t, { a: 0.012, d: 0.1, s: 0.8, hold: 0.18, r: 0.26, peak: level });
    o.connect(f);
    o2.connect(f);
    f.connect(g);
    g.connect(gain);
    g.connect(delay);
    o.start(t);
    o2.start(t);
    o.stop(t + 0.7);
    o2.stop(t + 0.7);
  }

  function kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    envelope(g, t, { a: 0.002, d: 0.18, peak: 0.42 });
    o.connect(g);
    g.connect(gain);
    o.start(t);
    o.stop(t + 0.3);
  }

  function snare(t, level = 0.12) {
    const s = noiseSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 0.9;
    envelope(g, t, { a: 0.002, d: 0.16, peak: level });
    s.connect(f);
    f.connect(g);
    g.connect(gain);
    s.start(t);
    s.stop(t + 0.3);
  }

  function hat(t, open) {
    const s = noiseSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'highpass';
    f.frequency.value = 7000;
    envelope(g, t, { a: 0.001, d: open ? 0.1 : 0.03, peak: 0.035 });
    s.connect(f);
    f.connect(g);
    g.connect(gain);
    s.start(t);
    s.stop(t + 0.2);
  }

  function schedule(s, t) {
    const bar = Math.floor(s / STEPS_PER_BAR);
    const n = s % STEPS_PER_BAR;
    const chord = CHORDS[bar];
    const funk = bar < 4;

    if (n === 0) pad(t, chord.notes, STEP_DUR * STEPS_PER_BAR);

    // Four on the floor through the whole loop. It is the one thing both halves share, which is
    // what keeps a funk vamp and a synthwave arpeggio sounding like the same piece of music.
    if (n % 4 === 0) kick(t);
    if (n === 4 || n === 12) snare(t, funk ? 0.085 : 0.12);

    if (funk) {
      // Closed hats on the eighths, open on the "and" of 4. In disco the hats are the clock, so
      // they stay dry and quiet; the open one is the only thing in the bar that says "turnaround".
      if (n % 2 === 0) hat(t, n === 14);
      const walk = FUNK_BASS[bar][n];
      if (walk !== null) bass(t, chord.bass + walk, STEP_DUR * 1.4);
      if (CHANK[bar][n]) chank(t, chord.chank);
    } else {
      if (n % 2 === 1) hat(t, n === 7 || n === 15);
      if (n % 2 === 0) bass(t, chord.bass + (n === 6 || n === 14 ? 12 : 0), STEP_DUR * 1.6);
      const idx = ARP_ROLL[n];
      arp(t, chord.notes[idx % 3] + Math.floor(idx / 3) * 12);
      const slot = (bar - 4) * 8 + (n >> 1);
      const note = LEAD[slot];
      if (note && n % 2 === 0) {
        lead(t, note);
        if (LEAD_OCTAVE[slot]) lead(t, note + 12, 0.045);
      }
    }

    // A fill at the end of each half, so the loop has a shape instead of a seam.
    if ((bar === 3 || bar === 7) && n >= 12) snare(t, 0.05 + (n - 12) * 0.03);
  }

  // Four times through is about seventy seconds, which is long enough to be the track you
  // remember and short enough that the beds get most of the round.
  return { name: 'theme', steps: TOTAL_STEPS, stepDur: STEP_DUR, repeats: 4, gain, schedule };
}

export function createMusic() {
  let ctx = null, timer = null, tracks = null, musicGain = null;
  let step = 0, loops = 0, current = 0, nextTime = 0;
  // Track names the rotation must not pick. The theme lives here for the whole of a round.
  const excluded = new Set();
  let volume = readVolume();
  let playing = false, ducked = false;

  function readVolume() {
    const v = parseFloat(localStorage.getItem('bv.music'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : VOLUME_MUSIC_DEFAULT;
  }

  function build() {
    // Shared with the sound effects. One context, so one user gesture unlocks both and turning
    // the music off cannot take the sound effects down with it.
    ctx = audioContext();
    musicGain = createMusicBus(volume);
    // The theme is first because start() always comes back to the top, and the track somebody
    // turned off is the one they expect back when they turn it on again.
    tracks = [createTheme({ bus: musicGain }), ...createAmbient({ bus: musicGain })];
  }

  /**
   * The one place the music bus gain is ever written.
   *
   * It used to be three places, and they did not agree. stop() ramped to zero, start() never put
   * it back, and setVolume and duck were both gated on `playing` so neither rescued it: toggling
   * the music off and on gave you a button that said "on" and silence for the rest of the
   * session, because a setTargetAtTime whose startTime is already in the past keeps decaying
   * until some later automation event replaces it. Routing every writer through here also means
   * `ducked` survives a restart, instead of coming back at full volume while the chat box still
   * has focus.
   */
  function applyGain(tc = 0.05) {
    if (!musicGain) return;
    // Silence while stopped is deliberate, not a fallthrough. Each track's delay line rings for
    // about two seconds after its last note, and moving the slider must not un-mute that tail
    // once the user has explicitly turned the music off.
    const target = playing ? volume * (ducked ? 0.4 : 1) : 0;
    musicGain.gain.setTargetAtTime(target, ctx.currentTime, tc);
  }

  /**
   * Crossfade rather than cut. The outgoing track stops scheduling at the boundary but its pad
   * releases and its delay tail keep sounding through its own fader, which is the overlap — so a
   * track change is a change of scene and not an edit.
   */
  function crossfade(at) {
    const from = tracks[current].gain.gain;
    current = nextTrack();
    const to = tracks[current].gain.gain;
    loops = 0;
    for (const [p, target] of [[from, 0], [to, 1]]) {
      // Anchored at `at` rather than at currentTime: the fade belongs to the loop boundary, and
      // the boundary is up to LOOKAHEAD_S in the future when we get here.
      p.setValueAtTime(p.value, at);
      p.linearRampToValueAtTime(target, at + XFADE_S);
    }
  }

  /** One track up at full, the rest down, with no pending ramps left over. */
  function resetFaders(startAt = 0) {
    current = startAt;
    for (const [i, track] of tracks.entries()) {
      const p = track.gain.gain;
      p.cancelScheduledValues(ctx.currentTime);
      p.setValueAtTime(i === current ? 1 : 0, ctx.currentTime);
    }
  }

  /** Crossfade to a track immediately, from wherever the scheduler happens to be. */
  function jumpTo(next) {
    const now = ctx.currentTime;
    for (const [i, track] of tracks.entries()) {
      const p = track.gain.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(i === next ? 1 : 0, now + XFADE_S);
    }
    current = next;
    step = 0;
    loops = 0;
    // The new track has its own step duration, and nextTime was measured in the old one.
    nextTime = Math.max(nextTime, now + 0.05);
  }

  /**
   * The next track in the cycle, skipping anything excluded.
   *
   * The theme belongs to the landing page. Left in the rotation it comes back round after a few
   * minutes and starts playing a tune with a backbeat over a firefight, which is exactly the
   * thing moving to ambient beds was for.
   */
  function nextTrack() {
    for (let i = 1; i <= tracks.length; i++) {
      const n = (current + i) % tracks.length;
      if (!excluded.has(tracks[n].name)) return n;
    }
    return current;
  }

  function scheduler() {
    // tracks[current] is read fresh every iteration because crossfade() changes it mid-loop, and
    // the step duration of the track we are moving to is not the one we came from.
    while (nextTime < ctx.currentTime + LOOKAHEAD_S) {
      const track = tracks[current];
      track.schedule(step, nextTime);
      nextTime += track.stepDur;
      if (++step >= track.steps) {
        step = 0;
        if (++loops >= track.repeats) crossfade(nextTime);
      }
    }
  }

  // ─── public surface ─────────────────────────────────────────────────────────

  return {
    get playing() { return playing; },
    get volume() { return volume; },

    /** Which of the four tracks is current. Diagnostics only; nothing in the game reads it. */
    get track() { return tracks ? tracks[current].name : null; },

    /**
     * Must be called from a user gesture the first time — browsers block audio otherwise.
     *
     * `from` names where to come in. The theme belongs to the landing page: it has a tune and a
     * backbeat, which is right for twenty seconds of reading a menu and wrong for ten minutes of
     * being hunted. Starting a round jumps straight to an ambient bed instead.
     */
    async start(from = 'theme') {
      if (!ctx) build();
      if (!await unlock()) return false;
      const at = Math.max(0, tracks.findIndex(t => t.name === from));
      if (playing) { if (at !== current) jumpTo(at); return true; }
      playing = true;
      applyGain();
      step = 0;
      loops = 0;
      resetFaders(at);
      nextTime = ctx.currentTime + 0.08;
      timer = setInterval(scheduler, TIMER_MS);
      return true;
    },

    /**
     * Change track now rather than at the next loop boundary. Used when a round starts, because
     * waiting up to a minute for the theme to come round would be absurd.
     */
    playFrom(name) {
      if (!playing || !tracks) return;
      const at = tracks.findIndex(t => t.name === name);
      if (at >= 0 && at !== current) jumpTo(at);
    },

    /**
     * Keep a track out of the rotation, or let it back in.
     *
     * The theme is excluded for the whole of a round. Without this it is only skipped once: the
     * cycle comes back round after a few minutes and starts playing a tune with a backbeat over
     * a firefight, which is the exact thing the ambient beds exist to avoid.
     */
    exclude(name, off = true) {
      if (off) excluded.add(name); else excluded.delete(name);
      if (off && playing && tracks && tracks[current]?.name === name) jumpTo(nextTrack());
    },

    stop() {
      clearInterval(timer);
      timer = null;
      playing = false;
      applyGain();
    },

    async toggle() { return playing ? (this.stop(), false) : this.start(); },

    setVolume(v) {
      // An empty slider reads as NaN, and NaN in an AudioParam throws and takes the chain down.
      if (!Number.isFinite(v)) return;
      volume = Math.min(1, Math.max(0, v));
      localStorage.setItem('bv.music', String(volume));
      applyGain();
    },

    /** Ducked while chat is focused, per docs/ART-AUDIO.md §6. */
    duck(on) {
      ducked = !!on;
      applyGain(0.08);
    },
  };
}
