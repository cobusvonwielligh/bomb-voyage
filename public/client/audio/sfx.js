// Sound effects. Synthesised, per docs/ART-AUDIO.md §6 — there is not one audio file in this
// project and there is not going to be one.
//
// Four things carry the whole design, and they matter more than the individual recipes:
//
//  1. **Positional.** Everything is panned and attenuated by distance from your own player, and
//     anything past SFX_MAX_DISTANCE_TILES is not played at all. Unpanned explosions from across
//     a 41x29 map are exhausting inside a minute.
//  2. **Budgeted.** A chain can set off a dozen bombs on one tick. Past the third, the sound
//     stops being information and becomes noise, so the rest are dropped.
//  3. **Jittered.** Every instance is pitched and timed a few percent off. Identical repeats are
//     the single biggest tell that a game's audio was made by a programmer — a bomb going off
//     four times in a row should not sound like one sample played four times.
//  4. **About you.** Anything that happened TO you is non-positional, longer and louder than the
//     same thing happening to somebody else. You killing someone has its own sound; that
//     confirmation is the most important noise in a deathmatch.

import {
  VOLUME_SFX_DEFAULT, SFX_MAX_DISTANCE_TILES, UNITS_PER_TILE, PERK,
} from '/shared/constants.js';
import { audioContext, createBus, noiseSource, hz, unlock } from './engine.js';

// Per rendered frame. `boom` and `blockdie` are the ones that genuinely need a cap; the rest are
// belt and braces against a pathological snapshot.
const MAX_PER_FRAME = {
  boom: 3, blockdie: 4, blocknew: 2, status: 2, death: 3, fuse: 2,
  // A keg is loud enough that two at once is already a wall. Chat and pickups are one a frame
  // because more than one is never information.
  kegboom: 2, chat: 1, mention: 1, glug: 1, hiccup: 1, ready: 1,
};
const DEFAULT_MAX_PER_FRAME = 4;

// Sounds that are about you, not about a place. Never panned, never attenuated.
const CLOSE_UP = new Set([
  'kill', 'ownDeath', 'ownSpawn', 'fanfare', 'click', 'warn', 'tick', 'streak',
  'hiccup', 'chat', 'mention', 'ready',
]);

// Sounds whose whole job is to say WHERE. Panned to the full width of the field rather than the
// gentle third the general rolloff gives, because a cue you have to concentrate to place is not
// a cue in a game where you are being chased.
const WIDE_PAN = new Set(['spawn']);

