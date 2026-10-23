// Canvas 2D renderer: cached map chunks, then entities on top.
//
// The map is split into 8x8-tile chunks, each drawn once into its own offscreen canvas and only
// redrawn when a cell inside it changes. Per frame we blit a dozen chunks and draw a handful of
// sprites. Same approach Game of Bombs uses. docs/ARCHITECTURE.md §6.

import {
  TILE_PX, CHUNK_TILES, UNITS_PER_TILE, TRACER_SAMPLES, FUSE_TICKS, FIRE_TICKS, STATUS,
} from '/shared/constants.js';
import { cellType, cellHp } from '/shared/maps.js';
import { BLOCK_HP } from '/shared/constants.js';
import { drawTile, drawFire, drawPerk, playerShades, PALETTE, bake } from '/assets/art.js';

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

  const ensureBaked = () => { baked ??= bake({ playerCount: 16 }); };

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const { clientWidth: w, clientHeight: h } = canvas;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }
  addEventListener('resize', resize);

  const invalidateAll = () => { chunks = new Map(); };

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
      cc.fillStyle = PALETTE.void;
      cc.fillRect(0, 0, CHUNK_PX, CHUNK_PX);
      const map = world.map;
      for (let j = 0; j < CHUNK_TILES; j++) {
        for (let i = 0; i < CHUNK_TILES; i++) {
          const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
          if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
          const byte = map.cells[ty * map.w + tx];
          const type = cellType(byte);
          const maxHp = BLOCK_HP[type] || 0;
          const dmg = maxHp ? 1 - cellHp(byte) / maxHp : 0;
          cc.save();
          cc.translate(i * TILE_PX, j * TILE_PX);
          drawTile(cc, type, tx, ty, dmg);
          cc.restore();
        }
      }
      c.dirty = false;
      redrawsThisSecond++;
    }
    return c.canvas;
  }

  // ─── frame ──────────────────────────────────────────────────────────────────

  function frame(dtMs = 16) {
    if (!world.ready || !world.map) return;
    ensureBaked();

    const me = world.me();
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const worldW = world.map.w * TILE_PX, worldH = world.map.h * TILE_PX;

    // Follow, then clamp so we never show the void outside a small map.
    if (me) {
      const tx = (me.rx / UNITS_PER_TILE) * TILE_PX - vw / 2;
      const ty = (me.ry / UNITS_PER_TILE) * TILE_PX - vh / 2;
      // Time-based, not per-frame: a fixed 0.25 factor makes the camera twice as laggy at
      // 120 Hz as at 60 Hz, which is exactly the kind of thing that reads as "it feels off".
      const k = 1 - Math.exp(-dtMs / 60);
      if (Math.abs(tx - cam.x) > vw || Math.abs(ty - cam.y) > vh) { cam.x = tx; cam.y = ty; }
      else { cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; }
    }
    cam.x = Math.max(0, Math.min(Math.max(0, worldW - vw), cam.x));
    cam.y = Math.max(0, Math.min(Math.max(0, worldH - vh), cam.y));

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

    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, 0, vw, vh);

    const cx0 = Math.floor(cam.x / CHUNK_PX), cx1 = Math.floor((cam.x + vw) / CHUNK_PX);
    const cy0 = Math.floor(cam.y / CHUNK_PX), cy1 = Math.floor((cam.y + vh) / CHUNK_PX);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        ctx.drawImage(chunkAt(cx, cy), ox + cx * CHUNK_PX, oy + cy * CHUNK_PX);

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
      ctx.fillRect(0, 0, vw, vh);
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
