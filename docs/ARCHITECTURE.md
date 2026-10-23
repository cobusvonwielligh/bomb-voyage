# Bomb Voyage — Architecture

The organising principle: **two developers working as vertical slices must almost never edit the
same file.** Everything below is shaped by that, not by architectural taste.

---

## 1. Shape of the thing

```
browser                                     node (one process, one port)
┌────────────────────────────┐              ┌─────────────────────────────┐
│ menu / HUD   (jQuery DOM)  │              │ static file serving          │
│ game loop    (rAF)         │  wss://  ⟷   │ websocket hub                │
│  ├ input                   │   JSON       │ room: authoritative 30 Hz    │
│  ├ prediction ─┐           │              │   loop ─┐                    │
│  ├ renderer    │           │              │         │                    │
│  └ audio       │           │              │ leaderboard.json             │
└────────────────┼───────────┘              └─────────┼───────────────────┘
                 │                                    │
                 └──────────  shared/sim/*  ──────────┘
                      the same files, imported by both
```

`shared/` is the trick. Movement, fire spread, collision and the rules are **one implementation**
loaded as ES modules by both Node and the browser. There is no build step, no transpile, no
duplicated logic to drift.

---

## 2. Directory layout

The planned layout is below under "as designed"; what actually got built is flatter. Several
planned files were never needed (`protocol.js`, `inputs.js`, `snapshot.js`, `predict.js`, the
`render/` and `ui/` folders) because the thing they would have held turned out to be twenty
lines inside its neighbour. A file per concept is a cost when the concept is one function.

### As built

```
shared/
  constants.js                 every tuning number and enum. FROZEN: agree before changing.
  maps.js                      map definitions, land masks, spawn placement, cell encoding
  wire.js                      framing + which channel a message belongs on. Both ends use it.
  sim/
    state.js                   createState / createPlayer / tile accessors / seeded rng
    movement.js                step() — walking, corner assist, centring, diagonals, stamina
    bombs.js                   placement, fuses, same-tick chains, powder kegs
    fire.js                    spread() — pure (map, bomb) → cells. No state, no clock.
    blocks.js                  damage, destruction, wall regrowth, keg placement
    perks.js                   drop table, supply-and-demand drop rate, pickup, death scatter
    statuses.js                timers, contagion
    round.js                   tick orchestration: the one place that fixes the order
  util/
    rng.js                     seeded PRNG — the sim NEVER calls Math.random()
    interp.js                  pickPair() — the snapshot pair that BRACKETS a render time

server/
  index.js                     http(s) + static + /healthz + the deploy webhook
  net.js                       socket lifecycle, chat commands, bans, seating
  webtransport.js              the HTTP/3 listener, every session wrapped to look like a ws
  room.js                      one round: the loop, seats, snapshots, hosts, respawn
  ai.js                        bot brains: danger map, pathing, fleeing
  bots.js                      headless clients for load testing
  leaderboard.js               load/save JSON, XP and levels
  config.js                    config.ini + env overrides
  canonical.js                 hostname redirects

public/
  index.html                   one page, everything
  style.css
  client/
    main.js                    boot, the loop, HUD, event handling
    transport.js               dials WebTransport and WebSocket, races them
    net.js                     clock sync, reconnect, identity
    world.js                   prediction, reconciliation, interpolation
    render.js                  canvas, camera, chunks, sea, boulders, the ship
    input.js                   keyboard → bitmask
    quips.js                   what the mascot says
    audio/
      engine.js                one AudioContext, buses, helpers
      sfx.js                   named one-shots
      music.js                 the theme
      ambient.js               the in-round beds
  assets/
    art.js                     everything in the game, drawn from shapes
    img/*.png                  four decorative images: mascot, face, kegs, icon
    fonts/shotling.ttf         the display face
    audio/*.mp3                theme, drift, suspend, undertow — named after their slots

infra/
  bootstrap.sh deploy.sh rollback.sh logs.sh bomb-voyage.service

test/                          23 files, 201 tests, node --test
```

### As designed

