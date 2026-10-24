// What the music is doing right now, as a handful of numbers the renderer can draw with.
//
// The sea moves to the music: bass swells the waves, overall energy speeds the current, the top
// end makes the surface glitter, every beat sends a swell out from the coast, and the whole sea
// keeps time with the tempo between the beats. This module turns an AnalyserNode into those
// numbers and nothing else — it knows nothing about water.
//
// The problems it has to solve, and they are the whole design:
//
//  1. LOUDNESS IS NOT MOTION. The analyser reports decibels, so a mix that is "quiet" and a mix
//     that is "loud" both sit in the top third of the byte range and barely move within it. Each
//     band is therefore a z-score against its own recent history — how many of its usual swings
//     above or below its usual level it is right now — mapped so "usual" is 0.4 and two swings
//     up is 1. (The first version normalised against a decaying peak; measured on the real
//     tracks, every band sat at 0.95 the whole time, which is no signal at all.)
//
//  2. SILENCE MUST BE STILL. A z-score amplifies whatever is there, including nothing. Silence is
//     far below the running average, so it maps to zero rather than to noise.
//
//  3. A BEAT IS A CHANGE, NOT A LEVEL. Beats are spectral flux in the kick's range — every low bin
//     that got louder, summed — against an adaptive threshold and an absolute floor, with a
//     refractory gap so one kick is one beat. The same, in the top end, for hats and snares.
//
//  4. A DETECTOR IS NOT A DRUMMER. Detected beats are late, early, and sometimes missing — a
//     sea that only moves when the detector fires stutters exactly when the music does not. So
//     the beats feed a TEMPO (the median of recent spacings) and a phase-locked metronome that
//     runs on its own between them and is nudged back into line by each one. `phase` goes 0→1
//     once a beat, every beat, and `lock` says how much to believe it.
//
//  5. THE ANALYSER HEARS IT FIRST. It sees audio as it is processed, which is the output latency
//     — tens of milliseconds — before it comes out of the speakers. Seeing a swell before you
//     hear the kick is the version of "out of sync" that everybody notices. Every output is
//     therefore delayed by that latency before the renderer gets it.
//
// Attack is fast and release slow on every continuous output, so the water rises with the music
// and settles after it.

const BANDS = {
  bass: [30, 160],
  mid: [160, 2000],
  high: [2000, 9000],
};

const RELEASE_MS = { bass: 240, mid: 320, high: 170, level: 400 };
const ATTACK_MS = 35;

const KICK = [40, 140];           // Hz: where a kick drum lives
const BEAT_GAP_MS = 260;          // ~230 BPM ceiling; a double kick is one beat
const BEAT_DECAY_MS = 220;
const BEAT_K = 1.4;               // deviations of flux above its mean that count as a hit
const BEAT_MIN_FLUX = 9;          // average rise per kick bin, in analyser byte steps

const HATS = [5000, 12000];       // Hz: hats, the snare's crack, shakers
const SPARK_GAP_MS = 90;
const SPARK_K = 2.3;
const TONE_LO = Math.log2(250), TONE_HI = Math.log2(3000);   // centroid range mapped to 0..1
const SPARK_MIN_FLUX = 6;

// The metronome. Periods are folded into one octave so a detector that hears half-time on one
// bar and double-time on the next still agrees with itself about the pulse.
const PERIOD_MIN_S = 0.42, PERIOD_MAX_S = 0.84;    // 71–143 BPM, the swell's comfortable range
const TEMPO_MEMORY = 12;          // spacings remembered
const PLL_PULL = 0.3;             // how hard each detected beat drags the phase back into line
const PLL_RATE = 0.06;            // and how much it nudges the tempo itself
const LOCK_TOLERANCE = 0.12;      // a spacing within 12% of the tempo agrees with it

const HISTORY = 40;               // frames of delay line; ~650 ms at 60 fps

