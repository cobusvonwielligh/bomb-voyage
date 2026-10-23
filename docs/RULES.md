# Bomb Voyage — Game Rules

The single source of truth for mechanics. Every number here has a matching constant in
`shared/constants.js`. **If a number appears in both places, `shared/constants.js` wins** — update
this doc when you tune it.

Values marked **(TUNE)** are first guesses chosen to feel like Game of Bombs. Expect to adjust
them in the first playtest. They all live in one file so that is a two-minute job.

---

## 1. The world

- Tile size: **32 px**. Grid-aligned blocks, free pixel movement for players.
- Internal position unit: **1 tile = 256 units**, integers only. Never store a float position.
- Simulation: **30 ticks/second**, fixed step. 1 tick = 33.333 ms.
- Rounds last **10 minutes** = 18 000 ticks, then a 20-second scoreboard, then the next map.
  The host can change the length live with `/roundtime N`, in tenths of a minute.
- Maps rotate in order, starting from a random one — the server restarts on every deploy, and
  always starting at index 0 meant nobody ever saw the later maps.

| Map | Size (tiles) | Character |
|---|---|---|
| Arena | 37 × 23 | Open lattice. Nowhere to hide. |
| Cove | 37 × 23 | An organic island; the coastline makes the chokepoints. |
| Twins | 39 × 23 | Two discs joined by one five-wide causeway. |
| Lagoon | 39 × 25 | A crescent round open water. The two tips are the far ends of the map. |
| Crossroads | 37 × 25 | Four arms off a central plaza, contested by construction. |

The board is scaled so the **island** plus two tiles of sea fits the window exactly. Not the map
rectangle — every map but Arena is a shape drawn inside its grid and the rest is water, so
fitting the rectangle frames several tiles of empty ocean before the margin is even added. Below
`MIN_ZOOM` (0.68) the board stops shrinking and the camera follows you instead: a map you cannot
read is worse than a map you cannot see all of.

---

## 2. Movement

| Property | Value |
|---|---|
| Base speed | **27 units/tick** ≈ 3.2 tiles/s |
| Per Boots | **+8 units/tick** |
| Max boots | **4** → 59 units/tick ≈ 6.9 tiles/s |
| Slowdown status | speed × 0.5, rounded down |
| Exhausted | speed × 0.5, rounded down — see §9 |
| Player hitbox | 20 × 20 units, centred (smaller than a tile — generous) |

**Diagonals.** Holding two directions still moves one axis per tick — that is what keeps a tile
game feeling like one, and what lets remote interpolation draw an L rather than a diagonal. What
the game picks is the axis that *works*: the one you are facing if it is open, the other if it
is not. So a held diagonal slides along whatever it meets instead of stopping dead against it.
Boxed into a corner where neither axis is open, you stop.

**Lane centring** has three limits, and all three matter. It never runs faster than your legs,
it moves a seventh of the remaining offset per tick so it decelerates into the lane, and it is
capped at 6 units per tick absolutely. Without that last one, every future speed increase makes
the assist more violent — at `speed × 2` a booted player was moved half a tile sideways in a
single tick, which reads as the game taking the controls off you.

**Corner assist.** This is what makes Bomberman feel good and it is not optional. When you move
into a blocked tile but the perpendicular offset from the tile centre is **≤ 96 units (0.375
tile)**, slide toward that centre at full speed instead of stopping. Without this, players feel
like they are fighting the grid.

**Players do not collide with each other.** You walk straight through other players. This is both
faithful to Game of Bombs and the thing that makes 180 ms latency invisible — see
[NETCODE.md](NETCODE.md) §1b.

**Bomb pass-through.** You may walk off a bomb you just placed. The moment your hitbox fully
leaves that tile, the bomb becomes solid to you. Everyone else treats it as solid immediately.

---

## 3. Bombs

| Property | Value |
|---|---|
| Fuse | **72 ticks (2.4 s)** **(TUNE)** |
| Fuse under Fast Detonation | **36 ticks (1.2 s)** |
| Start bombs | 1 |
| Max bombs | **16** |
| Start fire radius | 1 |
| Max fire radius | **6** (9 with Blue fire — *not in v1*) |

