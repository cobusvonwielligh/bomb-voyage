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
const MAX_BAR_PX = 8;
// The stack occupies the bottom of the window and leaves the top clear — that is where the
// title is, and bass belongs low anyway.
const STACK_TOP = 0.16;
// How far in from the edge a full-scale bar reaches, as a fraction of the window. Past about a
// fifth the two sides start reaching behind the card, and a bar you can see one end of is a bar
// that has become a rectangle.
// 0.11, down from 0.19. At a fifth of the window the two sides occupy the outer 40% of the
// screen between them, which is not a frame any more — it is the background. The card has to
// stay the subject.
// 0.125. 0.11 was too shy and 0.145 put the two sides back to filling the outer third of the
// screen between them — which is not a frame, it is a background, and the card has to stay the
// subject. This is the 'slightly' in 'slightly more prominent'.
const REACH = 0.125;
const EMBERS = 28;

/* Motes drifting in the dark behind the card, which scatter when the pointer goes near them.
 *
 * The menu is a still page and the one thing a still page cannot do is respond. The bars respond
 * to the music, which is somebody else's doing; this responds to YOU, before you have clicked
 * anything, which is the cheapest way a page can feel like a place rather than a screenshot.
 *
 * They are not sparks and they are not snow — they are specks in a shaft of light, which is what
 * the bloom at the bottom of the stack already implies is there.
 */
const MOTES = 70;
/* How far the pointer's push reaches, and how hard.
 *
 * Halved from 150/0.55. At that strength the pointer carved a visible hole in the field and
 * motes shot off it — which is a cursor with a forcefield on it, not air being moved. At half,
 * you notice the specks drifting aside as you pass and you do not notice yourself noticing,
 * which is the whole effect.
 *
 * Still a wide radius against a gentle force: a tight hard push reads as a collision. */
const MOUSE_R = 75;
const MOUSE_FORCE = 0.275;

/* The visualiser's colours, turning at the same rate as the animated panel borders — see
 * `.edge` in style.css.
 *
 * Gold and maroon. The bars used to share the borders' old rainbow, and on a dark page the
 * lavender and the two blue-greens dominated — the landing page read as purple. The mascot's
 * world is gold and a deep bandana red, so the bars run between them: bright gold, old gold,
 * amber, a lit maroon, the deep maroon, and a warm rose on the way back. The panel borders now
 * run the same six stops, so keep the two lists in step by hand.
 *
 * The PERIOD still matches the borders' 28 seconds, and that is the part that matters: two
 * things cycling at different speeds read as two things, whatever their colours.
 *
 * Hard-coded rather than read from CSS, because this runs per frame on a canvas and a
 * getComputedStyle call per bar is a layout read inside an animation loop.
 */
const EDGE_HUES = [
  [237, 194, 78], [204, 148, 52], [196, 104, 58],
  [168, 52, 66], [128, 30, 50], [184, 92, 84],
];
// How bright the bars, caps, bloom and embers are, overall. 0.8: a fifth down, on request.
const VU_INTENSITY = 0.8;
// Seconds for one full turn, matching `animation: spin 28s` on .edge.
const EDGE_PERIOD_S = 28;

/** The border colour at a point along the sweep, 0..1, wrapping. */
function edgeHue(t) {
  const n = EDGE_HUES.length;
  const f = ((t % 1) + 1) % 1 * n;
  const i = Math.floor(f), k = f - i;
  const a = EDGE_HUES[i % n], b = EDGE_HUES[(i + 1) % n];
  return `${Math.round(a[0] + (b[0] - a[0]) * k)}, ${Math.round(a[1] + (b[1] - a[1]) * k)}, ${Math.round(a[2] + (b[2] - a[2]) * k)}`;
}

