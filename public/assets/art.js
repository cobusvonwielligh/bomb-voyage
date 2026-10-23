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
  // The pirate. Taken off the mascot so the sprites and the artwork are the same character: red
  // bandana, cream sash, dark boots. Every one of these is a neutral against all sixteen player
  // hues, which is what lets the costume stay constant while the coat carries the identity.
  cloth: '#c0392b', clothDark: '#8f2a20',
  skin: '#e8b68a', skinDark: '#c4936c',
  patch: '#14181f', patchStrap: '#272d38',
  sash: '#e8dcc0', belt: '#3a2f22',
  boot: '#4a3728', bootDark: '#2f231a',
  cuff: '#e8dcc0', grin: '#f4f1e8',

  // The sea, and the rock the island is made of. The rock is brown-grey boulder, not the blue
  // slate the walls are: the coast has to read as a different material from the level.
  seaDeep: '#0a1a2e', seaMid: '#123252', seaLight: '#1d5176', foam: '#cfe7f5',
  rock: '#4a4036', rockLit: '#6b5e4f', rockTop: '#857665', rockDark: '#2b241d', sand: '#6e6346',
};

/** The costume, pulled out of the palette so the sprite code reads as a description of a pirate. */
const PIRATE = {
  cloth: PALETTE.cloth, clothDark: PALETTE.clothDark,
  skin: PALETTE.skin, skinDark: PALETTE.skinDark,
  patch: PALETTE.patch, patchStrap: PALETTE.patchStrap,
  sash: PALETTE.sash, belt: PALETTE.belt,
  boot: PALETTE.boot, bootDark: PALETTE.bootDark,
  cuff: PALETTE.cuff, grin: PALETTE.grin,
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

/** Rounded rect. `fill` may be null to stroke only; `stroke` is optional and drawn on top. */
const rr = (c, x, y, w, h, r, fill, stroke) => {
  c.beginPath(); c.roundRect(x, y, w, h, r);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1; c.stroke(); }
};
const px = (c, x, y, w, h, fill) => { c.fillStyle = fill; c.fillRect(x, y, w, h); };
/** Deterministic 0..1 from integers — terrain variation must not use Math.random(). */
const hash = (x, y) => {
  let n = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
};
// The bevel pair, softened. At 0.12/0.28 the lit and shaded faces of a block were nearly three
// stops apart, which on a grid of them reads as a checkerboard rather than as lighting — and it
// was the single biggest source of contrast on the map. Halving the shadow and easing the
// highlight keeps the form without the map looking etched.
const light = 'rgba(255,255,255,0.09)';
const dark = 'rgba(0,0,0,0.16)';

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
    /* Packed sand over buried stone.
     *
     * Four layers, each at a different spatial frequency, which is what stops a large open area
     * reading as a flat colour field. A single noise octave tiles visibly at 32px; three at
     * different scales do not, because their periods never line up.
     *
     * All of it is deterministic in (tx, ty). The chunk renderer may redraw any tile at any
     * moment, and terrain that reshuffles when a wall next to it breaks looks like a glitch.
     */
    case BLOCK.FLOOR: {
      px(c, 0, 0, S, S, PALETTE.floor);

      // Broad tonal drift: whole tiles a shade lighter or darker than their neighbours.
      const tone = hash(tx * 3, ty * 3);
      // Halved from the first pass: tile-to-tile drift should be felt, not seen. At the old
      // range adjacent floor tiles were visibly different colours and the floor read as a
      // patchwork.
      px(c, 0, 0, S, S, tone > 0.5
        ? `rgba(255,255,255,${(tone - 0.5) * 0.05})`
        : `rgba(0,0,0,${(0.5 - tone) * 0.06})`);

      // Grain: a scatter of single pixels, dense enough to texture and sparse enough to stay
      // cheap. Eighteen samples a tile over a cached chunk is nothing.
      for (let i = 0; i < 18; i++) {
        const gx = (hash(tx * 17 + i, ty * 7) * S) | 0;
        const gy = (hash(ty * 13 + i, tx * 11) * S) | 0;
        const g = hash(i * 5 + tx, i * 3 + ty);
        px(c, gx, gy, 1, 1, g > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.045)');
      }

      // Flagstones, on about one tile in six: the stone the sand has blown off.
      if (hash(tx + 101, ty + 211) > 0.84) {
        const sx = 3 + ((hash(tx, ty + 5) * 7) | 0);
        const sy = 3 + ((hash(tx + 5, ty) * 7) | 0);
        rr(c, sx, sy, 16, 13, 2, PALETTE.floorAccent);
        px(c, sx, sy, 16, 1, 'rgba(255,255,255,0.05)');
        px(c, sx, sy + 12, 16, 1, 'rgba(0,0,0,0.1)');
      }

      // Pebbles and shell fragments.
      const r = hash(tx, ty);
      if (r > 0.72) px(c, ((r * 23) | 0) + 3, ((hash(ty, tx) * 23) | 0) + 3, 3, 2, PALETTE.sand);
      if (r < 0.18) px(c, ((r * 120) | 0) + 5, ((hash(tx + 7, ty) * 20) | 0) + 5, 2, 2, PALETTE.floorAccent);

      // The seam where the chunk cache joins tiles. A hair of shadow on two sides gives the
      // floor a grid without drawing a grid, and hides the join entirely.
      px(c, 0, 0, S, 1, 'rgba(0,0,0,0.05)');
      px(c, 0, 0, 1, S, 'rgba(0,0,0,0.05)');
      break;
    }

    /* Soft wall: a stack of crates, not masonry.
     *
     * The old brick courses were a dungeon block on a pirate island, and more importantly a
     * breakable wall has to be visibly DIFFERENT in material from the ones that are not — the
     * single most important read on the whole map is "can I blow through this". Wood against
     * stone does that at any zoom, in one glance, before any of the detail is resolvable.
     */
    case BLOCK.SOFT: {
      px(c, 0, 0, S, S, PALETTE.soft);
      // Plank grain, two per crate, running with the boards.
      for (let y = 3; y < S; y += 7) {
        px(c, 2, y, S - 4, 1, 'rgba(0,0,0,0.13)');
        px(c, 2, y + 1, S - 4, 1, 'rgba(255,255,255,0.05)');
      }
      // Knots, deterministic so a given crate always has the same ones.
      for (let i = 0; i < 3; i++) {
        const kx = 4 + ((hash(tx * 31 + i, ty) * (S - 10)) | 0);
        const ky = 4 + ((hash(ty * 23 + i, tx) * (S - 10)) | 0);
        px(c, kx, ky, 2, 2, 'rgba(0,0,0,0.2)');
      }
      // The frame: corner battens and a cross brace, which is what makes it read as a crate
      // rather than as a plank wall.
      px(c, 0, 0, S, 3, '#6d5238'); px(c, 0, S - 3, S, 3, '#5a4330');
      px(c, 0, 0, 3, S, '#6d5238'); px(c, S - 3, 0, 3, S, '#5a4330');
      c.save();
      c.strokeStyle = 'rgba(90,67,48,0.75)'; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(3, 3); c.lineTo(S - 3, S - 3); c.stroke();
      c.restore();
      bevel(c, 0, 0, S, S);
      break;
    }

    /* Reinforced: cut stone, banded with iron. Six hits, so it has to look like it will take
     * six — the bands are the visual promise that this is not a crate. */
    case BLOCK.REINFORCED: {
      px(c, 0, 0, S, S, PALETTE.reinforced);
      // Two courses of ashlar with a staggered joint, which is how stone is actually laid and
      // reads as deliberate construction rather than as a texture.
      px(c, 0, S / 2 - 1, S, 2, 'rgba(0,0,0,0.22)');
      px(c, S / 2 - 1, 0, 2, S / 2, 'rgba(0,0,0,0.22)');
      px(c, S / 4 - 1, S / 2, 2, S / 2, 'rgba(0,0,0,0.22)');
      px(c, (S * 3) / 4 - 1, S / 2, 2, S / 2, 'rgba(0,0,0,0.22)');
      for (let i = 0; i < 10; i++) {
        const gx = (hash(tx * 19 + i, ty * 5) * S) | 0;
        const gy = (hash(ty * 29 + i, tx * 3) * S) | 0;
        px(c, gx, gy, 1, 1, 'rgba(0,0,0,0.09)');
      }
      // Iron bands across the middle, with rivets.
      px(c, 0, 12, S, 8, '#565d6b');
      px(c, 0, 12, S, 2, 'rgba(255,255,255,0.14)');
      px(c, 0, 18, S, 2, 'rgba(0,0,0,0.26)');
      for (const rx of [5, 15, 25]) px(c, rx, 15, 2, 2, 'rgba(255,255,255,0.3)');
      bevel(c, 0, 0, S, S, 3);
      break;
    }

    /* Monolith: one carved block, nine hits. Darker and smoother than the reinforced stone, with
     * a sunken face — the strongest thing you can actually break, and it looks it. */
    case BLOCK.MONOLITH: {
      px(c, 0, 0, S, S, PALETTE.monolith);
      rr(c, 4, 3, S - 8, S - 6, 2, 'rgba(0,0,0,0.26)');
      rr(c, 6, 5, S - 12, S - 10, 2, '#555e70');
      // A carved mark on the face. Same glyph every time for a given tile, different between
      // tiles, so a wall of them does not look stamped.
      c.save();
      c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 2; c.lineCap = 'round';
      const g = hash(tx * 7 + 3, ty * 11 + 5);
      c.beginPath();
      if (g < 0.33) { c.moveTo(12, 10); c.lineTo(20, 16); c.lineTo(12, 22); }
      else if (g < 0.66) { c.moveTo(12, 11); c.lineTo(20, 11); c.moveTo(16, 11); c.lineTo(16, 21); }
      else { c.moveTo(12, 21); c.lineTo(16, 11); c.lineTo(20, 21); }
      c.stroke();
      c.restore();
      px(c, 6, 5, S - 12, 1, 'rgba(255,255,255,0.1)');
      bevel(c, 0, 0, S, S, 3);
      break;
    }

    /* Iron: the fixed skeleton. Deliberately the dullest thing on the map — it is never a
     * decision, so it must never pull the eye away from the things that are. */
    case BLOCK.IRON: {
      px(c, 0, 0, S, S, PALETTE.iron);
      px(c, 2, 2, S - 4, S - 4, '#2e3542');
      for (let i = 5; i < S - 3; i += 7) px(c, i, 4, 2, S - 8, 'rgba(255,255,255,0.045)');
      // Corner plates with bolts: it reads as engineered rather than as a dark square.
      for (const [bx, by] of [[4, 4], [S - 6, 4], [4, S - 6], [S - 6, S - 6]]) {
        px(c, bx, by, 2, 2, 'rgba(255,255,255,0.14)');
      }
      bevel(c, 0, 0, S, S, 2);
      break;
    }
    case BLOCK.COLUMN:
      px(c, 0, 0, S, S, PALETTE.floor);
      rr(c, 9, 2, 14, S - 4, 3, PALETTE.column);
      px(c, 9, 2, 3, S - 4, light); px(c, 20, 2, 3, S - 4, dark);
      break;
    // A powder keg: barrel staves, iron hoops, and a lit fuse so it reads as armed rather than
    // as scenery. Warm against a map of cold blues and greys — the one tile you want spotted
    // from across the island.
    case BLOCK.POWDER: {
      px(c, 0, 0, S, S, PALETTE.floor);
      rr(c, 5, 7, S - 10, S - 10, 5, '#7a4a22');
      rr(c, 6, 8, S - 12, S - 12, 4, '#9c6230');
      for (const x of [11, 16, 21]) px(c, x, 8, 1, S - 12, 'rgba(0,0,0,0.25)');
      px(c, 5, 12, S - 10, 3, '#4a3524');            // hoops
      px(c, 5, S - 11, S - 10, 3, '#4a3524');
      px(c, 6, 8, S - 12, 2, 'rgba(255,255,255,0.18)');
      // The powder mark. Small and red, dead centre between the hoops: the universal "this one
      // is dangerous", and the one bit of pure red on an island of browns and blues.
      c.save();
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(13, 15); c.lineTo(19, 21);
      c.moveTo(19, 15); c.lineTo(13, 21);
      // Black underneath, red on top. The mark sits on mid-brown staves, and a bare red stroke
      // at this size has almost no luminance contrast against that — it goes muddy the moment
      // the board is zoomed out. The dark border is what keeps it legible.
      c.strokeStyle = '#140c08'; c.lineWidth = 4.2; c.stroke();
      c.strokeStyle = '#e03c2e'; c.lineWidth = 2.2; c.stroke();
      c.restore();
      c.strokeStyle = '#d8c9a8'; c.lineWidth = 1.6; c.lineCap = 'round';
      c.beginPath(); c.moveTo(20, 7); c.quadraticCurveTo(25, 3, 22, 1); c.stroke();
      c.beginPath(); c.arc(22, 1.5, 2.2, 0, 7); c.fillStyle = PALETTE.fireMid; c.fill();
      c.beginPath(); c.arc(22, 1.5, 1.1, 0, 7); c.fillStyle = PALETTE.fireCore; c.fill();
      break;
    }
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
  if (CASTS_SHADOW.has(type)) castShadow(c);
  if (OUTLINED.has(type)) outlineTile(c);
}

