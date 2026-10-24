# Bomb Voyage — Where We Stand

Last updated: **2026-10-24**, at **v1.0.0**. Live on `bombvoyage.online`. 314 tests, all of which
now pass on Windows as well as in CI. The security check that went into 1.0 is
[DEPLOY.md](DEPLOY.md) §12.

This document replaces the "⬜ The game: not started" line in the README. The game is built, the
whole plan in [PLAN.md](PLAN.md) has been walked through, and several decisions in it have since
been overtaken by what actually happened. Read this before PLAN.md, not after.

---

## 1. The short version

Sixteen players, five maps, ten-minute rounds, running on one EC2 box behind one hostname on one
port. Deploys take about six seconds. Everything in `docs/` that describes *rules* is still
accurate; the parts that describe *what is not built yet* are not.

| | |
|---|---|
| Playable end to end | ✅ |
| Deployed, TLS, auto-restart, rollback | ✅ |
| Bots | ✅ up to 15, pathfinding and fleeing; at least 6 appear the moment anyone joins, and they leave after two empty rounds. `npm run botbench` measures them |
| Maps | ✅ 5 |
| Art and audio | ✅ art in code; music is four produced files (see §2e) |
| Transport | ✅ **WebTransport over QUIC, with WebSocket as the fallback** |
| Persistence | ✅ leaderboard, levels, XP — banked on disconnect, round end **and shutdown** |
| Observer mode | ✅ built — Spectate on the menu, and from the death card |
| Mobile | ⬜ out of scope, unchanged |

---

## 2. What changed direction

Five decisions in the original plan did not survive contact. Each one is worth knowing about,
because the reasoning is still load-bearing.

### (a) WebSocket is no longer the only transport

PLAN.md and NETCODE.md assume `ws://` and nothing else. The game now dials **WebTransport over
HTTP/3 and WebSocket at the same time** and uses whichever connects — see
[NETCODE.md](NETCODE.md) §8.

The reason to care is head-of-line blocking. Over TCP a single lost packet stalls every byte
queued behind it, so one drop delays the next three snapshots as well as the one it hit. Inputs
and snapshots are continuously replaced — a lost one is superseded 33 ms later — so they want a
channel that drops rather than waits. That is what QUIC datagrams are.

It is strictly additive. UDP/443 is blocked by corporate firewalls far more often than TCP is,
and this game exists to be played in an office, so WebTransport can never be the only way in.

> **The thing that nearly made it pointless:** a WebSocket `open` fires as soon as TCP and TLS
> are up, which beats a cold QUIC handshake. A plain "whoever answers first" race therefore gave
> the WebSocket the win almost every time, and the QUIC path — once built — was never actually
> used by anybody. The WebSocket now waits 350 ms for WebTransport before claiming the
> connection, and gives up that wait the instant WebTransport fails.

### (b) Rounds are ten minutes, not sixteen

And the host can change it live with `/roundtime N`, in tenths of a minute. Sixteen minutes is a
long time to be losing.

### (c) The perk set is smaller and there are two new ones

Bomb, Fire, Boots, Shield, **Stim** (stamina capacity) and **Rum**. The **Gift** has been
removed. It was the only thing that handed out diseases, so the contagious statuses in
`statuses.js` are now dormant: still implemented and tested, but nothing in play starts one.

Rum is the odd one. At weight 11 of 411 it is **2.7% of drops**, it glows on the floor, and it
is the only perk you might not want: it softens damage and makes you drunk, which sways your
walk and rolls the camera. It is the only perk whose effect is visible to the person carrying
it and nobody else — and the only one rare enough to be an event rather than a thing you have.

### (d) New systems that were never in the plan

- **Stamina.** Ten seconds of running empties it; empty means half pace until you have recovered
  a third. Regenerates twice as fast standing still, so stopping is a decision rather than a
  punishment. See [RULES.md](RULES.md) §9.
- **Ice.** One soft wall in twenty. A blast melts it into water on its own tile and the four
  beside it, for **eight seconds**: half pace, and you slide when you let go. Eight because at
  four the puddle was gone before anyone but the person who made it could reach it — a rare
  thing that evaporates before you can cross to it is a rare thing nobody uses. The water is in
  the snapshot, not derived from events, because prediction reads it. See [RULES.md](RULES.md) §4.
