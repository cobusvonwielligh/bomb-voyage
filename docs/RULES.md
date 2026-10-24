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
  During the scoreboard the board is hidden and nothing on it moves; the card names the next map
  and a gold-to-green bar fills until it starts.
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

### The slide

**Double-tap a direction and you dash that way.** It is the only other verb the game has for
distance, and it exists because the whole fight is about whether you can be somewhere before a
fuse ends.

| | |
|---|---|
| Gesture | the same direction twice inside **260 ms** (client-side; the server sees one bit) |
| Launch | **3 ×** your current walking pace — boots included, so the perk still matters |
| Drag | **× 0.94** of the velocity per tick |
| Ends at | **26 units/tick**, or on hitting anything solid |
| Distance | about **3½ tiles over 18 ticks**, against 1¾ walking the same ticks |
| Cost | **700 stamina**, a fifth of a fresh bar, taken in full at the launch |
| Cooldown | **18 ticks** before another |
| Refused when | already sliding, cooling down, exhausted, or short of the cost |

Three rules make it a decision rather than free speed:

**It owns the tick.** While one runs, the keys do nothing — no steering, no braking, no cutting it
short. You chose the direction when you double-tapped. That is also what makes it a function of
(velocity, direction, map), which is why the client can replay it to the unit.

**Your hands are full.** No bombs from inside a slide. Without that rule the slide is a bomb
delivery vehicle: launch, cross three tiles in half a second, drop one at the far end from safety.

**Drag, not a timer.** The slide decelerates the whole way out, so starting one too late carries
you past the turn you wanted. That mistake is the cost of using it badly, and you can see it
coming.

**Barging.** Anyone your slide passes through is left **confused** (§7): a question mark over
their head, no bombs, and a quarter off their pace for 45 ticks. It is the reason to aim a slide
at a person rather than at a corridor — you can go through the pirate holding a doorway, and they
cannot answer by dropping one at your feet.

---

## 3. Bombs

**A bomb lands on the tile you are FACING, not the one you are standing on.** Placing one is an
aimed action: you turn, you press, it goes there.

The tile you are in is the guide — the target is its neighbour in your facing direction, so it
changes the instant your centre crosses a boundary and never depends on where inside the tile
you happen to be. The HUD draws a bracket on it in your own colour, which disappears when you
have no bombs left, because a sight on a shot you cannot take is a lie.

It **falls back to the tile underfoot** when the target cannot take a bomb — a wall, the sea,
the map edge, or a bomb already there. That is not a compromise: the commonest reason to bomb
anything is to break the wall you are looking at, and a rule that simply refused would mean
walls could never be broken by somebody facing them.

Four places have to agree on that tile exactly, and all four call the same `bombTile()`: the
simulation, the client's prediction, the click sound, and the bots.

> Note this is *our* rule, not Game of Bombs'. Theirs drops the bomb underneath you, as classic
> Bomberman does.


| Property | Value |
|---|---|
| Fuse | **72 ticks (2.4 s)** **(TUNE)** |
| Fuse under Fast Detonation | **36 ticks (1.2 s)** |
| Start bombs | 1 |
| Max bombs | **16** |
| Start fire radius | 1 |
| Max fire radius | **5** (9 with Blue fire — *not in v1*) |

Placing a bomb requires: you are alive, not Pacifism, and your live bomb count < your bomb stat.
A bomb is placed at the **centre of the tile your hitbox centre is in**. One bomb per tile.

**Explosion.** On the fuse tick the bomb produces fire in its own tile plus up to `radius` tiles
in each of the four directions. The arm stops when it hits:

- an indestructible block → stops **before** it,
- a destructible block → damages it, fills that tile with fire, then stops,
- a shrub → passes through but **radius is reduced by 1** for the rest of that arm (no map
  generates shrubs any more; the rule stays, because the block type does),
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
| Ice | **1** | no | no | Melts instead of breaking. Drops water, never a perk. |