```
shared/                        ← FROZEN DAY 1, changes need both devs to agree
  constants.js                 tuning numbers, enums, derived tables
  protocol.js                  message builders + validators (thin)
  sim/
    state.js                   createState / cloneState / hashState
    movement.js                step() — the one movement function
    bombs.js                   placement, fuse, chain resolution
    fire.js                    spread() — pure (map, bomb) → fire cells
    blocks.js                  damage, destruction, regeneration
    perks.js                   drop table, apply effects
    statuses.js                timers, contagion
    round.js                   tick orchestration: calls the above in fixed order
  util/
    rng.js                     seeded PRNG — the sim NEVER calls Math.random()
    grid.js                    index math, neighbours
    colors.js                  golden-angle palette

server/
  index.js                     http + ws bootstrap, static serving
  room.js                      owns one round: the loop, the player list
  net.js                       socket lifecycle, per-connection send queue
  inputs.js                    per-player input buffer, tick matching
  snapshot.js                  builds `snap` messages
  leaderboard.js               load/save JSON, rank computation
  bots.js                      headless test clients

public/
  index.html                   one page, everything
  style.css
  client/
    main.js                    boot, scene switch (menu ⇄ game)
    net.js                     socket, clock sync, reconnect
    predict.js                 prediction + reconciliation
    world.js                   client mirror of sim state
    input.js                   keyboard → bitmask, key rebinding
    render/
      camera.js
      chunks.js                cached 8×8-tile map canvases
      entities.js              players, bombs, fire, perks, tracers
      hud.js                   bars, timers, toasts
      overlay.js               Q-map, TAB scoreboard
    ui/
      menu.js                  name entry, map cards, play
      chat.js
      scoreboard.js
    audio/
      synth.js                 WebAudio oscillator helpers
      sfx.js                   named one-shots
      music.js                 the three loops
  assets/
    art.js                     shape-based sprite painters
    maps/arena.json
    maps/catacombs.json
    maps/islands.json

tools/
  art-preview.html             open in a browser, see every sprite, no server
  lag.js                       outbound delay/jitter shim for the dev server

test/
  sim-determinism.test.js
  fire-spread.test.js
  movement-corner.test.js
  protocol.test.js
```

---

## 3. The frozen core

`shared/constants.js` and `shared/protocol.js` are written **before the split**, by one person, and
then treated as a contract. Both developers import them from hour one and build against them even
when the other side does not exist yet.

Rule: a change to `shared/` is a 2-minute conversation, not a silent commit. In practice this
happens maybe five times across the project, always during tuning.

---

## 4. The tick, in order

`shared/sim/round.js` is the only place that decides the order of operations. Everything else is a
pure-ish system it calls. This matters enormously for determinism — reordering these changes
outcomes.

```
tick(state, inputsByPlayer):
  1. statuses.expire(state)
  2. movement.step(state, inputsByPlayer)     // all players, ascending index
  3. bombs.place(state, inputsByPlayer)       // ascending index
  4. bombs.fuse(state)                        // collect bombs with at === tick
  5. bombs.resolveChains(state)               // queue, ascending bombId, cap 64
  6. fire.apply(state)                        // damage blocks, kill players
  7. perks.collect(state)                     // overlap test, ascending index
  8. statuses.spread(state)                   // pairwise contact
  9. blocks.regenerate(state)                 // every 600 ticks
 10. state.tick++
```

**Do not add a step without telling the other developer.** A new step in the wrong position is the
classic source of "it desyncs after about a minute".

---

## 5. How vertical slices avoid each other

Each slice owns whole files, top to bottom — its sim system, its render layer, its tests.

| Slice | Owns (sim) | Owns (client) | Owns (server) |
|---|---|---|---|
| **NET** | — | `client/net.js`, `client/predict.js` | `net.js`, `inputs.js`, `snapshot.js`, `index.js` |
| **MOVE** | `sim/movement.js`, `sim/state.js` | `client/world.js`, `client/input.js` | `room.js` |
| **BOOM** | `sim/bombs.js`, `sim/fire.js`, `sim/blocks.js` | `render/entities.js` (bomb+fire parts) | — |
| **ARENA** | — | `render/camera.js`, `render/chunks.js` | — |
| **LOOT** | `sim/perks.js` | `render/entities.js` (perk parts) | — |
| **PLAGUE** | `sim/statuses.js` | `render/entities.js` (status FX) | — |
| **SHELL** | — | `ui/*`, `render/hud.js`, `render/overlay.js` | `leaderboard.js` |
| **ART** | — | `assets/art.js`, `audio/*` | — |

