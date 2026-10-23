// Bomb Voyage — tuning constants and enums.
//
// FROZEN FILE. Both developers import this. Agree before changing it.
// Every magic number in the project lives here; see docs/RULES.md for the rationale.
// Values marked TUNE are first guesses to be adjusted in playtesting (PLAN task TUNE-1).

// ─── World ────────────────────────────────────────────────────────────────────

export const TILE_PX = 32;
export const UNITS_PER_TILE = 256; // integer sub-tile resolution; never use floats in the sim
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAP_EVERY_TICKS = 2; // → 15 Hz snapshots

export const ROUND_TICKS = 16 * 60 * TICK_HZ; // 28800
export const ROUND_INTERMISSION_MS = 20_000;

export const CHUNK_TILES = 8; // renderer chunk size
export const VIEW_TILES_W = 32;
export const VIEW_TILES_H = 20;

export const MAX_PLAYERS = 16;

// ─── Movement ─────────────────────────────────────────────────────────────────

export const SPEED_UNITS_PER_TICK = [34, 39, 44, 49, 54]; // index = skate count. TUNE
export const MAX_SKATES = SPEED_UNITS_PER_TICK.length - 1; // 4
export const SLOWDOWN_NUM = 1, SLOWDOWN_DEN = 2; // speed * 1/2, integer division

export const HITBOX_UNITS = 20 * (UNITS_PER_TILE / TILE_PX); // 20 px → 160 units
export const HITBOX_REDUCED_UNITS = 10 * (UNITS_PER_TILE / TILE_PX);

// Slide toward a tile centre instead of stopping when the perpendicular offset is within this.
// This is what makes movement feel like Bomberman rather than like a grid. Do not remove.
export const CORNER_ASSIST_UNITS = 96; // 0.375 tile. TUNE

// Input bitmask
export const IN_RIGHT = 1, IN_UP = 2, IN_LEFT = 4, IN_DOWN = 8, IN_BOMB = 16;

// Facing
export const DIR_R = 0, DIR_U = 1, DIR_L = 2, DIR_D = 3;

// ─── Bombs & fire ─────────────────────────────────────────────────────────────

export const FUSE_TICKS = 72;      // 2.4 s. TUNE
export const FUSE_TICKS_FAST = 36; // Fast Detonation
export const FIRE_TICKS = 15;      // 0.5 s
export const MAX_BOMBS = 16;
export const MAX_RADIUS = 6;
export const MAX_RADIUS_BLUE = 9;  // reserved, Blue fire is not in v1
export const START_BOMBS = 1;
export const START_RADIUS = 1;
export const CHAIN_CAP_PER_TICK = 64; // safety valve, see docs/RULES.md §3
export const SHRUB_RADIUS_PENALTY = 1;

// ─── Blocks ───────────────────────────────────────────────────────────────────

export const BLOCK = {
  FLOOR: 0,
  SOFT: 1,
  REINFORCED: 2,
  MONOLITH: 3,
  IRON: 4,
  COLUMN: 5,
  SHRUB_WALK: 6,
  SHRUB_SOLID: 7,
};

export const BLOCK_HP = {
  [BLOCK.FLOOR]: 0,
  [BLOCK.SOFT]: 1,
  [BLOCK.REINFORCED]: 6,
  [BLOCK.MONOLITH]: 9,
  [BLOCK.IRON]: 0,        // 0 = indestructible
  [BLOCK.COLUMN]: 0,
  [BLOCK.SHRUB_WALK]: 0,
  [BLOCK.SHRUB_SOLID]: 0,
};

export const BLOCK_DESTRUCTIBLE = b => BLOCK_HP[b] > 0;
export const BLOCK_FIRE_PASSES = b =>
  b === BLOCK.FLOOR || b === BLOCK.COLUMN || b === BLOCK.SHRUB_WALK || b === BLOCK.SHRUB_SOLID;
export const BLOCK_WALKABLE = (b, reduced) =>
  b === BLOCK.FLOOR || b === BLOCK.SHRUB_WALK || (reduced && b === BLOCK.COLUMN);

export const REGEN_EVERY_TICKS = 20 * TICK_HZ; // 600
export const REGEN_PER_CYCLE = 3;
export const REGEN_CLEAR_RADIUS_TILES = 4;

// ─── Perks ────────────────────────────────────────────────────────────────────

export const PERK = {
  BOMB: 1, FIRE: 2, SKATE: 3, SHIELD: 4, GIFT: 5,
  // Reserved — designed for, not implemented in v1. Give one a weight to turn it on.
  KICK: 6, JELLY: 7, DETONATOR: 8, BAT: 9, JETPACK: 10,
  NUKE: 11, BLUE_FIRE: 12, HEART: 13, KEY: 14,
};

export const PERK_WEIGHTS = {
  [PERK.BOMB]: 30, [PERK.FIRE]: 30, [PERK.SKATE]: 20, [PERK.SHIELD]: 12, [PERK.GIFT]: 8,
  [PERK.KICK]: 0, [PERK.JELLY]: 0, [PERK.DETONATOR]: 0, [PERK.BAT]: 0, [PERK.JETPACK]: 0,
  [PERK.NUKE]: 0, [PERK.BLUE_FIRE]: 0, [PERK.HEART]: 0, [PERK.KEY]: 0,
};

