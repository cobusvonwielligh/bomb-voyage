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

// What /roundtime will accept, in minutes. The floor is a tenth of a minute — six seconds — which
// is short enough to be useless for a real round and exactly right for testing the round-end
// path without waiting ten minutes for it.
export const ROUNDTIME_MIN_MIN = 0.1;
export const ROUNDTIME_MAX_MIN = 60;

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

/* The count-in: five seconds at the top of every round, and NOBODY MOVES.
 *
 * Shared rather than a client constant, because it is a rule now and not a caption. The room
 * zeroes every input — people and bots alike — until `state.tick` reaches this, and the client
 * neither predicts nor sends over the same window, so the digit on screen and the frozen board
 * are two views of one fact.
 *
 * The round clock is pushed out by the same amount (see `roundEndsAtTick`), so a ten-minute round
 * is still ten minutes of play rather than nine minutes and fifty-five seconds of it.
 *
 * It exists because a round used to begin with sixteen people arriving on a map none of them had
 * seen, already live: the first second was spent working out where you were, and anybody who
 * already knew the map had a free head start. Five seconds of looking is the fairest thing a
 * round can start with.
 */
export const COUNT_IN_TICKS = 5 * TICK_HZ;

export const CHUNK_TILES = 8; // renderer chunk size

export const MAX_PLAYERS = 16;

// ─── Movement ─────────────────────────────────────────────────────────────────

// Index = skate count. The BASE is twenty percent slower than the first pass across the board:
// at the old pace a full-speed player crossed a tile in under five ticks, which is faster than
// the eye can plan a turn in and made corners feel like luck rather than judgement.
//
// The STEP is double what it was — 8 units a boot rather than 4. Four was a 59% gain across all
// four boots; eight makes a fully booted player 119% faster than a fresh one, 3.2 tiles a second
// against 6.9. Worth crossing the map for, which the old step was not.
export const SPEED_UNITS_PER_TICK = [27, 35, 43, 51, 59];
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
export const IN_RIGHT = 1, IN_UP = 2, IN_LEFT = 4, IN_DOWN = 8, IN_BOMB = 16, IN_SLIDE = 32;
// Everything a client is allowed to assert. `input` masks with this, so a crafted packet with
// high bits set cannot reach the simulation carrying anything the keyboard cannot produce.
export const IN_MASK = IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN | IN_BOMB | IN_SLIDE;

// Facing
export const DIR_R = 0, DIR_U = 1, DIR_L = 2, DIR_D = 3;

/* The slide. Double-tap a direction and go.
 *
 * It exists because the game had exactly one verb for distance — walking — and the whole fight is
 * about whether you can be somewhere before a fuse ends. A slide is the answer to "I am two tiles
 * from cover and the bomb has half a second left", and the reason it is not simply free speed is
 * the price: a fifth of the bar per slide, so three of them is most of your wind.
 *
 * The physics, and all three parts matter:
 *
 *   SLIDE_PEAK_NUM/DEN  the launch, as a multiple of your walking pace. Three times, so the first
 *                       tick is unmistakably not running. It scales WITH your boots
 *                       rather than being a flat number: a booted player who slides should still
 *                       be faster than an unbooted one who slides, or the perk stops mattering at
 *                       exactly the moment the perk matters most.
 *   SLIDE_DRAG_NUM/DEN  friction, applied to the velocity every tick. Ninety-four percent — the slide
 *                       decelerates the whole way out, which is what makes it read as momentum
 *                       rather than as a teleport, and it is the reason you can be carried past
 *                       the turn you wanted if you start it too late. That mistake is the cost of
 *                       using the mechanic badly, and it is a cost you can see coming.
 *   SLIDE_EXIT_UNITS    below this pace it is over, so it ends by running out of speed rather
 *                       than by a timer expiring. A timer gives every slide the same length
 *                       whatever the surface or the boots; drag gives each one its own.
 *
 * SLIDE_MAX_TICKS is a seatbelt against a tuning accident, not the mechanic: at these numbers the
 * exit speed arrives first, after about eighteen ticks — six tenths of a second and three and a
 * half tiles, against the one and three quarters that running the same ticks would cover. The
 * first pass at this was a 2.5x launch against a tenth of drag a tick, which decayed so fast that
 * the whole slide was worth about a sixth of a tile more than walking: a stamina cost for nothing.
 * The lesson is that the DRAG, not the launch, decides what a dash is worth.
 */