**Ice and water.** One soft wall in twenty is ice (`ICE_CHANCE`), at map generation and when walls
grow back. A blast that reaches ice melts it and floods **the ice tile and the four tiles beside
it** — five at most, and only where you could stand; a wall, rock or the sea next to it stays dry.
The water lasts **8 s** and is drawn drying up over the last 3 s.

In water you move at **half pace**, and it is slippery: let go of the keys and you keep sliding the
way you are facing for **8 ticks** before you stop. Sliding costs no stamina. Leaving the water
ends a slide at once. Two melts that overlap extend each other rather than stacking. Water is not
a status — it is where you are standing, judged by the tile your centre is in, like everything
else.

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

| Perk | Weight | Share | Effect | Cap |
|---|---:|---:|---|---|
| Bomb | 108 | 26.3 % | +1 max bombs | 8 |
| Fire | 100 | 24.3 % | +1 blast radius | 6 |
| Stim | 72 | 17.5 % | +75 maximum stamina, and tops you up | 4 |
| Boots | 72 | 17.5 % | +1 speed step | 4 |
| Shield | 48 | 11.7 % | Each absorbs one blast; a blue ring per shield on your pirate. No grace period: two blasts at once, or a second while the first still burns, cost two | 2 held |
| Rum | 11 | 2.7 % | Blast arms stop killing you for 12 s; you walk drunk | — |

The weights live in `PERK_WEIGHTS` in `shared/constants.js`; this table is a copy of them.

The **Gift** — Game of Bombs' random perk that sometimes hands you a disease — has been
**removed**. Type id 5 stays retired.

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

**Caps.** Bombs carried and blast radius both cap at **5**. They were 8 and 6, and together they
covered so much floor that a fully kitted player did not have to aim — position stopped being the
thing the game is about. A powder keg stays deliberately above the cap at radius 7, which is how
the renderer and the sound identify one without a flag on the wire.

---

**Moss.** Patches of growth over the sand and every kind of stone, spanning several tiles at a
time. Three frequencies of value noise, each answering a different question: one every six tiles
decides where a patch *is*, one a little over a tile makes its edge ragged, and one a third of a
tile thins it from the inside so a patch has clumps and holes rather than being a field. It is
drawn as a few dozen overlapping soft blobs sampled in world coordinates — never a tile-shaped
anything — clipped to the tiles that can carry it, so a patch runs over a wall and onto the sand
and stops dead at a crate.

Paint, nothing more: no rule anywhere reads it, it never changes what you can walk through, and it
replaced the green shrub blocks, which were the one colour on the board that answered to nothing
and, worse, made a walkable tile look like a wall.

**Under the boulders.** Every rock out in the sea is the top of something wider: a blurred, almost
invisible mass in the deep water's own colour, drawn under the rock and its shadow. It is the only
cue that says the water around a boulder is shallow, and it is what stops the rock reading as a
sticker on a flat surface.

**Light.** The map's sun (a hash of its name, pointing anywhere in a half-circle) now lights the
blocks themselves rather than only throwing shadows: a gradient across each one along the light's
axis, a bright rim on its sunward edges, and a hashed tint per tile so a wall of crates is a stack
of crates rather than one texture repeated. Contact shadows darken the floor where it meets
anything solid. All of it is baked into the chunk cache, so it costs nothing per frame.

---

## 5a. The start of a round

Every round opens with a **five-second count-in**, big in the middle of the board, and **nobody
can move** until it reaches zero — people and bots alike. The room zeroes every input until the
tick the client is counting down to, so the number on screen and the frozen board are two views
of one fact rather than an animation over a live game.

It exists because a round used to begin with sixteen people arriving on a map none of them had
seen, already live: the first second went on working out which pirate was yours and where the
walls were, and anybody who already knew the map had a free head start.

The round clock is pushed out by the same five seconds, so a ten-minute round is ten minutes of
play. `count_in = 0` in config.ini starts rounds live, which is also what every room test uses.

---

## 6. Death, respawn, and what you keep