- **The sea listens to the music.** Bass swells the waves, energy speeds the current, the highs
  glitter, and every beat rolls a swell out from the coast. See [ART-AUDIO.md](ART-AUDIO.md) §6.
- **Powder kegs.** A destructible block that detonates at radius 7 on the tick it breaks. At most
  six a round, at least one guaranteed. They chain into each other and into bombs, because a keg
  *is* a bomb as far as the blast code is concerned. See [RULES.md](RULES.md) §10.
- **Seagulls.** One crosses the island every minute or so. Catch one in a blast at the bottom of
  its dive — hard on purpose: about one tick in nine of its flight, and its shadow is the tell —
  and it drops a gold coin that does not count against the round's five. The server describes a
  flight once (start, end, departure tick, phases) and the client draws it from its own clock,
  so a gull costs a few dozen bytes a snapshot. See [RULES.md](RULES.md) §8c and
  `shared/sim/gulls.js`.
- **Bots that manage themselves.** At least six the moment anybody joins; all of them gone after
  two rounds with nobody there. A host removing bots by hand turns the top-up off until the room
  has emptied for those two rounds. See [RULES.md](RULES.md) §12.

### (e) Art is still code. The music is not.

Four PNGs live in `public/assets/img/`: the mascot, its cropped face, a stack of kegs and an icon.
They are landing-page and HUD decoration only. **Everything inside the game — terrain, players,
bombs, fire, perks, the sea, the moored ship, the boulders, the gulls — is still drawn from
shapes in code**, and that rule has not moved. The ship (2.5× her original size now) and the
sea boulders (the largest 3.5×, the rest about 2.5×) are sized in `render.js`.

What changed is how often some of it is drawn. Static or slow things are painted once into an
offscreen canvas and blitted: the ship, the shallows bands, players' name labels, and the coastal
glow (repainted at ~12 Hz rather than every frame — it moves on periods of tens of seconds). The
sea's 590 flow particles evaluate the current once per particle instead of twice and stroke in a
dozen batched paths instead of 590. The dock meter scales its bars with a transform instead of
writing `height`, which was forcing a layout every frame. Nothing visible was taken away.

**The music is four produced files**, in `assets/audio/`: `theme`, `drift`, `suspend`,
`undertow`. Around three minutes each, cycling, with the theme excluded for the duration of a
round so it never starts playing a tune with a backbeat over a firefight. Every sound effect is
still synthesised.

Each file is named after the **slot** it fills rather than after the mix it came from, and that
is the whole trick: `createFileTrack` asks for `/assets/audio/<its own name>.mp3` and uses the
synthesised version of itself when the file is not there. There is no table mapping names to
files, and adding or replacing a track is dropping in an mp3.

So the synthesised theme and the three synthesised beds in `ambient.js` are not dead code. They
are the fallback, and they are also the specification — what each slot is called and what it is
supposed to sound like. The tests still hold them to it.

A produced mix is wrapped as a track with ONE step whose duration is the length of the file,
minus the crossfade so the next track overlaps the outro instead of following a gap. Nothing
above `createFileTrack` knows the difference, which is why crossfading, `exclude`, `playFrom`,
muting and ducking all work on it unchanged.

Serving them needed two things the server did not have — an `audio/mpeg` type and byte-range
support, the latter because Safari refuses to play an `<audio>` source at all from a server that
answers a `Range` request with a 200.

The assets folder is now `art.js` plus `img/`, `fonts/` and `audio/`.

---

## 3. What is built, by system

### Simulation — `shared/sim/`

| File | Owns |
|---|---|
| `state.js` | The state object, players, tile accessors, seeded RNG |
| `movement.js` | Walking, corner assist, lane centring, diagonals, unstick, stamina |
| `bombs.js` | Placement, fuses, same-tick chains, powder kegs |
| `fire.js` | Blast shape. Pure: `(map, bomb, bombs) → cells` |
| `blocks.js` | Damage, destruction, wall regrowth, keg placement |
| `perks.js` | Drop table, pickup, supply-and-demand drop rate, scatter on death |
| `statuses.js` | Contagious statuses and their spread — dormant since the Gift went |
| `gulls.js` | Seagulls: flight as a pure function of the tick, spawning, and blast hits (server-only decision) |
| `round.js` | The one ordered tick: the only place that decides what happens before what |

