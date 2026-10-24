// The landing page, listening to itself.
//
// Bars grow INWARD from the left and right edges of the window, mirrored, bass at the bottom and
// air at the top. The card sits in the middle and the music pushes in from both sides towards it.
//
// Why from the edges rather than along the bottom, which is what everything else does: the menu
// card is centred and is the thing you came to look at, so the one place a visualiser must not
// be is underneath it competing for the same space. The edges are dead screen on every monitor
// wider than the card — the visualiser costs nothing that was being used, and the symmetry gives
// the card a frame instead of a floor.
//
// Five things are happening at once, and the stack is the whole design:
//
//   1. **Bars**, log-spaced, each a gradient that dissolves inward so none of them ends on a
//      hard line. A bar with a visible tip is a rectangle; a bar that fades out is light.
//   2. **Peak caps**, holding the loudest recent moment and falling under gravity. This is the
//      layer that lets you see the shape of a hit after the hit is over.
//   3. **A bass bloom** behind each side, which is the only part that moves the whole frame and
//      the reason a kick reads as a kick rather than as the bottom bar twitching.
//   4. **Embers**, lit by transients in the top half of the spectrum and carried upward. They
//      are the part that is not a meter — something has to not be a meter.
//   5. **An entrance.** The whole thing sweeps in from the edges when the music starts and
//      retracts when it stops, so pressing pause is visibly the same act as the bars leaving.
//
// Everything is additive over the menu's own background, and nothing is ever drawn where the
// card is.

import { createSpectrum } from './audio/spectrum.js';

// 40 thin bars rather than 26 thick ones. At 26 across a 760px window each row is 29px and the
// bars read as a film sprocket strip — chunky rectangles that happen to change length. The
// look wants LINES: enough of them to form a shape, thin enough that the shape is the subject.
const BANDS = 40;
// Hard cap, so the bars stay lines on a tall monitor instead of growing into blocks.
const MAX_BAR_PX = 7;
// The stack occupies the bottom of the window and leaves the top clear — that is where the
// title is, and bass belongs low anyway.
const STACK_TOP = 0.16;
// How far in from the edge a full-scale bar reaches, as a fraction of the window. Past about a
// fifth the two sides start reaching behind the card, and a bar you can see one end of is a bar
// that has become a rectangle.
// 0.11, down from 0.19. At a fifth of the window the two sides occupy the outer 40% of the
// screen between them, which is not a frame any more — it is the background. The card has to
// stay the subject.
const REACH = 0.11;
const EMBERS = 28;

/** Fire, matching --gold / PALETTE.fireMid. Hot at the edge, cooling as it travels inward. */
const HOT = '255, 201, 138';
const MID = '255, 155, 61';
const DEEP = '217, 113, 31';