export const SLIDE_PEAK_NUM = 3, SLIDE_PEAK_DEN = 1;
export const SLIDE_DRAG_NUM = 47, SLIDE_DRAG_DEN = 50;
export const SLIDE_EXIT_UNITS = 26;
export const SLIDE_MAX_TICKS = 30;
// A fifth of a fresh bar, and it is taken in full at the launch rather than per tick: a slide you
// can abort halfway through for half price is a slide nobody ever commits to. Scaled with
// STAMINA_MAX for the same reason the Stim is — three slides should still be most of your wind.
export const SLIDE_STAMINA_COST = 1400;
// You may not chain them. Long enough that the second slide is a decision rather than the rest of
// the first one, short enough to still be the answer to a chase.
export const SLIDE_COOLDOWN_TICKS = 18;
/* How long the client gives you between the two taps.
 *
 * Client-side only: the server is told "slide" by a bit in the mask and never sees the taps, which
 * is what keeps the gesture a matter of local feel rather than of latency. Long enough to be
 * comfortable, short enough that walking left-left-left in a corridor does not launch you.
 */
export const SLIDE_DOUBLE_TAP_MS = 260;

// ─── Bombs & fire ─────────────────────────────────────────────────────────────

export const FUSE_TICKS = 72;      // 2.4 s. TUNE
export const FUSE_TICKS_FAST = 36; // Fast Detonation
export const FIRE_TICKS = 15;      // 0.5 s — how long a blast is DRAWN

/* How long a blast actually kills for, as a fraction of how long it is drawn.
 *
 * Fire that is visibly dying should not still be lethal. The tail of the animation is a puff of
 * smoke and a few embers, and dying to it feels like the game cheating — you watched the
 * explosion finish and then died anyway. Lethal for the first two thirds, decorative for the
 * last third, which is about five ticks of grace at the end of every blast.
 *
 * The other direction is worse and is why this is a fraction rather than a flat subtraction: if
 * the kill window ever outlived the drawing, people would die to fire that was not on screen. */
export const FIRE_LETHAL_NUM = 2, FIRE_LETHAL_DEN = 3;
export const FIRE_LETHAL_TICKS = Math.round((FIRE_TICKS * FIRE_LETHAL_NUM) / FIRE_LETHAL_DEN);
export const MAX_BOMBS = 16;        // hard ceiling on bombs alive anywhere, a safety valve

/* What one player can have out at once, and how far one reaches. Both five.
 *
 * Separate from MAX_BOMBS, the safety valve, and much lower: sixteen bombs in one pair of hands
 * is not a loadout, it is a carpet, and a map where every tile is about to explode has no
 * decisions left in it. The HUD shows both caps so the ceiling is visible rather than a surprise
 * when a pickup stops doing anything.
 *
 * Down from eight and six. Eight bombs was most of a corridor at once and a radius of six was
 * most of a room, so a fully kitted player did not have to aim — the two of them together cover
 * so much floor that position stopped being the thing the game is about. Five and five still feel
 * like a full loadout and still leave somewhere to stand.
 *
 * A powder keg is deliberately above the cap (POWDER_RADIUS), which is how the renderer and the
 * sound both identify one without a flag on the wire — so this number dropping widens that gap
 * rather than closing it.
 */
export const MAX_BOMBS_CARRIED = 5;
export const MAX_RADIUS = 5;
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
  // A powder keg. Destructible like a soft wall, but detonating one sets off a blast several
  // times the size of the bomb that lit it. Rare on purpose — see POWDER_* below.
  POWDER: 9,
  // Ice. Breaks in one hit like a soft wall, but melts instead of breaking: it floods its own
  // tile and the four next to it with a short-lived puddle. See ICE_* and PUDDLE_* below.
  ICE: 10,
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
  [BLOCK.POWDER]: 1,      // one hit, like a soft wall: the point is the explosion, not the siege
  [BLOCK.ICE]: 1,
};

