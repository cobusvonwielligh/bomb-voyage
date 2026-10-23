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
- Rounds last **16 minutes** = 28 800 ticks, then a 20-second scoreboard, then the next map.
- Maps rotate: Arena → Catacombs → Islands → Arena …

| Map | Size (tiles) | Character |
|---|---|---|
| Arena | 31 × 25 | Open, classic grid, few hard walls. Fast and brutal. |
| Catacombs | 41 × 29 | Corridors and reinforced blocks. Rewards kicking people into dead ends. |
| Islands | 35 × 35 | Clusters separated by indestructible gaps and shrubs. Lots of ambush. |

Camera follows your player and clamps to the map edge. Viewport is 32×20 tiles at 1× zoom.

---

## 2. Movement

| Property | Value |
|---|---|
| Base speed | **34 units/tick** ≈ 4.0 tiles/s **(TUNE)** |
| Per Roller-skate | **+5 units/tick** |
| Max skates | **4** → 54 units/tick ≈ 6.3 tiles/s |
| Slowdown status | speed × 0.5, rounded down |
| Player hitbox | 20 × 20 units, centred (smaller than a tile — generous) |

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
| Bomb | 30 | +1 max bombs | 16 |
| Fire | 30 | +1 blast radius | 6 |
| Roller-skates | 20 | +1 speed step | 4 |
| Shield | 12 | Survive one death | 1 held |
| Gift | 8 | Rolls again on this table, excluding Gift | — |

A perk at its cap still gives **+15 score** instead of nothing, so late-round pickups are not
dead.

**Reserved for later** — the type ids exist in `shared/constants.js` with zero weight, so adding
them is a weight change and one effect function: Kick, Jelly, Detonator, Bat, Jetpack, Nuclear
charge, Blue fire, Heart, Key.

---

## 6. Death, respawn, and what you keep

Touching fire kills you, unless you are Invulnerable or hold a Shield.

- **Shield** absorbs the death, is consumed, and grants **60 ticks (2 s)** Invulnerability.
- **Death** drops your stats to the starting values (1 bomb, radius 1, 0 skates) and clears all
  statuses.
- On death you drop **up to 3 perks** on nearby free tiles, so a good kill is rewarded.
- You respawn by pressing **SPACE**, at a spawn point maximally far from the nearest living
  player, with **90 ticks (3 s)** Invulnerability.
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

Round score resets each round. **Lifetime score persists** per `playerId` and drives rank.

Rank titles, in order (these are Game of Bombs' own 16):

`Rookie, Private, Private First Class, Corporal, Sergeant, Second Lieutenant, First Lieutenant,
Captain, Major, Lieutenant Colonel, Colonel, Brigadier General, Major General,
Lieutenant General, General, Marshal`

Thresholds: rank *n* requires `1024 × n^1.6` lifetime score, rounded to the nearest 64. Rank 1 is
1 024, matching the Game of Bombs profile screen. The array is generated once in
`shared/constants.js` — do not hand-maintain it.

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
