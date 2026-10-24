// Bomb Voyage — the music.
//
// This module owns everything that counts as "the music": the theme, the three ambient beds in
// ./ambient.js, and the cycling between them. They all sit behind one public surface, so main.js
// still only ever says start / stop / toggle / setVolume / duck and never learns that there is
// more than one track.
//
// EVERY TRACK IS A FILE NOW — `/assets/audio/{theme,drift,suspend,undertow}.mp3`. This is the
// one place the project departs from "everything is generated in code", and it departs on
// purpose: a produced mix beats a synthesised one at being listened to, by a distance no amount
// of oscillator work closes.
//
// Each file is named after the SLOT it fills, not after the mix it came from, which is what
// makes the fallback automatic — a track asks for its own name and gets either the file or
// itself. So the synthesised theme below is NOT dead code. It is the fallback: if the file 404s,
// fails to decode, or the browser refuses the format, `createTheme` takes over and there is
// music instead of silence. It is also still the reference for what the file should sound like,
// and the tests still hold it to that. Everything from here to createMusic() describes it.
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
/* The hook you liked, with three small changes and nothing else.
 *
 * The shape is the one from before: a pickup into a hammered fifth, an answer that falls and
 * leaves a bar of air, the same cell restated, then a run home down the scale. That is what
 * was working, so it is untouched.
 *
 * What changed:
 *   1. **An octave up.** Down at D4 it shared a register with the arpeggio and read as another
 *      moving part. At D5 it is clear of everything else and sounds like a tune.
 *   2. **It enters two eighths late**, so it arrives on top of the arpeggio rather than
 *      alongside it — the difference between a chorus and a change of track.
 *   3. **The last phrase lands on the tonic and stops**, instead of touching it and then
 *      adding another note after. The silence is the part people sing along to.
 *
 * D natural minor throughout.
 */
const LEAD = [
  null, null, 74, 74, 81, null, 81, 79,   // Dm — pickup, then hammer the fifth. This is the hook.
  null, 82, 81, 79, 77, null, null, null, // Bb — answer it falling, and leave a bar of air
  null, 72, 72, 81, null, 81, 84, 81,     // F  — the same cell a fourth up: repetition is the hook
  86, 84, 81, 79, 74, null, null, null,   // C  — run home down the scale and land on the tonic
];

/* The octave shout, on the two moments the phrase peaks and nowhere else.
 *
 * Doubling more than that stops being an accent and becomes a second melody an octave up,
 * which is a different and much busier arrangement.
 */