`render/entities.js` is the one genuinely shared file. Keep it as a list of small draw functions
with a one-line dispatcher, and the merges stay trivial:

```js
export const drawers = { player: drawPlayer, bomb: drawBomb, fire: drawFire, perk: drawPerk };
```

Add your entry, do not restructure the file.

---

## 6. Rendering

Canvas 2D, following the same approach Game of Bombs itself uses (visible in their `renderer.js`):

- The map is split into **8 × 8 tile chunks**, each rendered once into its own offscreen canvas.
- A chunk is marked dirty when any cell in it, **or any cell in a neighbouring chunk's border**,
  changes. Redraw dirty chunks only.
- Per frame: blit visible chunks, then draw entities sorted by Y, then HUD.

At 32 × 20 visible tiles that is ~12 chunk blits plus ~80 sprite draws per frame. Trivially 60 fps
on an office laptop, and the laptop's fan stays quiet, which matters more than it sounds.

**Sprites are baked once at boot** from `assets/art.js` into offscreen canvases — including one
tinted copy per player colour. Drawing is then a plain `drawImage`, never per-pixel work in the
loop.

---

## 7. Server process

One Node process. One port. Three responsibilities:

1. **Static files.** `public/` served at `/`, **plus one extra mount: `shared/` at `/shared`.**
   That second mount is what lets the browser import the same simulation files Node does. Inside
   `shared/` use relative imports (they resolve identically in both); from `public/` import
   shared code by absolute path, e.g. `import {...} from '/shared/constants.js'`.
   Correct MIME types, long cache headers on everything except `index.html`. No framework;
   `node:http` plus a 30-line handler. Reject any path containing `..`.
2. **WebSocket hub.** `ws` server sharing the same HTTP server. One room, max 16 players, plus
   unlimited observers if we ever want them.
3. **The room loop.** `setInterval` at 33 ms with drift correction (track the next deadline in
   absolute time and catch up at most 3 ticks in one wake, never more — a long GC pause must not
   trigger a 200-tick catch-up storm).

Graceful shutdown: on SIGTERM, flush the leaderboard, send `roundend`, close sockets, exit.

---

## 8. State ownership

| State | Lives | Replicated how |
|---|---|---|
| Map cells | server, authoritative | full in `welcome`, deltas as events |
| Player position/stats | server | every snapshot |
| Bombs | server | every snapshot (with `at`) |
| Fire | **neither — derived** | computed from bombs by both sides |
| Perks on ground | server | events |
| Statuses | server | events + `stat` bitmask in snapshots |
| Round timer | server | `roundEndsAtTick` |
| Lifetime score | server, on disk | `scores` message |
| Camera, audio, settings | client only | not replicated |

Fire being derived is the load-bearing row. See [NETCODE.md](NETCODE.md) §1a.

---

## 9. Conventions

- ES modules everywhere, `.js`, no TypeScript, no bundler, no transpile.
- The sim uses **integers only**. Floats are allowed in rendering and audio, nowhere else.
- The sim never calls `Math.random()` — use `shared/util/rng.js` seeded from the round seed.
- The sim never reads `Date.now()`. It only knows `state.tick`.
- No `class` in shared or sim code. Plain objects and functions — they clone and hash cheaply.
  (Client UI code may use whatever reads best.)
- jQuery is for menu and HUD DOM only. It must never appear inside `requestAnimationFrame`.
- `test/` uses `node --test`. No framework, no fixtures, no mocks.
- Every non-trivial system leaves one runnable check behind. Determinism and fire spread are not
  optional to test; a menu button is.

---

## 10. Security posture

It is an office game, so: do the cheap correct things and skip the rest.

**Do:** validate and clamp every field arriving from a client; truncate names to 20 chars and
strip control characters; rate-limit chat; cap message size at 4 KB and drop the connection above
it; serve with `Content-Security-Policy: default-src 'self'` so nothing can phone home; never
interpolate user strings into HTML (use `textContent`).

**Skip:** authentication, anti-cheat beyond the position sanity check, encryption of game state,
audit logs.

The position sanity check exists to catch bugs, not cheaters. Log and correct; never kick.
