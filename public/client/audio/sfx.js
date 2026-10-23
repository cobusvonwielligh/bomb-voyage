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
const MAX_PER_FRAME = { boom: 3, blockdie: 4, blocknew: 2, status: 2, death: 3, fuse: 2 };
const DEFAULT_MAX_PER_FRAME = 4;

// Sounds that are about you, not about a place. Never panned, never attenuated.
const CLOSE_UP = new Set(['kill', 'ownDeath', 'ownSpawn', 'fanfare', 'click', 'warn']);

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

    /** Filtered noise burst sweeping 2 kHz -> 200 Hz, plus a sine thump for the body. */
    boom(c, out, t, level, { chain = false } = {}) {
      const up = chain ? 1.15 : 1;      // a chain is the same sound, pitched up 15 %
      const g = voiceGain(c, out, t, { a: 0.004, d: jit(0.3), peak: 0.5 * level, send: 0.5 });
      const s = noiseSource();
      s.playbackRate.value = jit(1, 0.08);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 1.2;
      f.frequency.setValueAtTime(jit(2000 * up, 0.06), t);
      f.frequency.exponentialRampToValueAtTime(200 * up, t + 0.3);
      s.connect(f); f.connect(g);
      s.start(t); s.stop(t + 0.45);

      const tg = voiceGain(c, out, t, { a: 0.002, d: jit(0.22), peak: 0.42 * level, send: 0.3 });
      const thump = c.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(jit(100 * up, 0.07), t);
      thump.frequency.exponentialRampToValueAtTime(38, t + 0.16);
      thump.connect(tg);
      thump.start(t); thump.stop(t + 0.3);

      // A short crack on top. Without it the blast is all body and reads as distant.
      const cg = voiceGain(c, out, t, { a: 0.001, d: 0.05, peak: 0.2 * level });
      const crack = noiseSource();
      crack.playbackRate.value = jit(1.6, 0.1);
      const hpf = c.createBiquadFilter();
      hpf.type = 'highpass';
      hpf.frequency.value = 2600;
      crack.connect(hpf); hpf.connect(cg);
      crack.start(t); crack.stop(t + 0.1);
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
    ownSpawn(c, out, t) {
      for (const [mul, peak] of [[1, 0.24], [1.5, 0.14]]) {
        const g = voiceGain(c, out, t, { a: 0.02, d: 0.34, peak, send: 0.2 });
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(220 * mul, t);
        o.frequency.exponentialRampToValueAtTime(660 * mul, t + 0.3);
        o.connect(g);
        o.start(t); o.stop(t + 0.45);
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
