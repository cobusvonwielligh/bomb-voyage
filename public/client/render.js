// Canvas 2D renderer: cached map chunks, then entities on top.
//
// The map is split into 8x8-tile chunks, each drawn once into its own offscreen canvas and only
// redrawn when a cell inside it changes. Per frame we blit a dozen chunks and draw a handful of
// sprites. Same approach Game of Bombs uses. docs/ARCHITECTURE.md §6.

import {
  TILE_PX, CHUNK_TILES, UNITS_PER_TILE, TRACER_SAMPLES, FUSE_TICKS, FIRE_TICKS, STATUS,
  BLOCK, BLOCK_HP, SEA_MARGIN_TILES, SPAWN_POP_TICKS, SPAWN_POP_SCALE,
} from '/shared/constants.js';
import { cellType, cellHp } from '/shared/maps.js';
import {
  drawTile, drawFire, drawPerk, drawRock, playerShades, PALETTE, bake, bakeSea,
} from '/assets/art.js';

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
  let seaT = 0;

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
  function recomputeZoom() {
    if (!world.map || !view.w) return;
    const m = SEA_MARGIN_TILES * 2;
    const fit = Math.min(view.w / ((world.map.w + m) * TILE_PX),
                         view.h / ((world.map.h + m) * TILE_PX));
    // Quantised. An unrounded scale changes by a hair on every layout settle and on every DPR
    // report, and a board that resizes by one part in a thousand reads as jitter. Twentieths are
    // fine enough that nobody sees the step and coarse enough that nothing wobbles.
    const q = Math.max(0.3, Math.round(fit * 20) / 20);
    // Pixel art upscaled by a non-integer factor gets rows of visibly different widths, so snap
    // to halves going up and smooth on the way down, where the same artefact reads as aliasing.
    const z = q >= 1 ? Math.floor(q * 2) / 2 : q;
    if (!Number.isFinite(z) || z <= 0) return;      // never let a bad measurement blank the board
    if (z === view.zoom) return;
    view.zoom = z;
    view.smooth = q < 1;
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
  const DROPS = 220;
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

  /** The current at a point. Two crossed waves plus a constant drift. */
  const flowX = (x, y, t) => Math.sin(y * 0.012 + t * 0.7) * 16 + 7;
  const flowY = (x, y, t) => Math.cos(x * 0.009 - t * 0.5) * 12 + 3;

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
  const MAX_SPLASHES = 10;
  const SPLASH_EVERY_MS = 2000;

  function spawnSplash() {
    const edges = shoreline();
    if (!edges.length || splashes.length >= MAX_SPLASHES) return;
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
      rate: 0.22 + Math.random() * 0.18,       // about four seconds to fade
    });
  }

  function drawSea(vw, vh, ox, oy, dtMs) {
    if (!seaNear) return;
    seaT += dtMs / 1000;

    ctx.fillStyle = PALETTE.seaDeep;
    ctx.fillRect(0, 0, vw, vh);

    // Two layers drifting at different speeds and angles. Parallax between them is the whole
    // reason a flat fill reads as moving water.
    for (const [pattern, sx, sy, alpha] of [[seaNear, 11, 5, 1], [seaFar, -7, 9, 1]]) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate((seaT * sx) % 128, (seaT * sy) % 128);
      ctx.fillStyle = pattern;
      ctx.fillRect(-128, -128, vw + 256, vh + 256);
      ctx.restore();
    }

    // A band of lighter shallows hugging the island, drawn in world space over the open sea.
    ctx.save();
    ctx.translate(ox, oy);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = PALETTE.seaMid;
    for (const s of shoreline()) {
      if (s.e & 1) ctx.fillRect((s.tx + 1) * TILE_PX, s.ty * TILE_PX, TILE_PX, TILE_PX);
      if (s.e & 4) ctx.fillRect((s.tx - 1) * TILE_PX, s.ty * TILE_PX, TILE_PX, TILE_PX);
      if (s.e & 2) ctx.fillRect(s.tx * TILE_PX, (s.ty - 1) * TILE_PX, TILE_PX, TILE_PX);
      if (s.e & 8) ctx.fillRect(s.tx * TILE_PX, (s.ty + 1) * TILE_PX, TILE_PX, TILE_PX);
    }
    ctx.restore();
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
      ctx.globalAlpha = s.life * s.life * 0.3;      // squared, so it fades out early and gently
      ctx.strokeStyle = PALETTE.foam;
      ctx.beginPath();
      ctx.arc(s.x, s.y, spread, 0, 7);
      ctx.stroke();
      ctx.globalAlpha = s.life * s.life * 0.12;
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
    const worldW = world.map.w * TILE_PX, worldH = world.map.h * TILE_PX;

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
    cam.x = worldW <= vw ? (worldW - vw) / 2 : Math.max(0, Math.min(worldW - vw, cam.x));
    cam.y = worldH <= vh ? (worldH - vh) / 2 : Math.max(0, Math.min(worldH - vh, cam.y));

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
    drawDrops(vw, vh, ox, oy, Math.min(0.05, dtMs / 1000));

    const cx0 = Math.floor(cam.x / CHUNK_PX), cx1 = Math.floor((cam.x + vw) / CHUNK_PX);
    const cy0 = Math.floor(cam.y / CHUNK_PX), cy1 = Math.floor((cam.y + vh) / CHUNK_PX);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        ctx.drawImage(chunkAt(cx, cy), ox + cx * CHUNK_PX, oy + cy * CHUNK_PX);

    drawSplashes(ox, oy, dtMs);

    for (const k of world.perks) {
      const bob = Math.sin((world.tick + k.id * 7) / 6) * 2;
      ctx.save();
      ctx.translate(ox + k.tx * TILE_PX, oy + k.ty * TILE_PX);
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
    c.globalAlpha = t * 0.55;
    c.lineWidth = 2 + t * 3;
    c.strokeStyle = k.light;
    c.beginPath();
    c.arc(cx, cy, TILE_PX * (0.4 + (1 - t) * 1.6), 0, 7);
    c.stroke();
    c.globalAlpha = t * 0.25;
    c.fillStyle = k.base;
    c.beginPath();
    c.arc(cx, cy, TILE_PX * 0.5 * pop, 0, 7);
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

    // Arriving. A player who simply appears at full size in a sixteen-player scrum is invisible,
    // so they land huge and collapse to size over about half a second. Cubic ease-out: nearly
    // all of the shrink happens in the first third, which is what makes it read as a landing
    // rather than as a slow zoom.
    let pop = 1;
    if (p.spawnAt !== undefined) {
      const age = (world.tick - p.spawnAt) / SPAWN_POP_TICKS;
      if (age >= 0 && age < 1) pop = 1 + (SPAWN_POP_SCALE - 1) * Math.pow(1 - age, 3);
      else p.spawnAt = undefined;
    }

    if (pop > 1) drawSpawnRing(c, px + TILE_PX / 2, py + TILE_PX / 2, pop, p.i);

    const sx = (small ? 0.55 : 1) * pop;
    const sy = (small ? 0.55 : 1) * pop * (flipped ? -1 : 1);
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

  resize();
  return {
    frame, resize, invalidateAll, invalidateTile, mapChanged,
    /** @param amount 0..1. Clamped and saturating: ten bombs at once must not throw the camera off. */
    addShake(amount) { shake = Math.min(1, shake + Math.max(0, amount)); },
    addFlash(amount, colour = '255,255,255') { flash = Math.min(1, flash + amount); flashColour = colour; },
    get chunkRedraws() { return redrawsThisSecond; },
  };
}
