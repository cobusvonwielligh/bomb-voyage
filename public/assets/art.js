// Bomb Voyage — art. Shapes, not pixels. No image files anywhere in this project.
//
// Slice: ART. This is a working starter, not finished art — it exists so you can see the style,
// check readability, and iterate in public/art-preview.html before the game exists.
// Read docs/ART-AUDIO.md first.
//
// Rules that keep it coherent:
//   1. Readable as a silhouette.
//   2. One light direction: top-left.
//   3. Terrain is muted; players are the only saturated things on screen.

// `/shared` is mounted by the dev server alongside `public/` — see docs/ARCHITECTURE.md §7.
import { BLOCK, TILE_PX, playerHueSlot } from '/shared/constants.js';

export const PALETTE = {
  void: '#0d1117',
  floor: '#2c3442', floorAccent: '#333d4d',
  soft: '#8a6b4a', reinforced: '#6f7785', monolith: '#4b5362',
  iron: '#262c38', column: '#59627a', shrub: '#3f6b46',
  outline: '#161b24',
  fireCore: '#fff4c2', fireMid: '#ff9b3d', fireEdge: '#e63f27',
  gold: '#ffd21f', text: '#e8eef7',
};

/** 16 maximally distinct player colours, plus their light/dark shades. Slots come from
 *  shared/constants.js so the sim, the HUD and the art never disagree about who is what colour. */
export const playerShades = i => {
  const slot = playerHueSlot(i), h = slot * 22.5, l = slot % 2 ? 52 : 64;
  return {
    light: `hsl(${h} 74% ${l + 14}%)`,
    base: `hsl(${h} 74% ${l}%)`,
    dark: `hsl(${h} 74% ${l - 20}%)`,
  };
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const rr = (c, x, y, w, h, r, fill) => {
  c.beginPath(); c.roundRect(x, y, w, h, r); c.fillStyle = fill; c.fill();
};
const px = (c, x, y, w, h, fill) => { c.fillStyle = fill; c.fillRect(x, y, w, h); };
/** Deterministic 0..1 from integers — terrain variation must not use Math.random(). */
const hash = (x, y) => {
  let n = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
};
const light = 'rgba(255,255,255,0.12)';
const dark = 'rgba(0,0,0,0.28)';

/** Top-left highlight, bottom-right shadow. Apply to every solid block. */
const bevel = (c, x, y, w, h, t = 2) => {
  px(c, x, y, w, t, light); px(c, x, y, t, h, light);
  px(c, x, y + h - t, w, t, dark); px(c, x + w - t, y, t, h, dark);
};

// ─── terrain ──────────────────────────────────────────────────────────────────

/** @param dmg 0..1, fraction of HP lost — drives the crack overlay. */
export function drawTile(c, type, tx = 0, ty = 0, dmg = 0) {
  const S = TILE_PX;
  switch (type) {
    case BLOCK.FLOOR: {
      px(c, 0, 0, S, S, PALETTE.floor);
      const r = hash(tx, ty);
      if (r > 0.8) px(c, (r * 20 | 0) + 4, (hash(ty, tx) * 20 | 0) + 4, 4, 3, PALETTE.floorAccent);
      if (r < 0.15) px(c, (r * 90 | 0) + 6, (hash(tx + 7, ty) * 18 | 0) + 6, 3, 3, PALETTE.floorAccent);
      break;
    }
    case BLOCK.SOFT:
      px(c, 0, 0, S, S, PALETTE.soft);
      // brick courses
      px(c, 0, S / 2 - 1, S, 2, dark);
      px(c, S / 2 - 1, 0, 2, S / 2, dark);
      px(c, S / 4 - 1, S / 2, 2, S / 2, dark);
      px(c, (S * 3) / 4 - 1, S / 2, 2, S / 2, dark);
      bevel(c, 0, 0, S, S);
      break;
    case BLOCK.REINFORCED:
      px(c, 0, 0, S, S, PALETTE.reinforced);
      rr(c, 4, 4, S - 8, S - 8, 2, 'rgba(0,0,0,0.18)');
      bevel(c, 0, 0, S, S, 3);
      break;
    case BLOCK.MONOLITH:
      px(c, 0, 0, S, S, PALETTE.monolith);
      px(c, 6, 3, S - 12, S - 6, 'rgba(0,0,0,0.22)');
      px(c, 10, 7, S - 20, S - 14, 'rgba(255,255,255,0.06)');
      bevel(c, 0, 0, S, S, 3);
      break;
    case BLOCK.IRON:
      px(c, 0, 0, S, S, PALETTE.iron);
      for (let i = 4; i < S; i += 8) px(c, i, 4, 2, S - 8, 'rgba(255,255,255,0.05)');
      bevel(c, 0, 0, S, S, 2);
      break;
    case BLOCK.COLUMN:
      px(c, 0, 0, S, S, PALETTE.floor);
      rr(c, 9, 2, 14, S - 4, 3, PALETTE.column);
      px(c, 9, 2, 3, S - 4, light); px(c, 20, 2, 3, S - 4, dark);
      break;
    case BLOCK.SHRUB_WALK:
    case BLOCK.SHRUB_SOLID: {
      px(c, 0, 0, S, S, PALETTE.floor);
      const solid = type === BLOCK.SHRUB_SOLID;
      c.globalAlpha = solid ? 1 : 0.72;
      for (let i = 0; i < 7; i++) {
        const r1 = hash(tx * 9 + i, ty), r2 = hash(ty * 7 + i, tx);
        rr(c, r1 * 20 | 0, r2 * 20 | 0, 12, 12, 6, solid ? PALETTE.shrub : '#4e8657');
      }
      c.globalAlpha = 1;
      break;
    }
  }
  if (dmg > 0) drawCracks(c, dmg, tx, ty);
}

/** Damage must read at a glance — a monolith takes nine hits. */
function drawCracks(c, dmg, tx, ty) {
  const S = TILE_PX, n = Math.ceil(dmg * 5);
  c.strokeStyle = `rgba(0,0,0,${0.25 + dmg * 0.45})`;
  c.lineWidth = 2; c.lineCap = 'round';
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const a = hash(tx + i * 13, ty) * Math.PI * 2;
    const x = S / 2 + Math.cos(a) * 4, y = S / 2 + Math.sin(a) * 4;
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(a) * (6 + dmg * 8), y + Math.sin(a) * (6 + dmg * 8));
  }
  c.stroke();
}

