// Canvas 2D renderer: cached map chunks, then entities on top.
//
// The map is split into 8x8-tile chunks, each drawn once into its own offscreen canvas and only
// redrawn when a cell inside it changes. Per frame we blit a dozen chunks and draw a handful of
// sprites. Same approach Game of Bombs uses. docs/ARCHITECTURE.md §6.

import {
  TILE_PX, CHUNK_TILES, UNITS_PER_TILE, TRACER_SAMPLES, FUSE_TICKS, FIRE_TICKS, STATUS,
  BLOCK, BLOCK_HP,
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
  let zoom = 1;
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
   * How much of a tile fits on screen.
   *
   * The whole map on screen beats a camera that follows you: on an island you want to see the
   * coast, and a 16-player game is mostly about reading where everyone is. So scale to fit the
   * box the layout gives us, and only fall back to a following camera when even the minimum zoom
   * cannot get the map in.
   *
   * Scaling up snaps to halves and keeps nearest-neighbour, because this is pixel art and a 1.37x
   * nearest-neighbour upscale gives you rows of pixels that are visibly different widths. Scaling
   * down is left unsnapped with smoothing on, where the same artefact reads as aliasing instead.
   */
  function fitZoom(vw, vh) {
    const fit = Math.min(vw / (world.map.w * TILE_PX), vh / (world.map.h * TILE_PX));
    if (fit >= 1) return { z: Math.max(1, Math.floor(fit * 2) / 2), smooth: false };
    return { z: Math.max(0.42, fit), smooth: true };
  }

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;                   // laid out but not measured yet
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    // The transform and the smoothing flag belong to frame(), which recomputes the zoom every
    // frame. Setting them here too would just mean two places to keep in step.
  }
  addEventListener('resize', resize);

  const invalidateAll = () => { chunks = new Map(); shore = null; splashes.length = 0; };

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
  const MAX_SPLASHES = 30;
  function spawnSplash() {
    const edges = shoreline();
    if (!edges.length || splashes.length >= MAX_SPLASHES) return;
    const s = edges[(Math.random() * edges.length) | 0];
    // Push the splash out onto the water side, so it breaks against the rock rather than on it.
    const dx = (s.e & 1 ? 1 : 0) - (s.e & 4 ? 1 : 0);
    const dy = (s.e & 8 ? 1 : 0) - (s.e & 2 ? 1 : 0);
    if (!dx && !dy) return;
    splashes.push({
      x: (s.tx + 0.5 + dx * 0.55) * TILE_PX,
      y: (s.ty + 0.5 + dy * 0.55) * TILE_PX,
      life: 1,
      r: 3 + Math.random() * 4,
      rate: 0.6 + Math.random() * 0.8,
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
    ctx.globalAlpha = 0.5;
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
    if (Math.random() < dtMs / 450) spawnSplash();
    if (!splashes.length) return;
    ctx.save();
    ctx.translate(ox, oy);
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i];
      s.life -= (dtMs / 1000) * s.rate;
      if (s.life <= 0) { splashes.splice(i, 1); continue; }
      // Grows as it fades, like foam spreading out.
      ctx.globalAlpha = s.life * 0.7;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * (2 - s.life), 0, 7);
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
    const dpr = Math.min(2, devicePixelRatio || 1);
    const fit = fitZoom(canvas.clientWidth, canvas.clientHeight);
    zoom = fit.z;
    // Everything below works in world pixels; the transform turns them into device pixels.
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
    ctx.imageSmoothingEnabled = fit.smooth;

    const vw = canvas.clientWidth / zoom, vh = canvas.clientHeight / zoom;
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

    if (flipped || small) {
      c.save();
      c.translate(px + TILE_PX / 2, py + TILE_PX / 2);
      c.scale(small ? 0.55 : 1, (small ? 0.55 : 1) * (flipped ? -1 : 1));
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
    frame, resize, invalidateAll, invalidateTile,
    /** @param amount 0..1. Clamped and saturating: ten bombs at once must not throw the camera off. */
    addShake(amount) { shake = Math.min(1, shake + Math.max(0, amount)); },
    addFlash(amount, colour = '255,255,255') { flash = Math.min(1, flash + amount); flashColour = colour; },
    get chunkRedraws() { return redrawsThisSecond; },
  };
}