/* Blocks that get a hairline round them.
 *
 * Two soft walls side by side used to be one continuous slab of brown, which matters because
 * "how many hits is that" is a count of blocks, not of pixels. A single dark line between them
 * turns a wall into a row of walls. Floor and water are excluded — a grid drawn on open ground
 * is a chessboard, and the floor already has its own faint seam. */
const OUTLINED = new Set([
  BLOCK.SOFT, BLOCK.REINFORCED, BLOCK.MONOLITH, BLOCK.POWDER, BLOCK.COLUMN,
  BLOCK.SHRUB_SOLID, BLOCK.IRON,
]);

/** One pixel of dark around the tile. Inside the tile, for the reason given in castShadow. */
function outlineTile(c) {
  const S = TILE_PX;
  c.strokeStyle = 'rgba(14,18,24,0.55)';
  c.lineWidth = 1;
  c.strokeRect(0.5, 0.5, S - 1, S - 1);
}

/* Blocks that stand proud of the floor and therefore throw one.
 *
 * Water and floor are flat, and iron is the one thing deliberately kept visually quiet, so none
 * of those get one. */
const CASTS_SHADOW = new Set([
  BLOCK.SOFT, BLOCK.REINFORCED, BLOCK.MONOLITH, BLOCK.POWDER, BLOCK.COLUMN, BLOCK.SHRUB_SOLID,
]);

