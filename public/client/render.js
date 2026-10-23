// Canvas 2D renderer: cached map chunks, then entities on top.
//
// The map is split into 8x8-tile chunks, each drawn once into its own offscreen canvas and only
// redrawn when a cell inside it changes. Per frame we blit a dozen chunks and draw a handful of
// sprites. Same approach Game of Bombs uses. docs/ARCHITECTURE.md §6.

import {
  TILE_PX, CHUNK_TILES, UNITS_PER_TILE, TRACER_SAMPLES, FUSE_TICKS, FIRE_TICKS, STATUS,
  BLOCK, BLOCK_HP, SEA_MARGIN_TILES, SPAWN_POP_TICKS, SPAWN_POP_SCALE, MIN_ZOOM, MAX_ZOOM,
  PERK_FADE_TICKS, STAMINA_SHOW_AT, staminaMaxFor,
} from '/shared/constants.js';
import { cellType, cellHp } from '/shared/maps.js';
import {
  drawTile, drawFire, drawPerk, drawRock, drawShip, playerShades, PALETTE, bake, bakeSea,
  PERK_GLOWS,
} from '/assets/art.js';
import { bombTile } from '/shared/sim/bombs.js';

const CHUNK_PX = TILE_PX * CHUNK_TILES;

export function createRenderer(canvas, world) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let chunks = new Map();          // "cx,cy" -> {canvas, dirty}
  let baked = null;
  const cam = { x: 0, y: 0 };
  let redrawsThisSecond = 0, redrawWindow = 0;
  // Screen shake and a full-screen flash. Both are presentation only and both decay toward zero,
  // so a frame drop can never leave the camera stuck off-centre or the screen stuck red.
  let shake = 0;
  let flash = 0, flashColour = '255,255,255';
  let sea = null, seaNear = null, seaFar = null;
  // Everything about the drawing surface, measured on resize and never from the frame loop.
  const view = { dpr: 1, w: 0, h: 0, zoom: 1, smooth: false };
  const splashes = [];         // shoreline foam, capped — see spawnSplash
  const floaters = [];         // "+1 BOMB" rising off a player — see addFloater
  let seaT = 0;
  let drunk = 0;                       // 0..1, eased, so it fades in and out rather than snapping
  let depth = null, depthFor = '';     // the depth gradient, rebuilt only when the view changes

  // Sun glints on the open water. Cheap, stateless, and most of what makes a surface read wet.
  const GLINTS = 46;
  const GLINT_LIFE_S = 1.6;
  /** Deterministic 0..1 from one integer, so a glint stays put for its whole life. */
  const hash01 = n => {
    let x = (n * 374761393) ^ 0x5bf03635;
    x = (x ^ (x >>> 13)) * 1274126177;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
  };

  function ensureBaked() {
    if (baked) return;
    baked = bake({ playerCount: 16 });
    sea = bakeSea();
    seaNear = ctx.createPattern(sea.near, 'repeat');
    seaFar = ctx.createPattern(sea.far, 'repeat');
  }


  /**
   * Measure, and work out the scale. Called when the box changes, never from the frame loop.
   *
   * Reading clientWidth forces the browser to flush layout. Doing that once per frame — which is
   * what the first version did — makes every frame wait on a layout pass, and because the number
   * it returns settles over several frames while the panels lay out, the zoom crept and the
   * whole board visibly shimmered. Measuring on resize only is both faster and stable.
   */
  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;                   // laid out but not measured yet
    // Bail when nothing actually changed. Writing canvas.width resets the drawing surface and
    // can itself be observed as a resize, so an unguarded ResizeObserver callback that always
    // writes is a loop that clears the canvas every frame.
    if (w === view.w && h === view.h && dpr === view.dpr) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    view.dpr = dpr;
    view.w = w;
    view.h = h;
    recomputeZoom();
  }

  /**
   * Fill the box with the island, keeping a strip of sea all the way round.
   *
   * The fit is computed against the map plus SEA_MARGIN_TILES on every side, so there is always
   * visible ocean and the island reads as an island rather than as a diagram that ran out of
   * paper. Beyond that the board is as large as it can possibly be.
   */
  /**
   * The bounding box of the LAND, in tiles, as [x0, y0, w, h].
   *
   * Not the map rectangle. Every map but Arena is a shape inside its rectangle — Cove is a blob,
   * Twins is two circles — and the rest of the grid is WATER. Fitting the rectangle therefore
   * fitted a frame of ocean that was already several tiles thick before the margin was added,
   * which is why Cove rendered a small island in a sea of empty blue.
   *
   * Cached per map object: this is a full w*h scan and the map identity only changes on a round.
   */
  let landBoxFor = null, landBox = null;
  function landBounds() {
    if (landBoxFor === world.map && landBox) return landBox;
    const { w, h, cells } = world.map;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        if (cellType(cells[ty * w + tx]) === BLOCK.WATER) continue;
        if (tx < x0) x0 = tx;
        if (tx > x1) x1 = tx;
        if (ty < y0) y0 = ty;
        if (ty > y1) y1 = ty;
      }
    }
    // A map that is somehow all water still has to render something.
    if (x1 < x0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
    landBoxFor = world.map;
    landBox = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
    return landBox;
  }

  function recomputeZoom() {
    if (!world.map || !view.w) return;
    const m = SEA_MARGIN_TILES * 2;
    const [, , lw, lh] = landBounds();
    // Fit the ISLAND plus its ocean margin, so the water starts SEA_MARGIN_TILES beyond the
    // coast on every map, whatever shape the land is inside its grid.
    const fit = Math.min(view.w / ((lw + m) * TILE_PX),
                         view.h / ((lh + m) * TILE_PX));

    // Quantised. An unrounded scale changes by a hair on every layout settle and on every DPR
    // report, and a board that resizes by one part in a thousand reads as jitter. Fortieths are
    // fine enough that nobody sees the step and coarse enough that nothing wobbles.
    //
    // Rounded DOWN, not to nearest: rounding up eats into the two tiles of ocean that are the
    // one rule this function has.
    let q = Math.floor(fit * 40) / 40;

    // Floored. Below MIN_ZOOM a tile is about twenty pixels and a player is a smudge, so the
    // board stops shrinking and the camera starts following instead — which frame() already does
    // whenever the map does not fit. A map you cannot read is worse than a map you cannot see
    // all of.
    q = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, q));

    // No half-step snapping. It was there so pixel art upscaled by a non-integer factor would
    // not get rows of visibly different widths — but flooring to the nearest half THREW AWAY UP
    // TO A THIRD OF THE SCALE: a window that could take 1.45 was rendered at 1.0, and the
    // difference went into the sea. Forty-five percent more ocean than asked for is a far worse
    // artefact than a row of pixels one unit wider than its neighbour, which at these sizes
    // nobody has ever noticed. Smoothing is switched on above 1 as well, which hides it anyway.
    const z = q;
    if (!Number.isFinite(z) || z <= 0) return;      // never let a bad measurement blank the board
    if (z === view.zoom) return;
    view.zoom = z;
    // Smooth at any non-integer scale, in both directions, for the reason above.
    view.smooth = Math.abs(q - Math.round(q)) > 1e-6;
    invalidateAll();
  }

  addEventListener('resize', resize);
  // The panels change the box without the window changing at all — a narrow viewport dropping
  // the side panel, or the HUD appearing when a round starts. Deferred to the next frame so the
  // canvas.width write inside resize() can never re-enter the observer that triggered it.
  if (typeof ResizeObserver === 'function') {
    let queued = false;
    new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; resize(); });
    }).observe(canvas);
  }

  const invalidateAll = () => {
    chunks = new Map(); shore = null; splashes.length = 0; dropsFor = null;
    rollCurrent();          // a new island sits in a different sea
  };
  const mapChanged = () => { recomputeZoom(); };

  /** Mark the chunk holding a tile dirty, plus neighbours when it sits on a border. */
  function invalidateTile(tx, ty) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const key = `${(tx + dx) >> 3},${(ty + dy) >> 3}`;
      const c = chunks.get(key);
      if (c) c.dirty = true;
    }
  }

  function chunkAt(cx, cy) {
    const key = `${cx},${cy}`;
    let c = chunks.get(key);
    if (!c) {
      const el = document.createElement('canvas');
      el.width = el.height = CHUNK_PX;
      c = { canvas: el, dirty: true };
      chunks.set(key, c);
    }
    if (c.dirty) {
      const cc = c.canvas.getContext('2d');
      cc.imageSmoothingEnabled = false;
      // Cleared, not filled: water tiles and everything off the edge of the map stay transparent
      // so the animated sea drawn underneath shows through. The sea is the background now.
      cc.clearRect(0, 0, CHUNK_PX, CHUNK_PX);
      const map = world.map;
      for (let j = 0; j < CHUNK_TILES; j++) {
        for (let i = 0; i < CHUNK_TILES; i++) {
          const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
          if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
          const byte = map.cells[ty * map.w + tx];
          const type = cellType(byte);
          if (type === BLOCK.WATER) continue;              // the sea draws itself
          const maxHp = BLOCK_HP[type] || 0;
          const dmg = maxHp ? 1 - cellHp(byte) / maxHp : 0;
          cc.save();
          cc.translate(i * TILE_PX, j * TILE_PX);
          if (type === BLOCK.IRON) drawRock(cc, tx, ty, seaEdges(tx, ty));
          else drawTile(cc, type, tx, ty, dmg);
          cc.restore();
        }
      }
      c.dirty = false;
      redrawsThisSecond++;
    }
    return c.canvas;
  }

  /** Which sides of this tile face open water, as a DIR_* bitmask. */
  function seaEdges(tx, ty) {
    const map = world.map;
    const sea = (x, y) =>
      x < 0 || y < 0 || x >= map.w || y >= map.h || cellType(map.cells[y * map.w + x]) === BLOCK.WATER;
    return (sea(tx + 1, ty) ? 1 : 0) | (sea(tx, ty - 1) ? 2 : 0)
         | (sea(tx - 1, ty) ? 4 : 0) | (sea(tx, ty + 1) ? 8 : 0);
  }

  /**
   * The shoreline, cached once per map.
   *
   * Scanning every tile for a coast every frame would be the single most expensive thing the
   * renderer does. The coast never changes — rock is indestructible and water never becomes
   * anything else — so it is computed on the first frame after a map arrives and then reused.
   */
  let shore = null;
  function shoreline() {
    if (shore) return shore;
    const map = world.map;
    shore = [];
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        if (cellType(map.cells[ty * map.w + tx]) !== BLOCK.IRON) continue;
        const e = seaEdges(tx, ty);
        if (e) shore.push({ tx, ty, e });
      }
    }
    return shore;
  }

  /**
   * Foam breaking on a rock. Spawned at a trickle from random shoreline tiles, capped hard.
   *
   * A real particle system would be the obvious thing and the wrong one: the sea is scenery and
   * is not allowed to compete with sixteen players and a chain reaction for the frame budget.
   * Thirty short-lived circles, spawned a couple a second, reads as a coast.
   */
  // ─── the sea, as particles ──────────────────────────────────────────────────
  //
  // A real simulation, not a scrolling texture: a fixed pool of drifting particles advected by a
  // flow field, recycled when they leave the visible water. Fixed pool and no allocation per
  // frame — a particle system that grows is a particle system that eventually drops frames, and
  // the sea is scenery that may never compete with sixteen players and a chain reaction.
  //
  // The flow field is two crossed sine waves sampled at the particle's position. It costs two
  // sin() per particle per frame and produces swirls, eddies and a slow prevailing drift, which
  // is everything the eye needs to read it as water.
  // Doubled from 220. The field was readable but sparse — at any one moment most of the open
  // water had nothing moving in it, so the current was something you inferred rather than saw.
  // Cost is linear and tiny: two sin() per particle per frame against a budget that is spent on
  // sixteen players and a chain reaction.
  const DROPS = 440;
  const drops = [];
  let dropsFor = null;              // the map they were seeded for

  function seedDrops() {
    drops.length = 0;
    const W = world.map.w * TILE_PX, H = world.map.h * TILE_PX;
    const M = SEA_MARGIN_TILES * TILE_PX * 2;
    for (let i = 0; i < DROPS; i++) {
      drops.push({
        x: -M + Math.random() * (W + M * 2),
        y: -M + Math.random() * (H + M * 2),
        len: 3 + Math.random() * 9,          // drawn as a short streak along its own velocity
        a: 0.12 + Math.random() * 0.3,
        vx: 0, vy: 0,
      });
    }
    dropsFor = world.map;
  }

  /**
   * The current: a prevailing drift with two wave trains riding on it, all rolled per map.
   *
   * The drift used to run straight down the screen at a fixed speed, which reads as a conveyor
   * belt rather than as water. What was still fixed after that was the WAVES: both sine terms
   * were axis-aligned, one travelling along y and one along x, so whatever the drift was doing
   * underneath, the surface corrugation always ran square to the screen. The current angle only
   * scaled their amplitude, which is not the same as turning them.
   *
   * So each train now has its own direction, wavelength, speed and amplitude. The sine is taken
   * along a PROJECTION onto that direction — `x*cos(a) + y*sin(a)` is distance measured along
   * the heading — which is what actually makes a plane wave travel that way.
   *
   * The two headings straddle the drift by a random 20-45 degrees rather than a fixed 30. Wind
   * waves and the current beneath them are never quite aligned, and two trains crossing at a
   * slight angle is what produces the wandering interference a real surface has. Identical
   * headings would just sum into one bigger wave.
   */
  const current = { angle: 0, speed: 0, trains: [], surface: [] };

  // The ranges. A drift is a drift, not a river, and a wavelength shorter than ~60px turns into
  // visual noise once the whole map is zoomed to fit.
  const DRIFT_SPEED = [9, 22];            // world px/s
  const TRAIN_SPREAD = [Math.PI / 9, Math.PI / 4];   // 20-45 degrees off the drift
  const TRAIN_WAVELENGTH = [88, 275];     // px between crests (a quarter wider than the first pass)
  const TRAIN_SPEED = [16, 52];           // px/s the crests travel
  const TRAIN_AMPLITUDE = [7, 16];        // px/s of sideways push at the crest

  /* The envelope: a wave within the wave.
   *
   * Real water is not evenly rough. Wind lanes, fetch and shelter leave bands of chop sitting
   * next to bands of near-glass, and those bands drift. A uniformly agitated surface is the
   * thing that reads as "simulation" rather than as sea, however good the individual waves are.
   *
   * So each train's amplitude is multiplied by a second, much longer, much slower wave running
   * at its own heading. Where the envelope peaks the train is at full strength; in its troughs
   * it drops to ENVELOPE_FLOOR of it. The envelope's heading is rolled independently of the
   * train's, so the calm patches travel ACROSS the waves rather than with them — which is what
   * makes them read as areas of water rather than as part of the wave pattern.
   */
  const ENVELOPE_WAVELENGTH = [400, 1125];  // px across a band of chop
  const ENVELOPE_SPEED = [4, 14];           // px/s the bands drift
  const ENVELOPE_FLOOR = 0.3;               // how calm the calm patches get

  /* The two tiled surface layers get the same treatment as the particles.
   *
   * These are the squiggles you actually see — the particle field is the motion, this is the
   * texture. They used to drift at a hard-coded (11, 5) and (-7, 9) and were drawn axis-aligned,
   * so every map had the same sea running the same way down the screen whatever the current
   * underneath it was doing. Now the whole pattern is rotated to the map's heading and each
   * layer drifts at its own angle off it, which is what produces parallax that looks like water
   * rather than like two sheets sliding.
   */
  const SURFACE_DRIFT = [5, 15];                   // px/s each layer travels
  const SURFACE_SPREAD = [-Math.PI / 5, Math.PI / 5];

  const between = ([lo, hi]) => lo + Math.random() * (hi - lo);

  function rollSurface() {
    current.surface = [0, 1].map(() => {
      const a = between(SURFACE_SPREAD);
      const sp = between(SURFACE_DRIFT);
      return { sx: Math.cos(a) * sp, sy: Math.sin(a) * sp };
    });
  }

  function rollCurrent() {
    // The heading everything is rolled around: a full turn, so no two maps share an orientation.
    current.angle = Math.random() * Math.PI * 2;
    current.speed = between(DRIFT_SPEED);
    rollSurface();
    current.trains = [-1, 1].map(side => {
      // Each train is rotated off the drift by its own random angle, on its own side of it.
      const heading = current.angle + side * between(TRAIN_SPREAD);
      const wavelength = between(TRAIN_WAVELENGTH);
      // The envelope gets a heading of its own, anywhere on the circle.
      const envHeading = Math.random() * Math.PI * 2;
      const envWavelength = between(ENVELOPE_WAVELENGTH);
      return {
        // Precomputed because this runs per particle per frame.
        dx: Math.cos(heading), dy: Math.sin(heading),
        k: (Math.PI * 2) / wavelength,          // radians of phase per pixel
        w: ((Math.PI * 2) / wavelength) * between(TRAIN_SPEED),   // and per second
        amp: between(TRAIN_AMPLITUDE),
        phase: Math.random() * Math.PI * 2,
        edx: Math.cos(envHeading), edy: Math.sin(envHeading),
        ek: (Math.PI * 2) / envWavelength,
        ew: ((Math.PI * 2) / envWavelength) * between(ENVELOPE_SPEED),
        ephase: Math.random() * Math.PI * 2,
      };
    });
  }

  /**
   * How strong this train is at this point, right now. Between ENVELOPE_FLOOR and 1.
   *
   * Kept as its own function so both flow axes use the identical value: computing it twice from
   * the same inputs would be correct, but a single call site is one fewer place for the two
   * components of one vector to drift apart.
   */
  const envelopeAt = (s, x, y, t) => {
    const e = Math.sin((x * s.edx + y * s.edy) * s.ek - t * s.ew + s.ephase);
    return ENVELOPE_FLOOR + (1 - ENVELOPE_FLOOR) * (0.5 + 0.5 * e);
  };
  rollCurrent();

  /**
   * Flow at a point, as a vector.
   *
   * Each train pushes ACROSS its own direction of travel, not along it: water in a passing swell
   * moves side to side while the crest moves forward. Pushing along the heading would make the
   * particles race the wave and the whole field would shear apart.
   */
  /* How much the boulders push the water aside at a point.
   *
   * A simple radial repulsion that dies off with distance: close in it is strong enough to steer
   * particles round the rock, and past a few radii it is nothing. Not fluid dynamics — the eye
   * is not checking for conservation of mass, it is checking that the water does not sail
   * straight through a rock.
   */
  const ROCK_PUSH = 46;
  function rockFlow(x, y, out) {
    out.x = 0; out.y = 0;
    for (const k of (rocksFor === world.map ? seaRocks : waterRocks())) {
      const dx = x - k.x, dy = y - k.y;
      const d2 = dx * dx + dy * dy;
      const reach = k.r * 3.2;
      if (d2 > reach * reach || d2 < 1) continue;
      const d = Math.sqrt(d2);
      const f = (1 - d / reach) ** 2 * ROCK_PUSH;
      out.x += (dx / d) * f;
      out.y += (dy / d) * f;
    }
  }
  const rockPush = { x: 0, y: 0 };

  const flowX = (x, y, t) => {
    rockFlow(x, y, rockPush);
    let v = Math.cos(current.angle) * current.speed + rockPush.x;
    for (const s of current.trains) {
      const a = s.amp * envelopeAt(s, x, y, t);
      v += Math.sin((x * s.dx + y * s.dy) * s.k - t * s.w + s.phase) * a * -s.dy;
    }
    return v;
  };
  const flowY = (x, y, t) => {
    // rockPush was filled by the flowX call for this same point, one line earlier in drawDrops.
    let v = Math.sin(current.angle) * current.speed + rockPush.y;
    for (const s of current.trains) {
      const a = s.amp * envelopeAt(s, x, y, t);
      v += Math.sin((x * s.dx + y * s.dy) * s.k - t * s.w + s.phase) * a * s.dx;
    }
    return v;
  };

  function drawDrops(vw, vh, ox, oy, dt) {
    if (dropsFor !== world.map) seedDrops();
    const W = world.map.w * TILE_PX, H = world.map.h * TILE_PX;
    const M = SEA_MARGIN_TILES * TILE_PX * 2;
    const map = world.map;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.lineCap = 'round';
    ctx.strokeStyle = PALETTE.foam;
    for (const d of drops) {
      const fx = flowX(d.x, d.y, seaT), fy = flowY(d.x, d.y, seaT);
      // Ease toward the current rather than snapping to it, so particles have momentum and the
      // field reads as water being pushed rather than as dots teleporting along a curve.
      d.vx += (fx - d.vx) * 0.08;
      d.vy += (fy - d.vy) * 0.08;
      d.x += d.vx * dt;
      d.y += d.vy * dt;

      // Wrap round the visible sea. Cheaper than respawning and keeps the density even.
      if (d.x < -M) d.x += W + M * 2; else if (d.x > W + M) d.x -= W + M * 2;
      if (d.y < -M) d.y += H + M * 2; else if (d.y > H + M) d.y -= H + M * 2;

      // Hidden behind the island: skip it rather than drawing a wave on top of the level.
      const tx = (d.x / TILE_PX) | 0, ty = (d.y / TILE_PX) | 0;
      if (tx >= 0 && ty >= 0 && tx < map.w && ty < map.h
          && cellType(map.cells[ty * map.w + tx]) !== BLOCK.WATER) continue;

      const sp = Math.hypot(d.vx, d.vy) || 1;
      ctx.globalAlpha = d.a;
      ctx.lineWidth = sp > 18 ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - (d.vx / sp) * d.len, d.y - (d.vy / sp) * d.len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Fewer, bigger, slower. Small frequent splashes read as static along the whole coast; a
  // handful of large slow swells read as a sea. Roughly one every two seconds, each living about
  // three times as long as the old ones and spreading to several tiles across.
  const MAX_SPLASHES = 4;
  const SPLASH_EVERY_MS = 8000;

  function spawnSplash() {
    if (splashes.length >= MAX_SPLASHES) return;

    // One in three breaks on a boulder rather than on the island. They are small and far out,
    // so without their own share of the foam they would be the only still thing in the water.
    const rocks = waterRocks();
    if (rocks.length && Math.random() < 0.34) {
      const k = rocks[(Math.random() * rocks.length) | 0];
      const a = Math.random() * Math.PI * 2;
      splashes.push({
        x: k.x + Math.cos(a) * k.r * 0.95,
        y: k.y + Math.sin(a) * k.r * 0.8,
        life: 1,
        r: 8 + Math.random() * 8,
        rate: 0.18 + Math.random() * 0.14,
      });
      return;
    }

    const edges = shoreline();
    if (!edges.length) return;
    const s = edges[(Math.random() * edges.length) | 0];
    // Push the swell out onto the water side, so it breaks against the rock rather than on it.
    const dx = (s.e & 1 ? 1 : 0) - (s.e & 4 ? 1 : 0);
    const dy = (s.e & 8 ? 1 : 0) - (s.e & 2 ? 1 : 0);
    if (!dx && !dy) return;
    splashes.push({
      x: (s.tx + 0.5 + dx * 0.7) * TILE_PX,
      y: (s.ty + 0.5 + dy * 0.7) * TILE_PX,
      life: 1,
      r: 9 + Math.random() * 9,
      rate: 0.16 + Math.random() * 0.12,       // five to six seconds to fade
    });
  }

  /* The ship, anchored out in open water.
   *
   * Scenery, and deliberately in the background: half the size she was, well off the coast, and
   * painted down into the colour of the sea so she never competes with a bomb or a player for
   * attention. The test for a piece of set dressing is whether you notice it when you are NOT
   * looking for it — if you do, it is too loud.
   *
   * Deterministic in the map, never random. Scenery that moves when you respawn is a bug as far
   * as the eye is concerned.
   */
  const SHIP_SCALE = 2;
  const SHIP_ALPHA = 0.42;
  // Nearly solid. A boulder is a real object sitting in the water, not a shadow under it —
  // what keeps it in the background is its COLOUR, which is mixed well down toward the deep
  // sea, not its transparency. Fading it out just made it look like a rendering fault.
  const ROCK_ALPHA = 0.88;
  // Her centre sits this far outside the island's bounding box. The visible ocean margin is two
  // or three tiles, so at two and a half she is half in frame and half past the edge of the
  // board — present, cut off, and obviously not something you can interact with.
  const SHIP_OFFSHORE_TILES = 2.5;

  let mooredFor = null, moored = null;
  function mooring() {
    if (mooredFor === world.map) return moored;
    mooredFor = world.map;
    const [lx, ly, lw, lh] = landBounds();

    // Which side of the island she sits off, chosen from the map's own dimensions so it is
    // stable for a given map and different between maps.
    const side = (world.map.w * 31 + world.map.h * 17) % 4;      // 0 right, 1 up, 2 left, 3 down
    const cx = (lx + lw / 2) * TILE_PX, cy = (ly + lh / 2) * TILE_PX;
    const outX = (lw / 2 + SHIP_OFFSHORE_TILES) * TILE_PX;
    const outY = (lh / 2 + SHIP_OFFSHORE_TILES) * TILE_PX;
    // Offset along the shore as well as away from it, so she is never dead level with the
    // middle of the island — which would look placed rather than anchored.
    const drift = ((world.map.w % 7) - 3) * TILE_PX * 1.5;

    const spots = [
      { x: cx + outX, y: cy + drift, angle: Math.PI / 2 },
      { x: cx + drift, y: cy - outY, angle: 0 },
      { x: cx - outX, y: cy + drift, angle: Math.PI / 2 },
      { x: cx + drift, y: cy + outY, angle: 0 },
    ];
    moored = spots[side];
    return moored;
  }

  function drawMoored(ox, oy) {
    const m = mooring();
    if (!m) return;
    ctx.save();
    ctx.globalAlpha = SHIP_ALPHA;
    ctx.translate(ox + m.x, oy + m.y);
    ctx.rotate(m.angle);
    // A slow roll at anchor. Tiny — a degree and a half — but a ship perfectly still on water
    // that is not reads as a sprite rather than as a boat.
    ctx.rotate(Math.sin(seaT * 0.45) * 0.026);
    ctx.scale(SHIP_SCALE, SHIP_SCALE);
    drawShip(ctx);
    ctx.restore();
  }

  /* Two boulders out in the water, per map.
   *
   * Deterministic in the map like everything else out here, placed outside the island's bounding
   * box so they never touch the playfield, and allowed to sit half off the edge of the board —
   * a rock that is politely fully visible looks placed, one that runs off the edge looks like
   * the island carried on under the water.
   *
   * They are not just paint: the flow field is deflected round them (see flowX/flowY) and the
   * shoreline foam spawns off them, so the water acknowledges they are there. A static rock in a
   * moving current is the one thing that would make the sea look fake.
   */
  /* Boulders out in the water: two or three, rolled fresh every time a map loads.
   *
   * Random rather than derived from the map, because they are weather rather than terrain —
   * nothing in the game interacts with them, so a different arrangement each round is free
   * variety. They are placed outside the island's bounding box and allowed to sit half off the
   * edge of the board: a rock that is politely fully visible looks placed, one that runs off the
   * edge looks like the island carried on under the water.
   *
   * Not just paint. The flow field is deflected round them (see rockFlow) and a share of the
   * foam breaks on them, so the water acknowledges they are there. A static rock in a moving
   * current is the one thing that would make the sea look fake.
   *
   * COLOUR IS THE WHOLE PROBLEM with these. At the shoreline palette they read as pieces of
   * island that have come adrift and pull the eye straight off the board. They are drawn in a
   * much darker, sea-tinted version of the same stone and at reduced opacity, so they sit at
   * about the brightness of the deep water around them: you see shapes, not objects.
   */
  const SEA_ROCKS = 3;
  let rocksFor = null, rocksForView = 0, seaRocks = [];

  /* Placed against the VIEW, not just against the island.
   *
   * Dropping them a fixed distance beyond the land was simple and wrong: on a wide window they
   * fell outside the frame entirely and nobody ever saw one, and on a narrow one they sat on
   * top of the coast. The sea you can actually see is a band between the edge of the island and
   * the edge of the board, and its width depends on the window and the zoom.
   *
   * So the band is measured and the rocks are placed inside it, with a guarantee rather than a
   * hope: the first is positioned to be **entirely** on screen, and the other two to be **at
   * least a fifth** on screen — those two are allowed to run off the edge, which is what stops
   * the set looking arranged.
   *
   * Re-rolled when the map changes or when the window resizes enough to move the band, because
   * a rock that was fully visible before you resized should still be.
   */
  const ROCK_FULLY_VISIBLE = 1;
  const ROCK_MIN_VISIBLE = 0.2;

  function waterRocks() {
    const viewKey = Math.round(view.w / 40) * 1000 + Math.round(view.h / 40);
    if (rocksFor === world.map && rocksForView === viewKey) return seaRocks;
    rocksFor = world.map;
    rocksForView = viewKey;

    const [lx, ly, lw, lh] = landBounds();
    const cx = (lx + lw / 2) * TILE_PX, cy = (ly + lh / 2) * TILE_PX;
    const zoom = view.zoom || 1;
    // Half the board, in world pixels, from the island's centre.
    const halfView = [(view.w / zoom) / 2, (view.h / zoom) / 2];
    const halfLand = [(lw * TILE_PX) / 2, (lh * TILE_PX) / 2];

    const bandOn = axis => halfView[axis] - (halfLand[axis] + TILE_PX * 1.2);
    // The fully-visible one goes on whichever axis has the most spare sea, because it is the
    // only one that has to fit the band twice over. The others take what is left.
    const widest = bandOn(0) >= bandOn(1) ? 0 : 1;

    seaRocks = [];
    const spin = (Math.random() * 4) | 0;
    for (let i = 0; i < SEA_ROCKS; i++) {
      const side = i === 0
        ? widest + (Math.random() < 0.5 ? 0 : 2)        // same axis, either end
        : (spin + i) % 4;
      const horizontal = side % 2 === 0;
      const sign = side % 4 < 2 ? 1 : -1;
      const axis = horizontal ? 0 : 1;

      const inner = halfLand[axis] + TILE_PX * 1.2;     // just clear of the coast
      const outer = halfView[axis];                      // the edge of the board
      const band = outer - inner;
      const full = i < ROCK_FULLY_VISIBLE;
      // A thin band still gets a rock; it is simply a smaller one. The fully-visible rock has
      // to fit the band twice over — once either side of its centre — so it is capped harder.
      const want = TILE_PX * (2.1 + Math.random() * 1.9);
      // No floor on the full one: "entirely on screen" beats "a decent size", and on a cramped
      // band a small rock is still a rock. The others may be as big as the band allows.
      const r = full
        ? Math.max(TILE_PX * 0.35, Math.min(want, band / 2))
        : Math.max(TILE_PX * 0.9, Math.min(want, band * 0.8));

      // Distance from the island's centre, along the chosen axis.
      const dist = full
        // Entirely inside: clear of the coast on one side, clear of the board edge on the other.
        ? (inner + r + Math.max(inner + r, outer - r)) / 2
        // Partly outside: `visible` is how much of its width is left on screen, so the centre
        // sits that far short of the edge plus the rest of its radius beyond it.
        : outer + r * (1 - 2 * (ROCK_MIN_VISIBLE + Math.random() * 0.3));

      // And a slide along the shore, so they are not all on the centre line of their side. The
      // fully-visible one is clamped so the slide cannot push it off the OTHER edge, which is
      // the easy way to lose a guarantee you only checked on one axis.
      const spread = halfView[1 - axis];
      const along = full
        ? (Math.random() - 0.5) * 2 * Math.max(0, spread - r)
        : (Math.random() - 0.5) * spread * 1.2;

      seaRocks.push({
        x: cx + (horizontal ? sign * dist : along),
        y: cy + (horizontal ? along : sign * dist),
        r,
        lumps: Array.from({ length: 4 }, () => ({
          dx: (Math.random() - 0.5) * r * 0.9,
          dy: (Math.random() - 0.5) * r * 0.7,
          r: r * (0.42 + Math.random() * 0.46),
          squash: 0.72 + Math.random() * 0.3,
          turn: Math.random() * Math.PI,
        })),
        phase: Math.random() * Math.PI * 2,
      });
    }
    return seaRocks;
  }

  function drawWaterRocks(ox, oy) {
    for (const k of waterRocks()) {
      const x = ox + k.x, y = oy + k.y;
      ctx.save();
      // Everything below is drawn inside this one alpha, so the rock sits at the same distance
      // from the eye as the ship does.
      ctx.globalAlpha = ROCK_ALPHA;

      // The water piling up around it. Wide and faint — a bright collar is what made these look
      // like islands rather than like something barely breaking the surface.
      ctx.globalAlpha = 0.12 + 0.04 * Math.sin(seaT * 1.1 + k.phase);
      ctx.strokeStyle = PALETTE.foam;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(x, y, k.r * 1.25, k.r * 1.05, 0, 0, 7); ctx.stroke();
      ctx.globalAlpha = 0.06;
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.ellipse(x, y, k.r * 1.6, k.r * 1.35, 0, 0, 7); ctx.stroke();

      // The mass itself. Every tone is mixed well down toward the deep sea, so the rock is a
      // shape you notice rather than an object that announces itself.
      const lump = (l, grow, fill, alpha) => {
        ctx.globalAlpha = ROCK_ALPHA * alpha;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.ellipse(x + l.dx, y + l.dy, l.r * grow, l.r * l.squash * grow, l.turn, 0, 7);
        ctx.fill();
      };
      for (const l of k.lumps) lump(l, 1.06, '#071320', 0.55);        // wet shadow underneath
      for (const l of k.lumps) lump(l, 1, '#2b3038', 0.92);           // the stone
      // The two lit layers at half strength. They were the brightest thing in the open water
      // and the only part of a rock that caught the eye from across the board — which is the
      // opposite of what a piece of background is for.
      for (const l of k.lumps) lump({ ...l, dx: l.dx - l.r * 0.22, dy: l.dy - l.r * 0.24 },
        0.6, '#3c424c', 0.75);                                        // the lit shoulder
      for (const l of k.lumps) lump({ ...l, dx: l.dx - l.r * 0.3, dy: l.dy - l.r * 0.34 },
        0.26, '#4b515c', 0.5);                                        // the dry cap

      // A wet line where it goes into the water, which is what sells "half submerged".
      ctx.globalAlpha = ROCK_ALPHA * 0.7;
      ctx.strokeStyle = PALETTE.seaLight;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y + k.r * 0.16, k.r * 0.86, k.r * 0.6, 0, 0, 7);
      ctx.stroke();

      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  function drawSea(vw, vh, ox, oy, dtMs) {
    if (!seaNear) return;
    seaT += dtMs / 1000;

    ctx.fillStyle = PALETTE.seaDeep;
    ctx.fillRect(0, 0, vw, vh);

    /* Depth.
     *
     * Open water is not one colour. It goes darker as it gets deeper and further from land, and
     * without that the sea is a flat field with some squiggles on it. A radial gradient centred
     * on the island — lighter at the coast, black-blue at the corners of the board — gives the
     * whole thing a middle, and it costs one fill.
     *
     * Built once per view rather than per frame: a canvas gradient is an object, and allocating
     * one sixty times a second to draw the same thing is work nobody asked for.
     */
    if (!depth || depthFor !== `${vw}x${vh}`) {
      const [lx, ly, lw, lh] = landBounds();
      const cx = ox + (lx + lw / 2) * TILE_PX, cy = oy + (ly + lh / 2) * TILE_PX;
      const r = Math.hypot(vw, vh) * 0.62;
      depth = ctx.createRadialGradient(cx, cy, Math.min(vw, vh) * 0.18, cx, cy, r);
      depth.addColorStop(0, 'rgba(29,81,118,0.30)');     // shelf, close in
      depth.addColorStop(0.45, 'rgba(18,50,82,0.16)');
      depth.addColorStop(1, 'rgba(2,8,16,0.55)');        // the deep, at the edges
      depthFor = `${vw}x${vh}`;
    }
    ctx.fillStyle = depth;
    ctx.fillRect(0, 0, vw, vh);

    // Two layers drifting at different speeds and angles, the whole thing rotated to this map's
    // heading. Parallax between them is the reason a flat fill reads as moving water; the
    // rotation is the reason it is not the same sea on every map.
    //
    // The fill has to cover the viewport once rotated, so it is sized to the diagonal and
    // centred — a viewport-sized rect turned 40 degrees leaves two bare corners.
    const reach = Math.hypot(vw, vh) / 2 + 256;
    for (let i = 0; i < 2; i++) {
      const pattern = i === 0 ? seaNear : seaFar;
      const d = current.surface[i] ?? { sx: 11, sy: 5 };
      ctx.save();
      ctx.translate(vw / 2, vh / 2);
      ctx.rotate(current.angle);
      // Modulo the pattern size, so the offset never grows large enough to lose precision.
      ctx.translate((seaT * d.sx) % 128, (seaT * d.sy) % 128);
      ctx.fillStyle = pattern;
      ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
      ctx.restore();
    }

    /* Sun glints: a sparse scatter of bright specks that live for a moment and go.
     *
     * This is the single cheapest thing that makes water look like water rather than like a
     * moving texture. Real sea is covered in points of reflected sky appearing and vanishing,
     * and the eye reads that as a wet surface before it reads anything else.
     *
     * Positions come from a hash of the index and a slowly advancing epoch, so each glint sits
     * still for its whole short life and a new one appears somewhere else — no state, no
     * allocation, deterministic enough never to flicker as a group.
     */
    ctx.save();
    ctx.fillStyle = '#dff0ff';
    for (let i = 0; i < GLINTS; i++) {
      const epoch = Math.floor(seaT / GLINT_LIFE_S + i * 0.37);
      const f = (seaT / GLINT_LIFE_S + i * 0.37) % 1;
      const hx = hash01(i * 7919 + epoch * 104729);
      const hy = hash01(i * 7919 + epoch * 104729 + 1);
      // A short rise and a long fall, so they twinkle out rather than blinking off.
      const life = f < 0.25 ? f / 0.25 : 1 - (f - 0.25) / 0.75;
      ctx.globalAlpha = life * 0.5;
      const gx = hx * vw, gy = hy * vh;
      const len = 1.5 + hash01(i + epoch) * 3.5;
      ctx.fillRect(gx, gy, len, 1);
      ctx.fillRect(gx + len / 2 - 0.5, gy - 1, 1, 3);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Shallows: two bands rather than one, so the water shelves away from the coast instead of
    // stepping from pale to deep in a single tile.
    ctx.save();
    ctx.translate(ox, oy);
    const shelf = (reachTiles, alpha, colour) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colour;
      for (const s of shoreline()) {
        for (let n = 1; n <= reachTiles; n++) {
          if (s.e & 1) ctx.fillRect((s.tx + n) * TILE_PX, s.ty * TILE_PX, TILE_PX, TILE_PX);
          if (s.e & 4) ctx.fillRect((s.tx - n) * TILE_PX, s.ty * TILE_PX, TILE_PX, TILE_PX);
          if (s.e & 2) ctx.fillRect(s.tx * TILE_PX, (s.ty - n) * TILE_PX, TILE_PX, TILE_PX);
          if (s.e & 8) ctx.fillRect(s.tx * TILE_PX, (s.ty + n) * TILE_PX, TILE_PX, TILE_PX);
        }
      }
    };
    shelf(2, 0.16, PALETTE.seaMid);     // the outer, deeper step
    shelf(1, 0.42, PALETTE.seaLight);   // and the bright water right against the rock

    /* Caustics in the shallows: slow bright ripples where the light reaches the bottom.
     *
     * Only against the coast, which is both where they would really be and the only place the
     * cost is bounded — the shoreline list is a few dozen tiles, not the whole board.
     */
    ctx.globalCompositeOperation = 'lighter';
    for (const s of shoreline()) {
      const dx = (s.e & 1 ? 1 : 0) - (s.e & 4 ? 1 : 0);
      const dy = (s.e & 8 ? 1 : 0) - (s.e & 2 ? 1 : 0);
      if (!dx && !dy) continue;
      const cx = (s.tx + 0.5 + dx * 1.1) * TILE_PX, cy = (s.ty + 0.5 + dy * 1.1) * TILE_PX;
      const beat = Math.sin(seaT * 0.9 + (s.tx + s.ty) * 0.6);
      ctx.globalAlpha = 0.05 + 0.045 * (beat * 0.5 + 0.5);
      ctx.fillStyle = PALETTE.foam;
      ctx.beginPath();
      ctx.ellipse(cx, cy, TILE_PX * (0.42 + 0.12 * beat), TILE_PX * 0.2, (s.tx + s.ty) * 0.7, 0, 7);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawSplashes(ox, oy, dtMs) {
    if (Math.random() < dtMs / SPLASH_EVERY_MS) spawnSplash();
    if (!splashes.length) return;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.lineWidth = 2;
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i];
      s.life -= (dtMs / 1000) * s.rate;
      if (s.life <= 0) { splashes.splice(i, 1); continue; }
      // A spreading ring rather than a filled blob. Foam is an edge, and an outline stays
      // readable at three times the size where a disc would just be a pale smear on the sea.
      const spread = s.r * (1 + (1 - s.life) * 2.2);
      ctx.globalAlpha = s.life * s.life * 0.16;     // squared, so it fades out early and gently
      ctx.strokeStyle = PALETTE.foam;
      ctx.beginPath();
      ctx.arc(s.x, s.y, spread, 0, 7);
      ctx.stroke();
      ctx.globalAlpha = s.life * s.life * 0.05;
      ctx.fillStyle = PALETTE.foam;
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ─── frame ──────────────────────────────────────────────────────────────────

  function frame(dtMs = 16) {
    if (!world.ready || !world.map) return;
    ensureBaked();

    const me = world.me();
    if (!view.w) resize();
    if (!view.w) return;
    const zoom = view.zoom;
    // Everything below works in world pixels; the transform turns them into device pixels.
    ctx.setTransform(view.dpr * zoom, 0, 0, view.dpr * zoom, 0, 0);
    ctx.imageSmoothingEnabled = view.smooth;

    const vw = view.w / zoom, vh = view.h / zoom;
    // The camera frames the ISLAND, not the grid: centring on the middle of the rectangle puts
    // an off-centre island off-centre on screen, with all the spare ocean on one side.
    const [lx, ly, lw, lh] = landBounds();
    const worldW = lw * TILE_PX, worldH = lh * TILE_PX;
    const originX = lx * TILE_PX, originY = ly * TILE_PX;

    // Follow, then clamp. When the whole map fits — which it now does on most screens — the
    // clamp collapses to a single position and the camera simply stops existing, which is the
    // right answer for a sixteen-player game on an island: you can see everyone.
    if (me && (worldW > vw || worldH > vh)) {
      const tx = (me.rx / UNITS_PER_TILE) * TILE_PX - vw / 2;
      const ty = (me.ry / UNITS_PER_TILE) * TILE_PX - vh / 2;
      // Time-based, not per-frame: a fixed 0.25 factor makes the camera twice as laggy at
      // 120 Hz as at 60 Hz, which is exactly the kind of thing that reads as "it feels off".
      const k = 1 - Math.exp(-dtMs / 60);
      if (Math.abs(tx - cam.x) > vw || Math.abs(ty - cam.y) > vh) { cam.x = tx; cam.y = ty; }
      else { cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; }
    }
    // Centre whichever axis has room to spare, instead of pinning the island to the top left.
    // cam stays in absolute world pixels throughout; only the clamp knows about the island.
    cam.x = worldW <= vw ? originX + (worldW - vw) / 2
      : Math.max(originX, Math.min(originX + worldW - vw, cam.x));
    cam.y = worldH <= vh ? originY + (worldH - vh) / 2
      : Math.max(originY, Math.min(originY + worldH - vh, cam.y));

    /* Drunk camera: a slow roll and a lazy drift, not a shake.
     *
     * A shake is an impact — short, high frequency, and it means something hit you. Being drunk
     * is the opposite: low frequency, continuous, and it never quite settles. So the board
     * leans a degree or two and wanders a few pixels on two slow sines, which is enough to make
     * lining up a corridor feel wrong without making anybody ill.
     *
     * Rotation is about the centre of the board rather than the origin, or the whole thing
     * swings away like a door.
     */
    const meNow = world.me();
    drunk += ((meNow && (meNow.status & STATUS.DRUNK) ? 1 : 0) - drunk) * (1 - Math.exp(-dtMs / 400));
    if (drunk > 0.01) {
      const roll = Math.sin(seaT * 0.63) * 0.035 * drunk;
      ctx.translate(vw / 2, vh / 2);
      ctx.rotate(roll);
      ctx.translate(-vw / 2, -vh / 2);
      ctx.translate(Math.sin(seaT * 0.41) * 9 * drunk, Math.cos(seaT * 0.29) * 6 * drunk);
    }

    // Shake is applied to the draw offset, not to the camera, so it cannot accumulate into the
    // follow logic or drift the view. Decay is time-based for the same reason the follow is.
    let sx = 0, sy = 0;
    if (shake > 0.002) {
      const amp = shake * shake * 11;        // squared, so small hits barely register
      sx = (Math.random() * 2 - 1) * amp;
      sy = (Math.random() * 2 - 1) * amp;
      shake *= Math.exp(-dtMs / 90);
    } else shake = 0;

    const ox = -Math.round(cam.x) + Math.round(sx), oy = -Math.round(cam.y) + Math.round(sy);

    drawSea(vw, vh, ox, oy, dtMs);
    // Both before the flow field, so the current runs ACROSS them rather than over the top.
    // Streaks of foam crossing a deck or a boulder read as the water being in front of the
    // thing, which is the one spatial relationship that cannot be true here.
    drawWaterRocks(ox, oy);
    drawMoored(ox, oy);
    drawDrops(vw, vh, ox, oy, Math.min(0.05, dtMs / 1000));

    const cx0 = Math.floor(cam.x / CHUNK_PX), cx1 = Math.floor((cam.x + vw) / CHUNK_PX);
    const cy0 = Math.floor(cam.y / CHUNK_PX), cy1 = Math.floor((cam.y + vh) / CHUNK_PX);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        ctx.drawImage(chunkAt(cx, cy), ox + cx * CHUNK_PX, oy + cy * CHUNK_PX);

    drawSplashes(ox, oy, dtMs);

    for (const k of world.perks) {
      const bob = Math.sin((world.tick + k.id * 7) / 6) * 2;
      // Dying drops fade and shrink. `until` rides along in the snapshot, so this needs no event
      // and survives a reconnect — a perk half-faded when you dropped out is still half-faded
      // when you come back, instead of resetting to full and then vanishing.
      const left = (k.until ?? Infinity) - world.tick;
      const fade = left >= PERK_FADE_TICKS ? 1 : Math.max(0, left / PERK_FADE_TICKS);
      ctx.save();
      ctx.translate(ox + k.tx * TILE_PX, oy + k.ty * TILE_PX);

      /* Rum glows.
       *
       * One drop in ten and the only perk that changes how the game is played rather than how
       * well you play it, so it is worth crossing a map for — and worth being able to SEE from
       * across one. A warm halo behind the tile, breathing, drawn before the plinth so it reads
       * as light coming off the bottle rather than as a ring painted round it.
       */
      if (PERK_GLOWS.has(k.type)) {
        const beat = 0.6 + 0.4 * Math.sin((world.tick + k.id * 11) / 9);
        const g = ctx.createRadialGradient(
          TILE_PX / 2, TILE_PX / 2, TILE_PX * 0.12,
          TILE_PX / 2, TILE_PX / 2, TILE_PX * (0.85 + 0.15 * beat),
        );
        g.addColorStop(0, `rgba(255,186,92,${0.42 * beat})`);
        g.addColorStop(0.5, `rgba(217,154,85,${0.2 * beat})`);
        g.addColorStop(1, 'rgba(217,154,85,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-TILE_PX, -TILE_PX, TILE_PX * 3, TILE_PX * 3);
      }

      if (fade < 1) {
        // A slow flicker on top of the ramp. The ramp alone is easy to miss in peripheral
        // vision; something blinking in the corner of your eye is not.
        const blink = 0.78 + 0.22 * Math.sin(world.tick / 2.2);
        ctx.globalAlpha = fade * (fade < 0.45 ? blink : 1);
        // Shrink about the tile's centre, so it sinks into the floor rather than drifting.
        const scale = 0.72 + 0.28 * fade;
        ctx.translate(TILE_PX / 2, TILE_PX / 2);
        ctx.scale(scale, scale);
        ctx.translate(-TILE_PX / 2, -TILE_PX / 2);
      }
      drawPerk(ctx, { type: k.type, bob });
      ctx.restore();
    }

    for (const b of world.bombs) {
      const phase = Math.max(0, Math.min(1, 1 - (b.at - world.tick) / FUSE_TICKS));
      ctx.drawImage(baked.bombs[(b.o ?? b.owner) % 16][Math.min(7, (phase * 8) | 0)],
        ox + b.tx * TILE_PX, oy + b.ty * TILE_PX);
    }

    // Fire over the bombs that made it, under the people it is about to kill.
    for (const f of world.fires) {
      const age = 1 - Math.max(0, (f.until - world.tick) / FIRE_TICKS);
      ctx.save();
      ctx.translate(ox + f.tx * TILE_PX, oy + f.ty * TILE_PX);
      drawFire(ctx, { kind: f.kind, rot: f.rot, age });
      ctx.restore();
    }

    // Y-sorted so someone below overlaps someone above.
    const alive = world.players.filter(Boolean).sort((a, b) => a.ry - b.ry);
    for (const p of alive) drawTracer(ctx, p, ox, oy);
    for (const p of alive) drawOne(ctx, p, ox, oy, p.i === world.you);

    drawAim(ox, oy);
    for (const p of alive) drawStamina(ctx, p, ox, oy);
    drawFloaters(ox, oy, dtMs);

    if (flash > 0.004) {
      ctx.fillStyle = `rgba(${flashColour},${flash * 0.5})`;
      ctx.fillRect(-4, -4, vw + 8, vh + 8);
      flash *= Math.exp(-dtMs / 110);
    } else flash = 0;

    if (performance.now() - redrawWindow > 1000) { redrawWindow = performance.now(); redrawsThisSecond = 0; }
  }

  // One coloured pip per active status, above the head. Statuses are contagious, so knowing at a
  // glance what the person running at you is carrying is most of playing around them.
  const PIPS = [
    [STATUS.PACIFISM, '#9aa6b5'], [STATUS.SLOWDOWN, '#5b7fd4'], [STATUS.INVISIBLE, '#b98fd9'],
    [STATUS.CHANGELING, '#d45b8f'], [STATUS.REDUCTION, '#5ad1a0'], [STATUS.FAST_DET, '#e8655a'],
  ];

  function drawStatusPips(c, p, px, py) {
    if (!(p.status & ~STATUS.INVULN)) return;
    let n = 0;
    for (const [bit, colour] of PIPS) {
      if (!(p.status & bit)) continue;
      c.fillStyle = colour;
      c.fillRect(px + 4 + n * 5, py - 14, 4, 4);
      n++;
    }
  }

  function drawTracer(c, p, ox, oy) {
    if (!p.trail.length || !p.alive) return;
    const k = playerShades(p.i);
    for (let n = 0; n < p.trail.length; n++) {
      const f = (n + 1) / TRACER_SAMPLES;
      const [x, y] = p.trail[n];
      c.globalAlpha = 0.1 + f * 0.3;
      c.beginPath();
      c.arc(ox + (x / UNITS_PER_TILE) * TILE_PX, oy + (y / UNITS_PER_TILE) * TILE_PX, 2 + f * 3, 0, 7);
      c.fillStyle = k.base;
      c.fill();
    }
    c.globalAlpha = 1;
  }

  /** A shockwave under an arriving player, in their own colour, so it says WHO as well as WHERE. */
  function drawSpawnRing(c, cx, cy, pop, i) {
    const t = (pop - 1) / (SPAWN_POP_SCALE - 1);     // 1 at the moment of arrival, 0 when settled
    const k = playerShades(i);
    c.save();

    // An expanding ring that runs the opposite way to the sprite: the pirate collapses inwards
    // while the shockwave races outwards, and the two moving apart is what reads as an impact
    // rather than as a sprite being resized.
    const ring = TILE_PX * (0.4 + (1 - t) * 7);
    c.globalAlpha = t * 0.5;
    c.lineWidth = 2 + t * 6;
    c.strokeStyle = k.light;
    c.beginPath();
    c.arc(cx, cy, ring, 0, 7);
    c.stroke();

    // A second, faster ring, so the wave has an edge instead of being one fat band.
    c.globalAlpha = t * 0.28;
    c.lineWidth = 1 + t * 2;
    c.beginPath();
    c.arc(cx, cy, ring * 1.45, 0, 7);
    c.stroke();

    // The glow under the sprite itself, which stays tied to how big the sprite still is.
    c.globalAlpha = t * 0.2;
    c.fillStyle = k.base;
    c.beginPath();
    c.arc(cx, cy, TILE_PX * 0.5 * Math.min(pop, 6), 0, 7);
    c.fill();

    c.restore();
    c.globalAlpha = 1;
  }

  function drawOne(c, p, ox, oy, isMe) {
    if (!p.alive) return;
    const px = ox + (p.rx / UNITS_PER_TILE) * TILE_PX - TILE_PX / 2;
    const py = oy + (p.ry / UNITS_PER_TILE) * TILE_PX - TILE_PX / 2;
    const frame = p.moving ? ((world.tick >> 2) & 1) : 0;

    // Invisible: gone to everyone else, a ghost to yourself, so you can still steer.
    if ((p.status & STATUS.INVISIBLE) && !isMe) return;

    // Invulnerable players flash, so "I am safe" and "I am about to not be" are readable at a
    // glance in a crowd. Four hertz: fast enough to notice, slow enough not to hurt.
    if (p.status & STATUS.INVULN) c.globalAlpha = (world.tick >> 2) % 2 ? 0.45 : 1;
    if (p.status & STATUS.INVISIBLE) c.globalAlpha = 0.35;

    const sprite = baked.players[p.i % 16][p.dir * 2 + frame];
    const flipped = (p.status & STATUS.CHANGELING) !== 0;
    const small = (p.status & STATUS.REDUCTION) !== 0;

    /* Out of breath, on the sprite itself.
     *
     * The meter beside the player is precise and easy to miss; this is the opposite. The figure
     * heaves — scaled on one axis only, so it reads as breathing rather than as a zoom — and
     * once genuinely exhausted it flashes amber on the beat of the breath.
     *
     * Deliberately on the SPRITE rather than only in the HUD: at the moment you need to know
     * you are about to be slow, you are looking at your pirate, not at a bar.
     */
    let pant = 0, gasp = 0;
    if (p.stamina !== undefined) {
      const frac = Math.max(0, Math.min(1, p.stamina / staminaMaxFor(p)));
      if (frac < STAMINA_SHOW_AT || p.tired) {
        // Breathing gets faster and deeper the emptier it gets.
        const depth = p.tired ? 1 : (STAMINA_SHOW_AT - frac) / STAMINA_SHOW_AT;
        const rate = 0.22 + depth * 0.3;
        pant = Math.sin(world.tick * rate) * 0.07 * depth;
        gasp = p.tired ? 0.5 + 0.5 * Math.sin(world.tick * rate) : 0;
      }
    }

    // Arriving. A player who simply appears at full size in a sixteen-player scrum is invisible,
    // so they land enormous and collapse to size.
    //
    // Quintic ease-out, not cubic: at twenty times scale a cubic curve is still four tiles wide
    // a third of the way through, which covers the fight. The fifth power dumps almost all of
    // the shrink into the first few frames, so it reads as something LANDING rather than as a
    // slow zoom — and then overshoots slightly below 1 and settles, which is the squash that
    // sells the impact.
    let pop = 1;
    if (p.spawnAt !== undefined) {
      const age = (world.tick - p.spawnAt) / SPAWN_POP_TICKS;
      if (age >= 0 && age < 1) {
        pop = 1 + (SPAWN_POP_SCALE - 1) * Math.pow(1 - age, 5);
        // The last fifth of the window is a small squash-and-settle, under a tenth of a tile.
        if (age > 0.8) pop -= Math.sin((age - 0.8) * 5 * Math.PI) * 0.12;
      } else p.spawnAt = undefined;
    }

    if (pop > 1) drawSpawnRing(c, px + TILE_PX / 2, py + TILE_PX / 2, pop, p.i);

    // Exhausted: a warm pulse on the ground under them. Under, not over — it says "slow" without
    // obscuring the one thing you are aiming at.
    if (gasp > 0) {
      c.save();
      c.globalAlpha = 0.18 + gasp * 0.3;
      c.fillStyle = '#ff9b4a';
      c.beginPath();
      c.ellipse(px + TILE_PX / 2, py + TILE_PX * 0.72, TILE_PX * (0.34 + gasp * 0.12),
        TILE_PX * (0.16 + gasp * 0.05), 0, 0, 7);
      c.fill();
      c.restore();
      c.globalAlpha = 1;
    }

    const sx = (small ? 0.55 : 1) * pop * (1 - pant * 0.5);
    const sy = (small ? 0.55 : 1) * pop * (flipped ? -1 : 1) * (1 + pant);
    if (sx !== 1 || sy !== 1) {
      c.save();
      c.translate(px + TILE_PX / 2, py + TILE_PX / 2);
      c.scale(sx, sy);
      c.drawImage(sprite, -TILE_PX / 2, -TILE_PX / 2);
      c.restore();
    } else {
      c.drawImage(sprite, Math.round(px), Math.round(py));
    }
    c.globalAlpha = 1;

    drawStatusPips(c, p, px, py);

    c.font = '10px ui-monospace, monospace';
    c.textAlign = 'center';
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(0,0,0,0.75)';
    c.strokeText(p.name, px + TILE_PX / 2, py - 3);
    c.fillStyle = isMe ? PALETTE.gold : playerShades(p.i).light;
    c.fillText(p.name, px + TILE_PX / 2, py - 3);
  }

  /**
   * The tile your next bomb would land on.
   *
   * Bombs go where you are facing, which makes placing one an aimed action — and an aimed
   * action with no sight on it is a guess. This is the sight: a bracket on the target tile, in
   * your own colour so sixteen of them never get confused, breathing slowly so it reads as live
   * rather than as part of the terrain.
   *
   * Corners only, not a full outline. A closed box on a 32-pixel tile covers the tile; four
   * corner marks say exactly the same thing while leaving the middle — where the bomb, the
   * wall, or the person you are aiming at actually is — completely clear.
   */
  function drawAim(ox, oy) {
    const me = world.me();
    if (!me || !me.alive || world.observing) return;
    const { tx, ty } = bombTile(world, me);
    // Nothing to show if you are out of bombs: a sight on a shot you cannot take is a lie.
    const live = world.bombs.reduce((n, b) => n + ((b.o ?? b.owner) === world.you ? 1 : 0), 0);
    if (live >= me.bombs) return;

    const k = playerShades(world.you);
    const x = ox + tx * TILE_PX, y = oy + ty * TILE_PX;
    const pulse = 0.55 + 0.25 * Math.sin(world.tick / 7);
    const arm = TILE_PX * 0.3, inset = 3;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A dark pass underneath, so the bracket survives being drawn over pale sand or bright fire.
    for (const [colour, width, alpha] of [['#0b0f16', 4, 0.5], [k.light, 2, pulse]]) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.globalAlpha = alpha;
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const cx = x + (sx > 0 ? inset : TILE_PX - inset);
        const cy = y + (sy > 0 ? inset : TILE_PX - inset);
        ctx.beginPath();
        ctx.moveTo(cx + sx * arm, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * arm);
        ctx.stroke();
      }
    }
    // A faint wash inside, which is what makes the tile read as selected rather than framed.
    ctx.globalAlpha = 0.1 * pulse;
    ctx.fillStyle = k.base;
    ctx.fillRect(x + 2, y + 2, TILE_PX - 4, TILE_PX - 4);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * Stamina, beside the player, and only when it matters.
   *
   * Nothing is drawn above half: a meter that is always on screen is a meter nobody looks at,
   * and sixteen permanent gauges would bury the thing they are drawn on top of. Below half a
   * small bolt appears and drains; at empty it pulses, because that is the moment the number
   * stops being informative and becomes "you are slow now".
   *
   * Drawn for everyone, not just you. Knowing the pirate chasing you is out of breath is at
   * least as useful as knowing you are.
   */
  function drawStamina(c, p, ox, oy) {
    if (!p.alive || p.stamina === undefined) return;
    const max = staminaMaxFor(p);
    const frac = Math.max(0, Math.min(1, p.stamina / max));
    if (frac >= STAMINA_SHOW_AT && !p.tired) return;

    const x = ox + (p.rx / UNITS_PER_TILE) * TILE_PX + TILE_PX * 0.42;
    const y = oy + (p.ry / UNITS_PER_TILE) * TILE_PX - TILE_PX * 0.1;

    // Fades in over the top quarter of the visible range rather than appearing at a hard edge,
    // which would read as a glitch on the frame it crossed the threshold.
    const appear = Math.min(1, (STAMINA_SHOW_AT - frac) / (STAMINA_SHOW_AT * 0.25));
    const pulse = p.tired ? 0.65 + 0.35 * Math.sin(world.tick / 2.6) : 1;

    c.save();
    c.globalAlpha = Math.max(0, appear) * pulse;

    // A vertical sliver that empties downwards, with the bolt sitting in it.
    const h = TILE_PX * 0.5, w = 3.5;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.beginPath(); c.roundRect(x - w / 2, y - h, w, h, w / 2); c.fill();
    c.fillStyle = p.tired ? '#ff7a5c' : '#ffe04a';
    const fh = Math.max(1.5, h * frac);
    c.beginPath(); c.roundRect(x - w / 2, y - fh, w, fh, w / 2); c.fill();

    // The bolt, so the sliver is identifiable as energy rather than as another health bar.
    c.translate(x + 4.5, y - h - 1.5);
    c.scale(0.42, 0.42);
    c.beginPath();
    c.moveTo(9.5, 0); c.lineTo(3, 9); c.lineTo(7.5, 9);
    c.lineTo(5.5, 17); c.lineTo(12, 7); c.lineTo(7.5, 7);
    c.closePath();
    c.fillStyle = p.tired ? '#ff7a5c' : '#ffe04a';
    c.fill();
    c.restore();
    c.globalAlpha = 1;
  }

  /**
   * Rising pickup labels. Drawn last of the world layer so nothing can cover them, in map
   * space, so they travel with the camera.
   */
  function drawFloaters(ox, oy, dtMs) {
    if (!floaters.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dtMs / 1100;
      if (f.life <= 0) { floaters.splice(i, 1); continue; }
      // Rises fast and then slows: the motion is what catches the eye, the hang is what makes
      // it readable. 1 - life^2 eases out, so most of the travel is in the first third.
      const rise = 26 * (1 - f.life * f.life);
      // Only fades over the last 40%, or it is translucent before you have noticed it.
      ctx.globalAlpha = Math.min(1, f.life / 0.4);
      const x = ox + f.x, y = oy + f.y - rise;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.colour;
      ctx.fillText(f.text, x, y);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  resize();
  return {
    frame, resize, invalidateAll, invalidateTile, mapChanged,
    /**
     * A line of text that floats up off a player and fades.
     *
     * Position is captured ONCE, at the moment it is added, rather than following the player.
     * Text stuck to a moving sprite is unreadable — it is the one thing on screen that has to
     * hold still long enough to be read, and the pickup it describes already happened here.
     */
    addFloater(x, y, text, colour = PALETTE.gold) {
      floaters.push({ x, y, text, colour, life: 1 });
      if (floaters.length > 24) floaters.shift();
    },
    /** @param amount 0..1. Clamped and saturating: ten bombs at once must not throw the camera off. */
    addShake(amount) { shake = Math.min(1, shake + Math.max(0, amount)); },
    addFlash(amount, colour = '255,255,255') { flash = Math.min(1, flash + amount); flashColour = colour; },
    get chunkRedraws() { return redrawsThisSecond; },
  };
}
