// Canvas 2D renderer: cached map chunks, then entities on top.
//
// The map is split into 8x8-tile chunks, each drawn once into its own offscreen canvas and only
// redrawn when a cell inside it changes. Per frame we blit a dozen chunks and draw a handful of
// sprites. Same approach Game of Bombs uses. docs/ARCHITECTURE.md §6.

import {
  TILE_PX, CHUNK_TILES, UNITS_PER_TILE, TRACER_SAMPLES, FUSE_TICKS, FIRE_TICKS, STATUS,
  BLOCK, BLOCK_HP, SEA_MARGIN_TILES, SPAWN_POP_TICKS, SPAWN_POP_SCALE, MIN_ZOOM, MAX_ZOOM,
  PERK_FADE_TICKS, STAMINA_SHOW_AT, staminaMaxFor, PUDDLE_FADE_TICKS, TICK_MS, TICK_HZ,
  BLOCK_WALKABLE,
} from '/shared/constants.js';
import { cellType, cellHp } from '/shared/maps.js';
import {
  drawTile, drawFire, drawPerk, drawRock, drawShip, playerShades, PALETTE, bake, bakeSea,
  PERK_GLOWS, drawBombLive, CASTS_SHADOW,
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

  /* The sea, set to music — quietly.
   *
   * Two things carry it, and both are meant to be felt from the corner of your eye rather than
   * watched:
   *
   *   the coastal equaliser  the island is the speaker: each stretch of coast is a band, and its
   *                          level lifts a faint bar of light out of the shallows. See
   *                          drawCoastEq.
   *   bioluminescence        cold points of light that drift on the current, twinkle and fade,
   *                          more of them when the top end is busy and a small bloom on every hat
   *                          or snare. On a beat the ones already lit brighten together. See
   *                          drawGlow.
   *
   * Everything that used to PULSE OUTWARD across the surface is gone: bands of swell walking
   * out from the coast, sonar rings sweeping the sea, a tempo wave pushing the current streaks
   * in rings, foam bursting off the rocks on every beat. In a real round, with the equaliser
   * running underneath them, they turned the whole sea into a light show — the wrong thing to
   * be looking at while somebody is trying to blow you up.
   *
   * The rest of the sea barely moves with the music: the surface texture drifts a little faster
   * when the music is busy (flowT) and the water lifts a shade toward the light on the bass. The
   * white flow lines do not listen at all — see drawDrops. `sound` is the listener's analysis, refreshed once a
   * frame and delayed by the output latency so what is drawn lands when it is heard. Music off,
   * every multiplier is 1.
   */
  const CALM = {
    bass: 0, mid: 0, high: 0, level: 0, beat: 0, beats: 0,
    bpm: 0, phase: 0, lock: 0, spark: 0, sparks: 0, tone: 0.5, accent: 0, accents: 0,
    eq: new Float32Array(24),
  };
  let soundOf = null, sound = CALM, lastSparks = 0;
  /* The music as the open sea feels it: the listener's bands and beat, eased again — a fifth of
   * a second to rise, most of a second to fall. The raw beat snaps up and decays in a fifth of a
   * second, and read directly it made everything it touched jump. */
  const mood = { bass: 0, mid: 0, high: 0, level: 0, beat: 0 };
  let eqFor = null, eqCoast = [];            // shoreline tiles with their band, per map
  let eqLen = new Float32Array(24);          // bar lengths per band, in tiles, eased
  // The coastal glow's own clock. Nothing to do with the music any more — see drawCoastEq.
  let eqT = 0;
  let eqBlur = new Float32Array(24);         // the same, blurred across neighbours; what is drawn
  let flowT = 0;                             // the surface texture's clock; see drawSea
  // The vignette, cached against the view size it was built for.
  let vignette = null, vignetteFor = null;
  const glow = [];                           // bioluminescent points; see drawGlow
  let glowSprites = null;                    // pre-drawn soft points, one per tint
  const bombClock = { tick: -1, at: 0 };    // when world.tick last changed; see the bomb loop
  /* How far above quiet a band is, 0..1, LINEARLY.
   *
   * This used to be curved (x^1.5 from 0.35) so the music's usual level barely moved the water.
   * Measured in a real round, that was the whole problem: the in-game music is the ambient beds,
   * whose bands swing between 0.1 and 0.9 — plenty of signal — and the curve turned a 0.5 into
   * 0.11. The sea looked dead. Linear from 0.25 keeps the motion that is actually there. */
  const lifted = v => Math.max(0, Math.min(1, (v - 0.25) / 0.75));
  let drunk = 0;                       // 0..1, eased, so it fades in and out rather than snapping

  /* Where the aim bracket is DRAWN, in tiles, as a float.
   *
   * The tile it is drawn on is not the tile it means. What it means is `bombTile`, which is
   * exact and changes the instant your centre crosses a boundary — and must, because it is
   * where the bomb actually goes. What it looks like is this, which chases that.
   *
   * Keeping them separate is the whole point: the glide is a lie told to the eye only, and the
   * game never consults it. Nothing about aiming gets slower, less precise, or dependent on a
   * frame rate — press the key mid-glide and the bomb lands on the tile the bracket is heading
   * to, not the one it is passing over. */
  let aimTx = 0, aimTy = 0, aimSeen = false;
  // 0..1, the fade-in when the bracket returns after your last bomb detonates.
  let aimIn = 0;
  let depth = null, depthFor = '';     // the depth gradient, rebuilt only when the view changes

  // Sun glints on the open water. Cheap, stateless, and most of what makes a surface read wet.
  const GLINTS = 46;
  const TIPSY_BUBBLES = 7;
  const TIPSY_LIFE_S = 1.3;
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
    pools.clear(); ripples.length = 0; wisps.length = 0; shards.length = 0; pops.length = 0; poolFor = null;
    glow.length = 0; eqFor = null; eqLen.fill(0);
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

/* The sun, which you never see.
 *
 * An actual sun in the corner of a top-down board is a bright thing competing with the fire for
 * the brightest-thing-on-screen slot, and it would have to be somewhere — which on a square
 * board means one of four corners, which means it stops being a choice. What you get instead is
 * everything it implies: one light direction, and every solid thing on the island throwing a
 * shadow the same way.
 *
 * ANGLE 0 to 180 degrees, deterministic in the map name, so a given map always has the same
 * light and nothing has to travel on the wire. Only the upper half: the sun is somewhere
 * overhead and ahead, never behind the camera, so shadows always fall DOWN the screen — a board
 * lit from below reads as though you are looking at it upside down.
 *
 * The length is deliberately short, about two thirds of a tile. Long shadows are prettier and
 * they obscure the floor, and the floor is where you walk.
 */
  const SHADOW_LEN = TILE_PX * 0.62;
  const SHADOW_ALPHA = 0.3;
  let sunFor = null, sun = { dx: 0, dy: 0 };

  function sunVec() {
    const map = world.map;
    if (!map) return sun;
    if (sunFor === map) return sun;
    sunFor = map;
    // Hash the map's identity rather than Math.random(): the sun is part of what a map LOOKS
    // like, and a light that moved every time you loaded the same island would read as a bug.
    let h = 2166136261;
    for (const ch of String(map.id ?? map.name ?? 'map')) {
      h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    }
    const angle = ((h >>> 0) / 4294967295) * Math.PI;   // 0..180 degrees
    sun = { dx: Math.cos(angle) * SHADOW_LEN, dy: Math.sin(angle) * SHADOW_LEN };
    return sun;
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
      const { dx: sdx, dy: sdy } = sunVec();

      /* The shadow pass, first, so every tile paints over its neighbours' shadows.
       *
       * Baked into the chunk rather than drawn per frame: the sun does not move, so a block's
       * shadow is as static as the block is, and a thousand offset rects a frame for something
       * that never changes would be the most expensive thing on screen.
       *
       * It overruns the chunk edge by design. A shadow near the boundary spills into the next
       * chunk and is simply clipped — the neighbouring chunk draws its own, so the only thing
       * lost is the sliver one block casts across the seam. At 0.62 of a tile against an
       * eight-tile chunk, that is a few pixels every sixty-four.
       */
      cc.save();
      cc.globalAlpha = SHADOW_ALPHA;
      cc.fillStyle = '#000';
      for (let j = 0; j < CHUNK_TILES; j++) {
        for (let i = 0; i < CHUNK_TILES; i++) {
          const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
          if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
          const t = cellType(map.cells[ty * map.w + tx]);
          if (!CASTS_SHADOW.has(t)) continue;
          cc.beginPath();
          cc.roundRect(i * TILE_PX + sdx, j * TILE_PX + sdy, TILE_PX, TILE_PX, 3);
          cc.fill();
        }
      }
      cc.restore();

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
  /* Doubled twice, from the original 220.
   *
   * The field was readable but sparse — at any one moment most of the open water had nothing
   * moving in it, so the current was something you inferred rather than saw. At 880 the whole
   * surface is in motion and the eddies round the island and the boulders are visible as
   * shapes rather than as individual streaks.
   *
   * Cost is linear and still small: four sin() per particle per frame, no allocation, no
   * collision, and all of it against a budget that is actually spent on sixteen players and a
   * chain reaction. If this ever needs to come back down, it is one number.
   */
  // A third fewer than the 880 it was: at that density, on a fitted board, the open water read
  // as white noise more than as a current.
  const DROPS = 590;
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
    /* The flow lines do NOT listen to the music.
     *
     * They are the one thing in the sea that says which way the water is going, and they used to
     * stretch with the mids, brighten with the highs, surge on every beat and run on the music's
     * clock — so in a busy passage the whole ocean flickered with them. Now they follow the plain
     * current on the plain clock, and the music lives in the coast and the bioluminescence. */
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

    /* The water round the hull, which the ship did not have and the rocks did — so the rocks
     * were sitting IN the sea and the ship was sitting ON it. Wider than tall and offset down,
     * because a hull displaces water along its length: a circular collar round a boat reads as a
     * buoy. Breathes with the music exactly as much as the rocks' collars do, which is barely:
     * see the note there. */
    // The hull's shadow, cast the same way as everything on the island. Drawn before the wake,
    // so the foam rings sit on top of it rather than under.
    const sv = sunVec();
    ctx.save();
    ctx.globalAlpha = SHADOW_ALPHA * 0.45;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(sv.dx / SHIP_SCALE, 6 + sv.dy / SHIP_SCALE * 0.7, 26, 9, 0, 0, 7);
    ctx.fill();
    ctx.restore();

    const lap = mood.beat * 0.55 + mood.bass * 0.3;
    ctx.save();
    ctx.strokeStyle = PALETTE.foam;
    ctx.globalAlpha = 0.09 + 0.04 * lap;
    ctx.lineWidth = 2.6 + lap * 1.1;
    ctx.beginPath(); ctx.ellipse(0, 7, 30 * (1 + lap * 0.04), 11 * (1 + lap * 0.06), 0, 0, 7); ctx.stroke();
    ctx.globalAlpha = 0.045 + 0.025 * lap;
    ctx.lineWidth = 8 + lap * 3;
    ctx.beginPath(); ctx.ellipse(0, 8, 40, 15, 0, 0, 7); ctx.stroke();
    ctx.restore();
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

      /* The rock's own shadow, on the water, before anything else it draws.
       *
       * Out here it reads less as shade and more as the dark of deep water beside something
       * solid — which is right either way, and it is the thing that stops the boulders looking
       * like decals laid on the surface. Half the strength of the shadows on land, because
       * water scatters light and a hard shadow on it looks like a hole. */
      const sv = sunVec();
      ctx.save();
      ctx.globalAlpha = SHADOW_ALPHA * 0.45;
      ctx.fillStyle = '#000';
      for (const l of k.lumps) {
        ctx.beginPath();
        ctx.ellipse(x + l.dx + sv.dx, y + l.dy + sv.dy * 0.7,
          l.r, l.r * l.squash * 0.8, l.turn, 0, 7);
        ctx.fill();
      }
      ctx.restore();

      /* The water piling up around it, and one of the three places the music still shows.
       *
       * SLIGHT, deliberately. A rock is the only fixed thing in a moving current, so it is
       * where a swell actually reads — but it is also out on the open water where nothing is
       * being played, which is exactly why it can afford to move at all. The whole range is
       * about four hundredths of alpha and a pixel of line width: visible if you watch it,
       * invisible if you are not. */
      const lap = mood.beat * 0.55 + mood.bass * 0.3;
      ctx.globalAlpha = 0.12 + 0.04 * Math.sin(seaT * 1.1 + k.phase) + 0.045 * lap;
      ctx.strokeStyle = PALETTE.foam;
      ctx.lineWidth = 3 + lap * 1.1;
      ctx.beginPath();
      ctx.ellipse(x, y, k.r * (1.25 + lap * 0.04), k.r * (1.05 + lap * 0.04), 0, 0, 7);
      ctx.stroke();
      ctx.globalAlpha = 0.06 + 0.03 * lap;
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.ellipse(x, y, k.r * 1.6, k.r * 1.35, 0, 0, 7);
      ctx.stroke();

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

  /* The island is the speaker.
   *
   * An equaliser built out of the sea itself: the coast is the spectrum, by angle round the
   * island — bass at the bottom, treble at the top, mirrored left and right — and the level
   * there lifts a soft bar of light out of the shallows.
   *
   * Three things make it read as water rather than as a meter, and all three came from it being
   * too jumpy in a real round:
   *
   *   SLOW     the listener eases each band over a quarter of a second up and most of one down,
   *            and the bars ease again here on top of that.
   *   STILL    the coast is cut into short straight runs, each run one band, and a whole run
   *            rises and falls together straight out from its wall. Nothing ever moves ALONG the
   *            coast — an earlier version interpolated between bands and the peaks slid sideways,
   *            which read as the whole shoreline flowing.
   *   FINE     each tile is split into a grid: EQ_SUB blocks outward and two across, small
   *            inset blocks rather than whole-tile slabs. More resolution, far less weight.
   *
   * Additive, dim, with a faint brighter block at the tip, and drawn under the island so a bar
   * reaching into a bay is simply covered by the land. */
  // Twice the blocks of the last pass, spread over twice the reach, each at half the light: the
  // same glow over a larger area, so it reads as a tint on the water rather than as a bar.
  const EQ_MAX = 5;                                     // tiles of reach, at full scale
  const EQ_SUB = 4;                                     // blocks per tile, outward
  // Half of what it was again — 0.15 and a 0.3 cap — at the user's request after a real round.
  const EQ_ALPHA = 0.038, EQ_CAP_ALPHA = 0.07;
  // One band per shade, so a colour never spans two bands.
  const EQ_BANDS = 24;
  const EQ_SHADES = 24;
  const EQ_COLOURS = Array.from({ length: EQ_SHADES }, (_, k) =>
    `hsl(${(205 - k * 2.3) | 0} 55% ${(54 + k * 0.7) | 0}%)`);  // deep blue bass to aqua treble

  /* Bioluminescence.
   *
   * Cold points of light in the water, and the one place the music shows on the open sea. Each
   * is a soft pre-drawn glow (two tints, sea-green and a colder blue), drifting slowly with the
   * real current, fading in, twinkling at its own rate and fading out over two to three and a
   * half seconds. How many there are is the music: a sparse trickle that follows the top and
   * middle of the mix, and on every hat or snare a small bloom of three, staggered, in one spot
   * rather than a scatter. On a beat the ones already lit brighten together, a little.
   *
   * Subtle on purpose. The first version was bright dots that flared and vanished in under a
   * second, a dozen at a time; it read as sparks, and it fought the game for attention. */
  const GLOW_MAX = 70;
  function glowSprite(core, mid, edge) {
    const el = document.createElement('canvas');
    el.width = el.height = 32;
    const g = el.getContext('2d');
    const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    r.addColorStop(0, core); r.addColorStop(0.16, mid); r.addColorStop(0.48, edge);
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, 32, 32);
    return el;
  }

  function spawnGlow(x, y, delay = 0) {
    if (glow.length >= GLOW_MAX) return;
    glow.push({
      x, y, age: -delay,
      span: 2 + Math.random() * 1.5,
      size: 7 + Math.random() * 6,
      peak: 0.11 + Math.random() * 0.1,
      tw: 1.4 + Math.random() * 2.2, ph: Math.random() * Math.PI * 2,     // a slow shimmer, not a flicker
      tint: Math.random() < 0.65 ? 0 : 1,
    });
  }

  /** A point of open water near the coast: one to three and a half tiles out, jittered. */
  function shallowsPoint() {
    const shore = shoreline();
    if (!shore.length) return null;
    const s = shore[(Math.random() * shore.length) | 0];
    const dx = (s.e & 1 ? 1 : 0) - (s.e & 4 ? 1 : 0), dy = (s.e & 8 ? 1 : 0) - (s.e & 2 ? 1 : 0);
    if (!dx && !dy) return null;
    const out = 1 + Math.random() * 2.5;
    return [
      (s.tx + 0.5 + dx * out + (Math.random() - 0.5) * 0.9) * TILE_PX,
      (s.ty + 0.5 + dy * out + (Math.random() - 0.5) * 0.9) * TILE_PX,
    ];
  }

  function feedGlow(dtMs) {
    if (!world.map || !soundOf) return;
    const dt = dtMs / 1000;
    const rate = 0.3 + mood.high * 2 + mood.mid * 0.6;                         // per second
    const n = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
    for (let i = 0; i < n; i++) { const p = shallowsPoint(); if (p) spawnGlow(p[0], p[1]); }
    if (sound.sparks !== lastSparks) {
      lastSparks = sound.sparks;
      const p = shallowsPoint();
      if (p) for (let i = 0; i < 2; i++) {
        spawnGlow(p[0] + (Math.random() - 0.5) * 12, p[1] + (Math.random() - 0.5) * 12, i * 0.12);
      }
    }
  }

  function drawGlow(dtMs) {
    if (!glow.length) return;
    glowSprites ??= [
      glowSprite('rgba(228,255,247,1)', 'rgba(120,240,214,0.5)', 'rgba(40,170,160,0.1)'),
      glowSprite('rgba(224,246,255,1)', 'rgba(120,205,250,0.45)', 'rgba(40,120,200,0.1)'),
    ];
    const dt = dtMs / 1000;
    const lift = 1 + mood.beat * 0.2;
    const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    ctx.globalCompositeOperation = 'lighter';
    for (let i = glow.length - 1; i >= 0; i--) {
      const g = glow[i];
      g.age += dt;
      if (g.age < 0) continue;
      const t = g.age / g.span;
      if (t >= 1) { glow.splice(i, 1); continue; }
      // Carried by the real current, slowly — it is in the water, not on the screen.
      g.x += flowX(g.x, g.y, seaT) * 0.3 * dt;
      g.y += flowY(g.x, g.y, seaT) * 0.3 * dt;
      const a = g.peak * smooth(0, 0.22, t) * (1 - smooth(0.5, 1, t))
        * (0.82 + 0.18 * Math.sin(seaT * g.tw + g.ph)) * lift;
      if (a < 0.01) continue;
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(glowSprites[g.tint], g.x - g.size / 2, g.y - g.size / 2, g.size, g.size);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /**
   * The coast, cut into strips — two per sea-facing tile edge, each half a tile wide — and the
   * strips grouped into RUNS: up to EQ_RUN tiles of one straight wall, facing one way. A whole
   * run takes one band and rises and falls as one, straight out from its wall.
   *
   * Runs, not per-strip heights, because heights read between neighbouring bands made the peaks
   * slide sideways along the shore, and the coast looked like it was flowing. Now nothing moves
   * along the coast at all: every bar only grows and shrinks perpendicular to its wall.
   */
  const EQ_RUN = 4;
  function coastEq() {
    if (eqFor === world.map && eqCoast.length) return eqCoast;
    eqFor = world.map;
    eqCoast = [];
    const S = TILE_PX, step = S / EQ_SUB, half = S / 2;
    const [lx, ly, lw, lh] = landBounds();
    const cx = lx + lw / 2, cy = ly + lh / 2;
    const walls = new Map();          // "dx,dy,line" -> tiles along that line facing that way
    for (const s of shoreline()) {
      for (const [bit, dx, dy] of [[1, 1, 0], [4, -1, 0], [2, 0, -1], [8, 0, 1]]) {
        if (!(s.e & bit)) continue;
        const key = `${dx},${dy},${dx ? s.tx : s.ty}`;
        if (!walls.has(key)) walls.set(key, []);
        walls.get(key).push(s);
      }
    }
    for (const [key, tiles] of walls) {
      const [dx, dy] = key.split(',').map(Number);
      const along = s => (dx ? s.ty : s.tx);
      tiles.sort((a, b) => along(a) - along(b));
      // Contiguous runs along the wall, cut at EQ_RUN tiles.
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const mx = run.reduce((t, s) => t + s.tx, 0) / run.length + 0.5 + dx * 0.5;
        const my = run.reduce((t, s) => t + s.ty, 0) / run.length + 0.5 + dy * 0.5;
        const pos = Math.abs(Math.atan2(mx - cx, my - cy)) / Math.PI;   // 0 below, 1 above
        for (const s of run) {
          for (let h = 0; h < 2; h++) {
            eqCoast.push({
              x: dx > 0 ? (s.tx + 1) * S : dx < 0 ? s.tx * S - step : s.tx * S + h * half,
              y: dy > 0 ? (s.ty + 1) * S : dy < 0 ? s.ty * S - step : s.ty * S + h * half,
              sx: dx * step, sy: dy * step,
              w: dx ? step : half, h: dy ? step : half,
              pos, shade: Math.min(EQ_SHADES - 1, (pos * EQ_SHADES) | 0),
            });
          }
        }
        run = [];
      };
      for (const s of tiles) {
        if (run.length && (along(s) !== along(run[run.length - 1]) + 1 || run.length >= EQ_RUN)) flush();
        run.push(s);
      }
      flush();
    }
    eqCoast.sort((a, b) => a.shade - b.shade);         // one fillStyle change per shade
    return eqCoast;
  }

  /* The coast glows, and it has STOPPED LISTENING.
   *
   * The picture is the one that worked — the island as a spectrum by angle, quarter-tile blocks
   * stepping out of the shallows, deep blue at the bass end running to aqua at the treble end.
   * What has gone is what was driving it.
   *
   * It was the loudest reactive thing on the board and it was in the wrong place: the coast
   * wraps the entire playfield, so a visualiser living there is one you cannot look away from
   * while you are trying to play. The music moves three quieter things instead, all at the edge
   * of attention — the mascot's bob, the rings round the boat and the rocks, and the vignette.
   *
   * So this is a standing wave now. Three sines per band on periods that do not divide into
   * each other, so the pattern never visibly repeats, plus a slow travelling term that walks the
   * whole shape round the island. Deterministic, allocation-free, three sin() per band on
   * twenty-four bands — and it breathes at the same gentle rate whether anything is playing or
   * not, which is what a coastline should do.
   */
  function drawCoastEq(dtMs) {
    const n = EQ_BANDS;
    if (eqLen.length !== n) { eqLen = new Float32Array(n); eqBlur = new Float32Array(n); }
    eqT += dtMs / 1000;
    for (let b = 0; b < n; b++) {
      const p = b / n;
      const w = Math.sin(eqT * 0.21 + p * 6.1)
        + Math.sin(eqT * 0.13 - p * 9.7) * 0.7
        + Math.sin(eqT * 0.072 + p * 3.3) * 0.5;
      eqLen[b] = Math.max(0, w / 2.2 + 0.52) * EQ_MAX;
    }
    // One gentle blur across neighbouring bands, so no band stands up on its own like a post.
    let prev = eqLen[0];
    for (let b = 0; b < n; b++) {
      const cur = eqLen[b], next = eqLen[Math.min(n - 1, b + 1)];
      eqBlur[b] = prev * 0.25 + cur * 0.5 + next * 0.25;
      prev = cur;
    }
    let any = false;
    for (let b = 0; b < n; b++) if (eqBlur[b] > 0.04) { any = true; break; }
    if (!any) return;

    ctx.globalCompositeOperation = 'lighter';
    let shade = -1;
    const deepest = EQ_MAX * EQ_SUB;
    for (const c of coastEq()) {
      // The run's own band — one height for the whole run, so nothing slides along the coast.
      const L = eqBlur[Math.min(n - 1, Math.round(c.pos * (n - 1)))] * EQ_SUB;   // in blocks
      if (L < 0.15) continue;
      if (c.shade !== shade) { shade = c.shade; ctx.fillStyle = EQ_COLOURS[shade]; }
      const blocks = Math.ceil(L);
      for (let i = 0; i < blocks; i++) {
        const frac = Math.min(1, L - i);
        const x = c.x + c.sx * i, y = c.y + c.sy * i;
        ctx.globalAlpha = EQ_ALPHA * frac * (1 - i / (deepest + 3));
        ctx.fillRect(x + 1, y + 1, c.w - 2, c.h - 2);
        if (i === blocks - 1) {
          // The tip: one faintly brighter block where the bar ends.
          ctx.globalAlpha = EQ_CAP_ALPHA * frac;
          ctx.fillRect(x + 1, y + 1, c.w - 2, c.h - 2);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function drawSea(vw, vh, ox, oy, dtMs) {
    if (!seaNear) return;
    seaT += dtMs / 1000;
    // The music's clock and push. See `sound` at the top of the renderer.
    // The surface texture drifts a touch faster when the music is busy. A touch.
    flowT += (dtMs / 1000) * (1 + mood.level * 0.25);

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
      ctx.translate((flowT * d.sx) % 128, (flowT * d.sy) % 128);
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
    /* The water lifts toward the light on the bass, and flashes on the beat.
     *
     * One translucent wash over the whole sea, under everything floating on it. The depth
     * gradient means it reads as the swell rising rather than as the screen flashing. */
    // Tinted by the brightness of the mix: dark, bass-heavy passages pull the water toward deep
    // indigo, bright ones toward teal. Slow — `tone` has a 700 ms release — so it reads as the
    // light changing over the sea, never as a flash.
    const lift = mood.bass * 0.018 + mood.beat * 0.006;
    if (lift > 0.004) {
      const t = sound.tone;
      ctx.fillStyle = `rgba(${(52 - 22 * t) | 0},${(92 + 70 * t) | 0},${(196 - 14 * t) | 0},${lift})`;
      ctx.fillRect(0, 0, vw, vh);
    }

    ctx.save();
    ctx.fillStyle = '#dff0ff';
    // Sun glints. Not driven by the music any more: the top end now lights the bioluminescence,
    // and two sparkling things answering the same hi-hat was one too many.
    const glints = GLINTS;
    const shine = 0.5;
    for (let i = 0; i < glints; i++) {
      const epoch = Math.floor(seaT / GLINT_LIFE_S + i * 0.37);
      const f = (seaT / GLINT_LIFE_S + i * 0.37) % 1;
      const hx = hash01(i * 7919 + epoch * 104729);
      const hy = hash01(i * 7919 + epoch * 104729 + 1);
      // A short rise and a long fall, so they twinkle out rather than blinking off.
      const life = f < 0.25 ? f / 0.25 : 1 - (f - 0.25) / 0.75;
      ctx.globalAlpha = Math.min(1, life * shine);
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
    /** One row of sea, exactly `n` tiles out from the rock all the way round. */
    const shelfRow = (n, alpha) => {
      if (n < 1 || alpha < 0.004) return;
      ctx.globalAlpha = alpha;
      for (const s of shoreline()) {
        if (s.e & 1) ctx.fillRect((s.tx + n) * TILE_PX, s.ty * TILE_PX, TILE_PX, TILE_PX);
        if (s.e & 4) ctx.fillRect((s.tx - n) * TILE_PX, s.ty * TILE_PX, TILE_PX, TILE_PX);
        if (s.e & 2) ctx.fillRect(s.tx * TILE_PX, (s.ty - n) * TILE_PX, TILE_PX, TILE_PX);
        if (s.e & 8) ctx.fillRect(s.tx * TILE_PX, (s.ty + n) * TILE_PX, TILE_PX, TILE_PX);
      }
    };

    // Both bands breathe with the bass: the shallows glow on the kick.
    // The shallows breathe very slightly with the bass.
    const kickLift = mood.bass * 0.5;
    shelf(2, 0.16 * (1 + kickLift * 0.4), PALETTE.seaMid);      // the outer, deeper step
    shelf(1, 0.42 * (1 + kickLift * 0.15), PALETTE.seaLight);

    drawCoastEq(dtMs);

    drawGlow(dtMs);

    /* No caustics.
     *
     * There was a ring of rotated ellipses pulsing along the coast here, meant to read as light
     * reaching the bottom in the shallows. It did not: at one tile across and on a grid, a
     * repeating ellipse per shore tile reads as a row of ellipses, and once you have seen it as
     * a row of ellipses you cannot see it as water again. The two shelf bands above do the same
     * job — depth against the rock — without drawing a shape the eye can name.
     */
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

  // ─── melted ice ─────────────────────────────────────────────────────────────

  /* Puddles, drawn as one pool rather than five squares.
   *
   * Each wet tile contributes three overlapping ellipses, and every tile's ellipses go into the
   * SAME path, so neighbours fuse into one body of water with an organic edge instead of a plus
   * sign of tiles. That union is drawn opaque into its own layer — rim, body, sheen — and the
   * layer goes onto the board at partial alpha once, so overlaps never double up into darker
   * patches.
   *
   * Presence is eased, not read off the tick. `vis` chases 1 while the puddle is fresh and
   * chases its remaining life over the last PUDDLE_FADE_TICKS, so a puddle swells in fast and
   * dries slowly from the edges inward, steaming as it goes — and it carries on drying for a
   * moment after the simulation has dropped it, which is what makes the end look like
   * evaporation rather than a delete. Pure presentation: the sim already stopped being wet.
   */
  const pools = new Map();         // "tx,ty" -> { tx, ty, vis, target, seed }
  const ripples = [];              // rings on the water: rain-like idle ones, footsteps, the melt
  const wisps = [];                // steam off a drying puddle
  const shards = [];               // ice flying off a melt
  const pops = [];                 // the bright burst at the moment of melting
  let poolLayer = null, poolCtx = null, poolFor = null;
  let wetFloor = null;             // Path2D of walkable tiles round the puddles; see drawPuddles

  const POOL_RIM = '#9fcfe6', POOL_BODY = '#2a6c9e', POOL_SHEEN = '#3580b6';

  /**
   * One wet tile's share of the pool, plus a bridge to each wet neighbour right and below.
   *
   * The bridges are what make it a pool. Blobs sized to stay inside their own tile leave a waist
   * between neighbours where the rim shows through, and five tiles read as five balloons; blobs
   * sized to overlap without bridges bulge past the plus into the corners. A bridge at the shared
   * edge, as thick as the thinner of the two, fills the waist and nothing else.
   */
  function poolBlobs(c, fx, scale, sx, sy, t) {
    const S = TILE_PX;
    const grow = 0.3 + 0.7 * fx.vis;
    const wob = Math.sin(t * 1.6 + fx.seed * 6.28) * 0.7;
    const cx = fx.tx * S + S / 2 + sx, cy = fx.ty * S + S / 2 + sy;
    for (let k = 0; k < 3; k++) {
      const a = fx.seed * 9 + k * 2.1;
      const ex = cx + Math.cos(a) * 3 * grow, ey = cy + Math.sin(a) * 2.5 * grow;
      const rx = (S * (0.64 - k * 0.06) + wob) * scale * grow;
      const ry = rx * (0.84 + 0.1 * Math.sin(a * 1.3));
      c.moveTo(ex + rx, ey);
      c.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
    }
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const n = pools.get(`${fx.tx + dx},${fx.ty + dy}`);
      if (!n) continue;
      const g = 0.3 + 0.7 * Math.min(fx.vis, n.vis);
      const along = S * 0.62 * scale * g, across = S * 0.5 * scale * g;
      const mx = cx + (dx * S) / 2, my = cy + (dy * S) / 2;
      const rx = dx ? along : across, ry = dx ? across : along;
      c.moveTo(mx + rx, my);
      c.ellipse(mx, my, rx, ry, 0, 0, Math.PI * 2);
    }
  }

  function drawPuddles(ox, oy, dtMs) {
    const dt = dtMs / 1000;
    const live = new Set();
    for (const q of world.puddles) {
      if (q.until <= world.tick) continue;
      const key = `${q.tx},${q.ty}`;
      live.add(key);
      let fx = pools.get(key);
      if (!fx) pools.set(key, fx = { tx: q.tx, ty: q.ty, vis: 0, target: 1, seed: hash01(q.tx * 977 + q.ty * 131) });
      const left = q.until - world.tick;
      fx.target = left >= PUDDLE_FADE_TICKS ? 1 : Math.max(0, left / PUDDLE_FADE_TICKS);
    }
    for (const [key, fx] of pools) {
      if (!live.has(key)) fx.target = 0;
      // In fast, out slow: a splash arrives, a puddle evaporates.
      const tau = fx.target > fx.vis ? 90 : 320;
      fx.vis += (fx.target - fx.vis) * (1 - Math.exp(-dtMs / tau));
      if (fx.target === 0 && fx.vis < 0.03) { pools.delete(key); continue; }

      // Idle ripples, and steam once it starts drying.
      if (fx.vis > 0.5 && ripples.length < 18 && Math.random() < dtMs / 900) {
        ripples.push({ x: fx.tx * TILE_PX + 6 + Math.random() * 20, y: fx.ty * TILE_PX + 6 + Math.random() * 20,
          life: 1, max: 4 + Math.random() * 5, rate: 1.1, w: 1 });
      }
      if (fx.target < 1 && fx.vis > 0.08 && wisps.length < 48 && Math.random() < dtMs / 160) {
        wisps.push({ x: fx.tx * TILE_PX + 5 + Math.random() * 22, y: fx.ty * TILE_PX + 8 + Math.random() * 18,
          life: 1, ph: Math.random() * 6.28 });
      }
    }

    // Wading. A ring at the feet of anyone moving through water, so you can see who is slowed.
    if (pools.size) {
      for (const p of world.players) {
        if (!p || !p.alive || !p.moving || ripples.length >= 24) continue;
        const tx = (p.rx ?? p.x) >> 8, ty = (p.ry ?? p.y) >> 8;
        if (!pools.has(`${tx},${ty}`) || Math.random() > dtMs / 110) continue;
        ripples.push({ x: ((p.rx ?? p.x) / UNITS_PER_TILE) * TILE_PX, y: ((p.ry ?? p.y) / UNITS_PER_TILE) * TILE_PX + 9,
          life: 1, max: 7, rate: 1.6, w: 1.2 });
      }
    }

    if (!pools.size && !ripples.length && !wisps.length && !shards.length && !pops.length) return;

    if (pools.size) {
      const map = world.map, S = TILE_PX;
      if (poolFor !== map) {
        poolLayer = document.createElement('canvas');
        poolLayer.width = map.w * S; poolLayer.height = map.h * S;
        poolCtx = poolLayer.getContext('2d');
        poolFor = map;
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const fx of pools.values()) {
        x0 = Math.min(x0, fx.tx); y0 = Math.min(y0, fx.ty);
        x1 = Math.max(x1, fx.tx); y1 = Math.max(y1, fx.ty);
      }
      const bx = Math.max(0, (x0 - 1) * S), by = Math.max(0, (y0 - 1) * S);
      const bw = Math.min(poolLayer.width, (x1 + 2) * S) - bx, bh = Math.min(poolLayer.height, (y1 + 2) * S) - by;

      /* Water stays on the floor.
       *
       * Each wet tile's blobs reach a few pixels past its edges — that bulge is what fuses
       * neighbours into one pool with an organic outline — but drawn unclipped it also spilled
       * across every wall beside the puddle, so a puddle in a corridor painted water over the
       * rock on both sides of it. So the pool, its glints and its ripples are clipped to the
       * walkable tiles round it: water can spread onto open floor and stops dead at anything
       * solid, the way it would. */
      wetFloor = new Path2D();
      for (let ty = y0 - 1; ty <= y1 + 1; ty++) {
        for (let tx = x0 - 1; tx <= x1 + 1; tx++) {
          if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
          if (BLOCK_WALKABLE(cellType(map.cells[ty * map.w + tx]), false)) wetFloor.rect(tx * S, ty * S, S, S);
        }
      }

      const pc = poolCtx;
      pc.clearRect(bx, by, bw, bh);
      pc.save();
      pc.clip(wetFloor);
      // Rim, body, then a sheen lifted toward the top-left light.
      for (const [scale, colour, sx, sy] of [[1, POOL_RIM, 0, 0], [0.9, POOL_BODY, 0, 0], [0.62, POOL_SHEEN, -2, -2]]) {
        pc.fillStyle = colour;
        pc.beginPath();
        for (const fx of pools.values()) poolBlobs(pc, fx, scale, sx, sy, seaT);
        pc.fill();
      }
      pc.restore();
      ctx.globalAlpha = 0.64;
      ctx.drawImage(poolLayer, bx, by, bw, bh, ox + bx, oy + by, bw, bh);

      // Light on the water: two small glints per puddle, circling slowly and breathing.
      ctx.save();
      ctx.translate(ox, oy);
      ctx.clip(wetFloor);
      ctx.fillStyle = '#ffffff';
      for (const fx of pools.values()) {
        if (fx.vis < 0.25) continue;
        for (let k = 0; k < 2; k++) {
          const a = seaT * 0.7 + fx.seed * 10 + k * 3.1;
          const gx = fx.tx * S + S / 2 - 3 + Math.cos(a) * 6 * fx.vis;
          const gy = fx.ty * S + S / 2 - 3 + Math.sin(a) * 4 * fx.vis;
          ctx.globalAlpha = 0.4 * fx.vis * (0.45 + 0.55 * Math.sin(seaT * 2.6 + fx.seed * 20 + k * 2));
          if (ctx.globalAlpha <= 0.01) continue;
          ctx.beginPath(); ctx.ellipse(gx, gy, 2.6, 1.1, -0.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.translate(ox, oy);

    for (let i = pops.length - 1; i >= 0; i--) {
      const b = pops[i];
      b.life -= dt / 0.28;
      if (b.life <= 0) { pops.splice(i, 1); continue; }
      ctx.globalAlpha = b.life * b.life * 0.5;
      ctx.fillStyle = '#e9f8ff';
      ctx.beginPath(); ctx.arc(b.x, b.y, TILE_PX * (0.45 + (1 - b.life) * 0.5), 0, Math.PI * 2); ctx.fill();
    }

    // Rings on the water stay on the water too (see wetFloor above) — while there is any.
    ctx.save();
    if (pools.size && wetFloor) ctx.clip(wetFloor);
    ctx.strokeStyle = '#d8f1ff';
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.life -= dt * r.rate;
      if (r.life <= 0) { ripples.splice(i, 1); continue; }
      ctx.globalAlpha = r.life * r.life * 0.55;
      ctx.lineWidth = r.w;
      ctx.beginPath(); ctx.ellipse(r.x, r.y, 1.5 + (1 - r.life) * r.max, (1.5 + (1 - r.life) * r.max) * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = '#e6f4fb';
    for (let i = wisps.length - 1; i >= 0; i--) {
      const s = wisps[i];
      s.life -= dt / 1.2;
      if (s.life <= 0) { wisps.splice(i, 1); continue; }
      const up = (1 - s.life) * 16;
      ctx.globalAlpha = Math.sin(s.life * Math.PI) * 0.22;     // in and out, never a pop
      ctx.beginPath();
      ctx.arc(s.x + Math.sin(s.ph + up * 0.3) * 2.5, s.y - up, 1.8 + (1 - s.life) * 4, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.life -= dt / s.span;
      if (s.life <= 0) { shards.splice(i, 1); continue; }
      const drag = Math.exp(-dt * 5);
      s.vx *= drag; s.vy *= drag;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.rot += s.vr * dt;
      ctx.globalAlpha = Math.min(1, s.life * 1.6);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.beginPath();
      ctx.moveTo(0, -s.size); ctx.lineTo(s.size * 0.55, 0); ctx.lineTo(0, s.size); ctx.lineTo(-s.size * 0.55, 0);
      ctx.closePath();
      ctx.fillStyle = '#cdeefc'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Ice breaking: a flash, a ring of meltwater pushing out, and shards thrown off it. */
  function addMelt(tx, ty) {
    const x = tx * TILE_PX + TILE_PX / 2, y = ty * TILE_PX + TILE_PX / 2;
    pops.push({ x, y, life: 1 });
    ripples.push({ x, y, life: 1, max: TILE_PX * 0.9, rate: 1.4, w: 2.2 });
    ripples.push({ x, y, life: 1, max: TILE_PX * 0.5, rate: 1.9, w: 1.4 });
    for (let i = 0; i < 12 && shards.length < 60; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
      const v = 60 + Math.random() * 90;
      shards.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: a, vr: (Math.random() * 2 - 1) * 9,
        size: 2 + Math.random() * 2.5, life: 1, span: 0.45 + Math.random() * 0.3 });
    }
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

    // Listen before drawing a single wave, so everything this frame hears the same instant.
    sound = soundOf ? soundOf(dtMs) : CALM;
    // And smoothed once more, here, for everything on the open sea. See mood.
    {
      const up = 1 - Math.exp(-dtMs / 180), down = 1 - Math.exp(-dtMs / 700);
      const glide = (key, v) => { mood[key] += (v - mood[key]) * (v > mood[key] ? up : down); };
      glide('bass', lifted(sound.bass)); glide('mid', lifted(sound.mid));
      glide('high', lifted(sound.high)); glide('level', lifted(sound.level));
      glide('beat', sound.beat);
    }

    feedGlow(dtMs);

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
    // On the floor, under the perks, bombs and everybody standing in it.
    drawPuddles(ox, oy, dtMs);

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

    /* Bombs, counting down in real time.
     *
     * A bomb bursts on the client when `world.tick` reaches its `at` — and `world.tick` only moves
     * when a snapshot lands, two ticks at a time. Reading it directly would step the countdown 15
     * times a second. So the time left is measured against that same tick, carried forward
     * smoothly by the time since it last changed and capped just short of the next one: the ring
     * and the fuse run continuously and still reach zero on the frame the blast appears. */
    if (world.tick !== bombClock.tick) { bombClock.tick = world.tick; bombClock.at = performance.now(); }
    const tickNow = world.tick + Math.min(1.95, (performance.now() - bombClock.at) / TICK_MS);
    for (const b of world.bombs) {
      const owner = (b.o ?? b.owner) % 16;
      ctx.save();
      ctx.translate(ox + b.tx * TILE_PX, oy + b.ty * TILE_PX);
      drawBombLive(ctx, baked.bombs[owner], {
        leftS: Math.max(0, b.at - tickNow) / TICK_HZ,
        fullS: FUSE_TICKS / TICK_HZ,
        colorIndex: owner,
        t: seaT + b.id * 0.37,
      });
      ctx.restore();
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
    /* Every shadow before every player, not a shadow-then-player pair each.
     *
     * Two passes, because with one pass a player standing below another would paint over the
     * other's shadow — and a shadow that disappears when somebody walks past it is worse than
     * no shadow. All the shadows belong to the floor; all the players stand on top of them. */
    drawSunShadows(alive, ox, oy);
    for (const p of alive) drawOne(ctx, p, ox, oy, p.i === world.you);

    drawAim(ox, oy, dtMs);
    for (const p of alive) drawTipsy(ctx, p, ox, oy);
    for (const p of alive) drawStamina(ctx, p, ox, oy);
    drawFloaters(ox, oy, dtMs);

    /* A vignette that breathes with the music, drawn last so it sits over everything.
     *
     * Two jobs at once, which is why it earns the fill. Flat, it does what every vignette does:
     * darkens the corners so the eye goes to the middle, where you are. Breathing, it is the
     * only reactive thing on screen that touches the WHOLE frame — the coast glows and the
     * shallows light, but all of that is out at the edges and none of it reaches the board. A
     * kick squeezes the picture very slightly, everywhere.
     *
     * Deliberately tiny. The range is 0.30 to about 0.40 of a corner that is already dark, which
     * is at the edge of noticeable in a still frame and the right amount while moving — the
     * ailure mode of a reactive vignette is a screen that pumps, and a pumping screen in a game
     * you are trying to read is unplayable.
     *
     * Cached per view: a radial gradient is cheap but not free, and this one only changes when
     * the board is resized.
     */
    const squeeze = mood.beat * 0.11 + mood.bass * 0.06;
    if (vignetteFor !== `${vw}x${vh}`) {
      vignetteFor = `${vw}x${vh}`;
      const vg = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.34,
        vw / 2, vh / 2, Math.max(vw, vh) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(0.65, 'rgba(4,7,12,0.22)');
      vg.addColorStop(1, 'rgba(2,4,8,0.62)');
      vignette = vg;
    }
    ctx.globalAlpha = 0.8 + squeeze * 0.45;
    ctx.fillStyle = vignette;
    ctx.fillRect(-4, -4, vw + 8, vh + 8);
    ctx.globalAlpha = 1;

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

  /* Players, in the sun. The rocks and the boat get theirs where they are drawn.
   *
   * The silhouette is baked (see `playerShadows` in art.js) and simply blitted at the sun's
   * offset — no filter, no per-frame compositing, one drawImage each. Squashed vertically on
   * the way down, because a shadow on the ground is a projection of an upright thing and an
   * unsquashed copy reads as a second player lying underneath the first.
   */
  function drawSunShadows(alive, ox, oy) {
    const set = baked.playerShadows;
    if (!set || !set.length) return;
    const { dx, dy } = sunVec();
    ctx.save();
    ctx.globalAlpha = SHADOW_ALPHA * 0.8;
    for (const p of alive) {
      if (!p.alive) continue;
      if ((p.status & STATUS.INVISIBLE) && p.i !== world.you) continue;
      const frame = p.moving ? ((world.tick >> 2) & 1) : 0;
      const img = set[p.dir * 2 + frame];
      if (!img) continue;
      const px = ox + (p.rx / UNITS_PER_TILE) * TILE_PX - TILE_PX / 2;
      const py = oy + (p.ry / UNITS_PER_TILE) * TILE_PX - TILE_PX / 2;
      ctx.save();
      // Anchored at the feet — a shadow is attached to where the thing touches the ground, so
      // the squash has to happen about that point rather than about the sprite's middle.
      ctx.translate(px + dx, py + TILE_PX * 0.72 + dy);
      ctx.scale(1, 0.55);
      ctx.drawImage(img, 0, -TILE_PX * 0.72);
      ctx.restore();
    }
    ctx.restore();
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
   * Bubbles off a drunk. Theirs alone — it is a status on one player, and the only way to see
   * at a glance which of sixteen pirates has been at the rum.
   *
   * Stateless, like the sun glints: position and life come from a hash of the bubble's index
   * and a slowly advancing epoch, so each one rises for its whole short life and a new one
   * starts somewhere else. No arrays, no allocation, nothing to clean up when a player dies.
   */
  function drawTipsy(c, p, ox, oy) {
    if (!(p.status & STATUS.DRUNK) || !p.alive) return;
    const bx = ox + (p.rx / UNITS_PER_TILE) * TILE_PX;
    const by = oy + (p.ry / UNITS_PER_TILE) * TILE_PX;

    c.save();
    for (let i = 0; i < TIPSY_BUBBLES; i++) {
      const phase = seaT / TIPSY_LIFE_S + i * 0.41 + p.i * 0.17;
      const epoch = Math.floor(phase);
      const f = phase % 1;
      const seed = i * 2654 + epoch * 7919 + p.i * 31;
      // Drifting up and sideways, wider as it rises, the way a bubble actually goes.
      const rise = 6 + f * 22;
      const sway = Math.sin(f * 4 + seed) * (2 + f * 5);
      const r = 1.1 + hash01(seed) * 1.8;
      c.globalAlpha = (1 - f) * 0.5;
      c.fillStyle = '#cfe7f5';
      c.beginPath();
      c.arc(bx + sway + (hash01(seed + 1) - 0.5) * 10, by - rise, r, 0, 7);
      c.fill();
      // A highlight on the bigger ones, which is what makes a dot read as a bubble.
      if (r > 2) {
        c.globalAlpha = (1 - f) * 0.7;
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(bx + sway + (hash01(seed + 1) - 0.5) * 10 - r * 0.3, by - rise - r * 0.3, r * 0.35, 0, 7);
        c.fill();
      }
    }
    c.restore();
    c.globalAlpha = 1;
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
  function drawAim(ox, oy, dtMs) {
    const me = world.me();
    if (!me || !me.alive || world.observing) { aimSeen = false; return; }
    const { tx, ty } = bombTile(world, me);
    // Nothing to show if you are out of bombs: a sight on a shot you cannot take is a lie.
    const live = world.bombs.reduce((n, b) => n + ((b.o ?? b.owner) === world.you ? 1 : 0), 0);
    if (live >= me.bombs) { aimSeen = false; aimIn = 0; return; }

    /* Fade in when it comes back.
     *
     * The bracket vanishes the instant you place your last bomb and reappears the instant that
     * bomb goes off — which is a hard pop in the corner of your eye at the exact moment the
     * screen is already full of fire. Easing it in over about a sixth of a second turns an
     * event into an arrival.
     *
     * In only. Going OUT stays instant, and that asymmetry is deliberate: the bracket
     * disappearing is information — you have no bombs — and information must never lag. */
    aimIn += (1 - aimIn) * (1 - Math.pow(1 - 0.22, (dtMs || 16) / 16.7));
    if (aimIn < 0.02) return;

    /* Chase the target tile instead of appearing on it.
     *
     * Exponential approach on real elapsed time, not a fixed step per frame, so it looks the
     * same at 60 and at 144 Hz. AIM_TAU_MS is the time constant: about three frames at 60 Hz,
     * which is enough to read as a movement and short enough that the bracket has arrived
     * before you could have pressed the key. Longer than this and it stops being a flourish
     * and starts being a question about where your bomb is going.
     *
     * Two cases skip the glide entirely:
     *   - the first frame it is shown, or it slides in from wherever it was last round;
     *   - a jump of more than two tiles, which is a respawn, a map change or a camera cut, and
     *     a bracket sailing across the whole board is a bug with an animation on it.
     */
    const AIM_TAU_MS = 52, AIM_SNAP_TILES = 2;
    if (!aimSeen || Math.abs(tx - aimTx) > AIM_SNAP_TILES || Math.abs(ty - aimTy) > AIM_SNAP_TILES) {
      aimTx = tx; aimTy = ty; aimSeen = true;
    } else {
      const a = 1 - Math.exp(-(dtMs || 16) / AIM_TAU_MS);
      aimTx += (tx - aimTx) * a;
      aimTy += (ty - aimTy) * a;
      // Below a thousandth of a tile it is on the target for drawing purposes, and leaving it
      // asymptotic forever means the brackets sit a fraction of a pixel off true for good.
      if (Math.abs(tx - aimTx) < 0.001) aimTx = tx;
      if (Math.abs(ty - aimTy) < 0.001) aimTy = ty;
    }

    const k = playerShades(world.you);
    const x = ox + aimTx * TILE_PX, y = oy + aimTy * TILE_PX;
    // How far it still has to go, 0 at rest. Used to lean into the move below.
    const travel = Math.min(1, Math.hypot(tx - aimTx, ty - aimTy));
    // Brighter while it is moving, so the glide reads as intent rather than as lag, and the
    // resting pulse is what you see the other 99% of the time. Multiplied by the fade, so the
    // whole bracket arrives together rather than one layer at a time.
    const pulse = Math.min(1, 0.55 + 0.25 * Math.sin(world.tick / 7) + travel * 0.45) * aimIn;
    // The arms pull IN as it travels and spring back out when it lands — the same trick a
    // camera reticle uses, and it is what makes a 50 ms move feel deliberate.
    const arm = TILE_PX * (0.3 - 0.1 * travel), inset = 3 + travel * 2;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A dark pass underneath, so the bracket survives being drawn over pale sand or bright fire.
    // The dark backing pass fades in with the rest, or the outline arrives before the bracket.
    for (const [colour, width, alpha] of [['#0b0f16', 4, 0.5 * aimIn], [k.light, 2, pulse]]) {
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
    frame, resize, invalidateAll, invalidateTile, mapChanged, addMelt,
    /** Where the sea gets its music from: `dtMs => analysis`, called once a frame. */
    setSound(fn) { soundOf = fn; },
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
