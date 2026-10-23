// One AudioContext for the whole page.
//
// Music and sound effects used to be unrelated, and the obvious shortcut — let each build its own
// context — breaks in two ways. Browsers only unlock a context inside a user gesture, so the
// second one stays suspended forever; and turning the music off would take the sound effects with
// it, because they would be hanging off the music's context.
//
// So: one context, created lazily, unlocked once, and two independent buses on top of it.

import { VOLUME_MASTER } from '/shared/constants.js';

let ctx = null;

export function audioContext() {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/** Must be called from inside a user gesture the first time. True if audio can actually play. */
export async function unlock() {
  const c = audioContext();
  if (c.state === 'suspended') {
    try { await c.resume(); } catch { /* blocked; the caller reports it */ }
  }
  return c.state === 'running';
}

/**
 * The master trim, as a node of its own on the end of a bus.
 *
 * It lives here rather than in the volume defaults because a default only ever reaches somebody
 * with no stored slider value, and everybody who has already played has one in `localStorage`.
 * Putting it downstream of the caller's volume node also means no slider can scale back past it.
 *
 * It sits AFTER the limiter deliberately. Trimming before the limiter means peaks that used to be
 * squashed now pass through untouched, so the mix gets quieter by rather less than the trim says;
 * trimming last is the only way "half as loud" is actually half as loud.
 */
function trimmedOutput(c, limiter) {
  const master = c.createGain();
  master.gain.value = VOLUME_MASTER;
  limiter.connect(master);
  master.connect(c.destination);
}

/**
 * A bus with its own volume and a limiter on the end.
 *
 * The limiter is not optional: sixteen players means explosions land on top of each other, and
 * digital clipping is the fastest way to make synthesised audio sound broken rather than loud.
 */
export function createBus(volume = 1) {
  const c = audioContext();
  const gain = c.createGain();
  gain.gain.value = volume;

  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.2;

  gain.connect(limiter);
  trimmedOutput(c, limiter);
  return gain;
}

/**
 * The music's bus. Softer limiting than `createBus`, because the music is a continuous mix rather
 * than a pile of transients and a 12:1 ratio on it is audible as pumping.
 *
 * Returned node is the volume control: everything the music makes connects into it, and the master
 * trim is already applied downstream where the slider cannot reach it.
 */
export function createMusicBus(volume = 1) {
  const c = audioContext();
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;

  const gain = c.createGain();
  gain.gain.value = volume;
  gain.connect(comp);
  trimmedOutput(c, comp);
  return gain;
}

/**
 * A feedback delay — the sound that makes an arpeggio feel like synthwave rather than like a
 * sequence of beeps. Connect voices into the returned node; the wet signal arrives at `out`.
 *
 * Every track owns its own line rather than sharing one, because the tracks run at different
 * tempos. Retuning a single shared `delayTime` at a track change warps the two seconds of tail
 * still ringing through it, and it warps at exactly the moment the crossfade exists to hide.
 */
export function createDelayLine(time, out, { feedback = 0.34, mix = 0.5 } = {}) {
  const c = audioContext();
  const delay = c.createDelay(2);
  delay.delayTime.value = time;
  const fb = c.createGain();
  fb.gain.value = feedback;
  const wet = c.createGain();
  wet.gain.value = mix;
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  wet.connect(out);
  return delay;
}

/**
 * The attack/decay(/sustain/release) shape every synthesised voice here needs, scheduled onto a
 * gain node. Pass `s` > 0 for a sustain stage, `hold` for how long to sit on it.
 *
 * Ramps are exponential because loudness is perceived logarithmically — a linear fade sounds like
 * it hangs around and then drops off a cliff. They stop at a floor rather than at zero because
 * `exponentialRampToValueAtTime(0)` throws in every real browser.
 */
export function envelope(node, t, { a = 0.005, d = 0.1, s = 0, r = 0.1, peak = 1, hold = 0 }) {
  const FLOOR = 0.0001;
  const g = node.gain;
  const top = Math.max(FLOOR, peak);
  g.setValueAtTime(FLOOR, t);
  g.exponentialRampToValueAtTime(top, t + a);
  if (s > 0) {
    const sustain = Math.max(FLOOR, top * s);
    g.exponentialRampToValueAtTime(sustain, t + a + d);
    g.setValueAtTime(sustain, t + a + d + hold);
    g.exponentialRampToValueAtTime(FLOOR, t + a + d + hold + r);
  } else {
    g.exponentialRampToValueAtTime(FLOOR, t + a + d);
  }
}

/** Shared noise buffer. Allocating 0.4 s of random floats per explosion is pure waste. */
let noiseBuf = null;
export function noiseSource() {
  const c = audioContext();
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.5), c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  return s;
}

export const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);