// ─── player ───────────────────────────────────────────────────────────────────

/**
 * 12x16 figure centred in a 32px tile. dir: 0 R, 1 U, 2 L, 3 D. frame: 0|1 walk cycle.
 * Caller handles Changeling (flip Y) and Reduction (scale 0.5) with a transform.
 */
export function drawPlayer(c, { dir = 3, frame = 0, colorIndex = 0, dead = false }) {
  const S = TILE_PX, k = playerShades(colorIndex);
  const ox = S / 2 - 6, oy = S / 2 - 9;
  c.save(); c.translate(ox, oy);
  if (dead) c.globalAlpha = 0.45;

  const bob = frame ? 1 : 0;
  // legs
  px(c, 2 + (frame ? 1 : 0), 13, 3, 4, PALETTE.outline);
  px(c, 7 - (frame ? 1 : 0), 13, 3, 4, PALETTE.outline);
  // body
  rr(c, 1, 6 + bob, 10, 8, 3, k.base);
  px(c, 1, 6 + bob, 3, 8, k.light);
  px(c, 8, 6 + bob, 3, 8, k.dark);
  // helmet
  rr(c, 1, 0 + bob, 10, 8, 4, '#e9edf4');
  px(c, 1, 1 + bob, 3, 5, '#ffffff');
  px(c, 8, 1 + bob, 3, 5, '#b9c2d0');
  // visor — rotates with facing
  if (dir === DIRS.D) rr(c, 2, 3 + bob, 8, 4, 2, '#1b2430');
  else if (dir === DIRS.U) rr(c, 3, 3 + bob, 6, 3, 1, '#2a3443');
  else if (dir === DIRS.R) rr(c, 5, 3 + bob, 6, 4, 2, '#1b2430');
  else rr(c, 1, 3 + bob, 6, 4, 2, '#1b2430');
  // the player's colour must be visible from every angle — chest band
  px(c, 1, 9 + bob, 10, 2, k.dark);
  c.restore();
}

export const DIRS = { R: 0, U: 1, L: 2, D: 3 };

// ─── bomb, fire, perks ────────────────────────────────────────────────────────

/** phase 0..1 through the fuse; pulse accelerates as it runs out. */
export function drawBomb(c, { phase = 0, colorIndex = 0 }) {
  const S = TILE_PX, k = playerShades(colorIndex);
  const pulse = 1 + 0.12 * Math.sin(phase * Math.PI * 2 * (3 + phase * 9));
  const r = 11 * pulse;
  c.save(); c.translate(S / 2, S / 2 + 2);
  c.beginPath(); c.ellipse(0, 9, r * 0.9, 3, 0, 0, 7); c.fillStyle = 'rgba(0,0,0,0.3)'; c.fill();
  c.beginPath(); c.arc(0, 0, r, 0, 7); c.fillStyle = '#1b2029'; c.fill();
  c.beginPath(); c.arc(-r * 0.3, -r * 0.35, r * 0.28, 0, 7); c.fillStyle = 'rgba(255,255,255,0.3)'; c.fill();
  // owner ring — you must be able to tell whose bomb you are standing next to
  c.beginPath(); c.arc(0, 0, r - 1, 0, 7); c.strokeStyle = k.base; c.lineWidth = 2; c.stroke();
  // fuse spark
  px(c, -1, -r - 4, 2, 4, '#6b7585');
  c.beginPath(); c.arc(0, -r - 5, 2 + phase * 2, 0, 7); c.fillStyle = PALETTE.fireCore; c.fill();
  c.restore();
}