const LEAD_OCTAVE = [
  0, 0, 0, 0, 1, 0, 1, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 1, 0, 1, 1, 0,
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

// ─── produced tracks ──────────────────────────────────────────────────────────

/* Every track in the rotation now has a file, and every file is named after the slot it fills.
 *
 * Naming them `theme.mp3`, `drift.mp3` and so on rather than after the mixes they came from is
 * what makes the fallback automatic: a track asks for `/assets/audio/<its own name>.mp3`, and
 * if that is not there it is the synthesised version of itself. Nothing maps names to files. */
const AUDIO_DIR = '/assets/audio/';

// How long to wait for a file's metadata before giving up and using the synth. Metadata is a few
// kilobytes off the front of the file, not the three megabytes of audio, so this is generous.
const METADATA_TIMEOUT_MS = 4000;

/**
 * A produced mix, wearing the same clothes as a synthesised track.
 *
 * The sequencer in createMusic() knows about `steps`, `stepDur`, `repeats`, `gain` and
 * `schedule(step, time)`, and nothing else. A whole mix is just a track with ONE step whose
 * duration is the length of the file — so crossfading, excluding, muting, ducking and the
 * rotation all keep working with no special case anywhere above this function.
 *
 * Resolves to null if the file cannot be used, so the caller can fall back to the synth.
 */
async function createFileTrack({ bus, name, loop = false }) {
  const ctx = audioContext();
  const src = `${AUDIO_DIR}${name}.mp3`;
  const el = new Audio();
  el.src = src;
  // Metadata, NOT 'auto'. There are four of these and they are three megabytes each: preloading
  // the lot would pull twelve megabytes the moment somebody unmutes, for three tracks they will
  // not hear for the next five minutes. The one that is playing streams, the rest stay idle.
  el.preload = 'metadata';
  // The theme loops; the beds do not. A looping track never rotates away, which is exactly
  // what 'the theme plays on the dashboard, always' means — see `repeats` below.
  el.loop = loop;
  // The element's own volume stays at 1. The fader is the gain node below, because that is what
  // crossfade() automates and it has to be on the AudioContext clock, not the DOM one.
  el.volume = 1;

  // Is it there, does it decode, does this browser want the format? Known once metadata lands.
  const ok = await new Promise(resolve => {
    const done = v => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(false), METADATA_TIMEOUT_MS);
    el.addEventListener('loadedmetadata', () => done(Number.isFinite(el.duration) && el.duration > 1), { once: true });
    el.addEventListener('error', () => done(false), { once: true });
    el.load();
  });
  if (!ok) {
    console.warn(`music: ${src} unavailable, falling back to the synthesised "${name}"`);
    return null;
  }

  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(bus);
  // Once only — an element can have exactly one MediaElementAudioSourceNode, and creating a
  // second throws. Routing it through WebAudio also takes it off the page's own output, which
  // is what puts it behind the music bus and the volume slider with everything else.
  ctx.createMediaElementSource(el).connect(gain);

  let pauseTimer = null;

  return {
    name,
    /** So the now-playing readout can say `name.mp3` only when it really is one. */
    file: true,
    steps: 1,
    /* A looping track NEVER hands over.
     *
     * `repeats: Infinity` means the sequencer's `loops >= repeats` can never be true, so
     * crossfade() is never reached and this track owns the rotation until something calls
     * jumpTo — which is precisely what starting a round does. The element's own `loop` does the
     * actual repeating, gaplessly; `schedule` below is a no-op while it is already running. */
    repeats: loop ? Infinity : 1,

    /* The crossfade has to OVERLAP the end of the file, not follow it.
     *
     * The sequencer calls crossfade() after `steps * stepDur` has elapsed and then ramps over
     * XFADE_S. Report the true duration and the next track starts fading up two and a half
     * seconds after this one has already stopped, which is two and a half seconds of silence
     * between every theme and whatever follows it. Ending early by exactly the fade length puts
     * the ramp across the outro instead. */
    get stepDur() { return Math.max(XFADE_S + 1, el.duration - XFADE_S); },

    gain,

    schedule(step) {
      if (step !== 0) return;
      clearTimeout(pauseTimer);
      // Already running and looping: leave it alone. Restarting it every `stepDur` would chop
      // the gapless loop the element is giving us for free.
      if (loop && !el.paused) return;
      // Close enough: `time` is at most LOOKAHEAD_S away, and a music bed does not need
      // sample-accurate entry the way a hi-hat does.
      try { el.currentTime = 0; } catch { /* not seekable yet; it starts at 0 anyway */ }
      el.play().catch(() => { /* a gesture is still owed, or the tab is hidden */ });
    },

    /**
     * Stop costing anything once we have faded away. Optional on a track — the synthesised ones
     * simply stop being scheduled, but an <audio> element keeps decoding into a silent gain node
     * forever unless somebody tells it not to.
     */
    leave(at = 0) {
      clearTimeout(pauseTimer);
      const inMs = Math.max(0, (at - ctx.currentTime) * 1000);
      pauseTimer = setTimeout(() => el.pause(), inMs);
    },
  };
}

