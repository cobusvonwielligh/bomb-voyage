// One AudioContext for the whole page.
//
// Music and sound effects used to be unrelated, and the obvious shortcut — let each build its own
// context — breaks in two ways. Browsers only unlock a context inside a user gesture, so the
// second one stays suspended forever; and turning the music off would take the sound effects with
// it, because they would be hanging off the music's context.
//
// So: one context, created lazily, unlocked once, and two independent buses on top of it.

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
  limiter.connect(c.destination);
  return gain;
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