/**
 * A shadow along the bottom and right edges of a solid block.
 *
 * It is drawn INSIDE the block's own tile rather than onto the floor beside it, which is not
 * where a real shadow would fall — but the chunk renderer draws each tile independently and has
 * no idea what its neighbour is, so a shadow that spilled outwards would be painted over by
 * whatever tile is drawn next. Inside the tile it survives, and at two pixels the eye reads the
 * block as raised either way.
 *
 * Top-left light, matching every other piece of shading in the file.
 */
function castShadow(c) {
  const S = TILE_PX;
  const g = c.createLinearGradient(0, S - 5, 0, S);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.3)');
  px(c, 0, S - 5, S, 5, g);
  const h = c.createLinearGradient(S - 5, 0, S, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)');
  h.addColorStop(1, 'rgba(0,0,0,0.22)');
  px(c, S - 5, 0, 5, S, h);
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
  const k = playerShades(colorIndex);
  const ox = TILE_PX / 2 - 6, oy = TILE_PX / 2 - 9;
  c.save();

  // A soft shadow on the ground, drawn in tile space before the figure is offset.
  //
  // This is the single cheapest thing that makes a sprite sit ON the floor rather than float
  // above it, and it matters more here than in most games: the floor is a flat top-down plane
  // with no horizon, so contact is the only depth cue there is.
  if (!dead) {
    c.save();
    c.globalAlpha = 0.3;
    c.beginPath();
    c.ellipse(TILE_PX / 2, TILE_PX / 2 + 8, 7, 2.6, 0, 0, 7);
    c.fillStyle = '#000';
    c.fill();
    c.restore();
  }

  c.translate(ox, oy);
  if (dead) c.globalAlpha = 0.45;

  const bob = frame ? 1 : 0;
  const back = dir === DIRS.U;
  const side = dir === DIRS.R || dir === DIRS.L;
  // Profiles are drawn facing right and mirrored for left, so there is one set of coordinates to
  // get right instead of two that drift apart.
  if (dir === DIRS.L) { c.translate(12, 0); c.scale(-1, 1); }

  // ── boots ──
  px(c, 1 + (frame ? 1 : 0), 13, 4, 4, PIRATE.boot);
  px(c, 7 - (frame ? 1 : 0), 13, 4, 4, PIRATE.bootDark);

  // ── coat ──
  // The player's colour IS the coat, because colour is how you tell sixteen people apart at a
  // glance and the costume must never win that fight.
  //
  // A dark silhouette is laid down first, one pixel proud on every side, and the colour drawn
  // inside it. Sixteen hues have to stay apart against a sand floor, a blue wall and an orange
  // explosion, and the darker half of them lose their edge against the floor without this.
  rr(c, 0, 5 + bob, 12, 10, 4, PALETTE.outline);
  rr(c, 1, 0 + bob, 10, 9, 4, PALETTE.outline);
  rr(c, 1, 6 + bob, 10, 8, 3, k.base);
  px(c, 1, 6 + bob, 3, 8, k.light);
  px(c, 8, 6 + bob, 3, 8, k.dark);

  if (side) {
    // A coat tail behind him, so a profile is not a featureless slab.
    px(c, 0, 9 + bob, 2, 5, k.dark);
    px(c, 8, 8 + bob, 3, 2, PIRATE.cuff);
  } else {
    // Sash across the chest, and a belt. Cream against any hue, so the costume reads on all 16.
    c.save();
    c.beginPath();
    c.rect(1, 6 + bob, 10, 8);
    c.clip();
    c.translate(6, 10 + bob);
    c.rotate(back ? -0.6 : 0.6);
    // Two pixels, not three: the coat is the player's identity and the costume may not crowd it.
    px(c, -7, -1, 14, 2, PIRATE.sash);
    c.restore();
    px(c, 1, 12 + bob, 10, 2, PIRATE.belt);
    px(c, 5, 12 + bob, 2, 2, PALETTE.gold);
  }

  // A rim of light down the top-left edge, matching the one light direction the whole tile set
  // is lit from. Two pixels of highlight is the difference between a coloured blob and a figure.
  px(c, 1, 6 + bob, 10, 1, 'rgba(255,255,255,0.22)');

  // ── head ──
  rr(c, 2, 1 + bob, 8, 7, 3, back ? PIRATE.skinDark : PIRATE.skin);
  px(c, 2, 7 + bob, 8, 1, 'rgba(0,0,0,0.18)');          // jaw shadow, onto the collar

  // ── bandana ──
  // Red, always, on every colour of coat: it is the thing that says "pirate" from across the map,
  // and it has to be the same red every time or it stops being a uniform.
  rr(c, 1, 0 + bob, 10, 4, 2, PIRATE.cloth);
  px(c, 1, 2 + bob, 10, 2, PIRATE.clothDark);
  // The knot and its tails, trailing behind whichever way he is facing.
  if (side) {
    px(c, 0, 2 + bob, 2, 2, PIRATE.cloth);
    px(c, -1, 3 + bob, 2, 2, PIRATE.clothDark);
  } else {
    px(c, 0, 2 + bob, 2, 3, PIRATE.cloth);
    px(c, 10, 2 + bob, 2, 3, PIRATE.cloth);
  }

  // ── face ──
  if (!back) {
    if (side) {
      px(c, 7, 4 + bob, 2, 2, PALETTE.outline);          // the one visible eye
      px(c, 9, 5 + bob, 1, 1, PIRATE.skinDark);          // nose
      px(c, 6, 4 + bob, 1, 1, PIRATE.patch);             // patch strap crossing the temple
    } else {
      // Small features, wide apart. At twelve pixels of face a patch drawn 3x3 is a third of his
      // head and reads as a hole rather than as an eye patch, so it is 2x2 with a strap that
      // stops at the edge of the head instead of running off it.
      px(c, 3, 4 + bob, 2, 2, PALETTE.outline);          // open eye
      px(c, 7, 4 + bob, 2, 2, PIRATE.patch);             // eye patch
      px(c, 6, 4 + bob, 4, 1, PIRATE.patchStrap);        // strap, held inside the head
      px(c, 4, 6 + bob, 4, 1, PIRATE.grin);              // grin
      px(c, 7, 6 + bob, 1, 1, PALETTE.gold);             // the gold tooth, same as the mascot
    }
  }

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

