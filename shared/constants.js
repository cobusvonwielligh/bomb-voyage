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

export const ROUND_TICKS = 10 * 60 * TICK_HZ; // 18000

// Tiles of open sea kept visible on every side of the island. The board is scaled so the map
// plus this margin fits exactly — without it an island can sit flush against the panel edge and
// stop reading as an island.
export const SEA_MARGIN_TILES = 2;

// The board is never drawn smaller than this, whatever the window. Below about two thirds a
// 32-pixel tile is 21 pixels and a player is a smudge; past that point a camera that follows you
// is strictly better than a whole map you cannot read. Maps are sized so this floor is never hit
// on a normal window — it exists for the laptop somebody opens at 1280x720 with the panel up.
export const MIN_ZOOM = 0.68;
export const MAX_ZOOM = 2;
export const ROUND_INTERMISSION_MS = 20_000;

export const CHUNK_TILES = 8; // renderer chunk size
export const VIEW_TILES_W = 32;
export const VIEW_TILES_H = 20;

export const MAX_PLAYERS = 16;

// ─── Movement ─────────────────────────────────────────────────────────────────

// Index = skate count. Twenty percent slower than the first pass across the board: at the old
// pace a full-speed player crossed a tile in under five ticks, which is faster than the eye can
// plan a turn in and made corners feel like luck rather than judgement.
export const SPEED_UNITS_PER_TICK = [27, 31, 35, 39, 43];
export const MAX_SKATES = SPEED_UNITS_PER_TICK.length - 1; // 4
export const SLOWDOWN_NUM = 1, SLOWDOWN_DEN = 2; // speed * 1/2, integer division

export const HITBOX_UNITS = 20 * (UNITS_PER_TILE / TILE_PX); // 20 px → 160 units
export const HITBOX_REDUCED_UNITS = 10 * (UNITS_PER_TILE / TILE_PX);

// Slide toward a tile centre instead of stopping when the perpendicular offset is within this.
// This is what makes movement feel like Bomberman rather than like a grid. Do not remove.
// Widened from 0.375 to 0.44 of a tile after playtesting: at the old window you could be visibly
// most of the way into a doorway and still stop dead against its edge, which reads as the game
// refusing a move you clearly made. There is no overshoot risk — the assist only ever pulls you
// onto the centre line of a lane you are already in.
export const CORNER_ASSIST_UNITS = 112; // 0.44 tile. TUNE

// Input bitmask
export const IN_RIGHT = 1, IN_UP = 2, IN_LEFT = 4, IN_DOWN = 8, IN_BOMB = 16;

// Facing
export const DIR_R = 0, DIR_U = 1, DIR_L = 2, DIR_D = 3;

// ─── Bombs & fire ─────────────────────────────────────────────────────────────

export const FUSE_TICKS = 72;      // 2.4 s. TUNE
export const FUSE_TICKS_FAST = 36; // Fast Detonation
export const FIRE_TICKS = 15;      // 0.5 s
export const MAX_BOMBS = 16;        // hard ceiling on bombs alive anywhere, a safety valve

// What one player can have out at once. Separate from MAX_BOMBS and much lower: sixteen bombs in
// one pair of hands is not a loadout, it is a carpet, and a map where every tile is about to
// explode has no decisions left in it. The HUD shows the cap so the ceiling is visible, not a
// surprise when a Bomb pickup stops doing anything.
export const MAX_BOMBS_CARRIED = 8;
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
  // Everything outside the island. Behaves exactly like IRON to the simulation — not walkable,
  // not destructible, stops fire — and exists only so the renderer can tell "the sea" from "a
  // wall" and so a map can be any shape it likes inside its bounding rectangle.
  WATER: 8,
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
  [BLOCK.WATER]: 0,
};

export const BLOCK_DESTRUCTIBLE = b => BLOCK_HP[b] > 0;
export const BLOCK_FIRE_PASSES = b =>
  b === BLOCK.FLOOR || b === BLOCK.COLUMN || b === BLOCK.SHRUB_WALK || b === BLOCK.SHRUB_SOLID;
export const BLOCK_WALKABLE = (b, reduced) =>
  b === BLOCK.FLOOR || b === BLOCK.SHRUB_WALK || (reduced && b === BLOCK.COLUMN);

