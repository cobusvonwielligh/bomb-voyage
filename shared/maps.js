// Map definitions and the generator that turns them into cells.
//
// docs/PROTOCOL.md §5 specifies an ASCII `rows` authoring format. Maps are generated from a seed
// instead, for now: a 41x29 hand-drawn map is 1 200 characters to type and maintain, and nothing
// about M1 needs hand-placed walls. `buildMap` accepts `rows` too, so a hand-authored map can be
// dropped in later without touching anything else.
//
// Classic Bomberman lattice: indestructible pillars on odd/odd, soft walls scattered everywhere
// else, and the eight cells around each spawn kept clear so nobody dies on the first tick.

import { BLOCK, BLOCK_HP } from './constants.js';
import { rng } from './util/rng.js';

// `shape` decides what the arena is cut out of. A rectangle is the Bomberman default and Arena
// keeps it; the others are islands, which is both prettier and better level design — a coast
// gives you dead ends and choke points that a rectangle has to spend soft walls to create.
//
//   rect   the whole bounding box is playable, walled with iron
//   blob   one organic island with bays and headlands
//   atoll  a blob with a lagoon bitten out of the middle, so the map is a ring
//   poly   an explicit polygon in normalised -1..1 coordinates, for a deliberate silhouette
// Three maps, each a different problem to solve. Sized so the board can be drawn big: the view
// is roughly 1.5 times wider than it is tall, so a map that is nearly square wastes the sides and
// a map that is too large has to be scaled down to fit. Everything here is about 1.5:1 once the
// two tiles of ocean on each side are counted in, and none of them exceeds 39x23.
//
//   arena   a plain rectangle, the Bomberman default: no terrain to hide behind, pure lattice
//   cove    one organic island, all bays and headlands, where the coast makes the chokepoints
//   twins   two round islands joined by a single causeway, so crossing is a decision
export const MAPS = [
  { id: 'arena', name: 'Arena', w: 37, h: 23, seed: 1337,
    shape: 'rect', density: 0.62, reinforced: 0.05, shrubs: 0.03 },
  { id: 'cove', name: 'Cove', w: 37, h: 23, seed: 4242,
    shape: 'blob', density: 0.7, reinforced: 0.12, shrubs: 0.04 },
  { id: 'twins', name: 'Twins', w: 39, h: 23, seed: 777,
    shape: 'twin', density: 0.58, reinforced: 0.09, shrubs: 0.08 },
  // A crescent round a lagoon. The inside of the curve is water, so the two tips are the
  // furthest-apart places on a board that is not actually very big.
  { id: 'lagoon', name: 'Lagoon', w: 39, h: 25, seed: 2468,
    shape: 'horseshoe', density: 0.6, reinforced: 0.1, shrubs: 0.06 },
  // Four arms off a central plaza: the only map where the middle is the shortest route between
  // anywhere and anywhere else, which makes it contested by construction.
  { id: 'crossroads', name: 'Crossroads', w: 37, h: 25, seed: 13579,
    shape: 'cross', density: 0.66, reinforced: 0.07, shrubs: 0.05 },
];

export const mapById = id => MAPS.find(m => m.id === id) || MAPS[0];

/** Pack a block type and its HP into one byte, per docs/PROTOCOL.md §5. */
export const packCell = (type, hp = BLOCK_HP[type] || 0) => (type & 0x0f) | ((hp & 0x0f) << 4);
export const cellType = b => b & 0x0f;
export const cellHp = b => (b >> 4) & 0x0f;

// ─── island shapes ────────────────────────────────────────────────────────────
// All of this runs exactly once, on the server, when a round starts. The result goes out as
// base64 cells and no client ever re-derives it, so floating point here cannot desync anything —
// which is why these are the only trigonometry in the project.

const SECTORS = 24;

/**
 * A coastline as a radius per sector of the compass, smoothed twice.
 *
 * Smoothing is the whole trick. Raw per-sector noise gives a sawtooth coast that reads as
 * corruption rather than as geography; two passes of a 1-2-1 kernel turn the same numbers into
 * bays and headlands.
 */
function coastline(next, low, high) {
  const r = [];
  for (let i = 0; i < SECTORS; i++) r.push(low + next() * (high - low));
  for (let pass = 0; pass < 2; pass++) {
    const prev = r.slice();
    for (let i = 0; i < SECTORS; i++) {
      r[i] = (prev[(i - 1 + SECTORS) % SECTORS] + prev[i] * 2 + prev[(i + 1) % SECTORS]) / 4;
    }
  }
  return r;
}