export function createSfx({ listener }) {
  let bus = null, space = null;
  let volume = readVolume();
  const spent = new Map();      // voice name -> how many already played this frame

  function readVolume() {
    const v = parseFloat(localStorage.getItem('bv.sfx'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : VOLUME_SFX_DEFAULT;
  }

  /** ±`pct` either way. Presentation only — the simulation never calls Math.random(). */
  const jit = (v, pct = 0.05) => v * (1 + (Math.random() * 2 - 1) * pct);

  /**
   * A cheap plate: one lowpassed feedback delay. Explosions and the fanfare send into it, so a
   * blast sounds like it happened in a stone corridor rather than in an anechoic chamber. Not a
   * real reverb, and a real one is not worth 200 lines here.
   */
  function createSpace(c) {
    const input = c.createGain();
    input.gain.value = 1;
    const delay = c.createDelay(0.5);
    delay.delayTime.value = 0.085;
    const damp = c.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 1700;
    const fb = c.createGain();
    fb.gain.value = 0.38;
    const wet = c.createGain();
    wet.gain.value = 0.42;

    input.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wet);
    wet.connect(bus);
    return input;
  }

  /**
   * Pan and attenuation for a world position, or null if it is too far away to be worth hearing.
   * @param tx tile x, or undefined for a non-positional sound
   */
  function place(tx, ty, wide = false) {
    if (tx === undefined) return { pan: 0, level: 1 };
    const me = listener();
    if (!me) return { pan: 0, level: 1 };
    const dx = tx - me.tx, dy = ty - me.ty;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > SFX_MAX_DISTANCE_TILES) return null;
    return {
      // Three times the spread for the sounds whose whole job is direction. Everything else keeps
      // the gentle version: a map where every footstep is hard left or hard right is a headache.
      pan: Math.max(-1, Math.min(1, (dx / SFX_MAX_DISTANCE_TILES) * (wide ? 3 : 1))),
      // Linear rolloff, not inverse-square. Inverse-square is physically right and sounds wrong
      // here, because a bomb four tiles away matters nearly as much as one at your feet.
      level: 1 - 0.75 * (d / SFX_MAX_DISTANCE_TILES),
      // Far-away sounds also lose their top end, which is what actually reads as distance.
      cutoff: 2000 + 14000 * (1 - d / SFX_MAX_DISTANCE_TILES),
    };
  }

  /**
   * One panner (and one distance lowpass) per sound. Voices build their own envelope gains and
   * connect into `out`, so a voice with several components — a noise burst plus a sine thump —
   * can shape each separately.
   */
  function head(pan, cutoff) {
    const c = audioContext();
    let out = bus;
    if (cutoff && cutoff < 15000) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      lp.connect(out);
      out = lp;
    }
    if (c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      p.connect(out);
      out = p;
    }
    return out;
  }

  /** A gain node with an attack/decay envelope already scheduled on it. */
  function voiceGain(c, out, t, { a = 0.004, d = 0.12, peak = 1, send = 0 }) {
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    g.connect(out);
    if (send > 0 && space) {
      const s = c.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(space);
    }
    return g;
  }

  /** Pitch pairs for each perk, so grabbing a Fire is audibly not grabbing a Skate. */
  const PERK_NOTES = {
    [PERK.BOMB]: [76, 83],      // fifth up — solid, grounded
    [PERK.FIRE]: [79, 83],      // major third — bright
    [PERK.SKATE]: [81, 93],     // octave, quick — it is about speed
    [PERK.SHIELD]: [84, 91],    // high and open
    [PERK.GIFT]: [80, 75],      // DOWN, because it might be a disease
  };

  // ─── the sounds ─────────────────────────────────────────────────────────────
  // Each takes (context, destination, startTime, level, opts) and schedules itself. Nothing here
  // reads the clock or the world: the caller has already decided when, where and how loud.

  const VOICES = {
    /** Short square blip. The sound you hear most, so it stays deliberately out of the way. */
    place(c, out, t, level) {
      const g = voiceGain(c, out, t, { a: 0.002, d: 0.06, peak: 0.13 * level });
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(jit(220, 0.04), t);
      o.frequency.exponentialRampToValueAtTime(jit(180, 0.04), t + 0.06);
      o.connect(g);
      o.start(t); o.stop(t + 0.1);
    },

    /**
     * A bomb about to go off nearby. Pure gameplay information: a quiet, dry tick that climbs as
     * the fuse runs out, so you can hear danger you cannot see round a corner.
     */
    fuse(c, out, t, level, { urgency = 0 } = {}) {
      const g = voiceGain(c, out, t, { a: 0.001, d: 0.035, peak: (0.05 + 0.05 * urgency) * level });
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = jit(1200 + 700 * urgency, 0.02);
      o.connect(g);
      o.start(t); o.stop(t + 0.06);
    },

    /**
     * An explosion, in five layers.
     *
     * The old one was three — noise sweep, sine thump, a crack — and it sounded like a programmer
     * explosion: all of it arrived at once and all of it left at once, so a bomb and a powder keg
     * were the same event at different volumes. Real blasts are a SEQUENCE, and the sequence is
     * what carries size:
     *
     *   1. **Crack.** Highpassed noise, three milliseconds. The transient. Without it the blast
     *      reads as distant no matter how loud the rest is — this is the layer that says "here".
     *   2. **Body.** Bandpassed noise sweeping down. The bulk of what you hear.
     *   3. **Sub.** A sine falling off a cliff. You feel this one more than hear it, and it is
     *      the single biggest difference between a firework and a bomb.
     *   4. **Rubble.** A slow noise tail through a resonant lowpass, half a second of debris
     *      settling. The layer that makes it sound like it happened in a place.
     *   5. **Air.** A short filtered swell that arrives a few milliseconds LATE, which is what
     *      stops all five lining up into one click.
     *
     * `size` (0..1) scales every one of them differently rather than uniformly: a bigger blast
     * is not a louder blast, it is a LONGER and DEEPER one with relatively less crack. That is
     * why a keg at size 1 does not sound like a bomb with the volume up.
     */
    boom(c, out, t, level, { chain = false, size = 0.35 } = {}) {
      const s01 = Math.max(0, Math.min(1, size));
      // A chain goes off early and without warning, so it is pitched up: brighter reads as
      // "that was not supposed to happen yet".
      const up = chain ? 1.15 : 1;
      const long = 1 + s01 * 1.1;                  // bigger blasts ring longer
      const deep = 1 - s01 * 0.35;                 // ...and lower

      // 1. crack
      const cg = voiceGain(c, out, t, { a: 0.0008, d: 0.045 + 0.02 * s01, peak: (0.26 - 0.08 * s01) * level });
      const crack = noiseSource();
      crack.playbackRate.value = jit(1.7, 0.12);
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(jit(3000, 0.1), t);
      hp.frequency.exponentialRampToValueAtTime(900, t + 0.06);
      crack.connect(hp); hp.connect(cg);
      crack.start(t); crack.stop(t + 0.12);

      // 2. body
      const bg = voiceGain(c, out, t, { a: 0.004, d: jit(0.3) * long, peak: 0.46 * level, send: 0.45 });
      const body = noiseSource();
      body.playbackRate.value = jit(1, 0.08);
      const bp = c.createBiquadFilter();
      bp.type = 'lowpass';
      bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(jit(2200 * up, 0.06), t);
      bp.frequency.exponentialRampToValueAtTime(170 * up * deep, t + 0.3 * long);
      body.connect(bp); bp.connect(bg);
      body.start(t); body.stop(t + 0.5 * long);

      // 3. sub
      const sg = voiceGain(c, out, t, { a: 0.003, d: jit(0.24) * long, peak: (0.34 + 0.18 * s01) * level, send: 0.25 });
      const sub = c.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(jit(110 * up, 0.07), t);
      sub.frequency.exponentialRampToValueAtTime(jit(32 * deep, 0.08), t + 0.18 * long);
      sub.connect(sg);
      sub.start(t); sub.stop(t + 0.36 * long);

      // 4. rubble — only worth the nodes on a blast big enough to throw any
      if (s01 > 0.15) {
        const rt = t + 0.05;
        const rg = voiceGain(c, out, rt, { a: 0.04, d: (0.45 + 0.5 * s01), peak: 0.1 * s01 * level, send: 0.6 });
        const rub = noiseSource();
        rub.playbackRate.value = jit(0.55, 0.15);
        const rf = c.createBiquadFilter();
        rf.type = 'lowpass';
        rf.Q.value = 6;                                   // resonant, so it rattles rather than hisses
        rf.frequency.setValueAtTime(jit(700, 0.2), rt);
        rf.frequency.exponentialRampToValueAtTime(150, rt + 0.6);
        rub.connect(rf); rf.connect(rg);
        rub.start(rt); rub.stop(rt + 1.1);
      }

      // 5. air, deliberately late
      const at = t + 0.012;
      const ag = voiceGain(c, out, at, { a: 0.03, d: 0.18 * long, peak: 0.16 * level, send: 0.3 });
      const air = noiseSource();
      air.playbackRate.value = jit(0.8, 0.1);
      const af = c.createBiquadFilter();
      af.type = 'bandpass';
      af.Q.value = 0.7;
      af.frequency.setValueAtTime(jit(520, 0.15), at);
      af.frequency.exponentialRampToValueAtTime(190, at + 0.2);
      air.connect(af); af.connect(ag);
      air.start(at); air.stop(at + 0.4);
    },

    /**
     * A powder keg. The same five layers with the dial turned up, plus the one thing a keg has
     * that a bomb does not: a split second of fizzing powder before it lets go.
     *
     * Radius 7 against a bomb's maximum of 6, and it is the loudest thing in the game. It earns
     * a sound you can pick out of a chain without looking.
     */
    kegboom(c, out, t, level) {
      // The fizz wants to come BEFORE the blast. It only gets as much head start as the
      // scheduling margin allows, which is a few milliseconds — enough to read as a fuse
      // catching rather than as part of the hit, and it cannot be scheduled into the past.
      const ft = Math.max(c.currentTime, t - 0.07);
      const fg = voiceGain(c, out, ft, { a: 0.01, d: 0.09, peak: 0.13 * level });
      const fizz = noiseSource();
      fizz.playbackRate.value = jit(2.2, 0.1);
      const fhp = c.createBiquadFilter();
      fhp.type = 'bandpass';
      fhp.Q.value = 2;
      fhp.frequency.setValueAtTime(3800, ft);
      fhp.frequency.exponentialRampToValueAtTime(6500, ft + 0.08);
      fizz.connect(fhp); fhp.connect(fg);
      fizz.start(ft); fizz.stop(ft + 0.12);

      VOICES.boom(c, out, t, level, { size: 1 });

      // And a second sub an octave down, arriving late enough to read as the ground moving
      // rather than as part of the same hit.
      const gt = t + 0.06;
      const gg = voiceGain(c, out, gt, { a: 0.02, d: 0.6, peak: 0.3 * level, send: 0.4 });
      const ground = c.createOscillator();
      ground.type = 'sine';
      ground.frequency.setValueAtTime(jit(54, 0.06), gt);
      ground.frequency.exponentialRampToValueAtTime(23, gt + 0.5);
      ground.connect(gg);
      ground.start(gt); ground.stop(gt + 0.7);
    },

    /** Two-note arpeggio. The interval says which perk it was. */
    pickup(c, out, t, level, { perk } = {}) {
      const notes = PERK_NOTES[perk] || [79, 86];
      for (const [i, n] of notes.entries()) {
        const at = i * 0.045;
        const g = voiceGain(c, out, t + at, { a: 0.003, d: 0.08, peak: 0.28 * level });
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = jit(hz(n), 0.004);
        o.connect(g);
        o.start(t + at); o.stop(t + at + 0.14);
      }
    },

    /** Descending saw. Somebody else just died, somewhere over there. */
    death(c, out, t, level) {
      const g = voiceGain(c, out, t, { a: 0.006, d: 0.4, peak: 0.26 * level, send: 0.2 });
      const o = c.createOscillator();
      const f = c.createBiquadFilter();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(jit(330, 0.05), t);
      o.frequency.exponentialRampToValueAtTime(70, t + 0.4);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(1800, t);
      f.frequency.exponentialRampToValueAtTime(400, t + 0.4);
      o.connect(f); f.connect(g);
      o.start(t); o.stop(t + 0.5);
    },

    /** You died. Same idea, bigger, slower, and right in front of you. */
    ownDeath(c, out, t) {
      const g = voiceGain(c, out, t, { a: 0.008, d: 0.75, peak: 0.42, send: 0.45 });
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(2200, t);
      f.frequency.exponentialRampToValueAtTime(260, t + 0.7);
      for (const [type, detune] of [['sawtooth', 0], ['sawtooth', -14]]) {
        const o = c.createOscillator();
        o.type = type;
        o.detune.value = detune;
        o.frequency.setValueAtTime(300, t);
        o.frequency.exponentialRampToValueAtTime(52, t + 0.7);
        o.connect(f);
        o.start(t); o.stop(t + 0.85);
      }
      f.connect(g);
    },

    /**
     * You killed someone. The most important sound in the game, so it is the only one that is
     * both bright and consonant: a clean two-note stab up a fourth, with a tiny click on front.
     */
    kill(c, out, t) {
      for (const [n, at, d] of [[88, 0, 0.1], [93, 0.055, 0.3]]) {
        const g = voiceGain(c, out, t + at, { a: 0.002, d, peak: 0.34, send: 0.25 });
        for (const [type, detune] of [['square', 0], ['triangle', 8]]) {
          const o = c.createOscillator();
          o.type = type;
          o.frequency.value = hz(n);
          o.detune.value = detune;
          o.connect(g);
          o.start(t + at); o.stop(t + at + d + 0.1);
        }
      }
      const cg = voiceGain(c, out, t, { a: 0.001, d: 0.03, peak: 0.18 });
      const s = noiseSource();
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 4000;
      s.connect(hp); hp.connect(cg);
      s.start(t); s.stop(t + 0.06);
    },

    /**
     * Somebody has arrived over there. Rising, the inverse of death, and the one positional cue
     * that is allowed to be loud: it is panned and attenuated by where it happened, so the sound
     * alone tells you which side of you a player just materialised on. A quiet version of that
     * is no cue at all.
     */
    spawn(c, out, t, level) {
      const g = voiceGain(c, out, t, { a: 0.015, d: 0.34, peak: 0.34 * level, send: 0.25 });
      for (const [mul, detune] of [[1, 0], [1.5, 6]]) {
        const o = c.createOscillator();
        o.type = 'triangle';
        o.detune.value = detune;
        o.frequency.setValueAtTime(220 * mul, t);
        o.frequency.exponentialRampToValueAtTime(jit(660, 0.02) * mul, t + 0.3);
        o.connect(g);
        o.start(t); o.stop(t + 0.45);
      }
      // A soft thump of air underneath, so an arrival behind you is felt as well as heard.
      const tg = voiceGain(c, out, t, { a: 0.004, d: 0.18, peak: 0.22 * level });
      const thump = c.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(190, t);
      thump.frequency.exponentialRampToValueAtTime(70, t + 0.16);
      thump.connect(tg);
      thump.start(t); thump.stop(t + 0.26);
    },

    /** You are back. Same shape, with a fifth under it so it feels like a start, not an event. */
    /**
     * Your own arrival: a falling whoosh that lands on a thump, then the rising chime.
     *
     * Matched to what the sprite does. It drops in from twenty times its size and collapses, so
     * the sound has to fall too — a rising tone alone said "something good happened" when the
     * picture said "something just landed". The noise sweeps DOWN through the collapse, the
     * thump hits where the squash is, and only then does the chime rise.
     */
    ownSpawn(c, out, t) {
      // The descent. Bandpassed noise falling 5 kHz -> 400 Hz over the pop window.
      const air = voiceGain(c, out, t, { a: 0.03, d: 0.3, peak: 0.3, send: 0.25 });
      const s = noiseSource();
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(5000, t);
      bp.frequency.exponentialRampToValueAtTime(400, t + 0.3);
      s.connect(bp); bp.connect(air);
      s.start(t); s.stop(t + 0.42);

      // The landing, a fifth of a second in, where the sprite reaches normal size.
      const hit = t + 0.2;
      const body = voiceGain(c, out, hit, { a: 0.004, d: 0.26, peak: 0.42, send: 0.35 });
      const thump = c.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(180, hit);
      thump.frequency.exponentialRampToValueAtTime(52, hit + 0.22);
      thump.connect(body);
      thump.start(hit); thump.stop(hit + 0.3);

      // And the chime, after the impact rather than through it.
      for (const [mul, peak] of [[1, 0.2], [1.5, 0.12]]) {
        const g = voiceGain(c, out, hit + 0.02, { a: 0.02, d: 0.34, peak, send: 0.2 });
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(220 * mul, hit + 0.02);
        o.frequency.exponentialRampToValueAtTime(660 * mul, hit + 0.32);
        o.connect(g);
        o.start(hit + 0.02); o.stop(hit + 0.45);
      }
    },

    /** Wobbly detuned pair — something is wrong with you now. */
    status(c, out, t, level) {
      const g = voiceGain(c, out, t, { a: 0.01, d: 0.26, peak: 0.24 * level });
      const lfo = c.createOscillator();
      const lfoGain = c.createGain();
      lfo.frequency.value = jit(7, 0.15);
      lfoGain.gain.value = 22;          // cents of wobble
      lfo.connect(lfoGain);
      for (const detune of [-18, 18]) {
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = hz(69);
        o.detune.value = detune;
        lfoGain.connect(o.detune);
        o.connect(g);
        o.start(t); o.stop(t + 0.28);
      }
      lfo.start(t); lfo.stop(t + 0.3);
    },

    /** A shield eating a blast: a glassy ping, so "that should have killed me" lands. */
    shield(c, out, t, level) {
      for (const [n, at] of [[88, 0], [95, 0.03]]) {
        const g = voiceGain(c, out, t + at, { a: 0.002, d: 0.34, peak: 0.26 * level, send: 0.4 });
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.value = hz(n);
        o.connect(g);
        o.start(t + at); o.stop(t + at + 0.45);
      }
    },

    /**
     * The round clock, in the last fifteen seconds. One tick a second, climbing in pitch and
     * loudness as it runs out, so the last few feel like the last few without anybody having to
     * look at the number.
     */
    tick(c, out, t, level, { urgency = 0 } = {}) {
      const g = voiceGain(c, out, t, { a: 0.001, d: 0.05 + urgency * 0.08,
        peak: (0.06 + 0.22 * urgency * urgency) * level, send: urgency * 0.3 });
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = 660 + 440 * urgency;
      o.connect(g);
      o.start(t); o.stop(t + 0.2);
      // The last three get a body under them, so the end of a round lands rather than stops.
      if (urgency > 0.8) {
        const tg = voiceGain(c, out, t, { a: 0.002, d: 0.18, peak: 0.2 * level });
        const thump = c.createOscillator();
        thump.type = 'sine';
        thump.frequency.setValueAtTime(160, t);
        thump.frequency.exponentialRampToValueAtTime(60, t + 0.16);
        thump.connect(tg);
        thump.start(t); thump.stop(t + 0.26);
      }
    },

    /**
     * A kill streak, escalating. `step` is how far up the ladder this one is, 0 for a double and
     * 1 for an ace: more voices, a wider chord, longer tails. A double should be a flourish and
     * an ace should stop the room.
     */
    streak(c, out, t, level, { step = 0 } = {}) {
      // Root, fifth, octave, then the third above it: each rung adds a note rather than just
      // getting louder, which is what makes the escalation audible rather than merely felt.
      const notes = [72, 79, 84, 88].slice(0, 2 + Math.round(step * 2));
      for (const [i, n] of notes.entries()) {
        const at = i * (0.075 - step * 0.02);
        const d = 0.22 + step * 0.5 + i * 0.04;
        const g = voiceGain(c, out, t + at, {
          a: 0.004, d, peak: (0.2 + 0.16 * step) * level, send: 0.3 + 0.3 * step,
        });
        for (const [type, detune] of [['square', 0], ['triangle', 7], ['sawtooth', -9]]) {
          const o = c.createOscillator();
          o.type = type;
          o.frequency.value = hz(n);
          o.detune.value = detune;
          o.connect(g);
          o.start(t + at); o.stop(t + at + d + 0.2);
        }
      }
      // A rising sweep underneath, longer and deeper the higher the streak.
      const sg = voiceGain(c, out, t, { a: 0.01, d: 0.3 + step * 0.4, peak: 0.22 * level, send: 0.4 });
      const sweep = c.createOscillator();
      sweep.type = 'sawtooth';
      sweep.frequency.setValueAtTime(70, t);
      sweep.frequency.exponentialRampToValueAtTime(260 + 240 * step, t + 0.3 + step * 0.35);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(600, t);
      f.frequency.exponentialRampToValueAtTime(3000 + 3000 * step, t + 0.35);
      sweep.connect(f); f.connect(sg);
      sweep.start(t); sweep.stop(t + 0.8 + step * 0.5);
    },

    /** Your invulnerability is about to run out. Two dry ticks: a warning, not a fanfare. */
    warn(c, out, t) {
      for (const at of [0, 0.1]) {
        const g = voiceGain(c, out, t + at, { a: 0.002, d: 0.05, peak: 0.12 });
        const o = c.createOscillator();
        o.type = 'square';
        o.frequency.value = 880;
        o.connect(g);
        o.start(t + at); o.stop(t + at + 0.08);
      }
    },

    /** A wall coming apart. Quiet — this fires several times per explosion. */
    blockdie(c, out, t, level) {
      const g = voiceGain(c, out, t, { a: 0.003, d: jit(0.15), peak: 0.16 * level });
      const s = noiseSource();
      s.playbackRate.value = jit(1, 0.12);
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(jit(900, 0.1), t);
      f.frequency.exponentialRampToValueAtTime(420, t + 0.14);
      f.Q.value = 0.7;
      s.connect(f); f.connect(g);
      s.start(t); s.stop(t + 0.25);
    },

    /** A wall growing back. You need to notice this: your escape route just changed. */
    blocknew(c, out, t, level) {
      const g = voiceGain(c, out, t, { a: 0.004, d: 0.18, peak: 0.2 * level, send: 0.25 });
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(jit(150, 0.06), t);
      o.frequency.exponentialRampToValueAtTime(70, t + 0.16);
      o.connect(g);
      o.start(t); o.stop(t + 0.25);
      const ng = voiceGain(c, out, t, { a: 0.003, d: 0.1, peak: 0.1 * level });
      const s = noiseSource();
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 700;
      s.connect(f); f.connect(ng);
      s.start(t); s.stop(t + 0.15);
    },

    /** C E G C. The only unsubtle thing in the project, and it plays once a round. */
    fanfare(c, out, t) {
      for (const [i, n] of [72, 76, 79, 84].entries()) {
        const at = i * 0.13;
        const d = i === 3 ? 0.7 : 0.17;
        const g = voiceGain(c, out, t + at, { a: 0.006, d, peak: 0.26, send: 0.5 });
        for (const [type, detune] of [['square', 0], ['triangle', 6], ['sawtooth', -8]]) {
          const o = c.createOscillator();
          o.type = type;
          o.frequency.value = hz(n);
          o.detune.value = detune;
          o.connect(g);
          o.start(t + at); o.stop(t + at + d + 0.2);
        }
      }
    },

    /** UI. One tick, so a button feels like a button. */
    click(c, out, t) {
      const g = voiceGain(c, out, t, { a: 0.001, d: 0.03, peak: 0.1 });
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = 1400;
      o.connect(g);
      o.start(t); o.stop(t + 0.05);
    },

    /**
     * Rum. Three descending glugs and a cork.
     *
     * It gets its own voice rather than a pair of notes from PERK_NOTES because it is the one
     * perk you might not have wanted. Every other pickup goes UP; this one goes down, and it is
     * the only pickup with a sense of humour, which is the warning.
     */
    glug(c, out, t, level) {
      for (let i = 0; i < 3; i++) {
        const at = t + i * 0.085;
        const g = voiceGain(c, out, at, { a: 0.006, d: 0.07, peak: 0.22 * level });
        const o = c.createOscillator();
        o.type = 'sine';
        // Each glug lower than the last, and each one bends down inside itself. A bottle
        // emptying raises in pitch; a bottle going INTO somebody does the opposite.
        o.frequency.setValueAtTime(jit(300 - i * 55, 0.05), at);
        o.frequency.exponentialRampToValueAtTime(jit(150 - i * 30, 0.05), at + 0.07);
        o.connect(g);
        o.start(at); o.stop(at + 0.1);
      }
      const ct = t + 0.26;
      const cg = voiceGain(c, out, ct, { a: 0.001, d: 0.04, peak: 0.16 * level });
      const pop = c.createOscillator();
      pop.type = 'triangle';
      pop.frequency.setValueAtTime(700, ct);
      pop.frequency.exponentialRampToValueAtTime(220, ct + 0.04);
      pop.connect(cg);
      pop.start(ct); pop.stop(ct + 0.07);
    },

    /** You, drunk. A small involuntary noise, occasionally, while the rum is on you. */
    hiccup(c, out, t) {
      const g = voiceGain(c, out, t, { a: 0.004, d: 0.1, peak: 0.1 });
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(jit(360, 0.12), t);
      o.frequency.exponentialRampToValueAtTime(jit(620, 0.12), t + 0.035);
      o.frequency.exponentialRampToValueAtTime(jit(240, 0.1), t + 0.1);
      o.connect(g);
      o.start(t); o.stop(t + 0.15);
    },

    /** Somebody said something. Deliberately the quietest voice in here. */
    chat(c, out, t) {
      const g = voiceGain(c, out, t, { a: 0.002, d: 0.045, peak: 0.055 });
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t);
      o.frequency.setValueAtTime(1175, t + 0.035);
      o.connect(g);
      o.start(t); o.stop(t + 0.09);
    },

    /** Somebody said YOUR name. Same shape, up a fourth and twice as loud, so it cuts through. */
    mention(c, out, t) {
      for (const [i, n] of [84, 89, 91].entries()) {
        const at = t + i * 0.055;
        const g = voiceGain(c, out, at, { a: 0.003, d: 0.1, peak: 0.16 });
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = hz(n);
        o.connect(g);
        o.start(at); o.stop(at + 0.16);
      }
    },

    /**
     * The respawn countdown reached zero.
     *
     * Worth a sound of its own: you have been watching a number for ten seconds and the moment
     * it becomes a button is the moment you want to stop watching it.
     */
    ready(c, out, t) {
      for (const [i, n] of [76, 83].entries()) {
        const at = t + i * 0.08;
        const g = voiceGain(c, out, at, { a: 0.004, d: 0.22, peak: 0.19, send: 0.25 });
        const o = c.createOscillator();
        o.type = 'square';
        o.frequency.value = hz(n);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 2200;
        o.connect(f); f.connect(g);
        o.start(at); o.stop(at + 0.3);
      }
    },
  };

  // ─── public surface ─────────────────────────────────────────────────────────

  return {
    get volume() { return volume; },
    get ready() { return bus !== null; },

    /** Shares the context's unlock with the music, so one click covers both. */
    async start() {
      const ok = await unlock();
      if (!bus) {
        bus = createBus(volume);
        space = createSpace(audioContext());
      }
      return ok;
    },

    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      localStorage.setItem('bv.sfx', String(volume));
      if (bus) bus.gain.setTargetAtTime(volume, audioContext().currentTime, 0.03);
    },

    /** Call once per rendered frame: resets the per-frame budget. */
    frame() { if (spent.size) spent.clear(); },

    /**
     * @param name a key of VOICES
     * @param tx   tile x of the source. Ignored for the CLOSE_UP sounds.
     * @param opts passed through to the voice, e.g. `{chain: true}` or `{perk: PERK.FIRE}`
     */
    play(name, tx, ty, opts) {
      const voice = VOICES[name];
      if (!voice || !bus || volume <= 0) return;

      const cap = MAX_PER_FRAME[name] ?? DEFAULT_MAX_PER_FRAME;
      const used = spent.get(name) || 0;
      if (used >= cap) return;

      const where = place(CLOSE_UP.has(name) ? undefined : tx, ty, WIDE_PAN.has(name));
      if (!where) return;                   // too far away to hear

      const c = audioContext();
      if (c.state !== 'running') return;    // still blocked; do not pile up dead nodes

      spent.set(name, used + 1);
      // A hair into the future: scheduling at exactly currentTime puts the first milliseconds of
      // the envelope in the past, which clicks.
      voice(c, head(where.pan, where.cutoff), c.currentTime + 0.005, where.level, opts || {});
    },

    /** Convenience for the events that carry sim units rather than tiles. */
    playAtUnits(name, x, y, opts) {
      this.play(name, Math.floor(x / UNITS_PER_TILE), Math.floor(y / UNITS_PER_TILE), opts);
    },
  };
}