// The two the renderer treats as scenery rather than as level: it draws the sea under them and
// a rock on top. Both are indestructible, so a cached chunk never has to redraw because of one.
export const BLOCK_IS_EDGE = b => b === BLOCK.WATER || b === BLOCK.IRON;

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

export const PERK_DROP_CHANCE_SOFT = 0.35; // TUNE — the baseline, before supply and demand

/* How the drop rate responds to the board.
 *
 * A flat chance is wrong at both ends of a round. Early on sixteen players open walls at once,
 * perks pile up faster than anyone can walk to them, and the floor turns into a buffet. Late on,
 * with the soft walls gone and everyone fully kitted, nothing drops for minutes. Both ends are
 * the same bug: the rate ignores how many perks are actually lying around and how fast they are
 * being taken.
 *
 * Supply: count what is on the floor against a target that scales with the number of players
 * alive, because that is who is competing for them.
 * Demand: an exponential moving average of pickups, so a board being cleared quickly refills
 * quickly. HALFLIFE is in ticks; DECAY is derived from it so the two cannot drift apart. */
export const PERK_TARGET_PER_PLAYER = 0.9;
export const PERK_TARGET_MIN = 3;
export const PERK_SCARCE_BOOST = 2.2;      // empty floor: more than double the base rate
export const PERK_GLUT_FLOOR = 0.25;       // at or past target: a quarter of it
export const PERK_TAKE_HALFLIFE_TICKS = 8 * TICK_HZ;
export const PERK_TAKE_DECAY = Math.pow(0.5, 1 / PERK_TAKE_HALFLIFE_TICKS);
export const PERK_DEMAND_BOOST = 0.8;      // at most +80% when the board is being stripped
export const GIFT_DISEASE_CHANCE = 0.3;    // a Gift is a gamble; see shared/sim/perks.js
export const PERK_DROP_ALWAYS = [BLOCK.REINFORCED, BLOCK.MONOLITH];
export const PERK_EXPIRE_TICKS = 45 * TICK_HZ;
/* How long a perk spends visibly dying before it is removed.
 *
 * A drop that vanishes between two frames reads as a bug, or as somebody else having taken it
 * from across the map. Fading it out turns the same event into information you can act on: a
 * perk you can see going translucent is one you have a few seconds left to reach. Purely a
 * render concern — the sim still removes it on the exact tick. */
export const PERK_FADE_TICKS = 15 * TICK_HZ;
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

// How long you sit on the death screen before SPACE will do anything.
//
// It started at zero, which meant anyone holding the bomb key — everyone, always — respawned on
// the same tick they died and never saw it happen. Ten seconds is long enough that dying costs
// something, which is what makes not dying worth playing for.
export const RESPAWN_DELAY_TICKS = 10 * TICK_HZ; // 300

// How many of the furthest-apart spawn points to choose between. Always taking the single
// furthest makes every death send you to the same two corners; picking at random from the best
// handful keeps the "nobody lands in a firefight" guarantee while making it a real shuffle.
export const SPAWN_CANDIDATES = 5;
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

// ─── Levels ───────────────────────────────────────────────────────────────────
//
// XP is lifetime score. The curve is calibrated against the real scoring table rather than
// guessed: a decent player in a ten-minute round takes roughly 20 kills (2000), 150 blocks (300),
// 40 perks (200) and the survival bonus, minus about ten suicides, for ~2300 a round and
// ~13 800 an hour. Round that down to 12 000 to be honest about the average session.
//
// From there the only free parameters are where level 1 lands and where Veteran does. Level 1 at
// 200 XP is about a minute, which is the right feel for a first level; Veteran at 20 is pinned to
// 100 hours by the brief, and the exponent is DERIVED from those two rather than tuned by hand —
// so changing the hours or the scoring table moves the whole curve correctly instead of silently
// making the target wrong.
export const XP_PER_HOUR = 12_000;
export const HOURS_TO_VETERAN = 100;
export const VETERAN_LEVEL = 20;
export const XP_LEVEL_BASE = 200;
export const XP_LEVEL_EXP =
  Math.log((XP_PER_HOUR * HOURS_TO_VETERAN) / XP_LEVEL_BASE) / Math.log(VETERAN_LEVEL);

/** Total XP needed to have reached a level. Level 0 is where everybody starts. */
export const xpForLevel = n =>
  (n <= 0 ? 0 : Math.round(XP_LEVEL_BASE * Math.pow(n, XP_LEVEL_EXP)));

