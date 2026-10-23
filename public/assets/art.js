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
  // The sea, and the rock the island is made of.
  seaDeep: '#0a1a2e', seaMid: '#123252', seaLight: '#1d5176', foam: '#cfe7f5',
  rock: '#3a4150', rockLit: '#4d5566', rockDark: '#20262f', sand: '#6e6346',
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

/**
 * Damage must read at a glance — a monolith takes nine hits, so there need to be enough
 * distinguishable steps between pristine and about-to-go.
 *
 * Three layers, each appearing at a different damage level, so the eye has something new to
 * notice at every stage rather than just "more scribble":
 *   1. fractures  — jagged multi-segment lines radiating from an off-centre origin, with branches
 *   2. chips      — bitten-out corners, from 45% damage
 *   3. shatter    — a bright rim on the cracks plus a dark core, from 75%, so it reads as deep
 *
 * Deterministic in (tx, ty): the same tile always cracks the same way, which matters because
 * the chunk renderer may redraw a tile at any time and a reshuffling crack pattern looks like
 * a glitch.
 */
function drawCracks(c, dmg, tx, ty) {
  const S = TILE_PX;
  const rnd = (a, b) => hash(tx * 31 + a * 17 + 7, ty * 19 + b * 23 + 3);

  // Origin sits off-centre; dead-centre starbursts look synthetic.
  const ox = S / 2 + (rnd(0, 0) - 0.5) * 8;
  const oy = S / 2 + (rnd(0, 1) - 0.5) * 8;

  const fractures = Math.max(2, Math.round(2 + dmg * 5)); // 2 → 7
  const reach = 5 + dmg * 13;

  /** One jagged run of 3 segments that wanders as it travels. */
  const fracture = (angle, len, seed, depth) => {
    let x = ox, y = oy, a = angle;
    const segs = 3;
    c.moveTo(x, y);
    for (let s = 0; s < segs; s++) {
      a += (rnd(seed, s + 10) - 0.5) * 0.9;     // wander
      const step = len / segs * (0.6 + rnd(seed, s + 20) * 0.8);
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      c.lineTo(x, y);
      // Branch off the middle segment once, on the more damaged tiles.
      if (depth === 0 && s === 1 && dmg > 0.3 && rnd(seed, 40) > 0.45) {
        const ba = a + (rnd(seed, 41) > 0.5 ? 1 : -1) * (0.5 + rnd(seed, 42) * 0.6);
        const bl = len * (0.35 + rnd(seed, 43) * 0.3);
        let bx = x, by = y;
        for (let k = 0; k < 2; k++) {
          bx += Math.cos(ba + (rnd(seed, 50 + k) - 0.5) * 0.7) * (bl / 2);
          by += Math.sin(ba + (rnd(seed, 55 + k) - 0.5) * 0.7) * (bl / 2);
          c.lineTo(bx, by);
        }
        c.moveTo(x, y); // return to the trunk
      }
    }
  };

  const drawAll = () => {
    for (let i = 0; i < fractures; i++) {
      const angle = (i / fractures) * Math.PI * 2 + rnd(i, 2) * 0.8;
      fracture(angle, reach * (0.7 + rnd(i, 3) * 0.6), i, 0);
    }
  };

  c.lineCap = 'round';
  c.lineJoin = 'round';

  // Highlight pass first, offset down-right, so the crack reads as a groove with a lit lower lip.
  if (dmg > 0.75) {
    c.save();
    c.translate(0.9, 0.9);
    c.strokeStyle = 'rgba(255,255,255,0.14)';
    c.lineWidth = 2;
    c.beginPath(); drawAll(); c.stroke();
    c.restore();
  }

  c.strokeStyle = `rgba(0,0,0,${0.3 + dmg * 0.5})`;
  c.lineWidth = dmg > 0.6 ? 2.2 : 1.6;
  c.beginPath(); drawAll(); c.stroke();

  // Chips: bitten-out wedges on the tile edge. These are what sell "nearly gone".
  if (dmg > 0.45) {
    const chips = Math.round((dmg - 0.45) * 7);
    c.fillStyle = `rgba(0,0,0,${0.3 + dmg * 0.35})`;
    for (let i = 0; i < chips; i++) {
      const edge = Math.floor(rnd(i, 60) * 4);
      const along = 4 + rnd(i, 61) * (S - 8);
      const d = 3 + rnd(i, 62) * 5;
      const [px0, py0] = edge === 0 ? [along, 0] : edge === 1 ? [S, along]
                       : edge === 2 ? [along, S] : [0, along];
      const inx = edge === 1 ? -1 : edge === 3 ? 1 : 0;
      const iny = edge === 2 ? -1 : edge === 0 ? 1 : 0;
      c.beginPath();
      c.moveTo(px0 - (iny ? d : 0), py0 - (inx ? d : 0));
      c.lineTo(px0 + inx * d * 1.6, py0 + iny * d * 1.6);
      c.lineTo(px0 + (iny ? d : 0), py0 + (inx ? d : 0));
      c.closePath();
      c.fill();
    }
  }

  // The last stage: a dark hollow at the origin. Reads as "one more hit".
  if (dmg > 0.85) {
    c.beginPath();
    c.arc(ox, oy, 3 + (dmg - 0.85) * 14, 0, 7);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fill();
  }
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

// ─── mascot ───────────────────────────────────────────────────────────────────

/**
 * The landing-page character: a one-eyed privateer holding a lit bomb. Drawn into a 96x96 box
 * at scale 1 and meant to be blown up with an integer scale, so it stays crisp and chunky.
 *
 * `t` is a free-running time in seconds; it only drives the fuse spark and a slow breath, so
 * the page has a pulse without anything actually moving.
 */
export function drawMascot(c, t = 0) {
  const breathe = Math.sin(t * 1.6) * 1.2;
  const skin = '#d9a06b', skinDark = '#b57f4e';
  const coat = '#2f4a6d', coatDark = '#22374f', coatLight = '#3d5f88';
  const cloth = '#b8303a', clothDark = '#8e222b';

  c.save();
  c.translate(0, breathe);

  // bomb, held low and to his left — the thing you are actually here for
  const bx = 70, by = 68;
  c.beginPath(); c.ellipse(bx, by + 15, 15, 4, 0, 0, 7); c.fillStyle = 'rgba(0,0,0,0.35)'; c.fill();
  c.beginPath(); c.arc(bx, by, 15, 0, 7); c.fillStyle = '#1b2029'; c.fill();
  c.beginPath(); c.arc(bx - 5, by - 6, 4.5, 0, 7); c.fillStyle = 'rgba(255,255,255,0.28)'; c.fill();
  c.strokeStyle = '#3a4455'; c.lineWidth = 3; c.lineCap = 'round';
  c.beginPath(); c.moveTo(bx + 4, by - 14); c.quadraticCurveTo(bx + 13, by - 24, bx + 9, by - 31); c.stroke();
  // the spark flickers on a fast, uneven cycle so it reads as burning, not blinking
  const spark = 2.6 + Math.sin(t * 17) * 0.8 + Math.sin(t * 31) * 0.5;
  c.beginPath(); c.arc(bx + 9, by - 32, spark + 2.5, 0, 7); c.fillStyle = 'rgba(255,155,61,0.45)'; c.fill();
  c.beginPath(); c.arc(bx + 9, by - 32, spark, 0, 7); c.fillStyle = PALETTE.fireCore; c.fill();

  // body
  rr(c, 26, 52, 36, 38, 6, coat);
  rr(c, 26, 52, 12, 38, 6, coatLight);
  rr(c, 52, 52, 10, 38, 6, coatDark);
  px(c, 40, 52, 8, 38, cloth);                       // open coat, sash beneath
  rr(c, 24, 74, 42, 9, 3, clothDark);
  rr(c, 24, 74, 42, 4, 2, cloth);

  // arms: one across the body, one holding the bomb
  rr(c, 18, 58, 11, 22, 5, coatDark);
  rr(c, 58, 56, 11, 20, 5, coat);
  rr(c, 60, 72, 10, 9, 4, skin);

  // head
  rr(c, 30, 20, 30, 30, 10, skin);
  rr(c, 30, 20, 11, 30, 10, '#e8b67f');
  rr(c, 52, 24, 8, 24, 6, skinDark);
  px(c, 33, 44, 24, 6, skinDark);                    // stubble shadow under the jaw

  // bandana, knotted at the back
  rr(c, 27, 16, 36, 13, 5, cloth);
  rr(c, 27, 16, 36, 6, 4, '#d4474f');
  c.beginPath(); c.moveTo(28, 24); c.lineTo(16, 30); c.lineTo(20, 20); c.closePath();
  c.fillStyle = clothDark; c.fill();

  // the eye patch — the whole point
  c.strokeStyle = '#11161f'; c.lineWidth = 2.5;
  c.beginPath(); c.moveTo(31, 29); c.lineTo(60, 26); c.stroke();
  rr(c, 46, 28, 13, 11, 3, '#11161f');
  // the good eye
  rr(c, 34, 31, 7, 6, 2, '#ffffff');
  rr(c, 36, 32, 4, 4, 2, '#1b2430');

  // a crooked grin
  c.strokeStyle = '#8c5a33'; c.lineWidth = 2; c.lineCap = 'round';
  c.beginPath(); c.moveTo(34, 44); c.quadraticCurveTo(40, 48, 46, 43); c.stroke();
  px(c, 41, 43, 3, 3, '#ffd21f');                    // gold tooth

  // legs
  rr(c, 29, 88, 12, 8, 3, coatDark);
  rr(c, 47, 88, 12, 8, 3, coatDark);

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

// ─── the sea ──────────────────────────────────────────────────────────────────
// Water is a two-layer scrolling pattern, not a particle system. Sixteen players and a chain
// reaction already own the frame budget; the sea is scenery and has to cost close to nothing.
// Two baked tiles, two fillRects a frame, and the illusion is done.

const WATER_TILE = 128;

/** One seamless ripple layer. Seamless because every wave is an integer number of cycles wide. */
function waterLayer(cyclesX, cyclesY, amp, colour, alpha) {
  const el = canvas(WATER_TILE, WATER_TILE);
  const c = el.getContext('2d');
  c.globalAlpha = alpha;
  c.strokeStyle = colour;
  c.lineWidth = 2;
  const kx = (Math.PI * 2 * cyclesX) / WATER_TILE;
  const ky = (Math.PI * 2 * cyclesY) / WATER_TILE;
  for (let row = 0; row < 8; row++) {
    const y0 = (row + 0.5) * (WATER_TILE / 8);
    c.beginPath();
    for (let x = 0; x <= WATER_TILE; x += 4) {
      const y = y0 + Math.sin(x * kx + row * 1.7) * amp + Math.sin(y0 * ky) * amp * 0.4;
      if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
  return el;
}

/**
 * Everything needed to draw the sea, built once.
 *
 * Patterns rather than per-frame geometry: scrolling two of them at different speeds and in
 * different directions is what makes a flat fill read as moving water, and it costs two draws.
 */
export function bakeSea() {
  return {
    near: waterLayer(3, 2, 3.0, PALETTE.seaLight, 0.5),
    far: waterLayer(5, 3, 2.0, PALETTE.foam, 0.16),
  };
}

/**
 * A rock on a shoreline tile.
 *
 * `edges` is a bitmask of which sides face open water (1 right, 2 up, 4 left, 8 down), matching
 * the DIR_* order used everywhere else. Rocks only get their lit cap and their wet foot on the
 * sides that actually touch the sea, so the island reads as a solid mass with a coast rather than
 * as a row of identical boulders.
 */
export function drawRock(c, tx, ty, edges) {
  const S = TILE_PX;
  px(c, 0, 0, S, S, PALETTE.rock);

  // Two chunks of lighter stone, placed by hash so neighbouring tiles differ but never flicker.
  const h1 = hash(tx, ty), h2 = hash(ty + 3, tx + 11);
  px(c, (h1 * 10 | 0) + 2, (h2 * 10 | 0) + 2, 11, 9, PALETTE.rockLit);
  px(c, (h2 * 12 | 0) + 4, (h1 * 14 | 0) + 12, 9, 8, PALETTE.rockDark);

  // A lit edge wherever the sea is, because that is where the light gets in.
  if (edges & 1) px(c, S - 3, 0, 3, S, PALETTE.rockLit);
  if (edges & 2) px(c, 0, 0, S, 3, PALETTE.rockLit);
  if (edges & 4) px(c, 0, 0, 3, S, PALETTE.rockLit);
  if (edges & 8) px(c, 0, S - 3, S, 3, PALETTE.rockDark);

  // A thin band of wet sand on the seaward side, so the join is not a hard line.
  if (edges) {
    c.globalAlpha = 0.5;
    if (edges & 1) px(c, S - 2, 2, 2, S - 4, PALETTE.sand);
    if (edges & 2) px(c, 2, 0, S - 4, 2, PALETTE.sand);
    if (edges & 4) px(c, 0, 2, 2, S - 4, PALETTE.sand);
    if (edges & 8) px(c, 2, S - 2, S - 4, 2, PALETTE.sand);
    c.globalAlpha = 1;
  }
}

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