Placing a bomb requires: you are alive, not Pacifism, and your live bomb count < your bomb stat.
A bomb is placed at the **centre of the tile your hitbox centre is in**. One bomb per tile.

**Explosion.** On the fuse tick the bomb produces fire in its own tile plus up to `radius` tiles
in each of the four directions. The arm stops when it hits:

- an indestructible block → stops **before** it,
- a destructible block → damages it, fills that tile with fire, then stops,
- a shrub → passes through but **radius is reduced by 1** for the rest of that arm,
- another bomb → that bomb detonates **this same tick** (chain), and the arm stops,
- a column → fire passes through, no reduction, arm continues.

Fire lasts **15 ticks (0.5 s)**. Every fire tile records the player who owns it, for kills.

**Chains are same-tick and bounded.** Resolve chain detonations with a queue in a single tick,
with a hard cap of 64 bombs per tick, so a 16-player bomb carpet cannot stall the loop.

**Determinism rule (critical).** A bomb's explode tick is fixed at placement and sent to clients.
Clients compute fire locally from the bomb list. Neither side may make explosion timing depend on
wall-clock time, `Math.random()`, or iteration order of an unsorted collection. Iterate bombs in
ascending `bombId` everywhere.

---

**An arm stops at another bomb.** The tile still burns — so the bomb still chains and goes off
this same tick with its own radius — but the arm does not continue past it. That is the
difference between a bomb being a link in a chain and a bomb being transparent: a line of three
bombs should propagate along itself, not have the first one's fire overshoot the other two and
reach further than any of them could. It is a per-arm rule; the other three directions are
unaffected.

---

## 4. Blocks

| Block | HP | Fire passes | Walk | Notes |
|---|---|---|---|---|
| Floor | — | yes | yes | |
| Soft wall | **1** | no | no | The brick you break. Drops perks. |
| Reinforced | **6** | no | no | |
| Stone monolith | **9** | no | no | |
| Iron | ∞ | no | no | Indestructible. Map skeleton. |
| Column | ∞ | **yes** | only with Reduction | Fire ignores it, bodies do not. |
| Shrub (walk-through) | ∞ | yes, −1 radius | yes | You are **invisible** to others while inside. |
| Shrub (solid) | ∞ | yes, −1 radius | no | |

One point of blast damage per fire event. A reinforced block therefore needs six separate blasts.
A damaged block shows its damage state visually (see [ART-AUDIO.md](ART-AUDIO.md)).

**Brick regeneration.** Game of Bombs rematerialises walls as the round runs. We do the same,
cheaply: every **20 s**, pick up to **3** empty floor tiles that have no player, bomb, fire or
perk within **4 tiles** and turn them into soft walls. Never regenerate inside a spawn ring.

---

## 5. Perks

Perks drop from destroyed blocks. A destroyed **soft wall** drops a perk with probability **35 %**
**(TUNE)**; reinforced and monolith blocks always drop one. A perk on the ground expires after
**45 s**. Walking over one picks it up.

Drop weights, applied after the drop roll:

| Perk | Weight | Effect | Cap |
|---|---:|---|---|
| Bomb | 26 | +1 max bombs | 8 |
| Fire | 24 | +1 blast radius | 6 |
| Stim | 20 | +75 maximum stamina, and tops you up | 4 |
| Boots | 18 | +1 speed step | 4 |
| Shield | 12 | Survive one death | 1 held |
| Gift | **0** | Rolls again on this table, excluding Gift | — |

The Gift is **switched off**, not removed: it hands out diseases and that mechanic is
unfinished. It is still implemented and still tested, and a single weight turns it back on.

**The drop rate is not flat.** A fixed 35% is wrong at both ends of a round — sixteen players
opening walls at once buries the floor in perks, and once the soft walls are gone nothing drops
for minutes. Two multipliers on the base chance fix both ends:

- **Supply** — perks on the floor against a target that scales with *players alive*, because
  that is who is competing for them. Bare floor runs at 2.2×, at or past target 0.25×.
- **Demand** — a decaying average of pickups, 8-second half-life, worth up to +80%. A board
  being stripped refills faster.

**Perks are fireproof.** They used to burn, on the reasoning that a tile with a perk on it
should not be the safest square on the map. In practice it did the opposite: the only way to
open a wall is with a bomb, and that bomb is usually still burning when the perk appears, so the
player who did the work watched their own blast eat the reward. Expiry already stops a contested
drop sitting there forever.