/** Interpolated radius at an angle, so the coast has no visible 24 facets. */
function radiusAt(r, ang) {
  const t = ((ang + Math.PI) / (2 * Math.PI)) * SECTORS;
  const i0 = ((Math.floor(t) % SECTORS) + SECTORS) % SECTORS;
  const f = t - Math.floor(t);
  return r[i0] * (1 - f) + r[(i0 + 1) % SECTORS] * f;
}

/**
 * Which tiles are land. 1 = land, 0 = sea.
 *
 * The distance test is a superellipse rather than a circle: exponent 2.4 keeps an island fat in
 * the corners instead of tapering to a diamond, which matters because the corners are where the
 * spawns want to be.
 */
/** Ray casting. Odd crossings means inside, and it does not care if the polygon is concave. */
function inPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function landMask(def, next) {
  const { w, h, shape } = def;
  const land = new Uint8Array(w * h);
  if (shape === 'rect' || !shape) { land.fill(1); return land; }

  if (shape === 'twin') {
    // Two round islands joined by one causeway.
    //
    // The causeway is the whole map: it is the only way across, so holding it is worth something
    // and crossing it is a decision rather than a walk. Three tiles wide, because two is a
    // corridor one bomb seals and four is a road.
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const r = Math.min(w / 4.3, h / 2.3);
    const lobes = [[cx - w * 0.235, cy], [cx + w * 0.235, cy]];
    // Five, not three. The shoreline ring takes the outer row on each side, so a three-wide
    // bridge lands as a one-wide corridor that a single bomb seals forever.
    const BRIDGE = 5;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const onLobe = lobes.some(([lx, ly]) =>
          ((x - lx) / r) ** 2 + ((y - ly) / (r * 0.92)) ** 2 <= 1);
        const onBridge = Math.abs(y - cy) <= (BRIDGE - 1) / 2 && x > lobes[0][0] && x < lobes[1][0];
        land[y * w + x] = onLobe || onBridge ? 1 : 0;
      }
    }
    return land;
  }

  if (shape === 'horseshoe') {
    /* A crescent round a lagoon, open on one side.
     *
     * The lagoon is water, so the inside of the curve is not a shortcut: getting from one tip to
     * the other means walking the whole arc. That turns a flat map into one with a near side and
     * a far side without putting a single wall anywhere, and it means the two tips are the
     * furthest apart places on a board that is physically quite small.
     *
     * The mouth faces down, and the arms are thickened at the tips so neither ends in a point
     * nobody can fight on.
     */
    const cx = (w - 1) / 2, cy = h * 0.42;
    const R = Math.min(w / 2.35, h / 1.5);          // outer radius
    const r = R * 0.44;                              // the lagoon
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / R, dy = (y - cy) / (R * 0.82);
        const d = Math.hypot(dx, dy);
        const inner = Math.hypot(dx / (r / R), dy / (r / R));
        // The mouth: a wedge of open water cut out of the bottom of the ring.
        const ang = Math.atan2(dy, dx);
        const mouth = ang > 0.72 && ang < Math.PI - 0.72 && inner > 0.35;
        land[y * w + x] = d <= 1 && inner >= 1 && !mouth ? 1 : 0;
      }
    }
    // Blunt the tips, so each arm ends in somewhere you can stand rather than a spike.
    for (let pass = 0; pass < 2; pass++) {
      const add = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (land[y * w + x]) continue;
          let n = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (land[(y + dy) * w + (x + dx)]) n++;
          }
          if (n >= 3) add.push(y * w + x);
        }
      }
      for (const i of add) land[i] = 1;
    }
    return land;
  }

  if (shape === 'cross') {
    /* Four arms off a central plaza.
     *
     * Every map so far rewards running the long way round. This one does the opposite: the
     * middle is the shortest path between any two arms, so the plaza is contested by
     * construction and there is nowhere to hide in it. The arms are long enough to be their own
     * fight and narrow enough that a bomb in one is a real problem.
     *
     * The plaza is a disc rather than a square, because four square corners meeting produce four
     * dead pockets that nothing ever happens in.
     */
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const armH = Math.max(5, Math.round(h * 0.34));     // thickness of the horizontal arms
    const armV = Math.max(5, Math.round(h * 0.42));     // thickness of the vertical arms, in x
    const plaza = Math.min(w, h) * 0.3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inPlaza = Math.hypot((x - cx) * 0.62, y - cy) <= plaza;
        const inH = Math.abs(y - cy) <= armH / 2 && x >= 1 && x <= w - 2;
        const inV = Math.abs(x - cx) <= armV / 2 && y >= 1 && y <= h - 2;
        land[y * w + x] = inPlaza || inH || inV ? 1 : 0;
      }
    }
    return land;
  }

  if (shape === 'poly') {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Normalised with a one-tile margin, matching the other shapes, so the polygon never
        // touches the bounding box and the shoreline always has somewhere to be drawn.
        land[y * w + x] = inPolygon(def.points, (x - cx) / (cx - 1), (y - cy) / (cy - 1)) ? 1 : 0;
      }
    }
    return land;
  }

  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const outer = coastline(next, 0.74, 1.0);
  const inner = shape === 'atoll' ? coastline(next, 0.2, 0.34) : null;
  const P = 2.4;
  const dist = (dx, dy) => Math.pow(Math.abs(dx), P) + Math.pow(Math.abs(dy), P);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Normalised, with a one-tile margin so the sea always has somewhere to be drawn.
      const dx = (x - cx) / (cx - 1), dy = (y - cy) / (cy - 1);
      const d = dist(dx, dy);
      const ang = Math.atan2(dy, dx);
      let on = d <= Math.pow(radiusAt(outer, ang), P);
      if (on && inner && d <= Math.pow(radiusAt(inner, ang), P)) on = false;   // the lagoon
      land[y * w + x] = on ? 1 : 0;
    }
  }
  return land;
}