export const BLOCK_DESTRUCTIBLE = b => BLOCK_HP[b] > 0;
export const BLOCK_WALKABLE = (b, reduced) =>
  b === BLOCK.FLOOR || b === BLOCK.SHRUB_WALK || (reduced && b === BLOCK.COLUMN);

export const REGEN_EVERY_TICKS = 20 * TICK_HZ; // 600
export const REGEN_PER_CYCLE = 3;
export const REGEN_CLEAR_RADIUS_TILES = 4;

/* Powder kegs.
 *
 * At most six in a round, and at least one guaranteed — a map event you can plan around is worth
 * far more than a random one you might never see. Six over ten minutes is roughly one every
 * ninety seconds, which is often enough to be part of the map rather than a rumour. Placement rides on the existing regrowth cycle
 * (every 20 s) because that function already knows which tiles are quiet: dropping a keg next to
 * a player would be a free kill nobody could read coming.
 *
 * The blast is a bomb with a much larger radius, detonating on the tick the keg breaks. Nothing
 * special in the blast code — a keg IS a bomb, which is why it chains through other kegs, bombs
 * and walls exactly the way you would expect.
 */
export const POWDER_MAX_PER_ROUND = 6;
export const POWDER_RADIUS = 7;
export const POWDER_CHANCE_PER_CYCLE = 0.36;
// Six minutes in, the first one stops being optional. A round must never pass without one.
export const POWDER_GUARANTEE_TICK = Math.round(0.6 * 10 * 60 * TICK_HZ);

/* Ice, and the puddle it leaves.
 *
 * One soft wall in twenty is ice, at map generation and when walls grow back. Rare enough that a
 * patch of water is an event, common enough that every map has a few.
 *
 * A blast that reaches ice melts it — no perk, the water IS the drop — and floods the ice tile
 * plus its four neighbours, wherever those are walkable. Five tiles at most. The puddle lasts
 * EIGHT seconds, the last PUDDLE_FADE_TICKS of them visibly drying up.
 *
 * Eight, up from four. At four a puddle was gone before anybody but the person who made it
 * could do anything about it: ice is one soft wall in twenty, so a patch of water is a rare
 * thing to find, and a rare thing that evaporates before you can cross the map to use it is a
 * rare thing nobody ever uses. Eight seconds is long enough for the fight to move INTO the
 * water, which is the point of having it — it is terrain, not a side effect.
 *
 * Standing in water halves your pace and makes you slide: let go of the keys and you carry on
 * the way you were going for PUDDLE_SLIDE_TICKS before you stop. Momentum, not ice-rink chaos —
 * at half pace that is about a third of a tile, enough to overshoot a corner you were braking
 * for and not enough to carry you into a blast you were standing clear of. */
/* Seagulls.
 *
 * Now and then a gull crosses the island — one at a time usually, two at most — on a straight
 * line with a lazy weave in it, entering and leaving well outside the board. It is scenery right
 * up until somebody catches one in a blast, and then it drops a gold coin.
 *
 * Catching one is meant to be HARD, and three things make it so:
 *   - it is only low enough to hit during a dive: a short dip every few seconds, the bottom
 *     GULL_LOW_TICKS of it, which you can read coming from its shadow closing in under it;
 *   - only fire still in its lethal window counts, the same window that kills players;
 *   - it is quick — about four tiles a second — and over water there is nothing to burn it with.
 * So it is a timing shot against a moving target, which is the most satisfying thing a bomb can
 * do in a game about standing still in the right place.
 *
 * The coins do not count against GOLD_MAX_PER_ROUND. That cap is about the floor paying out
 * by luck; these were earned.
 */
