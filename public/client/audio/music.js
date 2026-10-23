// Bomb Voyage — the music. Synthesised, no audio files anywhere in this project.
//
// This module owns everything that counts as "the music": the main theme below, the three ambient
// beds in ./ambient.js, and the cycling between them. They all sit behind one public surface, so
// main.js still only ever says start / stop / toggle / setVolume / duck and never learns that
// there is more than one track.
//
// The theme is eight bars at 116 BPM in two halves that do not sound alike.
//
// Both halves are the same four chords — Dm Bb F C — and the difference between them is
// ARRANGEMENT, not harmony. That is the oldest structure in synthwave and it works because the
// second time round, the ear already knows where the chords are going and is free to follow the
// tune instead.
//
// Bars 1-4 are the statement: a driving octave bass on the eighths, a gated pad, and the
// arpeggio running at half density through a filter that is barely open. No melody at all. The
// last bar is a build — the arp fills in, the snare runs, and a noise sweep rises into bar 5.
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
// Bars of build before the main section. Two, deliberately: see `intro` in schedule().
const INTRO_BARS = 2;
const TOTAL_STEPS = STEPS_PER_BAR * BARS;

const LOOKAHEAD_S = 0.12;
const TIMER_MS = 25;

// Long enough to be a change of scene rather than a seam, short enough that nobody sits through
// a track they cannot hear yet.
const XFADE_S = 2.5;

// `notes` is the pad and arpeggio voicing; `bass` is the root the pulse is measured from.
/* Dm Bb F C, twice. The progression every pirate tune ever written sits on.
 *
 * Same bass both times — the octave pulse lives in one register and moving it would just make
 * half the track sound thin. What changes is the VOICING above it: the first pass is an octave
 * down, so the statement sits under the restatement rather than beside it.
 */
const CHORDS = [
  { bass: 38, notes: [50, 53, 57] },   // Dm, voiced low — the intro
  { bass: 34, notes: [50, 53, 58] },   // Bb, voiced low
  { bass: 41, notes: [60, 65, 69] },   // F  — the main section starts here
  { bass: 36, notes: [60, 64, 67] },   // C
  { bass: 38, notes: [62, 65, 69] },   // Dm, open
  { bass: 34, notes: [62, 65, 70] },   // Bb
  { bass: 41, notes: [60, 65, 69] },   // F
  { bass: 36, notes: [60, 64, 67] },   // C, pulling back round to the Dm
];

/* The octave bass, in semitones above the bar's root. Eighth notes, root and octave alternating.
 *
 * This one pattern is most of what synthwave IS. It never rests and it never wanders: the point
 * is relentlessness, and a bass line with ideas in it fights the arpeggio for the same job. The
 * root on the beat and the octave off it is the entire trick.
 */
const PULSE_BASS = [0, null, 12, null, 0, null, 12, null, 0, null, 12, null, 0, null, 12, null];

/* How much of the arpeggio plays, through the two-bar intro.
 *
 * A 1 is a sixteenth that sounds. Two bars, not four: the intro is a door, and the main section
 * is the room. Quarter-notes then most of the sixteenths means the listener hears the same
 * figure getting denser rather than a new thing arriving, which is why bar 3 lands as an
 * arrival instead of as a change of subject.
 */
const ARP_GATE = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1],
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
/* The hook, written as a straight homage to the one everybody means when they say "pirate".
 *
 * That tune is built from one idea repeated three times: FOUR of the same note, then a
 * two-note climb off the top of them. Each repeat starts where the climb before it landed, so
 * the line walks up the scale a third at a time without ever doing anything clever — and that
 * is exactly why it sticks. The fourth bar turns round and falls home.
 *
 *   D D D D  F G        ← the cell
 *   G G G G  A Bb       ← same cell, starting where the last one ended
 *   Bb Bb Bb Bb  C D    ← and again
 *   D C Bb G  D         ← down and home
 *
 * Written an octave above where this started. Down at D4 it sat inside the arpeggio and read
 * as another moving part; at D5 it is clear of everything else in the mix and sounds like a
 * melody rather than a harmony line. Top note is D6, about 1.2 kHz — bright, not shrill.
 *
 * It still enters two eighths late, so it arrives on top of the arpeggio instead of alongside
 * it. D natural minor throughout.
 */