A perk at its cap still gives **+15 score** instead of nothing, so late-round pickups are not
dead.

**Reserved for later** — the type ids exist in `shared/constants.js` with zero weight, so adding
them is a weight change and one effect function: Kick, Jelly, Detonator, Bat, Jetpack, Nuclear
charge, Blue fire, Heart, Key.

---

## 6. Death, respawn, and what you keep

Touching fire kills you, unless you are Invulnerable or hold a Shield.

- **Shield** absorbs the death, is consumed, and grants **60 ticks (2 s)** Invulnerability.
- **Death** drops your stats to the starting values (1 bomb, radius 1, 0 boots) and clears all
  statuses.
- On death you drop **up to 3 perks** on nearby free tiles, so a good kill is rewarded.
- You respawn by pressing **SPACE** after a **10-second** cooldown, with **90 ticks (3 s)**
  Invulnerability.

**Where you respawn.** Every legal spawn is a candidate, weighted by the *square* of the
distance to the nearest living player — twice as far away is four times as likely. Not "the best
few, shuffled": that kept sending everyone back to the same handful of corners, and a corner you
can predict is a corner somebody can camp. Weighting the whole list means any spot on the map
can come up, a busy one is merely unlikely rather than impossible, and there is no set of tiles
to watch.
- While dead you are in observer mode (§9).

Faithful note: Game of Bombs' Heart perk keeps half your bonuses through death. It is a reserved
type here, not implemented in v1.

---

## 7. Statuses

Statuses are timed flags. Most are **contagious**: when two players' hitboxes overlap and one has
a contagious status, the other catches it with the **remaining duration**, and the carrier keeps
it. Contagion has a **1 s per-pair cooldown** so a scrum does not ping-pong.

| Status | Duration | Contagious | Effect |
|---|---:|:---:|---|
| Invulnerability | 90 t / 60 t | no | Cannot die. From respawn or a broken shield. |
| Pacifism | 300 t (10 s) | yes | Cannot place bombs. |
| Slowdown | 300 t | yes | Speed × 0.5. |
| Invisibility | 300 t | yes | Invisible to other clients. Your own tracer still shows to you. |
| Changeling | 300 t | yes | Up/down and left/right inverted, sprite drawn upside down. |
| Reduction | 450 t (15 s) | yes | Half-size hitbox (10 × 10), may pass **columns**, blast radius forced to 1. |
| Fast Detonation | 300 t | yes | Your bombs fuse in 36 ticks. |

Statuses come from Gift perks and from touching an infected player. **Invulnerability is never
contagious and is never overwritten by a weaker status.**

*Nyan disease is reserved, not in v1 — it needs its own art and an auto-bombing behaviour.*

---

## 8. Scoring and ranks

| Event | Score |
|---|---:|
| Kill another player | +100 |
| Suicide (your own fire) | −25, floored at 0 for the round |
| Killed by another player | 0 |
| Perk picked up | +5 (+15 if already capped) |
| Block destroyed | +2 |
| Alive at round end | +50 |

Round score resets each round. **Lifetime score persists** per `playerId` and is your XP.

**Levels replaced ranks.** Sixteen military titles were flavour nobody could place on a scale;
a level with a bar under it is a number you can feel moving. The curve is anchored at one real
quantity — **100 hours of play reaches Veteran, level 20** — and `XP_LEVEL_EXP` is derived from
that rather than hand-tuned, so changing the target changes the whole curve consistently.

| Levels | Tier |
|---|---|
| 0–10 | Rookie |
| 11–15 | Been around the block |
| 16–19 | Pro |
| 20+ | Veteran |

The level, the tier and the bar's `into / need / fraction` are all computed **on the server** and
sent in the 1 Hz scores broadcast. The client does no arithmetic on them, because two
implementations of one curve drift.

---

## 8a. Stamina

Running costs something. Ten seconds of continuous movement empties the bar; once empty you move
at **half pace** until you have recovered a third of it.

