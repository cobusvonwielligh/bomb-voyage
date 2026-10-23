# Bomb Voyage — Where We Stand

Last updated: **2026-10-23**. Live on `bombvoyage.online`. 201 tests passing.

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
| Bots | ✅ 15 of them, pathfinding and fleeing |
| Maps | ✅ 5 |
| Art and audio | ✅ all generated in code, bar four PNGs on the landing page |
| Transport | ✅ **WebTransport over QUIC, with WebSocket as the fallback** |
| Persistence | ✅ leaderboard, levels, XP |
| Observer mode | ⬜ never built — see §6 |
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

### (c) The perk set is smaller and there is a new one

Bomb, Fire, Boots, Shield and **Stim** (stamina capacity). The **Gift** is at weight zero — it
hands out diseases, and that mechanic is unfinished. It is still implemented and still tested; a
single number switches it back on.

### (d) Two new systems that were never in the plan

- **Stamina.** Ten seconds of running empties it; empty means half pace until you have recovered
  a third. Regenerates twice as fast standing still, so stopping is a decision rather than a
  punishment. See [RULES.md](RULES.md) §9.
- **Powder kegs.** A destructible block that detonates at radius 7 on the tick it breaks. At most
  six a round, at least one guaranteed. They chain into each other and into bombs, because a keg
  *is* a bomb as far as the blast code is concerned. See [RULES.md](RULES.md) §10.

### (e) Art is no longer purely code

Four PNGs live in `public/assets/`: the mascot, its cropped face, a stack of kegs and an icon.
They are landing-page and HUD decoration only. **Everything inside the game — terrain, players,
bombs, fire, perks, the sea, the moored ship, the boulders — is still drawn from shapes in
code**, and that rule has not moved.

---

## 3. What is built, by system

### Simulation — `shared/sim/`

| File | Owns |
|---|---|
| `state.js` | The state object, players, tile accessors, seeded RNG |
| `movement.js` | Walking, corner assist, lane centring, diagonals, unstick, stamina |
| `bombs.js` | Placement, fuses, same-tick chains, powder kegs |
| `fire.js` | Blast shape. Pure: `(map, bomb) → cells` |
| `blocks.js` | Damage, destruction, wall regrowth, keg placement |
| `perks.js` | Drop table, pickup, supply-and-demand drop rate, scatter on death |
| `statuses.js` | Contagious statuses and their spread |
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
| Caps | 8 bombs, radius 6, 4 boots, 1 shield, 4 stims |
| Stamina | 300 (+75 per stim), empty = half pace until a third is back |
| Respawn | 10 s, then weighted-random across every legal spawn |
| Perk drops | 35% base, scaled by what is on the floor and how fast it is taken |
| Kegs | ≤6 a round, ≥1 guaranteed, radius 7 |
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

---

## 6. What is still missing

Ordered by how much it would change a Friday session.

### Worth doing

1. **Observer mode.** In DESIGN.md, never built. Joining a full server currently kicks a bot;
   there is no way to watch.
2. **Bot suicides.** Roughly 3.4 deaths per bot per minute and about 49 in 50 are self-inflicted.
   26 of 30 sampled deaths landed on a tile the danger map called safe one tick earlier. Not root
   caused.
3. **A browser-side confirmation of WebTransport.** Verified with a real QUIC client from outside
   AWS (8/8 sessions, ~50 ms to ready) and from the box, but not yet read off a Chrome session.
   The console logs `transport: webtransport` on connect; somebody needs to look.
4. **Reduction does not force blast radius to 1.** Listed in RULES.md, never implemented.
5. **`SURVIVE_ROUND` bonus has no effect.** The constant exists and nothing reads it.

### Known-and-fine

- `playerWire` omits `moving` for remotes; the client derives it from drawn movement instead.
- `close()` leaves the reconnect timer armed. Harmless, because `closedByUs` gates it.
- Bans are in memory only and clear on restart. Deliberate: there is no `/unban`.

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
- **Host commands:** `/restart`, `/godmode`, `/kick`, `/map`, `/gamespeed`, `/roundtime`. The host
  is the named admin when present and the longest-standing human otherwise, so a room is never
  left without someone who can run it.