export const GULL_FIRST_TICK = 25 * TICK_HZ;         // the first one comes early, so people see it
// Twice as often as it was, which was 40-90 s. At that spacing most rounds saw three or four
// birds and a player who wanted to try the shot had to wait a minute for a second attempt; a
// trick shot nobody gets to practise is a trick shot nobody lands.
export const GULL_GAP_MIN_TICKS = 20 * TICK_HZ;      // one every 20-45 s
export const GULL_GAP_MAX_TICKS = 45 * TICK_HZ;
export const GULL_MAX = 2;
// A fifth slower than the 34 it was: about three tiles a second. Speed was doing too much of the
// difficulty on its own — at four tiles a second the window over any one tile was shorter than a
// fuse, so the only way to land it was to have already had a bomb there.
export const GULL_SPEED_UNITS = 27;
export const GULL_OFFMAP_TILES = 4;                  // how far outside the map it enters and leaves
/* It dawdles over the island and hurries over the sea.
 *
 * The flight is a straight line at a constant pace, and the pace that makes the middle of it
 * — the part over the board, the only part you can do anything about — worth aiming at is much
 * slower than the pace that keeps the empty sea crossing from being dull. So progress along the
 * line is eased rather than linear: `f + k·sin(2πf)/2π`, which leaves both ends where they were
 * and runs at (1 + k·cos 2πf) of the average pace — a little over half speed across the middle,
 * half again as fast on the way in and out. Total flight time is unchanged, so nothing else has
 * to know. Closed form and monotonic for k < 1, which is what keeps `gullAt` a description of a
 * flight rather than a simulation of one.
 */
export const GULL_LOITER = 0.45;
export const GULL_WEAVE_UNITS = 300;                 // the side-to-side drift, a little over a tile
export const GULL_WEAVE_TICKS = 170;                 // ...over about six seconds
export const GULL_DIVE_EVERY_TICKS = 105;            // a dive every three and a half seconds
export const GULL_DIVE_TICKS = 27;                   // each lasting a bit under one
// The bottom of the dive, when it is low enough to burn: the middle two fifths of each dive,
// about eleven ticks, which is one tick in nine of its flight.
export const GULL_LOW_ALT = 0.22;
/* What one is worth, and it goes straight to whoever lit the fire.
 *
 * It used to drop a single coin on the nearest clear floor tile, which was the wrong shape for
 * the thing it was rewarding: the hard part is the shot, and a coin on the ground after it turns
 * the hard part into a race to the spot — often won by somebody who had nothing to do with it,
 * and sometimes by nobody at all when the only floor nearby was about to be on fire. Three,
 * because it is the rarest thing in the game and a reward you can lose by half a second is not a
 * reward. A blast with no owner — a powder keg — still leaves a coin on the floor; see gulls.js.
 */
export const GULL_COINS = 3;

export const ICE_CHANCE = 0.05;
export const PUDDLE_TICKS = 8 * TICK_HZ;
// The drying-up, scaled with the lifetime so the tail is still the same share of it — a puddle
// that sits full for six and a half seconds and then vanishes in a blink reads as a bug.
export const PUDDLE_FADE_TICKS = Math.round(3 * TICK_HZ);   // render only
export const PUDDLE_SPEED_NUM = 1, PUDDLE_SPEED_DEN = 2;
export const PUDDLE_SLIDE_TICKS = 8;

/* Stamina.
 *
 * Running flat out for ten seconds empties it; once empty you move at half pace until you have
 * recovered a third of it back. The hysteresis is the important part — a bare "zero means slow"
 * rule flips the speed on and off every single tick at the boundary, which is unplayable and
 * looks like lag.
 *
 * It regenerates whether you are moving or not, just twice as fast when you stand still. That
 * makes stopping a real tactical choice rather than a punishment, and it means an exhausted
 * player is never stuck: limping still refills, slowly.
 */