const LEAD = [
  null, null, 74, 74, 74, 74, 77, 79,   // Dm — pickup, four Ds, climb F G
  79, 79, 79, 79, 81, 82, null, null,   // Bb — four Gs, climb A Bb
  82, 82, 82, 82, 84, 86, null, null,   // F  — four B flats, climb C D
  86, 84, 82, 79, 74, null, null, null, // C  — turn round and fall home to the tonic
];

/* The octave shout sits on the CLIMBS, not on the repeated notes.
 *
 * Doubling the repeats would make the loudest part of the bar the part that is standing still.
 * The two-note rise is the thing the ear follows out of each cell, so that is what gets the
 * extra octave — and the last D, because a hook should land on something.
 */
const LEAD_OCTAVE = [
  0, 0, 0, 0, 0, 0, 1, 1,
  0, 0, 0, 0, 1, 1, 0, 0,
  0, 0, 0, 0, 1, 1, 0, 0,
  0, 0, 0, 0, 1, 0, 0, 0,
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
   * The build: filtered noise rising across a bar.
   *
   * One of the two things synthwave uses to mark a section — the other is silence — and the
   * cheaper of the two. A bandpass climbing two octaves while it gets louder reads as "here it
   * comes" to anybody who has heard a record made after 1983.
   */
  function sweep(t, dur) {
    const src = noiseSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass';
    f.Q.value = 2.5;
    f.frequency.setValueAtTime(hz(60), t);
    f.frequency.exponentialRampToValueAtTime(hz(96), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(gain);
    src.start(t);
    src.stop(t + dur + 0.05);
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
    /* Two bars of intro, six of the main section.
     *
     * The synthwave half is the track; the build in front of it is an introduction, and an
     * introduction that lasts as long as the thing it introduces is a second track. The hook
     * still waits until bar 5, so the main section gets two bars of arpeggio on its own before
     * the melody arrives on top of it.
     */
    const intro = bar < INTRO_BARS;

    if (n === 0) pad(t, chord.notes, STEP_DUR * STEPS_PER_BAR);

    // Four on the floor through the whole loop. It is the one thing both halves share, which is
    // what keeps the intro and the main section sounding like one piece of music.
    if (n % 4 === 0) kick(t);
    if (n === 4 || n === 12) snare(t, intro ? 0.085 : 0.12);

    if (intro) {
      // Offbeat sixteenth hats: the shuffle between the kick and the bass, and the only thing
      // in the front half moving faster than an eighth until the build.
      if (n % 2 === 1) hat(t, n === 15);
      const step = PULSE_BASS[n];
      if (step !== null) bass(t, chord.bass + step, STEP_DUR * 1.5);
      // The same arpeggio as the back half, gated down and voiced low — so bar 5 is the figure
      // you have been hearing all along, finally let out.
      if (ARP_GATE[bar][n]) {
        const idx = ARP_ROLL[n];
        arp(t, chord.notes[idx % 3] + Math.floor(idx / 3) * 12, 0.028);
      }
      // The build: a rising noise sweep across the last bar, which is the thing that makes the
      // hook arrive rather than merely start.
      if (bar === INTRO_BARS - 1 && n === 0) sweep(t, STEP_DUR * STEPS_PER_BAR);
    } else {
      if (n % 2 === 1) hat(t, n === 7 || n === 15);
      if (n % 2 === 0) bass(t, chord.bass + (n === 6 || n === 14 ? 12 : 0), STEP_DUR * 1.6);
      const idx = ARP_ROLL[n];
      arp(t, chord.notes[idx % 3] + Math.floor(idx / 3) * 12);
      // The hook occupies the last four bars, so the main section runs two bars of arpeggio
      // on its own first. A negative slot simply has no note in it.
      const slot = (bar - (BARS - 4)) * 8 + (n >> 1);
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