Touching fire kills you, unless you are Invulnerable or hold a Shield.

- **Shield** absorbs the death and is consumed — one shield per blast, and never two at once.
  Spending one opens a **grace window of 18 ticks (0.6 s)** in which nothing can touch you, so a
  chain reaction or a crossfire costs exactly one shield and the second is still there for the
  next mistake. The grace outlasts a blast's lethal window, so the explosion that triggered it can
  never come back for more.
- **Death** drops your stats to the starting values (1 bomb, radius 1, 0 boots) and clears all
  statuses.
- On death you drop **up to 3 perks** on nearby free tiles, so a good kill is rewarded.
- You respawn by pressing **SPACE** after a **13.5-second** cooldown, with **90 ticks (3 s)**
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

Statuses are timed flags. **Only Invulnerability and Drunk (rum) occur in play today.** The
contagious diseases below were handed out by the Gift, which has been removed, so nothing starts
an outbreak any more. Their effects and the contagion rule are still implemented and tested — a
new source is one call to `applyStatus` — but treat this table as dormant.

Most are **contagious**: when two players' hitboxes overlap and one has
a contagious status, the other catches it with the **remaining duration**, and the carrier keeps
it. Contagion has a **1 s per-pair cooldown** so a scrum does not ping-pong.

| Status | Duration | Contagious | Effect |
|

**Confused** is the only status that does not come out of a bottle: it is what a slide leaves
behind (§2). A question mark over the head, **no bombs**, and **speed × ¾**, for **45 ticks**. It
is not contagious — a confused player barging about cannot confuse anybody else — and
Invulnerability protects against it like it protects against the diseases.

---|---:|:---:|---|
| Invulnerability | 90 t / 60 t | no | Cannot die. From respawn or a broken shield. |
| Pacifism | 300 t (10 s) | yes | Cannot place bombs. |
| Slowdown | 300 t | yes | Speed × 0.5. |
| Invisibility | 300 t | yes | Invisible to other clients. Your own tracer still shows to you. |
| Changeling | 300 t | yes | Up/down and left/right inverted, sprite drawn upside down. |
| Reduction | 450 t (15 s) | yes | Half-size hitbox (10 × 10), may pass **columns**. |
| Fast Detonation | 300 t | yes | Your bombs fuse in 36 ticks. |
| Drunk | 360 t (12 s) | no | From rum. Only the bomb's own tile kills you; your walk sways. |

**Invulnerability is never contagious and is never overwritten by a weaker status.**

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

**Medals.** At the end of every round the top three by score (then kills — the order the
round-over table shows) get a gold, silver or bronze, counted for life alongside kills and
deaths. A place only pays if somebody finished below it — gold needs two players, silver three,
bronze four — so last is never on the podium, and a finish on **zero points** wins nothing.
Your count is on your stats card, and everyone's is on the TAB board and the all-time table.

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

Running costs something. About **thirteen and a half seconds** of continuous movement empties the
bar; once empty you move at **half pace** until you have recovered a third of it.

| | |
|---|---|
| Capacity | 6900, plus 1500 per Stim, to a maximum of 4 Stims |
| Drain | 17 per tick while moving — 13.5 s of running |
| Regen | 53 per tick standing still (4.3 s to full), 28 while limping |
| Exhausted | speed × ½ until stamina reaches a third of capacity |
| A slide | 1400 off the bar, at once — see §2 |

The units are twentieths, because the sim is integers only and these rates have twice been asked
for a fifteen percent change: the resolution has to be fine enough to express one. Against the
previous numbers, the drain is **15% slower** and the regen **15% faster** — you run longer, and
you get your wind back quicker.

Two details carry the whole system.

**The exhausted flag is a latch with hysteresis.** A plain "zero means slow" rule flips the
speed every single tick at the boundary — regain a point, sprint, spend it, crawl — which is
unplayable and reads as packet loss rather than as a mechanic. It is set at zero and cleared
only once a third of the bar is back.