Deterministic throughout: integers only, one tile is 256 units, no wall clock, no
`Math.random()`. The client imports every one of these unchanged and runs them for prediction,
which is why reconciliation is usually a no-op.

### Server — `server/`

`index.js` (static + TLS + health), `net.js` (WebSocket hub, chat commands, bans),
`webtransport.js` (the HTTP/3 listener, presenting every session as a `ws`-shaped object),
`room.js` (the authoritative loop, seats, snapshots, rounds, hosts), `ai.js` + `bots.js`,
`leaderboard.js`, `config.js`, `canonical.js`.

### Client — `public/client/`

`main.js` (loop, HUD, events), `net.js` (clock, reconnect, identity), `transport.js` (the
two-transport race), `world.js` (prediction, reconciliation, interpolation), `render.js` (canvas,
camera, sea, boulders, ship), `input.js`, `quips.js`, `audio/` (engine, music, ambient, sfx).

### Maps — `shared/maps.js`

| id | size | shape | the idea |
|---|---|---|---|
| `arena` | 37×23 | rectangle | open lattice, nowhere to hide |
| `cove` | 37×23 | blob | organic coast, the shoreline makes the chokepoints |
| `twins` | 39×23 | two discs | one five-wide causeway between them |
| `lagoon` | 39×25 | crescent | the inside of the curve is water, so the tips are far apart |
| `crossroads` | 37×25 | cross | the middle is the shortest route between any two arms |

Every map is verified by test: sixteen spawns, all on walkable tiles, all in one connected
island.

---

## 4. Numbers as they stand

Every one of these is in `shared/constants.js`. Nothing is inline.

| | |
|---|---|
| Tick | 30 Hz, snapshots every 2 ticks (15 Hz) |
| Round | 10 min, `/roundtime 0.1–60` to change |
| Speed | `[27, 35, 43, 51, 59]` units/tick by boot count — 3.2 to 6.9 tiles/s |
| Caps | 8 bombs, radius 6, 4 boots, 2 shields, 4 stims |
| Stamina | 3450 tenths (+750 per stim), empty = half pace until a third is back |
| Respawn | 15 s, then weighted-random across every legal spawn |
| Perk drops | 35% base, scaled by what is on the floor and how fast it is taken |
| Rum | 2.7% of drops. Softens damage, sways your walk, rolls your camera for 12 s |
| Gold | 2.1% of drops, ≤5 a round. 400 XP. Changes nothing about the round — it is a collectible |
| Kegs | ≤6 a round, ≥1 guaranteed, radius 7 |
| Gulls | first at 25 s, then every 40–90 s, ≤2 aloft, ~4 tiles/s, one coin each when downed |
| Bots | ≥6 while anyone plays (`min_bots`), removed after 2 empty rounds |
| Zoom | fitted to the **island**, floor 0.68, 2 tiles of sea minimum |
| Levels | 100 hours to Veteran (level 20) |

---

## 5. Things that were fixed and are worth not re-breaking

Each of these was a real bug with a non-obvious cause. The code comments carry the detail; this
is the index.