export function createMusic() {
  let ctx = null, timer = null, tracks = null, musicGain = null, sidechain = null;
  let step = 0, loops = 0, current = 0, nextTime = 0;
  /* Which track you can actually HEAR, as opposed to which one is being scheduled.
   *
   * They are not the same thing, and the gap between them used to be invisible. The scheduler
   * works ahead: it queues a step, then advances `current` so the NEXT step comes from the next
   * track. With synthesised tracks a step is 0.13 s, so `current` was wrong for a frame and
   * nobody could tell. A produced track is ONE step of about three minutes — so `current`
   * named the next track for the entire time this one was playing.
   *
   * Which broke two things: the now-playing readout showed the wrong title for three minutes,
   * and `exclude(name)`'s "is that the one playing?" check consulted a track that had not
   * started, so excluding the theme while the theme was audible did nothing.
   *
   * `sounding` flips when the crossfade's start time actually arrives on the audio clock. */
  let sounding = 0;
  let pendingAt = 0, pendingIndex = 0;
  // Track names the rotation must not pick. The theme lives here for the whole of a round.
  const excluded = new Set();
  let volume = readVolume();
  let playing = false, ducked = false;

  function readVolume() {
    const v = parseFloat(localStorage.getItem('bv.music'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : VOLUME_MUSIC_DEFAULT;
  }

  /* Does this person want music at all? Yes, unless they have said otherwise.
   *
   * Stored separately from the volume, because they answer different questions: the volume is
   * how loud, this is whether. Muting to zero and pausing are not the same act and should not
   * share a setting — see the mute button in main.js.
   *
   * Default TRUE, and the check is `!== '0'` rather than `=== '1'` so a browser with nothing
   * stored, or with the key cleared, lands on playing. The music is the first impression; a
   * silent landing page that needs a button press to become the thing it is supposed to be is
   * a worse default than one somebody occasionally has to turn off.
   */
  const WANTED_KEY = 'bv.musicOn';
  let wanted = localStorage.getItem(WANTED_KEY) !== '0';
  const setWanted = v => {
    wanted = v;
    localStorage.setItem(WANTED_KEY, v ? '1' : '0');
  };

  async function build() {
    // Shared with the sound effects. One context, so one user gesture unlocks both and turning
    // the music off cannot take the sound effects down with it.
    ctx = audioContext();
    musicGain = createMusicBus(volume);
    /* A gain node of its own, between the tracks and the bus, for the explosion duck.
     *
     * It exists so that `applyGain` stays the ONLY writer of `musicGain` — the property the
     * comment above it is about, and which a previous bug cost a whole session of silence.
     * A dip and a volume change are different concerns on different clocks: one is a 300 ms
     * transient fired by the game, the other is a setting. Sharing a parameter between them
     * means every dip races every slider move. Two nodes, two owners, no race. */
    sidechain = ctx.createGain();
    sidechain.gain.value = 1;
    sidechain.connect(musicGain);

    /* Four slots, each a produced mix if its file is reachable and the synthesised version of
     * itself if it is not.
     *
     * The synthesised tracks are built either way, and that is on purpose rather than wasteful:
     * they are what defines the slot — its name, and what it should sound like — and an unused
     * one costs a single gain node at zero that is never scheduled. No oscillator exists until
     * something calls its `schedule`.
     *
     * The theme is first because start() always comes back to the top, and the track somebody
     * turned off is the one they expect back when they turn it on again. */
    const synth = [createTheme({ bus: sidechain }), ...createAmbient({ bus: sidechain })];
    // In parallel: four metadata probes in sequence would be four round trips in front of the
    // first note, on a path that a user gesture is waiting on.
    tracks = await Promise.all(synth.map(async fallback =>
      await createFileTrack({
        bus: sidechain, name: fallback.name,
        // The theme belongs to the dashboard and plays there the whole time you are on it.
        loop: fallback.name === 'theme',
      }) ?? fallback));
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
    // A synthesised track just stops being scheduled. A file-backed one has to be told, or it
    // keeps decoding into a fader that is already at zero for the rest of the session.
    tracks[current].leave?.(at + XFADE_S);
    current = nextTrack();
    // What is audible does not change until `at`; see `sounding`.
    pendingAt = at;
    pendingIndex = current;
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
    sounding = startAt;
    pendingAt = 0;
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
      if (i !== next) track.leave?.(now + XFADE_S);
    }
    current = next;
    // A jump is immediate by definition, so there is nothing pending about it.
    sounding = next;
    pendingAt = 0;
    step = 0;
    loops = 0;
    /* Start the new track NOW, not whenever the old one's clock said the next step was due.
     *
     * This was `Math.max(nextTime, now + 0.05)`, which was right when every track was a synth
     * on a 0.13-second grid: the max only ever rounded up by a frame. A produced track has a
     * step of about three MINUTES, so leaving the menu left `nextTime` stranded that far in the
     * future and the bed you jumped to was never scheduled at all. The fader came up on
     * silence, and the game started with no music until the theme's step finally elapsed. */
    nextTime = now + 0.05;
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

  /** The same walk, backwards, for the skip-back button. */
  function prevTrack() {
    for (let i = 1; i <= tracks.length; i++) {
      const n = (current - i + tracks.length * i) % tracks.length;
      if (!excluded.has(tracks[n].name)) return n;
    }
    return current;
  }

  function scheduler() {
    // The handover we queued earlier has now arrived in real time, so what you hear has changed.
    if (pendingAt && ctx.currentTime >= pendingAt) { sounding = pendingIndex; pendingAt = 0; }

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

    /** Which of the four tracks you can hear right now. Drives the now-playing readout. */
    get track() { return tracks ? tracks[sounding].name : null; },

    /**
     * Must be called from a user gesture the first time — browsers block audio otherwise.
     *
     * `from` names where to come in. The theme belongs to the landing page: it has a tune and a
     * backbeat, which is right for twenty seconds of reading a menu and wrong for ten minutes of
     * being hunted. Starting a round jumps straight to an ambient bed instead.
     */
    async start(from = 'theme') {
      setWanted(true);
      if (!ctx) await build();
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
     * Whether music is wanted at all, remembered across sessions and defaulting to yes.
     *
     * Separate from `playing`, which is whether it is running RIGHT NOW: a browser will not
     * let anything start before a gesture, so there is always a window where this is true and
     * `playing` is not. That window is exactly what the autostart in main.js is closing.
     */
    get wanted() { return wanted; },

    /** True when what you are hearing is the produced file rather than the synth fallback. */
    get trackIsFile() { return !!tracks?.[sounding]?.file; },

    /**
     * Skip, in either direction. Both honour `excluded`, so neither can land you on the theme
     * in the middle of a round — which is the one thing a skip button must not be able to do.
     *
     * `current = sounding` first: the scheduler may have queued a handover minutes out, and a
     * skip is relative to what the person pressing it can HEAR, not to what is queued.
     */
    next() {
      if (!playing || !tracks) return;
      current = sounding;
      jumpTo(nextTrack());
    },

    prev() {
      if (!playing || !tracks) return;
      current = sounding;
      jumpTo(prevTrack());
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
      // `sounding`, not `current`: the question is whether you can hear it, and the scheduler
      // may already have queued a handover three minutes out.
      if (off && playing && tracks && tracks[sounding]?.name === name) {
        current = sounding;
        jumpTo(nextTrack());
      }
    },

    stop() {
      setWanted(false);
      clearInterval(timer);
      timer = null;
      playing = false;
      applyGain();
      // The bus ramps to silence over a moment; let the file ride that down rather than
      // chopping it, then stop it decoding. Synthesised tracks have no `leave` and need none.
      for (const track of tracks ?? []) track.leave?.(ctx.currentTime + 0.3);
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

    /**
     * Get out of the way of something loud, briefly. A sidechain, in the mixing sense.
     *
     * The problem it solves is that an explosion and a bassline occupy the same hundred hertz,
     * so a blast landing on a downbeat half disappears into it — the music is not loud, but it
     * is in the way. Pulling the music down for a third of a second makes the blast feel
     * bigger without making anything louder, which is the whole trick, and it is why a game
     * mix with ducking sounds expensive and one without sounds flat.
     *
     * Down fast and up slow, deliberately: a quick recovery pumps audibly and draws attention
     * to the duck itself, which is the one thing it must never do.
     *
     * @param depth 0..1, how far down. 1 is silence.
     */
    dip(depth = 0.45, recoverS = 0.38) {
      if (!sidechain || !playing) return;
      const g = sidechain.gain;
      const now = ctx.currentTime;
      const floor = Math.max(0, Math.min(1, 1 - depth));
      // Never dip ABOVE where a still-recovering earlier dip has got to: two blasts in quick
      // succession must duck further, not reset the first one upwards.
      const from = Math.min(g.value, 1);
      g.cancelScheduledValues(now);
      g.setValueAtTime(from, now);
      g.linearRampToValueAtTime(Math.min(from, floor), now + 0.02);
      g.linearRampToValueAtTime(1, now + 0.02 + recoverS);
    },
  };
}
