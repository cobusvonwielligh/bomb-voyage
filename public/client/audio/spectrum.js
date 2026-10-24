// Turning an FFT into something worth looking at.
//
// A raw `getByteFrequencyData` dump is the reason most web visualisers look cheap, and it is
// worth knowing exactly why, because all four problems have to be fixed and they are
// independent:
//
//  1. **The bins are linear and hearing is not.** An FFT divides 0–24 kHz into equal slices, so
//     at 1024 points the first bin spans 0–47 Hz and the whole bottom two octaves — every bass
//     note, every kick — lands in one or two bins, while the top half of the display is taken up
//     by cymbals and hiss nobody is looking at. Bars have to be LOG spaced to look musical.
//  2. **Nothing is ever loud.** Music is not flat: there is far more energy at 60 Hz than at
//     6 kHz, so a faithful display is a ramp down to the right that barely twitches at the top.
//     A tilt puts the bands on a comparable footing.
//  3. **It moves at the wrong speed.** One smoothing constant cannot serve both directions. A
//     bar has to SNAP up — that is the transient, and it is the whole point — and fall slowly,
//     which is what reads as a decaying note. Symmetric smoothing looks like jelly.
//  4. **There is no memory.** The peak caps that sit above the bars on every real meter are not
//     decoration: they hold the loudest recent moment, which is what lets the eye see the shape
//     of a hit after the hit is over.
//
// One reader, shared by the menu visualiser and the in-game one, so they can never disagree
// about what the music is doing.

/**
 * Edges of `n` log-spaced bands between two frequencies, as FFT bin indices.
 *
 * 40 Hz to 14 kHz: below 40 is rumble that no laptop speaker reproduces and above 14k is air.
 * Spending bars on either is spending them on nothing.
 */
/* 55 Hz, not 40.
 *
 * Below about 55 nothing a laptop speaker reproduces is there, and more importantly the FFT
 * cannot resolve it: at 4096 points the bins are 11.7 Hz wide, so 40–45 Hz and 45–50 Hz are the
 * same bin and two adjacent bars report the identical number. Starting higher spends the
 * resolution where there is something to see. */
function bandEdges(n, sampleRate, fftSize, lo = 55, hi = 14000) {
  const nyquist = sampleRate / 2;
  const bins = fftSize / 2;
  const edges = [];
  for (let i = 0; i <= n; i++) {
    const f = lo * Math.pow(hi / lo, i / n);
    // At least one bin wide, and always wider than the last, or the bottom bands collide and
    // several bars show the identical value — which looks like a bug and is one.
    const bin = Math.min(bins - 1, Math.max(i, Math.round((f / nyquist) * bins)));
    edges.push(bin);
  }
  return edges;
}

/**
 * @param bands how many bars
 * @param tilt  high-frequency lift, in dB per decade. 0 is faithful and looks dead.
 */
export function createSpectrum({ bands = 24, tilt = 4.5, rise = 0.55, fall = 0.085 } = {}) {
  const level = new Float32Array(bands);     // 0..1, what to draw
  const peak = new Float32Array(bands);      // 0..1, the cap above it
  const peakVel = new Float32Array(bands);   // caps fall under gravity, not at a constant rate
  let raw = null, edges = null, gain = null, forSampleRate = 0, forFft = 0;

  /** Rebuilt whenever the context or fft size changes, which in practice means once. */
  function prepare(analyser) {
    const n = analyser.frequencyBinCount;
    if (!raw || raw.length !== n) raw = new Uint8Array(n);
    if (forSampleRate === analyser.context.sampleRate && forFft === analyser.fftSize) return;
    forSampleRate = analyser.context.sampleRate;
    forFft = analyser.fftSize;
    edges = bandEdges(bands, forSampleRate, forFft);
    // The tilt, precomputed per band. Treble is quieter in every piece of music ever recorded;
    // without this the right-hand half of any visualiser is a flat line.
    gain = new Float32Array(bands);
    for (let i = 0; i < bands; i++) {
      const decades = (i / (bands - 1)) * Math.log10(14000 / 55);
      gain[i] = Math.pow(10, (tilt * decades) / 20);
    }
  }

  return {
    bands,
    level,
    peak,

    /** Loudness of the bottom two bands, 0..1. The kick, for anything that wants to pulse. */
    get bass() { return Math.max(level[0], level[1] || 0); },
    /** Where the voices and the lead live. */
    get mid() { return level[(bands * 0.45) | 0]; },
    get treble() { return level[(bands * 0.82) | 0]; },
    /** Everything at once, for a global brightness or scale. */
    get energy() {
      let s = 0;
      for (let i = 0; i < bands; i++) s += level[i];
      return s / bands;
    },

    /**
     * Read the analyser and advance the ballistics.
     *
     * @param dtMs real elapsed time, so the fall rate is the same on a 60 Hz and a 144 Hz
     *   display. A per-frame constant would make the bars fall two and a half times faster on a
     *   gaming monitor, which is the sort of thing nobody notices until they switch machines.
     * @returns false when there is nothing to read, so a caller can skip drawing entirely.
     */
    read(analyser, dtMs = 16.7) {
      if (!analyser) return false;
      prepare(analyser);
      analyser.getByteFrequencyData(raw);

      // Frame-rate independent coefficients. `rise`/`fall` are the fraction of the remaining
      // distance covered in one 60 Hz frame; this converts them to this frame's dt.
      const k = dtMs / 16.7;
      const up = 1 - Math.pow(1 - rise, k);
      const down = 1 - Math.pow(1 - fall, k);

      for (let i = 0; i < bands; i++) {
        const from = edges[i], to = Math.max(edges[i + 1], from + 1);
        // The LOUDEST bin in the band, not the average. An average drags every peak down
        // towards the quiet bins beside it and is why so many visualisers look muffled — a band
        // should report the note in it, not the note diluted by its neighbours.
        let max = 0;
        for (let b = from; b < to; b++) if (raw[b] > max) max = raw[b];
        const v = Math.min(1, (max / 255) * gain[i]);

        // Snap up, sag down. The asymmetry IS the look.
        level[i] += (v - level[i]) * (v > level[i] ? up : down);

        // Caps: instant to a new high, then accelerating downward. Gravity rather than a
        // constant fall, because a cap that drops linearly reads as a second bar.
        if (level[i] >= peak[i]) { peak[i] = level[i]; peakVel[i] = 0; }
        else {
          // 0.0007, down from 0.0016. At the old rate a cap fell from the top to nothing in
          // half a second, which is barely longer than the bar it is capping — so it never
          // looked like a held peak, it looked like a second bar chasing the first. A cap wants
          // to hang around for about a second and a half.
          peakVel[i] += 0.0007 * k;
          peak[i] = Math.max(level[i], peak[i] - peakVel[i]);
        }
      }
      return true;
    },

    /** Settle everything to silence — when the music stops, the bars should not freeze mid-air. */
    rest(dtMs = 16.7) {
      const down = 1 - Math.pow(1 - 0.12, dtMs / 16.7);
      for (let i = 0; i < bands; i++) {
        level[i] -= level[i] * down;
        peak[i] -= peak[i] * down;
      }
    },
  };
}