| Symptom | Actual cause |
|---|---|
| Walls invisible, players clipping into them | Events cleared every tick, snapshots sent every 2 — half of them never shipped |
| Remote players juddering | Interpolation took the newest snapshot pair, not the pair that *brackets* the render time |
| Board shimmering | Zoom recomputed from `clientWidth` every frame, which forces layout and settles over frames |
| Canvas drawn as a white box | `width: auto` on a replaced element resolves to its intrinsic 300×150, over-constraining the box |
| A sea of empty ocean on most maps | Zoom fitted the map **rectangle**; every map but Arena is a shape inside it, so the rest is water |
| The spawn effect ballooning constantly | It fired for all sixteen players, burying the one case it exists for |
| Movement "snapping" off bombs | Lane centring ran at `speed × 2` — half a tile sideways in one tick with boots |
| QUIC built but never used | The WebSocket won the race every time; see §2(a) |
| Everyone calling each other `p1` | Snapshots carry no names, and the only message that did was the welcome |
| Fire overshooting a chain | Blast arms passed straight through other bombs instead of stopping at them |
| Two bombs from one tap | Placement ran per tick. Harmless while the bomb landed underfoot; aimed placement made the second attempt fall back to the tile you were standing on |
| Scores lost on deploy | Only written at round end and disconnect, and `leaderboard.stop()` was not awaited before `process.exit` |
| Stuck in one tile after `/gamespeed` | The client clock and fixed-step loop always ran at 30 Hz. At 200% every input was stamped for a tick the server had already simulated and was dropped; at 50% the server's input buffer evicted the ones it needed next. The client now scales both by the server's rate (`gamespeed` message, `welcome.config.gamespeed`) |
| Searching `server/net.js` returned nothing | The file held raw control bytes inside a character class, so grep and `git diff` treated it as binary and said nothing at all. `test/sources.test.js` now fails on any raw control byte |
| The server restarting for everybody | Three ways for one person to end the process: `GET /%` (`decodeURIComponent` throws), typing `/logout` (it called helpers that only existed inside `attachHub`), and a hello or input whose fields were objects with a non-function `toString`. Any throw inside a request or message handler reached the uncaught-exception handler, which exits. Handlers now catch, and wire values are coerced by type |
| Anybody could be host | The admin was whoever typed the admin's name, and the name is in a public repository. It is now `[admin] key` in config.ini |

---

## 6. What is still missing

Ordered by how much it would change a Friday session.

### Worth doing

1. **Bots are competent at not dying; they are not yet good at killing.** `npm run botbench`
   (15 bots, every map, headless, ~3 s for 20 simulated minutes each) measures 0.17 suicides and
   0.45 kills per bot per minute. It was 2.3 and 0.33 — 87% of deaths self-inflicted — and the
   biggest cause was not the reasoning at all: a bot turning into a gap from just past the corner
   assist window pushed flat into the wall and froze there until its own fuse ran out (see
   `steer` in `ai.js`). Next: hunting. Bots bomb walls and wander toward the nearest player;
   nothing tries to trap anyone.
2. **A browser-side confirmation of WebTransport.** Verified with a real QUIC client from
   outside AWS (8/8 sessions, ~50 ms to ready) and from the box, but not yet read off a Chrome
   session. The console logs `transport: webtransport` on connect; somebody needs to look.
3. **Diseases have no source.** The Gift is gone, so the contagious statuses never start. If they
   come back it needs a new way in (a map hazard, a cursed drop); Reduction's old "blast radius
   forced to 1" was never implemented and has been dropped from RULES.md.

### Known-and-fine

- `playerWire` omits `moving` for remotes; the client derives it from drawn movement instead.
- Bans are in memory only and clear on restart. Deliberate: there is no `/unban`.
- Careers are keyed by name, so anyone can play under yours. The worst they can do is add to it;
  accounts remain a non-goal.

### Explicitly not doing

Accounts, payments, matchmaking, mobile, anti-cheat, a persistent world. Unchanged from
[DESIGN.md](DESIGN.md) → Non-goals.

---

## 7. Operating it

- **Deploy:** `npm run deploy` (~6 s), `npm run rollback`, `npm run logs`.
- **Health:** `/healthz` — tick timings, player count, map, version, and both transports.
  `"webtransport": 0` means the listener is up with no sessions; `null` means it failed to start
  and everyone is on WebSocket.
- **The QUIC addon is compiled on the box** and stashed outside the app directory, because
  `npm ci` deletes `node_modules`. The deploy script restores it; if that step ever disappears,
  WebTransport dies silently at the next lockfile change. See [DEPLOY.md](DEPLOY.md) §9.
- **Bots:** `min_bots` in config.ini (env `MIN_BOTS`), default 6, 0 switches the automatic top-up
  off. `/healthz` reports `autoBots`.
- **Host commands:** `/restart`, `/godmode`, `/kick`, `/map`, `/gamespeed`, `/roundtime`. The host
  is the admin when present and the longest-standing human otherwise, so a room is never left
  without someone who can run it. The admin is the browser holding `[admin] key` from the
  server's config.ini — open `https://bombvoyage.online/?admin=<key>` once, on each browser you
  host from.
