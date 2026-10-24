// What the music is doing right now, as a handful of numbers the renderer can draw with.
//
// The sea moves to the music: bass swells the waves, overall energy speeds the current, the top
// end makes the surface glitter, and every beat sends a swell out from the coast. This module
// turns an AnalyserNode into those numbers and nothing else — it knows nothing about water.
//
// Three problems it has to solve, and they are the whole design:
//
//  1. LOUDNESS IS NOT MOTION. The analyser reports decibels, so a mix that is "quiet" and a mix
//     that is "loud" both sit in the top third of the byte range and barely move within it. Each
//     band is therefore a z-score against its own recent history — how many of its usual swings
//     above or below its usual level it is right now — mapped so "usual" is 0.4 and two swings
//     up is 1. That is what makes a soft ambient bed move the sea visibly instead of not at all,
//     and it is why a drum and bass track does not simply pin everything at maximum. (The first
//     version normalised against a decaying peak; measured on the real tracks, every band sat at
//     0.95 the whole time, which is no signal at all.)
//
//  2. SILENCE MUST BE STILL. A z-score amplifies whatever is there, including nothing. Silence is
//     far below the running average, so it maps to zero rather than to noise, and when the music
//     stops the sea settles to its ordinary calm rather than twitching on the noise floor.
//
//  3. A BEAT IS A CHANGE, NOT A LEVEL. Beats are detected as spectral flux in the bass — how much
//     the low end JUMPED since last frame — against an adaptive threshold, with a refractory gap
//     so one kick is one beat. A level threshold fires continuously on a sustained bass note and
//     never on a kick that lands on top of one.
//
// Attack is fast and release is slow on every output, so the water rises with the music and
// settles after it. The other way round looks like it is lagging.

const BANDS = {
  bass: [30, 160],
  mid: [160, 2000],
  high: [2000, 9000],
};

const RELEASE_MS = { bass: 240, mid: 320, high: 170, level: 400 };
const ATTACK_MS = 35;
const BEAT_GAP_MS = 260;          // ~230 BPM ceiling; a double kick is one swell
const BEAT_DECAY_MS = 220;
const KICK = [40, 140];           // Hz: where a kick drum lives
const BEAT_K = 1.4;               // deviations of flux above its mean that count as a hit
const BEAT_MIN_FLUX = 9;          // average rise per kick bin, in analyser byte steps

export function createListener() {
  let bins = null, prevBins = null, binHz = 0;
  const avg = { bass: 0, mid: 0, high: 0 };
  const dev = { bass: 0, mid: 0, high: 0 };       // running variance
  let fluxMean = 0, fluxVar = 0, sinceBeat = 1e9;
  const out = { bass: 0, mid: 0, high: 0, level: 0, beat: 0, beats: 0 };

  const ease = (cur, target, dtMs, releaseMs) => {
    const tau = target > cur ? ATTACK_MS : releaseMs;
    return cur + (target - cur) * (1 - Math.exp(-dtMs / tau));
  };

  function band(lo, hi) {
    const a = Math.max(1, Math.floor(lo / binHz)), b = Math.min(bins.length - 1, Math.ceil(hi / binHz));
    let sum = 0;
    for (let i = a; i <= b; i++) sum += bins[i];
    return sum / (b - a + 1);
  }

  /**
   * @param analyser the music's AnalyserNode, or null before the music has been built
   * @param audible false while paused or muted: the sea should not dance to music nobody hears
   * @returns the same object every call — read it, do not keep it
   */
  return function sample(analyser, audible, dtMs) {
    dtMs = Math.min(100, Math.max(1, dtMs));
    sinceBeat += dtMs;
    let target = { bass: 0, mid: 0, high: 0 };
    let flux = 0;

    if (analyser && audible) {
      if (!bins || bins.length !== analyser.frequencyBinCount) {
        bins = new Uint8Array(analyser.frequencyBinCount);
        prevBins = new Uint8Array(analyser.frequencyBinCount);
        binHz = analyser.context.sampleRate / analyser.fftSize;
      }
      analyser.getByteFrequencyData(bins);
      // Spectral flux over the kick's range: every low bin that got LOUDER, summed. Per bin
      // rather than on the band average, because averaging lets a sustained bassline in one bin
      // hide a kick landing in the next.
      const a = Math.max(1, Math.floor(KICK[0] / binHz)), b = Math.ceil(KICK[1] / binHz);
      for (let i = a; i <= b; i++) flux += Math.max(0, bins[i] - prevBins[i]);
      flux /= (b - a + 1);
      prevBins.set(bins);
      const avgK = 1 - Math.exp(-dtMs / 3000);
      for (const k of Object.keys(BANDS)) {
        const v = band(...BANDS[k]);
        const d = v - avg[k];
        avg[k] += d * avgK;
        dev[k] += (d * d - dev[k]) * avgK;
        // A floor on the spread, so a band that is nearly constant does not turn its last
        // decimal of wobble into full-scale motion.
        const z = d / Math.max(4, Math.sqrt(dev[k]));
        target[k] = Math.max(0, Math.min(1, 0.4 + z * 0.3));
      }
    } else if (prevBins) {
      prevBins.fill(0);
    }

    // Adaptive beat threshold: comfortably above the recent run of flux, with the bass up — and
    // above an absolute floor. A purely relative threshold fires on ordinary frame-to-frame
    // jitter, which is how a beatless ambient bed produced ninety "beats" a minute: a kick moves
    // the low bins by tens of steps, jitter by a few.
    const fk = 1 - Math.exp(-dtMs / 1200);
    const d = flux - fluxMean;
    fluxMean += d * fk;
    fluxVar += (d * d - fluxVar) * fk;
    if (flux > BEAT_MIN_FLUX && flux > fluxMean + BEAT_K * Math.sqrt(fluxVar)
        && sinceBeat > BEAT_GAP_MS && target.bass > 0.45) {
      sinceBeat = 0;
      out.beat = 1;
      out.beats++;
    } else {
      out.beat *= Math.exp(-dtMs / BEAT_DECAY_MS);
    }

    for (const k of Object.keys(BANDS)) out[k] = ease(out[k], target[k], dtMs, RELEASE_MS[k]);
    out.level = ease(out.level, (target.bass * 0.5 + target.mid * 0.35 + target.high * 0.15), dtMs, RELEASE_MS.level);
    return out;
  };
}