**It regenerates whether you are moving or not**, just twice as fast when you stand still. That
makes stopping a tactical choice rather than a punishment, and it means an exhausted player is
never stuck: limping still refills, slowly.

It is shown twice over. A bar appears **under the player's feet** below 70% and drains; and the
sprite itself heaves, scaled on one axis so it reads as breathing, with a warm pulse on the ground
once genuinely exhausted. On the sprite rather than only in the HUD on purpose — at the moment you
need to know you are about to be slow, you are looking at your pirate, not at a bar.

The bar is horizontal, thin-bordered, and deliberately **not** a health bar: this game has no
health, and reading it as health would be actively dangerous information. A lightning bolt in
front of it, the interface's amber rather than green-to-red, a notch at what a slide costs, and a
red gradient with a gentle pulse below a third — the frame stays solid while it pulses, so the
reading is never hidden at the moment it matters.

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

## 8c. Seagulls

Now and then a gull crosses the island: the first about 25 s into a round, then one every
40–90 s, never more than two in the air. Each flies a straight line with a lazy weave in it,
entering and leaving well outside the board, at just under four tiles a second.

| | |
|---|---|
| Catchable | only at the bottom of a dive — a dip every ~3.5 s, low for ~11 ticks of it |
| Hit by | fire in its lethal window on the tile under it, exactly what kills a player |
| Drops | **one gold coin**, on the nearest bare floor. Does **not** count against the round's five |
| Credit | the kill feed names whoever's fire it was; the coin goes to whoever picks it up |

It is meant to be hard: one tick in nine of a flight is low enough, it is quick, and over water
there is nothing to burn it with. The tell is the shadow — at cruising height it sits well off to
one side of the bird, and in a dive it slides in underneath and turns crisp. Gulls draw from
their own random stream, so adding them changed no drop or regrowth roll.

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
| Arrows / W A S D, **twice** | Slide that way — see §2 |
| SPACE / K | Place bomb · respawn when dead |
| Q | Toggle map overview |
| ENTER | Toggle chat / send |
| TAB | Scoreboard |
| P | Fullscreen |
| ESC | Close overlays |
| SHIFT + direction | Emote |
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

Anyone: `/bots N`, `/kick bot N`, `/who`, `/logout`, `/help`.

Owner only: `/restart`, `/godmode`, `/kick NAME [hours]`, `/map 0-4`, `/gamespeed 10-200`,
`/roundtime 0.1-60`.

**Two tiers, and the line between them is "can this ruin somebody else's round".** The host —
whoever happens to be in charge — may add bots and remove bots, because a room with nobody who can
top the bots up is a worse room and the worst a mistake there can do is change who you are playing
against. Everything else belongs to the **owner**: the browser presenting the admin key, or the
configured `admin name` where no key is set. Restarting throws away everybody's score, godmode
makes one player unkillable, `/gamespeed` and `/roundtime` change the rules under sixteen people,
`/map` replaces the board mid-fight, and `/kick NAME` can ban somebody for hours.

The owner's commands are also **not advertised**: `/help` does not mention them to anybody else,
and using one without the right returns the unknown-command reply rather than "not for you" — a
refusal that confirms the command exists is an invitation to keep trying.

**Bots look after themselves.** The moment a person joins, the room tops itself up to at least
six bots (`min_bots` in config.ini, 0 to switch off). After two whole rounds with no person
present, every bot is removed. A host who removes bots by hand — `/kick bot N`, kicking one by
name, or `/bots` lower than it is — switches the top-up off, and it stays off until the room has
emptied and sat empty for those two rounds. Asking for *more* bots never switches it off.

**The host is a role, not a name.** It is the admin while they are connected — the browser that
presents the key in `config.ini`, never merely somebody who typed the admin's name — and the
longest-standing human otherwise, so a room is never left without somebody who can add bots. It
passes down the instant they leave, and a **crown** marks them in the live list, in the TAB
scoreboard and over their head on the board, so you can see who has it without asking.