/* Counted in TWENTIETHS of a unit, so every rate stays a whole number.
 *
 * The sim is integers only — floats in a shared simulation are a determinism bug waiting for a
 * platform that rounds differently. Each time these rates want a percentage change, the unit has
 * to be fine enough to express it: wanting 15% off rates of 1 and 2 made the unit tenths, and
 * wanting another 15% off a drain of 10 made it twentieths, because 8.5 is not a whole number
 * either. Doubling the resolution is free — nothing reads these as anything but a ratio against
 * STAMINA_MAX — and it leaves room for the next tweak.
 *
 * The numbers, in seconds, which is the only unit anybody can feel:
 *
 *   running     6900 at 17 a tick is 13.5 s, up from 11.5. The drain is 15% slower, so the bar
 *               takes 15% longer to reach the end.
 *   standing    6900 at 53 a tick is 4.3 s from empty to full, down from 5. Regen is 15% faster,
 *               so catching your breath is quicker than it was.
 *   limping     28 a tick while exhausted — the same 15% on the slower of the two regens, so
 *               the relationship between them is untouched: standing is still about twice as
 *               good as limping, which is what makes stopping a decision.
 */
export const STAMINA_MAX = 6900;
export const STAMINA_DRAIN_PER_TICK = 17;
export const STAMINA_REGEN_MOVING = 28;            // only while exhausted; see movement.js
export const STAMINA_REGEN_IDLE = 53;
export const STAMINA_RECOVER_UNITS = Math.round(STAMINA_MAX / 3);
export const STAMINA_TIRED_NUM = 1, STAMINA_TIRED_DEN = 2;   // half pace when exhausted
// Below this fraction the indicator appears beside the player. Above it nothing is drawn: a
// meter that is always on screen is a meter nobody looks at. Raised from a half to seven tenths
// — at a half the warning and the limp arrived almost together, which is a notification rather
// than a warning.
export const STAMINA_SHOW_AT = 0.7;
// Below this the gauge goes red and flashes. A third, which is also STAMINA_RECOVER_UNITS — the
// point the exhausted latch lets go — so the warning zone and the recovery line are the same
// line, and the red means one thing: from here, running out is a live possibility.
export const STAMINA_LOW_AT = 1 / 3;
// Each Stim adds this much to your ceiling, up to MAX_STAMINA_LEVELS of them. Four of them takes
// thirteen and a half seconds of running to twenty-seven. Scaled with STAMINA_MAX, so a Stim is
// still worth two and a bit seconds rather than quietly becoming worth one.
export const STAMINA_PER_LEVEL = 1500;
export const MAX_STAMINA_LEVELS = 4;
export const staminaMaxFor = p => STAMINA_MAX + Math.min(p?.staminaLevel ?? 0, MAX_STAMINA_LEVELS) * STAMINA_PER_LEVEL;

// ─── Perks ────────────────────────────────────────────────────────────────────

export const PERK = {
  BOMB: 1, FIRE: 2, SKATE: 3, SHIELD: 4,
  // 5 was the Gift, a random perk that sometimes handed out a disease. Removed; the number stays
  // retired so an old client never mistakes a new perk for it.
  // Reserved — designed for, not implemented in v1. Give one a weight to turn it on.
  KICK: 6, JELLY: 7, DETONATOR: 8, BAT: 9, JETPACK: 10,
  NUKE: 11, BLUE_FIRE: 12, HEART: 13, KEY: 14,
  // Raises your maximum stamina, so you can run for longer before the limp.
  STAMINA: 15,
  // Rum: tough and useless. See STATUS.DRUNK.
  RUM: 16,
  /* A gold coin. Changes nothing about how you play and is the rarest thing on the board.
   *
   * Every other perk is a capability. This is a COLLECTIBLE: it makes no difference to the
   * round you are in, it survives the round you are in, and it is the only thing here that
   * accumulates. Currency later; for now it is a number that goes up, which is most of what
   * currency is anyway. */
  GOLD: 17,
};

/* Gold coins. 2% of drops and never more than five a round.
 *
 * Two limits, not one, and they do different jobs. The WEIGHT makes any given coin a surprise.
 * The CAP makes the surprise finite: without it a long round on a map full of soft walls pays
 * out far more than a short one on a sparse map, so the reward would be a function of the map
 * rather than of the player. Five is about one every two minutes at the top end.
 *
 * Worth a lot of XP, because the whole point of something this rare is that finding one matters.
 * SCORE.GOLD is roughly four kills.
 */