/* The equaliser: EQ_BANDS log-spaced bands, each its own z-score like the three broad ones, so
 * every band dances around its own usual level instead of the bass towering over the treble.
 *
 * SLOW, on purpose. These started as meter ballistics — 25 ms up, 160 ms down — and in a round
 * that read as jumpy: every transient flicked a whole stretch of coast. The coast is scenery,
 * not a meter, so it gets water's timing: a quarter of a second to rise, most of a second to
 * settle, and a longer history so a band's "usual" does not chase every phrase. */
export const EQ_BANDS = 24;
const EQ_LO = 45, EQ_HI = 11000;
const EQ_ATTACK_MS = 240, EQ_RELEASE_MS = 750;
const EQ_HISTORY_MS = 4500;

/* Accents: an onset ANYWHERE in the spectrum, not just the kick. Ambient beds have almost no
 * kicks — measured in game, one detected beat every two seconds and a tempo lock that never
 * formed — but they are full of events: a chord arriving, a pad swelling, a pluck. Those are
 * what the sea should answer to when there is no drummer. */
const ACCENT_GAP_MS = 380;
const ACCENT_K = 1.6;
const ACCENT_MIN_FLUX = 3.2;

const FIELDS = ['bass', 'mid', 'high', 'level', 'beat', 'beats', 'bpm', 'phase', 'lock',
  'spark', 'sparks', 'tone', 'accent', 'accents'];