export function createMenuViz({ canvas, music }) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const spectrum = createSpectrum({ bands: BANDS, tilt: 5 });

  let w = 0, h = 0, dpr = 1;
  let raf = 0, last = 0;
  // 0 while away, 1 while present. Everything multiplies by it, so one number is the entrance,
  // the exit, and the "music is off" state.
  let presence = 0;
  let running = false;
  // Where the border sweep has got to, in turns. Advanced on real time so it stays locked to
  // the CSS animation's 28-second period rather than to the frame rate.
  let spin = 0;

  /* The motes, and the pointer they run from.
   *
   * Seeded lazily on the first resize, because position is in pixels and there are none before
   * the canvas has been measured.
   */
  const motes = [];
  const mouse = { x: -9999, y: -9999, seen: false };

  function seedMotes() {
    motes.length = 0;
    for (let i = 0; i < MOTES; i++) {
      motes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        // A slow prevailing drift up and to one side, different per mote, so they never look
        // like a field being scrolled.
        dx: (Math.random() - 0.5) * 0.012,
        dy: -(0.004 + Math.random() * 0.014),
        vx: 0, vy: 0,
        r: 0.7 + Math.random() * 2.1,
        // Depth, 0..1. Drives size, brightness AND how hard the pointer shoves it — a speck
        // far away should barely notice, and that parallax is most of the illusion.
        z: Math.random(),
        phase: Math.random() * 7,
      });
    }
  }

  function stepMotes(dtMs) {
    if (!motes.length) return;
    const k = dtMs / 16.7;

    for (const m of motes) {
      // The pointer, as a force rather than a position: a push that falls off with distance,
      // so a mote slides out of the way and keeps going instead of teleporting to the edge of
      // a circle. Squared falloff, which is gentle at the rim and firm in the middle.
      if (mouse.seen) {
        const dx = m.x - mouse.x, dy = m.y - mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < MOUSE_R * MOUSE_R && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const fall = 1 - d / MOUSE_R;
          // Nearer motes are shoved harder. The far ones barely stir.
          const push = fall * fall * MOUSE_FORCE * (0.35 + m.z * 0.65);
          m.vx += (dx / d) * push * k;
          m.vy += (dy / d) * push * k;
        }
      }

      // Drag, so a shoved mote coasts to a stop rather than flying off for ever, and settles
      // back into its own drift.
      const drag = Math.pow(0.94, k);
      m.vx *= drag;
      m.vy *= drag;

      m.x += (m.dx + m.vx) * dtMs;
      m.y += (m.dy + m.vy) * dtMs;

      // Wrap. Cheaper than respawning and it keeps the density even.
      if (m.x < -10) m.x = w + 10; else if (m.x > w + 10) m.x = -10;
      if (m.y < -10) m.y = h + 10; else if (m.y > h + 10) m.y = -10;
    }
  }

  function drawMotes(now) {
    const hue = edgeHue(spin + 0.5);
    for (const m of motes) {
      // Twinkle, so a static field still has life in it when nothing is moving.
      const tw = 0.55 + 0.45 * Math.sin(now / 900 + m.phase);
      // Never fully absent when the music is off — these belong to the page, not to the track.
      const a = (0.1 + m.z * 0.26) * tw * (0.45 + presence * 0.55);
      ctx.fillStyle = `rgba(${hue}, ${a})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r * (0.55 + m.z * 0.75), 0, 7);
      ctx.fill();
    }
  }

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
    if (!motes.length) seedMotes();
  }

  /** One side. `dir` is +1 for the left edge growing right, -1 for the right edge growing left. */
  function drawSide(dir, reach, rowH, bh) {
    // Each bar sits a little further round the sweep than the one below it, so the stack is a
    // slice of the same spectrum the borders are running — a rainbow standing on its end rather
    // than forty bars that happen to be coloured.
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
      /* A FULL turn of the spectrum across the stack, bottom to top.
       *
       * It was a third of a turn, which meant the whole stack sat inside two or three
       * neighbouring hues and read as one colour that happened to drift. The borders sweep the
       * entire six-stop spectrum; the stack should be that spectrum stood on its end, so the
       * bass end and the air end are at opposite points of it and every band in between is a
       * step along the way.
       *
       * `spin` still turns the whole thing at the border's rate, so what moves is which hue is
       * at the bottom — the stack is a window onto the same wheel the panels are running. */
      const hue = edgeHue(spin + i / BANDS);
      const grad = ctx.createLinearGradient(x0, 0, x0 + dir * len, 0);
      /* Hot at the edge, cooling and vanishing inward. The alpha ramp is what keeps the inner
       * end from ever being a visible edge.
       *
       * No floor term. There used to be a `+ 0.12`, so that a quiet band was still a visible
       * line — which is right for three bars in a dock and badly wrong for forty: it drew all
       * forty at all times and the result was a venetian blind down each side of the screen,
       * with the loud ones somewhere inside it. A band with nothing in it should show nothing.
       * The shape comes from the bands that are doing something. */
      // Brighter than before, and with a white-hot core at the edge where the bar meets the
      // frame: the old version was legible and polite, and a VU meter should be neither.
      grad.addColorStop(0, `rgba(255, 255, 255, ${0.22 * v * v * VU_INTENSITY})`);
      grad.addColorStop(0.12, `rgba(${hue}, ${(0.72 * v * v + 0.1 * v) * VU_INTENSITY})`);
      grad.addColorStop(0.5, `rgba(${hue}, ${0.4 * v * v * VU_INTENSITY})`);
      grad.addColorStop(1, `rgba(${hue}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(dir > 0 ? x0 : x0 - len, y, len, bh, bh / 2);
      ctx.fill();

      // The cap. Two pixels of bright, out where the loudest recent moment reached.
      const p = spectrum.peak[i] * presence;
      if (p > v + 0.02) {
        const px = x0 + dir * (p * reach);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.6 * p * p * VU_INTENSITY})`;
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
    // The bloom takes the hue at the bottom of the stack, so the light under the bars is the
    // same light that is in them.
    const hue = edgeHue(spin);
    g.addColorStop(0, `rgba(${hue}, ${0.17 * bass * bass * VU_INTENSITY})`);
    g.addColorStop(0.5, `rgba(${hue}, ${0.06 * bass * bass * VU_INTENSITY})`);
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
      const a = Math.min(1, e.life * 1.6) * presence * 0.45 * VU_INTENSITY;
      ctx.fillStyle = `rgba(${edgeHue(spin + e.life * 0.2)}, ${a})`;
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
    spin += (dtMs / 1000) / EDGE_PERIOD_S;
    const want = music.playing && music.volume > 0 && music.analyser ? 1 : 0;
    presence += (want - presence) * (1 - Math.pow(1 - 0.06, dtMs / 16.7));

    if (want) spectrum.read(music.analyser, dtMs);
    else spectrum.rest(dtMs);

    ctx.clearRect(0, 0, w, h);

    /* The motes run whatever the music is doing — they are the page responding to YOU, and a
     * page that stops responding when the music is off is a page with a bug in it. Drawn under
     * everything else and in `lighter`, like the rest of this canvas. */
    ctx.globalCompositeOperation = 'lighter';
    stepMotes(dtMs);
    drawMotes(now);
    ctx.globalCompositeOperation = 'source-over';

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
    /** The pointer, in canvas pixels. Passed in rather than listened for here, so the module
     *  owns no global state and a second instance could never fight the first. */
    pointer(x, y) {
      mouse.x = x; mouse.y = y; mouse.seen = true;
    },

    pointerOut() { mouse.seen = false; },

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