export const GOLD_MAX_PER_ROUND = 5;

/* What actually drops.
 *
 * Bombs and Fire are the backbone of the game — without them everybody is stuck on one bomb at
 * radius one for ten minutes, and there is no way to build a turn around anything. Everything
 * below the live row is reserved and has always been zero. A perk at zero weight costs nothing
 * and switches back on with one number.
 */
export const PERK_WEIGHTS = {
  /* 9 of 420 is 2.1%. A tenth of the rum, which was itself already the rare one. */
  [PERK.GOLD]: 9,
  /* Every weight but rum is the old one multiplied by four.
   *
   * Rum wanted to be a quarter as likely as it was, and the honest way to do that is to make
   * the denominator bigger rather than to pull one number down to 3 and hope: at these
   * magnitudes a single step is a quarter of a percent, so the next tweak to it can be as small
   * as it needs to be. All the OTHER perks keep their exact relative frequencies, which is the
   * property that matters — this change is about rum and nothing else.
   *
   * 11 of 411 is 2.7%, down from 11 of 111, which was 9.9%. It is the only perk that changes
   * how the game is played rather than how well, so it should be an event you remember rather
   * than a thing you have.
   */
  [PERK.BOMB]: 108, [PERK.FIRE]: 100, [PERK.SKATE]: 72, [PERK.SHIELD]: 48,
  [PERK.STAMINA]: 72, [PERK.RUM]: 11,
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
// Two, so a shield can be stacked: each one survives one hit, and a second is worth walking to
// rather than a capped pickup. Drawn on the player as a blue ring per shield — see drawShields.
export const MAX_SHIELDS = 2;

/* One shield per hit, and a moment's grace after it. Never two shields in one instant.
 *
 * The rule before this was "every blast that reaches you costs a shield the tick it arrives, and
 * two at once cost two". That is defensible and it played terribly: a chain reaction or a
 * crossfire is ONE event as far as the player is concerned, and walking into it with two shields
 * and coming out with none — having survived, having done nothing wrong, with no chance to react
 * in between — made the second shield feel like it had never existed. The whole reason to walk
 * across the map for a second shield is that it is a second chance, and a second chance you can
 * lose in the same frame as the first is not one.
 *
 * So a shield that absorbs a blast also buys this many ticks in which nothing can touch you:
 * further blasts in the window are simply shrugged off, and the NEXT one after it comes out of
 * the next shield. Eighteen ticks, six tenths of a second — comfortably longer than a blast's
 * lethal window (FIRE_LETHAL_TICKS), so one explosion can never reach past the grace it just
 * triggered, and short enough that it is a flinch rather than a free run through a fire.
 */
export const SHIELD_GRACE_TICKS = 18;

/* Password length, shared so the hint text and the rule cannot drift apart.
 *
 * The floor is the only composition rule there is: length is the one requirement that survives
 * contact with people, and "must contain a digit" produces "password1". The CEILING is the
 * security-relevant half — scrypt's cost grows with its input, so an unbounded password field is
 * an invitation to burn a core for as long as somebody holds a socket open. The enforcement lives
 * on the server (badPassword in server/accounts.js); the client only quotes these.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

// ─── Statuses ─────────────────────────────────────────────────────────────────

export const STATUS = {
  INVULN: 1, PACIFISM: 2, SLOWDOWN: 4, INVISIBLE: 8,
  CHANGELING: 16, REDUCTION: 32, FAST_DET: 64,
  // Rum. Blast arms stop hurting you; only the tile the bomb was on still does. In exchange
  // you cannot walk straight.
  DRUNK: 128,
  /* Knocked about by somebody sliding into you. A question mark over your head, no bombs, and a
   * quarter off your pace — for a moment. See CONFUSED_TICKS.
   *
   * The three together are the point. Taking the bombs away is what makes a slide a MOVE rather
   * than a faster walk: you can barge through the pirate holding a doorway and they cannot answer
   * by dropping one at your feet. The slowdown is small and short because it is a stumble, not a
   * disease — and it is not CONTAGIOUS, because it did not come from a bottle.
   */
  CONFUSED: 256,
};