/** Every tile reachable on foot from `start`, as a Set of indices. */
function reachable(cells, w, h, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const i = queue.pop();
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen.has(j)) continue;
      // Soft walls count as reachable: they are what the game is for.
      const t = cellType(cells[j]);
      if (t === BLOCK.IRON || t === BLOCK.WATER || t === BLOCK.COLUMN) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return seen;
}

/**
 * Sixteen spawn points, chosen from tiles that actually exist.
 *
 * Farthest-point sampling over the real floor: take the tile furthest from everything chosen so
 * far, sixteen times. On a rectangle that lands on the corners and edges, which is what the old
 * hand-computed ring did — but it also works on an island with a bay in it, where the geometric
 * version happily put a spawn point in the sea.
 *
 * Distance is Manhattan over coordinates rather than path length. A path-length version would be
 * more correct and needs sixteen more flood fills; the island is convex enough that it would pick
 * the same tiles.
 */
function spawnPoints(cells, w, h) {
  const open = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (cellType(cells[y * w + x]) === BLOCK.FLOOR) open.push([x, y]);
    }
  }
  if (!open.length) return [[1, 1]];

  // Start from the tile closest to the middle, so the set is stable rather than wherever the
  // scan happened to begin.
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  let best = 0;
  for (let i = 1; i < open.length; i++) {
    const a = open[i], b = open[best];
    if (Math.abs(a[0] - cx) + Math.abs(a[1] - cy) < Math.abs(b[0] - cx) + Math.abs(b[1] - cy)) best = i;
  }

  const chosen = [open[best]];
  const far = open.map(([x, y]) => Math.abs(x - chosen[0][0]) + Math.abs(y - chosen[0][1]));
  while (chosen.length < 16 && chosen.length < open.length) {
    let pick = 0;
    for (let i = 1; i < open.length; i++) if (far[i] > far[pick]) pick = i;
    chosen.push(open[pick]);
    const [px0, py0] = open[pick];
    for (let i = 0; i < open.length; i++) {
      far[i] = Math.min(far[i], Math.abs(open[i][0] - px0) + Math.abs(open[i][1] - py0));
    }
  }
  // Drop the centre seed if we found plenty: it is the one point that is near everybody.
  return chosen.length > 8 ? chosen.slice(1).concat([chosen[0]]) : chosen;
}