export const levelForXp = xp => {
  if (!(xp > 0)) return 0;
  // Invert the curve directly rather than looping: levels are unbounded above Veteran, and a
  // loop would be the one place a very long-lived leaderboard could stall.
  const n = Math.floor(Math.pow(xp / XP_LEVEL_BASE, 1 / XP_LEVEL_EXP));
  return xp >= xpForLevel(n + 1) ? n + 1 : n;
};

// The ladder. Four names, because a name you reach in an afternoon is not a rank.
export const TIERS = [
  { from: 0, name: 'Rookie' },
  { from: 11, name: 'Been around the block' },
  { from: 16, name: 'Pro' },
  { from: VETERAN_LEVEL, name: 'Veteran' },
];

export const tierForLevel = level => {
  let name = TIERS[0].name;
  for (const t of TIERS) if (level >= t.from) name = t.name;
  return name;
};

/**
 * Everything the UI needs to draw a progress bar, in one place so the server and the client can
 * never disagree about how far along somebody is.
 */
export function progressFor(xp) {
  const total = Math.max(0, xp | 0);
  const level = levelForXp(total);
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = Math.max(1, next - floor);
  return {
    xp: total,
    level,
    tier: tierForLevel(level),
    into: total - floor,          // XP earned since this level started
    need: span,                   // XP this level is worth
    nextAt: next,
    fraction: Math.min(1, (total - floor) / span),
  };
}

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

// A backgrounded tab stops being a player. Browsers throttle rAF in hidden tabs to about once a
// second, so a background tab cannot play — it can only hold a seat other people want and drift
// its clock. Input is cut the moment it hides; the socket goes after this.
export const IDLE_DISCONNECT_MS = 45_000;

// The server's own version, for the cases the client cannot report: a slept laptop, a killed
// renderer process, a tab the browser froze outright. A seat that has sent no input at all for
// this long is not being played and is given back.
export const IDLE_KICK_TICKS = 90 * TICK_HZ; // 90 s

// An id may take its own live seat back, but not endlessly. Two clients genuinely sharing an id
// would otherwise evict each other forever, each reconnect triggering the next — so past this
// many takeovers inside TAKEOVER_WINDOW_TICKS, the newcomer is given a fresh id instead.
export const TAKEOVER_LIMIT = 3;
export const TAKEOVER_WINDOW_TICKS = 20 * TICK_HZ; // 20 s

// ─── Presentation ─────────────────────────────────────────────────────────────
// Here rather than in art.js because the sim's tracer sampling rate must match the renderer's.

// How long a freshly spawned player is drawn oversized, shrinking to normal. Appearing out of
// nowhere in a sixteen-player scrum is invisible otherwise, and you need to know instantly
// whether the thing that just materialised is next to you.
export const SPAWN_POP_TICKS = 18;   // 0.6 s
export const SPAWN_POP_SCALE = 3.4;

export const TRACER_SAMPLES = 8;
export const TRACER_EVERY_TICKS = 3;
export const VOLUME_MUSIC_DEFAULT = 0.10;
export const VOLUME_SFX_DEFAULT = 0.75;

// Applied to every bus, on top of the sliders. A persisted slider value in localStorage would
// survive a change to the defaults above, so halving the output has to happen somewhere the
// user's stored preference cannot override.
export const VOLUME_MASTER = 0.5;

export const SFX_MAX_DISTANCE_TILES = 12;

// ─── Kill streaks ─────────────────────────────────────────────────────────────
// Kills inside this window, without dying, escalate. ACE is separate: everyone else, no deaths.

export const STREAK_WINDOW_TICKS = 6 * TICK_HZ;   // 6 s between kills to keep a streak alive
export const STREAK_NAMES = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'ULTRA KILL', 5: 'RAMPAGE' };
export const STREAK_ACE = 'ACE';

// ─── Admin ────────────────────────────────────────────────────────────────────

export const GAMESPEED_MIN = 10, GAMESPEED_MAX = 200;   // percent of TICK_HZ
export const BAN_MAX_HOURS = 24;

// Wall regrowth stops once this much of the open floor is wall again, or a long round silts up
// into a maze nobody can cross.
export const REGEN_MAX_FILL = 0.55;

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