/**
 * The pickups.
 *
 * Readability first. These are 32px squares seen at the edge of your vision while something is
 * chasing you, so each one has to be identifiable from THREE things at once, any of which might
 * be the one that survives the zoom level you happen to be at:
 *
 *   1. hue       — the plinth is tinted, so the colour alone is the answer at a distance
 *   2. silhouette— round, flame, wedge, shield, box: all different outlines
 *   3. detail    — only readable up close, and never the thing you depend on
 *
 * The old icons were all the same slate-grey plinth, which meant only the detail distinguished
 * them, and the detail is exactly what disappears first.
 */
const PERK_SKIN = {
  1: { dark: '#2b3550', mid: '#3f4e74', rim: '#7e93d6' },   // bomb   — steel blue
  2: { dark: '#5a2416', mid: '#8c3a1f', rim: '#ff9b4a' },   // fire   — ember
  3: { dark: '#123f4e', mid: '#1b6076', rim: '#5fd8f0' },   // skate  — ice
  4: { dark: '#15402f', mid: '#1d6347', rim: '#5ad1a0' },   // shield — green
  5: { dark: '#4a1d42', mid: '#752d69', rim: '#ff8fd8' },   // gift   — magenta
  15: { dark: '#4a4212', mid: '#75671d', rim: '#ffe04a' },  // stim   — yellow
};

