// Choosing which two snapshots to draw a remote player between.
//
// In `shared/` rather than in the client because it is pure, fiddly, and was wrong for a while in
// a way nobody could see from reading it — so it wants a test, and a test needs it importable
// from Node.

/**
 * The pair of buffered snapshots that brackets `t`, and how far between them to sit.
 *
 * The obvious implementation — take the two newest — is a trap, and it is the one this project
 * shipped. Snapshots arrive every 2 ticks and remotes are drawn INTERP_DELAY_TICKS behind, so the
 * newest pair usually starts *after* the time being drawn: the fraction clamps to 0 and the
 * player is pinned to one snapshot until the next arrives. The result is not a smooth 15 Hz, it
 * is a teleport 15 times a second, which reads exactly like a bad connection. The bracketing pair
 * is sitting in the buffer the whole time; it is simply never picked.
 *
 * @param buf ascending by tick
 * @param t   the tick to draw at
 * @returns {{a, b, f}|null} f in 0..1, or null if the buffer is too short
 */
export function pickPair(buf, t) {
  if (!buf || buf.length === 0) return null;
  if (buf.length === 1) return { a: buf[0], b: buf[0], f: 0 };

  // Older than everything we kept: hold the oldest rather than extrapolating backwards.
  if (t <= buf[0].tick) return { a: buf[0], b: buf[0], f: 0 };

  for (let i = 0; i < buf.length - 1; i++) {
    const a = buf[i], b = buf[i + 1];
    if (t > b.tick) continue;
    const span = b.tick - a.tick;
    // Two snapshots from the same tick: a duplicate, not a span. Show the later one.
    if (span <= 0) return { a: b, b, f: 0 };
    return { a, b, f: Math.max(0, Math.min(1, (t - a.tick) / span)) };
  }

  // Newer than everything we have — the next snapshot is late. Hold the newest position rather
  // than extrapolating: a guess that overshoots has to be taken back, and taking it back is more
  // visible than being 30 ms behind.
  const last = buf[buf.length - 1];
  return { a: last, b: last, f: 0 };
}