export function buildMap(def) {
  const { w, h } = def;
  const cells = new Uint8Array(w * h);
  const at = (x, y) => y * w + x;

  if (def.rows) {
    // Hand-authored ASCII, if a map ever wants it.
    const legend = { '#': BLOCK.IRON, '.': BLOCK.FLOOR, b: BLOCK.SOFT, R: BLOCK.REINFORCED,
                     M: BLOCK.MONOLITH, c: BLOCK.COLUMN, s: BLOCK.SHRUB_WALK, S: BLOCK.SHRUB_SOLID };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = legend[def.rows[y]?.[x]] ?? BLOCK.FLOOR;
      cells[at(x, y)] = packCell(t);
    }
    return { ...def, cells, spawns: spawnPoints(cells, w, h) };
  }

  const next = rng(def.seed);
  const land = landMask(def, next);
  const isLand = (x, y) => x >= 0 && y >= 0 && x < w && y < h && land[y * w + x] === 1;

  /**
   * A one-tile-wide neck of land, which the lattice would otherwise wall off completely.
   *
   * The even/even pillar rule is fine on open ground and fatal on a causeway: drop a pillar in a
   * three-wide bridge and it is a two-wide bridge with a plug in it. Anywhere the land is only a
   * few tiles deep, the pillars are skipped.
   */
  const isCauseway = (x, y) => {
    let depth = 0;
    for (let d = 1; d <= 3; d++) {
      if (isLand(x, y - d)) depth++;
      if (isLand(x, y + d)) depth++;
    }
    return depth < 4;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let type;
      if (!isLand(x, y)) {
        type = BLOCK.WATER;
      } else if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        type = BLOCK.IRON;
      } else if (!isLand(x - 1, y) || !isLand(x + 1, y) || !isLand(x, y - 1) || !isLand(x, y + 1)) {
        // The shoreline. A ring of rock one tile thick, so the island has an edge you can take
        // cover behind instead of a blast arm flying off into the sea.
        type = BLOCK.IRON;
      } else if (x % 2 === 0 && y % 2 === 0 && !isCauseway(x, y)) {
        type = BLOCK.IRON;
      } else {
        const r = next();
        if (r > def.density) type = BLOCK.FLOOR;
        else if (r < def.density * def.shrubs) type = BLOCK.SHRUB_WALK;
        else if (r < def.density * (def.shrubs + def.reinforced)) type = BLOCK.REINFORCED;
        else type = BLOCK.SOFT;
      }
      cells[at(x, y)] = packCell(type);
    }
  }

  // Anything the coastline cut off from the main body is a sandbar nobody can reach. Drown it,
  // rather than leaving an island with a perk on it that no player can ever collect.
  //
  // The component has to be the LARGEST one, not the first one found. Seeding from the first
  // floor tile in scan order means a single stranded tile at the top of the map becomes "the
  // island" and the entire real map is drowned — which is exactly what a star-shaped mask did,
  // leaving one playable tile out of two thousand.
  const visited = new Set();
  let main = null;
  for (let i = 0; i < cells.length; i++) {
    const t = cellType(cells[i]);
    if (t === BLOCK.IRON || t === BLOCK.WATER || visited.has(i)) continue;
    const comp = reachable(cells, w, h, i);
    for (const j of comp) visited.add(j);
    if (!main || comp.size > main.size) main = comp;
  }
  if (main) {
    for (let i = 0; i < cells.length; i++) {
      const t = cellType(cells[i]);
      if (t === BLOCK.IRON || t === BLOCK.WATER) continue;
      if (!main.has(i)) cells[i] = packCell(BLOCK.WATER);
    }
  }

  // Clear a plus-shape around every spawn. Without this you can start boxed in, which on a
  // 16-minute round is a genuinely bad first thirty seconds. Spawns are picked from real floor,
  // so this only ever clears soft walls — it can never punch a hole in the shoreline.
  const spawns = spawnPoints(cells, w, h);
  for (const [sx, sy] of spawns) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const x = sx + dx, y = sy + dy;
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
      const t = cellType(cells[at(x, y)]);
      if (t === BLOCK.IRON || t === BLOCK.WATER) continue;
      cells[at(x, y)] = packCell(BLOCK.FLOOR);
    }
  }

  return { ...def, cells, spawns };
}

/** Base64 for the wire. Node and the browser spell this differently. */
export function encodeCells(cells) {
  if (typeof Buffer !== 'undefined') return Buffer.from(cells).toString('base64');
  let s = '';
  for (const b of cells) s += String.fromCharCode(b);
  return btoa(s);
}

export function decodeCells(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