export const PERK_ART = {
  // A bomb: black sphere, bright specular, lit fuse.
  1: c => {
    c.beginPath(); c.arc(16, 18, 7.5, 0, 7); c.fillStyle = '#12161d'; c.fill();
    c.beginPath(); c.arc(13.4, 15.4, 2.6, 0, 7); c.fillStyle = 'rgba(255,255,255,0.4)'; c.fill();
    c.strokeStyle = '#8e9bb5'; c.lineWidth = 1.8; c.lineCap = 'round';
    c.beginPath(); c.moveTo(18, 11.5); c.quadraticCurveTo(22, 7, 20, 5); c.stroke();
    c.beginPath(); c.arc(20, 4.6, 2.1, 0, 7); c.fillStyle = PALETTE.fireCore; c.fill();
  },
  // Fire: a teardrop flame with a hot inner core, so it reads as fire and not as a leaf.
  2: c => {
    c.beginPath();
    c.moveTo(16, 4);
    c.bezierCurveTo(25, 13, 24, 20, 16, 27);
    c.bezierCurveTo(8, 20, 7, 13, 16, 4);
    c.fillStyle = PALETTE.fireMid; c.fill();
    c.beginPath();
    c.moveTo(16, 11);
    c.bezierCurveTo(20.5, 16, 20, 20, 16, 24);
    c.bezierCurveTo(12, 20, 11.5, 16, 16, 11);
    c.fillStyle = PALETTE.fireCore; c.fill();
  },
  // Skate: a boot in profile with a wing, which is the one shape nobody confuses with a bomb.
  3: c => {
    c.fillStyle = '#e8eef7';
    c.beginPath();
    c.moveTo(11, 7); c.lineTo(17, 7); c.lineTo(17, 17); c.lineTo(23, 20);
    c.lineTo(23, 24); c.lineTo(11, 24); c.closePath();
    c.fill();
    px(c, 11, 21, 12, 3, '#9fb0c8');                     // sole
    c.strokeStyle = '#5fd8f0'; c.lineWidth = 1.6; c.lineCap = 'round';
    for (const [y, len] of [[10, 7], [13, 5], [16, 3]]) {   // speed lines behind the heel
      c.beginPath(); c.moveTo(10, y); c.lineTo(10 - len, y); c.stroke();
    }
  },
  // Shield: a heater shield with a boss, rather than the old flat pentagon.
  4: c => {
    c.beginPath();
    c.moveTo(16, 5); c.lineTo(25, 9); c.lineTo(25, 17);
    c.quadraticCurveTo(16, 27, 7, 17); c.lineTo(7, 9); c.closePath();
    c.fillStyle = '#5ad1a0'; c.fill();
    c.strokeStyle = '#0f3326'; c.lineWidth = 1.4; c.stroke();
    px(c, 15, 8, 2, 14, 'rgba(255,255,255,0.45)');        // centre rib
    c.beginPath(); c.arc(16, 15, 2.6, 0, 7); c.fillStyle = '#0f3326'; c.fill();
  },
  // Gift: a wrapped box with a ribbon and a bow — a parcel, not a flag.
  5: c => {
    rr(c, 7, 12, 18, 13, 2, '#e05fa8');
    rr(c, 6, 9, 20, 4, 2, '#ff8fd8');
    px(c, 14.5, 9, 3, 16, '#ffe9a8');                     // ribbon down the front
    px(c, 6, 10, 20, 2, '#ffe9a8');                       // and across the lid
    c.fillStyle = '#ffe9a8';
    c.beginPath(); c.ellipse(13, 7.5, 3, 2.4, 0, 0, 7); c.fill();
    c.beginPath(); c.ellipse(19, 7.5, 3, 2.4, 0, 0, 7); c.fill();
  },
  // Stamina: a lightning bolt. Energy is the one idea with a universally understood glyph, and
  // the zig-zag is unmistakable at any size — which is the whole brief for these.
  15: c => {
    c.beginPath();
    c.moveTo(19, 4); c.lineTo(10, 17); c.lineTo(15.5, 17);
    c.lineTo(13, 28); c.lineTo(22, 14); c.lineTo(16.5, 14);
    c.closePath();
    c.fillStyle = '#ffe04a'; c.fill();
    c.strokeStyle = '#4a4212'; c.lineWidth = 1.2; c.stroke();
  },
};

/** Perk icon on its tile plinth. Unknown/reserved types draw a question mark. */
export function drawPerk(c, { type = 1, bob = 0 }) {
  const S = TILE_PX;
  const k = PERK_SKIN[type] || { dark: '#1a2029', mid: '#2a3444', rim: '#6b7585' };
  c.save(); c.translate(0, -bob);

  // A soft glow in the perk's own colour, so the tile is findable before the icon is readable.
  c.globalAlpha = 0.25;
  c.beginPath(); c.arc(S / 2, S / 2, S * 0.46, 0, 7); c.fillStyle = k.rim; c.fill();
  c.globalAlpha = 1;

  rr(c, 3, 5, S - 6, S - 8, 6, k.dark);
  rr(c, 4, 6, S - 8, S - 10, 5, k.mid);
  // One bright edge along the top and one dark one along the bottom: the cheapest way to make a
  // flat rectangle read as a solid object rather than as a sticker.
  px(c, 4, 6, S - 8, 2, 'rgba(255,255,255,0.22)');
  px(c, 4, S - 6, S - 8, 2, 'rgba(0,0,0,0.3)');
  rr(c, 3, 5, S - 6, S - 8, 6, null, k.rim);

  (PERK_ART[type] || (cc => {
    cc.fillStyle = PALETTE.gold; cc.font = 'bold 16px monospace';
    cc.textAlign = 'center'; cc.fillText('?', 16, 22);
  }))(c);
  c.restore();
}