export const STATUS_TICKS = {
  [STATUS.INVULN]: 90,        // 3 s from respawn
  [STATUS.PACIFISM]: 300,
  [STATUS.SLOWDOWN]: 300,
  [STATUS.INVISIBLE]: 300,
  [STATUS.CHANGELING]: 300,
  [STATUS.REDUCTION]: 450,
  [STATUS.FAST_DET]: 300,
  // 360 ticks, 12 s. Was 600, then 480. Twenty seconds of fighting the controls is long enough
  // that the only play is to wait it out, which makes rum a timeout rather than a trade-off;
  // sixteen was still on the long side, so a quarter came off it on request.
  [STATUS.DRUNK]: 360,
  // 45 ticks, a second and a half. Short on purpose: it is there to buy the slider the doorway,
  // not to take somebody out of the fight. Long enough to matter, over before it is annoying.
  [STATUS.CONFUSED]: 45,
};

// A quarter off your pace while you are seeing stars. Integer division like every other
// multiplier here, so the sim stays float-free.
export const CONFUSED_NUM = 3, CONFUSED_DEN = 4;

/* How drunk is drunk.
 *
 * The sway is a slow wander added to your heading, in units, applied across the axis you are
 * walking along. Not a random walk and not an input inversion: inversion is just broken
 * controls, and randomness cannot be predicted by the client, which would make every step a
 * reconciliation. It is a sum of two sines on the tick, seeded per player, so both machines
 * compute the same stagger and it still never repeats in a way anybody notices.
 */
// 20, down from 34. At a third of a tile the sway was not 'drunk', it was 'the controls are
// broken': you could not hold a corridor at all, so the only thing to do with rum was wait
// twenty seconds. Enough to be visibly unsteady and still thread a gap is the useful amount.
export const DRUNK_SWAY_UNITS = 20;
export const DRUNK_SWAY_RATE_A = 0.09, DRUNK_SWAY_RATE_B = 0.041;
/* How often a drunk takes a step that was not asked for.
 *
 * The sway alone is a wobble you can simply correct for after a few seconds. The stagger is
 * what makes it genuinely hard: for a handful of ticks the axis you are travelling on is not
 * the one you pressed. Deterministic in (tick, seat) like everything else here, so the client
 * predicts the stumble rather than being corrected into it.
 */
// Less often and much shorter. Seven ticks is nearly a quarter of a second of going somewhere
// you did not ask for, which at four stumbles a second of walking is most of the walking.
export const DRUNK_STAGGER_EVERY = 79;     // ticks between stumbles, prime so it never syncs
export const DRUNK_STAGGER_TICKS = 4;      // how long one lasts

/* How long you sit on the death screen before SPACE will do anything.
 *
 * It started at zero, which meant anyone holding the bomb key — everyone, always — respawned on
 * the same tick they died and never saw it happen. Then ten, at which a careless rush was nearly
 * free. Then fifteen: long enough that dying costs you something you feel, and short enough to
 * watch the fight you just left, which is the other thing the wait is for.
 *
 * Thirteen and a half now — a second and a half off, on request. Measured against the rest of the
 * round it is a small change; measured against the thing it governs, which is how long you sit
 * still after a mistake, a second and a half is most of the difference between reading the
 * scoreboard and waiting. */
export const RESPAWN_DELAY_TICKS = Math.round(13.5 * TICK_HZ); // 405

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
  // A gold coin, which is 2% of drops and capped at five a round. Four kills' worth: rare
  // enough that it has to be worth stopping for, bounded enough that it cannot be a strategy.
  GOLD: 400,
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
export const MAX_MESSAGE_BYTES = 4096;
export const CHAT_MAX_CHARS = 140;
export const CHAT_MIN_INTERVAL_MS = 1000;
export const NAME_MAX_CHARS = 20;

