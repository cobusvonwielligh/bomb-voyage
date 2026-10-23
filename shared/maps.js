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

export const MAPS = [
  { id: 'arena', name: 'Arena', w: 31, h: 25, seed: 1337, density: 0.62, reinforced: 0.05, shrubs: 0.03 },
  { id: 'catacombs', name: 'Catacombs', w: 41, h: 29, seed: 4242, density: 0.74, reinforced: 0.14, shrubs: 0.02 },
  { id: 'islands', name: 'Islands', w: 35, h: 35, seed: 777, density: 0.5, reinforced: 0.08, shrubs: 0.12 },
];

export const mapById = id => MAPS.find(m => m.id === id) || MAPS[0];

/** Pack a block type and its HP into one byte, per docs/PROTOCOL.md §5. */
export const packCell = (type, hp = BLOCK_HP[type] || 0) => (type & 0x0f) | ((hp & 0x0f) << 4);
export const cellType = b => b & 0x0f;
export const cellHp = b => (b >> 4) & 0x0f;

/**
 * Sixteen spawn points spread around the ring of the map, as far apart as the perimeter allows.
 * Corners first, so a two-player game starts at opposite ends.
 */
function spawnPoints(w, h) {
  const inset = 1;
  const x0 = inset, y0 = inset, x1 = w - 1 - inset, y1 = h - 1 - inset;
  const corners = [[x0, y0], [x1, y1], [x1, y0], [x0, y1]];
  const mids = [
    [(w >> 1) | 0, y0], [(w >> 1) | 0, y1], [x0, (h >> 1) | 0], [x1, (h >> 1) | 0],
  ];
  const quarters = [];
  for (const fx of [0.25, 0.75]) for (const fy of [0, 1]) {
    quarters.push([Math.round(w * fx) | 1, fy ? y1 : y0]);
    quarters.push([fy ? x1 : x0, Math.round(h * fx) | 1]);
  }
  // Odd coordinates only: even/even is where the indestructible pillars live.
  return [...corners, ...mids, ...quarters]
    .map(([x, y]) => [Math.max(1, Math.min(w - 2, x | 1)), Math.max(1, Math.min(h - 2, y | 1))])
    .slice(0, 16);
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
    return { ...def, cells, spawns: spawnPoints(w, h) };
  }

  const next = rng(def.seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let type;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) type = BLOCK.IRON;
      else if (x % 2 === 0 && y % 2 === 0) type = BLOCK.IRON;
      else {
        const r = next();
        if (r > def.density) type = BLOCK.FLOOR;
        else if (r < def.density * def.shrubs) type = BLOCK.SHRUB_WALK;
        else if (r < def.density * (def.shrubs + def.reinforced)) type = BLOCK.REINFORCED;
        else type = BLOCK.SOFT;
      }
      cells[at(x, y)] = packCell(type);
    }
  }

  // Clear a plus-shape around every spawn. Without this you can start boxed in, which on a
  // 16-minute round is a genuinely bad first thirty seconds.
  const spawns = spawnPoints(w, h);
  for (const [sx, sy] of spawns) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const x = sx + dx, y = sy + dy;
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
      if (cellType(cells[at(x, y)]) === BLOCK.IRON) continue;
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