/** kind: 'core' | 'arm' | 'tip'. rot in quarter turns. age 0..1 fades it out. */
export function drawFire(c, { kind = 'core', rot = 0, age = 0 }) {
  const S = TILE_PX;
  c.save(); c.translate(S / 2, S / 2); c.rotate(rot * Math.PI / 2);
  c.globalAlpha = 1 - age * 0.5;
  const w = S * (1 - age * 0.15);
  const band = (inset, col) => rr(c, -w / 2 + inset, -w / 2 + inset, w - inset * 2, w - inset * 2, 4, col);
  if (kind === 'tip') { c.beginPath(); c.arc(0, 0, w / 2 - 1, 0, 7); c.fillStyle = PALETTE.fireEdge; c.fill(); }
  else band(0, PALETTE.fireEdge);
  band(4, PALETTE.fireMid);
  band(9, PALETTE.fireCore);
  c.restore();
}

export const PERK_ART = {
  1: (c, k) => { c.beginPath(); c.arc(16, 17, 7, 0, 7); c.fillStyle = '#1b2029'; c.fill(); px(c, 15, 7, 2, 4, '#6b7585'); },
  2: (c, k) => { c.beginPath(); c.moveTo(16, 7); c.quadraticCurveTo(25, 17, 16, 25); c.quadraticCurveTo(7, 17, 16, 7); c.fillStyle = PALETTE.fireMid; c.fill(); },
  3: (c, k) => { rr(c, 8, 12, 16, 6, 2, '#5b7fd4'); c.fillStyle = '#1b2029'; [11, 16, 21].forEach(x => { c.beginPath(); c.arc(x, 21, 2.5, 0, 7); c.fill(); }); },
  4: (c, k) => { c.beginPath(); c.moveTo(16, 7); c.lineTo(25, 11); c.lineTo(25, 18); c.quadraticCurveTo(16, 26, 7, 18); c.lineTo(7, 11); c.closePath(); c.fillStyle = '#5ad1a0'; c.fill(); },
  5: (c, k) => { rr(c, 8, 12, 16, 13, 2, '#d45b8f'); px(c, 14, 12, 4, 13, PALETTE.gold); px(c, 8, 16, 16, 3, PALETTE.gold); },
};

/** Perk icon on its tile plinth. Unknown/reserved types draw a question mark. */
export function drawPerk(c, { type = 1, bob = 0 }) {
  const S = TILE_PX;
  c.save(); c.translate(0, -bob);
  rr(c, 4, 6, S - 8, S - 10, 5, '#1a2029');
  rr(c, 5, 7, S - 10, S - 12, 4, '#2a3444');
  px(c, 5, 7, S - 10, 2, 'rgba(255,255,255,0.15)');
  (PERK_ART[type] || ((cc) => {
    cc.fillStyle = PALETTE.gold; cc.font = 'bold 16px monospace';
    cc.textAlign = 'center'; cc.fillText('?', 16, 22);
  }))(c);
  c.restore();
}

// ─── baking ───────────────────────────────────────────────────────────────────
//
// Everything is drawn once into offscreen canvases at boot, then blitted. Never tint or draw
// shapes inside the frame loop — see docs/ART-AUDIO.md §7.

const canvas = (w = TILE_PX, h = TILE_PX) => {
  const el = document.createElement('canvas');
  el.width = w; el.height = h;
  return el;
};

export function bake({ playerCount = 16 } = {}) {
  const out = { tiles: {}, players: [], bombs: [], perks: {} };

  for (const type of Object.values(BLOCK)) {
    out.tiles[type] = [0, 0.33, 0.66, 0.95].map(d => {
      const el = canvas(); drawTile(el.getContext('2d'), type, 3, 5, d); return el;
    });
  }

  for (let i = 0; i < playerCount; i++) {
    const set = [];
    for (let dir = 0; dir < 4; dir++)
      for (let frame = 0; frame < 2; frame++) {
        const el = canvas();
        drawPlayer(el.getContext('2d'), { dir, frame, colorIndex: i });
        set.push(el);
      }
    out.players.push(set);
    const b = [];
    for (let p = 0; p < 8; p++) {
      const el = canvas();
      drawBomb(el.getContext('2d'), { phase: p / 8, colorIndex: i });
      b.push(el);
    }
    out.bombs.push(b);
  }

  for (const t of [1, 2, 3, 4, 5]) {
    const el = canvas(); drawPerk(el.getContext('2d'), { type: t }); out.perks[t] = el;
  }

  return out;
}