export function createMenuViz({ canvas, music }) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const spectrum = createSpectrum({ bands: BANDS, tilt: 5 });

  let w = 0, h = 0, dpr = 1;
  let raf = 0, last = 0;
  // 0 while away, 1 while present. Everything multiplies by it, so one number is the entrance,
  // the exit, and the "music is off" state.
  let presence = 0;
  let running = false;

  // Embers: lit by treble transients, carried up and inward. Stateless would be cheaper and
  // would not look like anything — the point of an ember is that it remembers where it has been.
  const embers = Array.from({ length: EMBERS }, () => ({ life: 0, x: 0, y: 0, vy: 0, vx: 0, r: 0, side: 1 }));
  let lastTreble = 0;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** One side. `dir` is +1 for the left edge growing right, -1 for the right edge growing left. */
  function drawSide(dir, reach, rowH, bh) {
    const x0 = dir > 0 ? 0 : w;
    const bottom = h * 0.97;

    for (let i = 0; i < BANDS; i++) {
      // Band 0 at the BOTTOM. Low frequencies belong low: every meter ever built does this, and
      // the one time you do it the other way round it feels wrong without anybody knowing why.
      const y = bottom - (i + 1) * rowH + (rowH - bh) / 2;
      const v = spectrum.level[i] * presence;
      // Below about a tenth there is nothing to say, and forty almost-invisible lines are
      // still forty lines.
      if (v < 0.09) continue;

      const len = v * reach;
      const grad = ctx.createLinearGradient(x0, 0, x0 + dir * len, 0);
      /* Hot at the edge, cooling and vanishing inward. The alpha ramp is what keeps the inner
       * end from ever being a visible edge.
       *
       * No floor term. There used to be a `+ 0.12`, so that a quiet band was still a visible
       * line — which is right for three bars in a dock and badly wrong for forty: it drew all
       * forty at all times and the result was a venetian blind down each side of the screen,
       * with the loud ones somewhere inside it. A band with nothing in it should show nothing.
       * The shape comes from the bands that are doing something. */
      grad.addColorStop(0, `rgba(${HOT}, ${0.52 * v * v + 0.06 * v})`);
      grad.addColorStop(0.45, `rgba(${MID}, ${0.34 * v * v})`);
      grad.addColorStop(1, `rgba(${DEEP}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(dir > 0 ? x0 : x0 - len, y, len, bh, bh / 2);
      ctx.fill();

      // The cap. Two pixels of bright, out where the loudest recent moment reached.
      const p = spectrum.peak[i] * presence;
      if (p > v + 0.02) {
        const px = x0 + dir * (p * reach);
        ctx.fillStyle = `rgba(${HOT}, ${0.4 * p * p})`;
        ctx.beginPath();
        ctx.roundRect(dir > 0 ? px - 2 : px, y, 2, bh, 1);
        ctx.fill();
      }
    }
  }

  /** The kick, as light rather than as a bar. */
  function drawBloom(dir, bass) {
    const x0 = dir > 0 ? 0 : w;
    // Centred on the BASS bars at the bottom of the stack, which is where a kick comes from.
    const cy = h * 0.9;
    const r = (0.09 + bass * 0.3) * w;
    const g = ctx.createRadialGradient(x0, cy, 0, x0, cy, r);
    g.addColorStop(0, `rgba(${MID}, ${0.1 * bass * bass})`);
    g.addColorStop(0.5, `rgba(${DEEP}, ${0.035 * bass * bass})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(dir > 0 ? 0 : w - r, cy - r, r, r * 2);
  }

  function stepEmbers(dtMs) {
    const t = spectrum.treble;
    // A RISE in the top end lights one, not the level itself: a sustained hi-hat would otherwise
    // pour them out continuously and they would stop meaning anything.
    const transient = Math.max(0, t - lastTreble);
    lastTreble = t;
    if (transient > 0.055 && presence > 0.2) {
      const e = embers.find(k => k.life <= 0);
      if (e) {
        e.side = Math.random() < 0.5 ? 1 : -1;
        e.x = e.side > 0 ? Math.random() * w * 0.08 : w - Math.random() * w * 0.08;
        e.y = h * (0.55 + Math.random() * 0.4);
        e.vy = -(0.012 + Math.random() * 0.03);
        e.vx = e.side * (0.002 + Math.random() * 0.008);
        e.r = 1 + Math.random() * 2.2;
        e.life = 1;
      }
    }

    for (const e of embers) {
      if (e.life <= 0) continue;
      e.life -= dtMs / 2600;
      e.y += e.vy * dtMs;
      e.x += e.vx * dtMs;
      // Updraft: they accelerate as they rise, the way anything hot does.
      e.vy -= 0.000004 * dtMs;
      if (e.life <= 0) continue;
      const a = Math.min(1, e.life * 1.6) * presence * 0.45;
      ctx.fillStyle = `rgba(${HOT}, ${a})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (0.4 + e.life * 0.6), 0, 7);
      ctx.fill();
    }
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dtMs = Math.min(50, now - (last || now));
    last = now;

    if (canvas.clientWidth !== w || canvas.clientHeight !== h) resize();

    // Present only while the music is actually audible. Eased, so starting and stopping are
    // movements rather than cuts — and `presence` gates every layer, so one number does it all.
    const want = music.playing && music.volume > 0 && music.analyser ? 1 : 0;
    presence += (want - presence) * (1 - Math.pow(1 - 0.06, dtMs / 16.7));

    if (want) spectrum.read(music.analyser, dtMs);
    else spectrum.rest(dtMs);

    ctx.clearRect(0, 0, w, h);
    if (presence < 0.003) return;

    const rowH = (h * (1 - STACK_TOP)) / BANDS;
    const bh = Math.max(1.5, Math.min(MAX_BAR_PX, rowH * 0.5));
    // The entrance: the reach itself grows, so the bars sweep OUT of the edge rather than fading
    // up in place. Cubed, so the first frames are a flick and the last are a settle.
    const reach = w * REACH * (presence * presence * presence * 0.45 + presence * 0.55);
    const bass = spectrum.bass * presence;

    ctx.globalCompositeOperation = 'lighter';
    drawBloom(1, bass);
    drawBloom(-1, bass);
    drawSide(1, reach, rowH, bh);
    drawSide(-1, reach, rowH, bh);
    stepEmbers(dtMs);
    ctx.globalCompositeOperation = 'source-over';
  }

  return {
    /** Only runs while the menu is up: there is no point analysing audio nobody is looking at. */
    start() {
      if (running) return;
      // Honour the system setting. Everything here is decoration and none of it is information.
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      running = true;
      resize();
      last = 0;
      raf = requestAnimationFrame(frame);
    },

    stop() {
      running = false;
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, w, h);
    },

    /** Shared with the in-game meter, so the two can never disagree about the music. */
    spectrum,
  };
}