export function createListener() {
  let bins = null, prevBins = null, binHz = 0;
  const avg = { bass: 0, mid: 0, high: 0 };
  const dev = { bass: 0, mid: 0, high: 0 };       // running variance
  const kick = { mean: 0, vari: 0, since: 1e9 };
  const hats = { mean: 0, vari: 0, since: 1e9 };
  const wide = { mean: 0, vari: 0, since: 1e9 };
  const eqAvg = new Float32Array(EQ_BANDS), eqDev = new Float32Array(EQ_BANDS);
  const eqNow = new Float32Array(EQ_BANDS);
  let eqEdges = null;
  let clock = 0, lastBeatAt = -1, period = 0.5, trim = 1;
  const spacings = [];

  const now = {
    bass: 0, mid: 0, high: 0, level: 0, beat: 0, beats: 0,
    bpm: 0, phase: 0, lock: 0, spark: 0, sparks: 0, tone: 0.5, accent: 0, accents: 0,
  };

  // The delay line: preallocated snapshots, so a frame allocates nothing. The equaliser rides in
  // it too, as a copy per slot.
  const ring = Array.from({ length: HISTORY }, () => ({ t: -1, ...now, eq: new Float32Array(EQ_BANDS) }));
  let head = 0;
  const out = { ...now, eq: new Float32Array(EQ_BANDS) };

  const ease = (cur, target, dtMs, releaseMs) => {
    const tau = target > cur ? ATTACK_MS : releaseMs;
    return cur + (target - cur) * (1 - Math.exp(-dtMs / tau));
  };

  const binOf = hz => Math.max(1, Math.min(bins.length - 1, Math.round(hz / binHz)));

  function band(lo, hi) {
    const a = binOf(lo), b = binOf(hi);
    let sum = 0;
    for (let i = a; i <= b; i++) sum += bins[i];
    return sum / (b - a + 1);
  }

  function rise(lo, hi) {
    const a = binOf(lo), b = binOf(hi);
    let sum = 0;
    for (let i = a; i <= b; i++) sum += Math.max(0, bins[i] - prevBins[i]);
    return sum / (b - a + 1);
  }

  /** Is this flux an onset? Adaptive threshold, absolute floor, refractory gap. */
  function onset(s, flux, dtMs, k, floor, gapMs) {
    s.since += dtMs;
    const fk = 1 - Math.exp(-dtMs / 1200);
    const d = flux - s.mean;
    const hit = flux > floor && flux > s.mean + k * Math.sqrt(s.vari) && s.since > gapMs;
    s.mean += d * fk;
    s.vari += (d * d - s.vari) * fk;
    if (hit) s.since = 0;
    return hit;
  }

  /** A detected beat: learn the tempo from it, and pull the metronome toward it. */
  function heardBeat() {
    if (lastBeatAt >= 0) {
      let gap = clock - lastBeatAt;
      if (gap > 0.2 && gap < 2.5) {
        while (gap < PERIOD_MIN_S) gap *= 2;
        while (gap > PERIOD_MAX_S) gap /= 2;
        spacings.push(gap);
        if (spacings.length > TEMPO_MEMORY) spacings.shift();
        // The median picks the pulse; the mean of the spacings that agree with it sets the period.
        // A median alone is quantised to whole frames — at 60 fps, 116 BPM is 31.03 frames and
        // came out as 30, i.e. 120 BPM, and a metronome 3% fast drifts a tenth of a beat off
        // between corrections. Averaging the agreeing spacings recovers the fraction.
        const sorted = [...spacings].sort((a, b) => a - b);
        const median = sorted[sorted.length >> 1];
        const agreeing = spacings.filter(g => Math.abs(g - median) / median < LOCK_TOLERANCE);
        period = agreeing.reduce((a, b) => a + b, 0) / agreeing.length;
        now.lock = spacings.length >= 4 ? agreeing.length / spacings.length : 0;
      }
    }
    lastBeatAt = clock;
    // Phase error is wherever we are relative to the nearest downbeat, either side of it.
    const err = now.phase > 0.5 ? now.phase - 1 : now.phase;
    now.phase -= err * PLL_PULL;
    if (now.phase < 0) now.phase += 1;
    // And the rate. Arriving early beat after beat means the metronome is running fast, however
    // well each correction hides it: lengthen its beat a little. This is the second half of a
    // phase-locked loop — position alone leaves a steady lag proportional to the tempo error.
    trim = Math.max(0.96, Math.min(1.04, trim + err * PLL_RATE));
  }

  /**
   * @param analyser the music's AnalyserNode, or null before the music has been built
   * @param audible false while paused or muted: the sea should not dance to music nobody hears
   * @param latencyS how far behind the analyser the speakers are; outputs are delayed by this
   * @returns the same object every call — read it, do not keep it
   */
  return function sample(analyser, audible, dtMs, latencyS = 0) {
    dtMs = Math.min(100, Math.max(1, dtMs));
    clock += dtMs / 1000;
    const target = { bass: 0, mid: 0, high: 0 };
    let kickFlux = 0, hatFlux = 0, wideFlux = 0, tone = now.tone;

    if (analyser && audible) {
      if (!bins || bins.length !== analyser.frequencyBinCount) {
        bins = new Uint8Array(analyser.frequencyBinCount);
        prevBins = new Uint8Array(analyser.frequencyBinCount);
        binHz = analyser.context.sampleRate / analyser.fftSize;
      }
      analyser.getByteFrequencyData(bins);
      kickFlux = rise(...KICK);
      hatFlux = rise(...HATS);
      wideFlux = rise(60, 8000);

      // The equaliser. Each band reports its LOUDEST bin, so a note reads as a note rather than
      // diluted by the quiet bins beside it, then is scored against its own history.
      if (!eqEdges) {
        eqEdges = [];
        for (let i = 0; i <= EQ_BANDS; i++) eqEdges.push(binOf(EQ_LO * Math.pow(EQ_HI / EQ_LO, i / EQ_BANDS)));
      }
      const eqK = 1 - Math.exp(-dtMs / EQ_HISTORY_MS);
      for (let k = 0; k < EQ_BANDS; k++) {
        let v = 0;
        for (let i = eqEdges[k], e = Math.max(eqEdges[k] + 1, eqEdges[k + 1]); i < e; i++) if (bins[i] > v) v = bins[i];
        const d = v - eqAvg[k];
        eqAvg[k] += d * eqK;
        eqDev[k] += (d * d - eqDev[k]) * eqK;
        // A floor of 12 byte steps on the spread: below that is the analyser's own frame-to-frame
        // jitter, and scoring it let a quiet band dance to noise as much as a loud one to music.
        const target = Math.max(0, Math.min(1, 0.35 + (d / Math.max(12, Math.sqrt(eqDev[k]))) * 0.32));
        const tau = target > eqNow[k] ? EQ_ATTACK_MS : EQ_RELEASE_MS;
        eqNow[k] += (target - eqNow[k]) * (1 - Math.exp(-dtMs / tau));
      }

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

      // Brightness: the spectral centroid between 100 Hz and 8 kHz, on a log scale so a move
      // from bass-heavy to bright is an even sweep rather than all at the top. Weighted by each
      // bin's loudness to the fourth power: the bytes are decibels, so weighting by them directly
      // lets a thousand quiet treble bins outvote the bass, and every track read as "bright".
      let wsum = 0, sum = 0;
      for (let i = binOf(100), b = binOf(8000); i <= b; i++) {
        const w = (bins[i] / 255) ** 4;
        wsum += w * Math.log2(i * binHz); sum += w;
      }
      if (sum > 0) tone = Math.max(0, Math.min(1, (wsum / sum - TONE_LO) / (TONE_HI - TONE_LO)));
      prevBins.set(bins);
    } else {
      if (prevBins) prevBins.fill(0);
      // Silence: the bars fall away rather than freezing where they were.
      for (let k = 0; k < EQ_BANDS; k++) eqNow[k] *= Math.exp(-dtMs / EQ_RELEASE_MS);
    }

    if (onset(wide, wideFlux, dtMs, ACCENT_K, ACCENT_MIN_FLUX, ACCENT_GAP_MS)) {
      now.accent = 1;
      now.accents++;
    } else {
      now.accent *= Math.exp(-dtMs / 260);
    }

    if (onset(kick, kickFlux, dtMs, BEAT_K, BEAT_MIN_FLUX, BEAT_GAP_MS) && target.bass > 0.45) {
      now.beat = 1;
      now.beats++;
      heardBeat();
    } else {
      now.beat *= Math.exp(-dtMs / BEAT_DECAY_MS);
    }

    if (onset(hats, hatFlux, dtMs, SPARK_K, SPARK_MIN_FLUX, SPARK_GAP_MS) && target.high > 0.4) {
      now.spark = 1;
      now.sparks++;
    } else {
      now.spark *= Math.exp(-dtMs / 140);
    }

    // The metronome runs whether or not a beat was heard this frame. Belief in it fades if the
    // beats stop coming — four periods of nothing and it is a guess, not a tempo.
    const beatS = period * trim;
    now.phase = (now.phase + dtMs / 1000 / beatS) % 1;
    if (lastBeatAt < 0 || clock - lastBeatAt > beatS * 4 || !audible) now.lock *= Math.exp(-dtMs / 900);
    now.bpm = 60 / beatS;

    for (const k of Object.keys(BANDS)) now[k] = ease(now[k], target[k], dtMs, RELEASE_MS[k]);
    now.level = ease(now.level, target.bass * 0.5 + target.mid * 0.35 + target.high * 0.15, dtMs, RELEASE_MS.level);
    now.tone += (tone - now.tone) * (1 - Math.exp(-dtMs / 700));

    // Into the delay line, and back out `latencyS` later.
    const slot = ring[head];
    slot.t = clock;
    for (const f of FIELDS) slot[f] = now[f];
    slot.eq.set(eqNow);
    head = (head + 1) % HISTORY;

    const want = clock - Math.max(0, latencyS);
    let pick = null;
    for (let i = 1; i <= HISTORY; i++) {
      const s = ring[(head - i + HISTORY) % HISTORY];
      if (s.t < 0) break;
      pick = s;
      if (s.t <= want) break;
    }
    if (pick) { for (const f of FIELDS) out[f] = pick[f]; out.eq.set(pick.eq); }
    // Phase is a clock, not a sample: advance the delayed one by however far short of `want` it
    // fell, so frame-time jitter in the delay line cannot make the metronome stutter.
    if (pick) out.phase = (pick.phase + Math.max(0, want - pick.t) / beatS) % 1;
    return out;
  };
}