| | |
|---|---|
| Capacity | 300, plus 75 per Stim, to a maximum of 4 Stims |
| Drain | 1 per tick while moving |
| Regen | 2 per tick standing still, 1 per tick while limping |
| Exhausted | speed × ½ until stamina reaches a third of capacity |

Two details carry the whole system.

**The exhausted flag is a latch with hysteresis.** A plain "zero means slow" rule flips the
speed every single tick at the boundary — regain a point, sprint, spend it, crawl — which is
unplayable and reads as packet loss rather than as a mechanic. It is set at zero and cleared
only once a third of the bar is back.

**It regenerates whether you are moving or not**, just twice as fast when you stand still. That
makes stopping a tactical choice rather than a punishment, and it means an exhausted player is
never stuck: limping still refills, slowly.

It is shown twice over. A bar appears beside the player below 70% and drains; and the sprite
itself heaves, scaled on one axis so it reads as breathing, with a warm pulse on the ground once
genuinely exhausted. On the sprite rather than only in the HUD on purpose — at the moment you
need to know you are about to be slow, you are looking at your pirate, not at a bar.

---

## 8b. Powder kegs

A rare destructible block that **detonates on the tick it breaks**, at radius 7 against a bomb's
1 to 6.

| | |
|---|---|
| Per round | at most 6, at least 1 guaranteed |
| HP | 1 — the point is the explosion, not a siege |
| Drops | nothing. It holds powder. |

A keg **is** a bomb as far as the blast code is concerned: on destruction it joins the same
chain queue any caught bomb uses. Nothing in `fire.js` or `detonate()` knows kegs exist, and
chaining keg → keg → bomb falls out for free rather than being coded for.

Placement rides the wall-regrowth cycle, which already knows which tiles are quiet — a keg
appearing next to somebody would be a free kill nobody could read coming. It runs *before* that
function's wall-fill cap, because a guarantee that only fires on maps which happen to be open is
not a guarantee, and a full map is exactly when a keg is most wanted.

---

## 9. Observer mode

While dead, or after pressing TAB and clicking a name:

- Camera follows the chosen player. Arrow keys detach it into free-fly.
- Press **SPACE** to respawn and rejoin.
- Observers receive the same snapshots; there is no separate spectator stream.

---

## 10. Controls

Exactly Game of Bombs', minus what we did not build.

| Key | Action |
|---|---|
| Arrows / W A S D | Move |
| SPACE / K | Place bomb · respawn when dead |
| Q | Toggle map overview |
| ENTER | Toggle chat / send |
| TAB | Scoreboard |
| P | Fullscreen |
| ESC | Close overlays |
| SHIFT / L | *reserved* — detonate radio bomb |
| I | *reserved* — safe-house |
| F | *reserved* — jetpack |

Reserved keys must be swallowed with a short "not in this build" toast rather than doing nothing,
so returning players are not confused.

---

## 11. Player identity and tracer

Each player gets a colour at join from a 16-slot palette: hues 22.5° apart, handed out in
bit-reversed order so the first joiners are maximally separated, with lightness alternating
between adjacent hues. This guarantees 16 visually distinct, equally readable colours — no two
players are ever "the two blue ones". Details and the reasoning in
[ART-AUDIO.md](ART-AUDIO.md) §2.

The colour drives: the player's body tint, their name tag, their bombs, their fire, and their
**tracer** — a fading trail of the last **8** positions sampled every 3 ticks, drawn at 40 % alpha
and shrinking. The tracer is what lets you read a crowded screen at a glance, and it is how
spectators follow the action. It is a core feature, not decoration.

---

## 12. Chat

ENTER focuses the input, ENTER again sends, ESC cancels. 140 characters, 1 message per second per
player, last 50 messages kept. No censorship, no channels, no moderation — it is 12 colleagues.
Kill feed lines share the chat panel.

### Commands

Anyone: `/bots N`, `/who`, `/logout`, `/help`.

Host only: `/restart`, `/godmode`, `/kick bot N`, `/kick NAME [hours]`, `/map 0-4`,
`/gamespeed 1-200`, `/roundtime 0.1-60`.

**The host is a role, not a name.** It is the configured admin while they are connected and the
longest-standing human otherwise, so a room is never left without somebody who can restart it —
which is the whole reason the commands exist. It passes down the instant they leave, and the
scoreboard shows a crown so you can see who has it.