// A backgrounded tab stops being a player. Browsers throttle rAF in hidden tabs to about once a
// second, so a background tab cannot play — it can only hold a seat other people want and drift
// its clock. Input is cut the moment it hides; the socket goes after this.
export const IDLE_DISCONNECT_MS = 45_000;

// The server's own version, for the cases the client cannot report: a slept laptop, a killed
// renderer process, a tab the browser froze outright. A seat that has sent no input at all for
// this long is not being played and is given back.
export const IDLE_KICK_TICKS = 90 * TICK_HZ; // 90 s

// ─── Presentation ─────────────────────────────────────────────────────────────
// Here rather than in art.js because the sim's tracer sampling rate must match the renderer's.

// How long a freshly spawned player is drawn oversized, shrinking to normal. Appearing out of
// nowhere in a sixteen-player scrum is invisible otherwise, and you need to know instantly
// whether the thing that just materialised is next to you.
/* Arriving. The sprite lands at SPAWN_POP_SCALE times its size and collapses to normal.
 *
 * Twenty is absurd on purpose — at a zoomed-out map that is a pirate the height of the island,
 * which is exactly the point: in a sixteen-player scrum the question "where did I just come
 * back" has to be answerable in one frame, from the far corner of the screen. The quintic
 * ease-out below is what keeps it from being obnoxious: it is past 20x within three frames and
 * spends most of the window near normal size. */
export const SPAWN_POP_TICKS = 24;   // 0.8 s
export const SPAWN_POP_SCALE = 20;

export const TRACER_SAMPLES = 8;
export const TRACER_EVERY_TICKS = 3;
export const VOLUME_MUSIC_DEFAULT = 0.10;
export const VOLUME_SFX_DEFAULT = 0.75;

// Applied to every bus, on top of the sliders. A persisted slider value in localStorage would
// survive a change to the defaults above, so halving the output has to happen somewhere the
// user's stored preference cannot override.
export const VOLUME_MASTER = 0.5;

/* Per-bus trim, on top of VOLUME_MASTER.
 *
 * The two buses carried the identical master trim, which is only right if the two want the
 * same headroom — and they do not. Effects are transients with a 12:1 limiter on them and sit
 * under the music more than they should; the music is a continuous mastered mix and arrives
 * hotter than anything synthesised next to it.
 *
 * These multiply the ceiling, not the default: somebody with a stored slider value gets the
 * change too, which a default could never do. */
export const VOLUME_TRIM_SFX = 1.2;     // +20%
// Halved again (was 0.75) at the user's request: the music sat on top of the game.
export const VOLUME_TRIM_MUSIC = 0.375; // -62.5% in all


export const SFX_MAX_DISTANCE_TILES = 12;

// ─── Kill streaks ─────────────────────────────────────────────────────────────
// Kills inside this window, without dying, escalate. ACE is separate: everyone else, no deaths.

export const STREAK_WINDOW_TICKS = 6 * TICK_HZ;   // 6 s between kills to keep a streak alive
export const STREAK_NAMES = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'ULTRA KILL', 5: 'RAMPAGE' };
export const STREAK_ACE = 'ACE';

// ─── Admin ────────────────────────────────────────────────────────────────────

export const GAMESPEED_MIN = 10, GAMESPEED_MAX = 200;   // percent of TICK_HZ
export const BAN_MAX_HOURS = 24;

/* Bots, kept topped up by the room itself.
 *
 * The moment a person joins there are at least AUTO_BOTS_MIN bots, so one or two early arrivals
 * have something to fight instead of an empty island. Once no human has been present for
 * AUTO_BOTS_EMPTY_ROUNDS whole rounds the bots are all removed — sixteen brains playing to nobody
 * all weekend is wasted CPU.
 *
 * A host removing bots by hand (/kick bot N, or /bots lower than it is) switches the top-up off:
 * re-adding what somebody just deliberately took away is the server arguing with its host. It
 * comes back on only after the room has emptied and stayed empty for those same two rounds. */
export const AUTO_BOTS_MIN = 6;
export const AUTO_BOTS_EMPTY_ROUNDS = 2;

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