export const PERK_DROP_CHANCE_SOFT = 0.35; // TUNE
export const GIFT_DISEASE_CHANCE = 0.3;    // a Gift is a gamble; see shared/sim/perks.js
export const PERK_DROP_ALWAYS = [BLOCK.REINFORCED, BLOCK.MONOLITH];
export const PERK_EXPIRE_TICKS = 45 * TICK_HZ;
export const PERKS_DROPPED_ON_DEATH = 3;
export const MAX_SHIELDS = 1;

// ─── Statuses ─────────────────────────────────────────────────────────────────

export const STATUS = {
  INVULN: 1, PACIFISM: 2, SLOWDOWN: 4, INVISIBLE: 8,
  CHANGELING: 16, REDUCTION: 32, FAST_DET: 64,
  // Reserved
  NYAN: 128,
};

export const STATUS_TICKS = {
  [STATUS.INVULN]: 90,        // 3 s from respawn
  [STATUS.PACIFISM]: 300,
  [STATUS.SLOWDOWN]: 300,
  [STATUS.INVISIBLE]: 300,
  [STATUS.CHANGELING]: 300,
  [STATUS.REDUCTION]: 450,
  [STATUS.FAST_DET]: 300,
};

export const INVULN_TICKS_SHIELD = 60; // 2 s after a shield breaks

// Shortest possible stay on the death screen. Zero meant that anyone holding the bomb key — which
// is everyone, all the time — respawned on the same tick they died and never saw it happen.
export const RESPAWN_DELAY_TICKS = 30; // 1 s
export const CONTAGIOUS = STATUS.PACIFISM | STATUS.SLOWDOWN | STATUS.INVISIBLE |
                          STATUS.CHANGELING | STATUS.REDUCTION | STATUS.FAST_DET;
export const CONTAGION_COOLDOWN_TICKS = TICK_HZ; // 1 s per pair

// ─── Scoring & ranks ──────────────────────────────────────────────────────────

export const SCORE = {
  KILL: 100,
  SUICIDE: -25,
  PERK: 5,
  PERK_CAPPED: 15,
  BLOCK: 2,
  SURVIVE_ROUND: 50,
};

export const RANK_NAMES = [
  'Rookie', 'Private', 'Private First Class', 'Corporal', 'Sergeant',
  'Second Lieutenant', 'First Lieutenant', 'Captain', 'Major', 'Lieutenant Colonel',
  'Colonel', 'Brigadier General', 'Major General', 'Lieutenant General', 'General', 'Marshal',
];

// Generated, never hand-maintained. Rank 1 = 1024, matching Game of Bombs' profile screen.
export const RANK_THRESHOLDS = RANK_NAMES.map((_, n) =>
  n === 0 ? 0 : Math.round(1024 * Math.pow(n, 1.6) / 64) * 64);

export const rankForScore = score => {
  let r = 0;
  while (r + 1 < RANK_THRESHOLDS.length && score >= RANK_THRESHOLDS[r + 1]) r++;
  return r;
};

// ─── Net ──────────────────────────────────────────────────────────────────────

export const INTERP_DELAY_TICKS = 4;     // ≈133 ms behind, for remote players only
export const CLOCK_SAFETY_MS = 50;       // added to rtt/2 when computing the client's lead
export const PING_EVERY_MS = 2000;
export const RTT_SAMPLES = 5;            // rolling minimum, see docs/NETCODE.md §2
export const PENDING_INPUT_PANIC = 60;   // stop predicting above this
export const POSITION_TOLERANCE_MULT = 1.5; // server sanity check, not anti-cheat
export const MAX_MESSAGE_BYTES = 4096;
export const CHAT_MAX_CHARS = 140;
export const CHAT_MIN_INTERVAL_MS = 1000;
export const CHAT_HISTORY = 50;
export const NAME_MAX_CHARS = 20;

// ─── Presentation ─────────────────────────────────────────────────────────────
// Here rather than in art.js because the sim's tracer sampling rate must match the renderer's.

export const TRACER_SAMPLES = 8;
export const TRACER_EVERY_TICKS = 3;
export const VOLUME_MUSIC_DEFAULT = 0.10;
export const VOLUME_SFX_DEFAULT = 0.75;
export const SFX_MAX_DISTANCE_TILES = 12;

// 16 hues evenly spaced 22.5° apart, handed out in bit-reversed order so the first few joiners
// get maximally separated colours. Adjacent hues also alternate lightness, so the two closest
// hues always differ on a second axis too.
// (The obvious golden-angle trick is worse here: for exactly 16 slots its minimum separation is
// 12.4°, against 22.5° for this.)
const HUE_ORDER = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
export const playerHueSlot = i => HUE_ORDER[((i % 16) + 16) % 16];
export const playerColor = i => {
  const h = playerHueSlot(i);
  return `hsl(${h * 22.5} 74% ${h % 2 ? 52 : 64}%)`;
};