/**
 * The ship, seen from directly above, moored off the island.
 *
 * Drawn at the origin, bow pointing along +x, about 100px long — the caller rotates and places
 * it. Top-down is an unusual view of a boat and the thing that makes it readable is the HULL
 * OUTLINE: a pointed bow, a wide waist and a square transom. Get that silhouette right and the
 * deck furniture is detail; get it wrong and no amount of detail rescues it.
 *
 * Deliberately a little grander than it needs to be — a capstan, a hatch, a boat on the deck,
 * two cannon a side. You only ever see part of it past the rocks, and the part you see should
 * suggest the rest.
 */
export function drawShip(c) {
  // Beam is half again what it was. At the old 3.5:1 she was a sleek thing; a working pirate
  // ship is a fat one, and the extra width is also what gives the deck room to be read at all.
  const L = 134, W = 57;                 // length bow-to-stern, beam at the waist

  /* The hull outline, as one reusable path at a given inset.
   *
   * Top-down is an unusual view of a boat and the silhouette is the whole read: a sharp bow, a
   * beam carried well aft, and a FLAT TRANSOM. Round the stern off and it becomes a canoe — the
   * squared-off back is the single line that says "ship". Every deck layer is the same curve
   * stepped inwards, which keeps the gunwale a constant thickness all the way round instead of
   * pinching to nothing at the bow.
   */
  const hull = (i, fill) => {
    const bx = L / 2 - i, sx = -L / 2 + i, hw = W / 2 - i, tw = W / 2.6 - i;
    c.beginPath();
    c.moveTo(bx, 0);
    c.bezierCurveTo(bx - L * 0.22, -hw * 0.32, -L * 0.02, -hw, sx + L * 0.05, -tw);
    c.lineTo(sx, -tw * 0.92);
    c.lineTo(sx, tw * 0.92);
    c.lineTo(sx + L * 0.06, tw);
    c.bezierCurveTo(-L * 0.02, hw, bx - L * 0.22, hw * 0.32, bx, 0);
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
  };

  // ── in the water ──
  // Disturbed water around her and a shadow under her, so she sits IN the sea rather than on
  // top of it. Both go down before the hull.
  // A ring, not a disc: a filled halo reads as a shadow in the wrong direction, where a ring
  // reads as the water she has pushed aside.
  c.save();
  c.globalAlpha = 0.14;
  c.strokeStyle = PALETTE.foam;
  c.lineWidth = 3;
  c.beginPath(); c.ellipse(0, 0, L / 2 + 8, W / 2 + 8, 0, 0, 7); c.stroke();
  c.globalAlpha = 0.07;
  c.lineWidth = 7;
  c.beginPath(); c.ellipse(0, 0, L / 2 + 13, W / 2 + 12, 0, 0, 7); c.stroke();
  c.restore();
  c.save();
  c.translate(4, 6);
  c.globalAlpha = 0.32;
  hull(0, '#000');
  c.restore();

  // ── hull ──
  hull(0, '#2f2217');                    // wet planking at the waterline
  // A dark line right on the outline. Against open water the hull is the only silhouette she
  // has, and a beamy shape with no edge reads as a rounded rectangle rather than as a boat.
  hull(0, null);
  c.strokeStyle = '#140e08'; c.lineWidth = 2; c.stroke();
  hull(3, '#73512f');                    // gunwale, lit
  hull(4.5, '#4e381f');                  // inner face of the rail, in shadow
  hull(7, '#9a7047');                    // deck

  // Deck furniture, clipped to the deck so nothing overhangs the rail.
  c.save();
  hull(7, null);                         // the same path again, used only as a clip
  c.clip();

  // A rail inside the gunwale. On a beamy hull the open waist is a lot of empty plank, and the
  // line is what tells you where the deck stops and the side begins.
  hull(8.5, null);
  c.strokeStyle = 'rgba(0,0,0,0.22)'; c.lineWidth = 1.4; c.stroke();

  // Planking, running fore and aft as deck planks actually do.
  for (let y = -W / 2; y < W / 2; y += 3) px(c, -L / 2, y, L, 1, 'rgba(0,0,0,0.13)');
  for (let i = 0; i < 26; i++) {         // grain, so it is not a perfect comb
    const gx = -L / 2 + hash(i, 3) * L, gy = -W / 2 + hash(3, i) * W;
    px(c, gx, gy, 2 + hash(i, i) * 6, 1, 'rgba(0,0,0,0.1)');
  }

  // Raised quarterdeck aft, with its own shadow onto the main deck. This is what reads as a
  // ship with a stern castle rather than as an open boat.
  px(c, -L / 2 + 30, -W / 2, 4, W, 'rgba(0,0,0,0.25)');          // its shadow, cast forward
  rr(c, -L / 2 + 2, -W / 2 + 9, 28, W - 18, 4, '#3d2c1b');        // the break of the deck
  rr(c, -L / 2 + 3.5, -W / 2 + 10.5, 25, W - 21, 3, '#a87a4e');
  for (let y = -W / 2 + 13; y < W / 2 - 11; y += 3) px(c, -L / 2 + 3.5, y, 25, 1, 'rgba(0,0,0,0.12)');
  px(c, -L / 2 + 3.5, -W / 2 + 10.5, 25, 1, 'rgba(255,255,255,0.18)');

  // The wheel, right aft.
  c.strokeStyle = '#3a2a1c'; c.lineWidth = 1.6;
  c.beginPath(); c.arc(-L / 2 + 13, 0, 5, 0, 7); c.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    c.beginPath();
    c.moveTo(-L / 2 + 13, 0);
    c.lineTo(-L / 2 + 13 + Math.cos(a) * 6.5, Math.sin(a) * 6.5);
    c.stroke();
  }

  // Two cargo hatches with gratings. Cross-hatched, because a plain rectangle on a planked deck
  // disappears into the planking.
  for (const [hx, hw2, hh] of [[-12, 26, 28], [24, 18, 20]]) {
    rr(c, hx, -hh / 2, hw2, hh, 2, '#4a3421');
    rr(c, hx + 2, -hh / 2 + 2, hw2 - 4, hh - 4, 1, '#6b4e30');
    for (let gx = hx + 3; gx < hx + hw2 - 2; gx += 4) px(c, gx, -hh / 2 + 2, 1, hh - 4, '#3a2a1c');
    for (let gy = -hh / 2 + 3; gy < hh / 2 - 2; gy += 4) px(c, hx + 2, gy, hw2 - 4, 1, '#3a2a1c');
  }

  // The ship's boat, stowed upside down amidships. Instantly readable as "a boat on a boat",
  // and the kind of detail that makes a vessel look lived in.
  c.save();
  c.translate(6, 0);
  c.beginPath();
  c.moveTo(14, 0);
  c.bezierCurveTo(7, -8, -7, -8, -14, 0);
  c.bezierCurveTo(-7, 8, 7, 8, 14, 0);
  c.closePath();
  c.fillStyle = '#6b4e30'; c.fill();
  c.strokeStyle = '#3a2a1c'; c.lineWidth = 1; c.stroke();
  px(c, -13, -0.6, 26, 1.2, '#3a2a1c');   // its keel, uppermost
  c.restore();

  // Coils of rope by the rail. Three rings each, because a single circle reads as a plate.
  for (const [rx, ry] of [[-24, -W / 2 + 8], [40, W / 2 - 8], [-2, W / 2 - 7]]) {
    c.strokeStyle = '#c9a874'; c.lineWidth = 1.1;
    for (const r of [1.5, 2.8, 4.1]) { c.beginPath(); c.arc(rx, ry, r, 0, 7); c.stroke(); }
  }

  // The fo'c'sle: a short raised deck right forward, mirroring the quarterdeck.
  rr(c, L / 2 - 40, -W / 2 + 14, 26, W - 28, 4, '#3d2c1b');
  rr(c, L / 2 - 38.5, -W / 2 + 15.5, 23, W - 31, 3, '#a87a4e');
  for (let y = -W / 2 + 18; y < W / 2 - 16; y += 3) px(c, L / 2 - 38.5, y, 23, 1, 'rgba(0,0,0,0.12)');
  px(c, L / 2 - 38.5, -W / 2 + 15.5, 23, 1, 'rgba(255,255,255,0.16)');
  // An anchor stowed on the fo'c'sle: a stock, a shank and two flukes. Small, but it is the one
  // object up here that is unmistakably nautical.
  c.save();
  c.translate(L / 2 - 27, 0);
  c.strokeStyle = '#2b2f36'; c.lineWidth = 1.6; c.lineCap = 'round';
  c.beginPath(); c.moveTo(-6, 0); c.lineTo(7, 0); c.stroke();          // shank
  c.beginPath(); c.moveTo(4, -4.5); c.lineTo(4, 4.5); c.stroke();      // stock
  c.beginPath();
  c.moveTo(-6, 0); c.quadraticCurveTo(-7, -4, -3, -5);
  c.moveTo(-6, 0); c.quadraticCurveTo(-7, 4, -3, 5);
  c.stroke();                                                          // flukes
  c.restore();
  px(c, L / 2 - 40, -W / 2, 2, W, 'rgba(0,0,0,0.18)');
  c.restore();

  // ── cannon ──
  // Barrels run out through the ports, so they overhang the rail. Drawn after the clip is
  // released, with a port shadow under each so they are not glued on.
  for (const x of [-22, -2, 18]) {
    for (const sgn of [-1, 1]) {
      const y = sgn * (W / 2 - 3);
      rr(c, x, y - (sgn > 0 ? 1 : 6), 2.6, 7, 1.3, '#23262c');
      px(c, x, y + (sgn > 0 ? 4.5 : -5.5), 2.6, 1.3, '#15181d');  // the muzzle
    }
  }

  /* ── masts ──
   *
   * From above a mast is a circle, and a circle is not a mast. What makes it legible is the YARD
   * across it with furled canvas bundled on it: a long pale bar athwartships, square to the
   * hull. Two of them at different lengths give the fore-and-aft arrangement away immediately.
   */
  const mast = (x, span, r) => {
    rr(c, x - 1.4, -span / 2, 2.8, span, 1.4, '#3f2e1e');              // the spar
    rr(c, x - 4, -span / 2 + 2, 8, span - 4, 4, '#d8cbab');            // canvas bundled on it
    rr(c, x - 4, -span / 2 + 2, 8, (span - 4) / 2, 4, 'rgba(255,255,255,0.12)');
    for (let i = -2; i <= 2; i++) px(c, x - 4, i * (span / 7), 8, 1.2, 'rgba(60,45,28,0.5)');
    c.beginPath(); c.arc(x, 0, r, 0, 7); c.fillStyle = '#2a1d12'; c.fill();
    c.beginPath(); c.arc(x - r * 0.3, -r * 0.3, r * 0.45, 0, 7);
    c.fillStyle = 'rgba(255,255,255,0.22)'; c.fill();
  };

  // Rigging first, so the spars sit on top of it.
  c.strokeStyle = 'rgba(24,16,9,0.38)';
  c.lineWidth = 0.9;
  for (const [x, span] of [[-18, W + 8], [18, W - 4]]) {
    for (const sgn of [-1, 1]) {
      c.beginPath(); c.moveTo(x, (sgn * span) / 2); c.lineTo(x - 26, sgn * (W / 2 - 5)); c.stroke();
      c.beginPath(); c.moveTo(x, (sgn * span) / 2); c.lineTo(x + 24, sgn * (W / 2 - 7)); c.stroke();
    }
  }
  mast(-18, W + 8, 4);
  mast(18, W - 4, 3.4);

  // The stem: a wedge of dark timber at the cutwater, so the bow comes to a point instead of
  // fading into deck planking.
  c.beginPath();
  c.moveTo(L / 2 - 1, 0);
  c.lineTo(L / 2 - 20, -5.5);
  c.lineTo(L / 2 - 20, 5.5);
  c.closePath();
  c.fillStyle = '#5c422b'; c.fill();
  c.strokeStyle = '#2f2217'; c.lineWidth = 1.2; c.stroke();

  // Bowsprit, out over the bow with a jib furled along it. The detail that reads as "ship" from
  // furthest away, because it is the one thing that breaks the hull outline.
  rr(c, L / 2 - 16, -1.4, 30, 2.8, 1.4, '#3f2e1e');
  rr(c, L / 2 - 4, -2.3, 13, 4.6, 2.3, '#d8cbab');
  px(c, L / 2 + 2, -2.3, 1.2, 4.6, 'rgba(60,45,28,0.5)');

  // A lantern at the stern. One warm point on a cold blue sea, and the only saturated colour on
  // the whole thing — which is what makes the eye find her.
  const lx = -L / 2 + 5;
  c.beginPath(); c.arc(lx, 0, 7, 0, 7);
  c.fillStyle = 'rgba(255,196,92,0.16)'; c.fill();
  c.beginPath(); c.arc(lx, 0, 3.6, 0, 7);
  c.fillStyle = 'rgba(255,196,92,0.4)'; c.fill();
  c.beginPath(); c.arc(lx, 0, 2.1, 0, 7);
  c.fillStyle = '#ffe3a6'; c.fill();
  c.strokeStyle = 'rgba(40,28,16,0.7)'; c.lineWidth = 0.9;
  c.beginPath(); c.moveTo(lx - 2.4, 0); c.lineTo(lx + 2.4, 0); c.stroke();
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
  // Six rows across the tile, not eight: a quarter more space between crests. Packed tighter
  // the lines start to read as corduroy rather than as water, and the gaps are where the deeper
  // colour shows through, which is most of what makes it look wet.
  const ROWS = 6;
  for (let row = 0; row < ROWS; row++) {
    const y0 = (row + 0.5) * (WATER_TILE / ROWS);
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
  px(c, 0, 0, S, S, PALETTE.rockDark);
  // The island's outline, drawn only on the sides that actually face open water. A border round
  // every rock tile would draw a grid through the middle of the coast; this draws one line
  // round the whole island, because the only tiles that carry it are the ones on the edge.
  // Same weight as the block hairline, in the darkest brown on the palette.
  const EDGE = '#241c14', T = 2;

  // Boulders, not a brick. Three overlapping rounded lumps of brown-grey stone, sized and placed
  // by hash — so every tile is a different pile, and the same tile is the same pile every time.
  // Rounded shapes are what stop a coastline reading as a wall with a different colour.
  const h = [hash(tx, ty), hash(ty + 3, tx + 11), hash(tx + 7, ty + 5), hash(ty + 13, tx + 2)];
  const lumps = [
    [1 + h[0] * 7, 3 + h[1] * 6, 15 + h[2] * 7, 14 + h[3] * 7],
    [12 + h[2] * 9, 1 + h[3] * 8, 13 + h[0] * 7, 13 + h[1] * 6],
    [3 + h[3] * 10, 13 + h[0] * 9, 14 + h[1] * 8, 13 + h[2] * 7],
  ];
  for (const [x, y, w, hh] of lumps) {
    rr(c, x | 0, y | 0, w | 0, hh | 0, 5, PALETTE.rock);
    // One light cap per boulder, top-left, matching the project's single light direction.
    rr(c, (x + 2) | 0, (y + 1) | 0, ((w * 0.5) | 0), ((hh * 0.38) | 0), 3, PALETTE.rockLit);
  }
  // A few dry highlights so the pile has grain rather than three flat blobs.
  px(c, (h[1] * 24 | 0) + 3, (h[2] * 24 | 0) + 3, 2, 2, PALETTE.rockTop);
  px(c, (h[3] * 22 | 0) + 5, (h[0] * 22 | 0) + 6, 2, 2, PALETTE.rockTop);

  // A thin band of wet sand on the seaward side, so the join to the water is not a hard line.
  if (edges) {
    c.globalAlpha = 0.45;
    if (edges & 1) px(c, S - 3, 2, 3, S - 4, PALETTE.sand);
    if (edges & 2) px(c, 2, 0, S - 4, 3, PALETTE.sand);
    if (edges & 4) px(c, 0, 2, 3, S - 4, PALETTE.sand);
    if (edges & 8) px(c, 2, S - 3, S - 4, 3, PALETTE.sand);
    c.globalAlpha = 1;

    // And the outline itself, on the seaward faces only. Drawn last so the sand does not sit on
    // top of it, and square-cornered: a rounded one would leave gaps where two edge tiles meet.
    if (edges & 1) px(c, S - T, 0, T, S, EDGE);
    if (edges & 2) px(c, 0, 0, S, T, EDGE);
    if (edges & 4) px(c, 0, 0, T, S, EDGE);
    if (edges & 8) px(c, 0, S - T, S, T, EDGE);
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
