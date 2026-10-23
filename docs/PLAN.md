# Bomb Voyage — Build Plan

Read [DESIGN.md](DESIGN.md) and [RULES.md](RULES.md) first. This document is the work breakdown,
the dependency order, and the slice boundaries that let two people work in parallel without
colliding.

**No task here is assigned to anyone.** Pick slices, not tasks — a slice is a coherent vertical
that owns whole files top to bottom. The full task list with sizes is in §8.

---

## 0. How we work

**Branches.** `slice/<id>-<short>` off `main`, e.g. `slice/boom-2-fire-spread`. Small PRs, merge
often. Do not sit on a branch for three days.

**The frozen-file rule.** `shared/constants.js`, `shared/protocol.js` and `shared/sim/round.js`
are shared by everyone. If you need to change one, say so in chat *before* you do. Every other
file belongs to exactly one slice (see [ARCHITECTURE.md](ARCHITECTURE.md) §5) — if you need a
change in a file outside your slice, ask; do not edit it.

**Definition of done** for every task:
1. It works when you run the game, not just when the test passes.
2. It has one runnable check if the logic is non-trivial (a branch, a loop, a parser).
   `node --test`. Trivial one-liners need no test.
3. It does not break `npm test`.
4. Any number you invented is in `shared/constants.js`, not inline.
5. A line in the PR saying what you deliberately left out.

**Daily:** 10 minutes, two questions — what landed, what is blocked. That is the whole process.

---

## 1. Milestones

| # | Name | What it means | After phase |
|---|---|---|---|
| **M1** | *Two squares move* | Two browsers, two players, one map, movement feels right at `LAG=200` | 1 |
| **M2** | *It is a game* | Bombs, fire, blocks, death, respawn. Ugly but playable end to end | 2 |
| **M3** | *It is the game* | Perks, statuses, 3 maps, real art and sound | 3 |
| **M4** | *It is a product* | Menu, scoreboard, chat, observer, leaderboard, round loop | 4 |
| **M5** | *It is on the internet* | Deployed, TLS, IT-unblockable, survives a 16-bot load test | 5 |

**M2 is the one that matters.** Get there fast, then play it every day while building the rest.
Everything after M2 is improvement on something you can already feel.

---

## 2. The slices

A slice is the unit of ownership. Two people take roughly half the slices each; the pairing
below is the one with the fewest cross-dependencies, but any split works as long as **one slice
has one owner**.

| Slice | What it is | Files it owns |
|---|---|---|
| **FOUND** | Repo, frozen contracts, map format | `package.json`, `shared/constants.js`, `shared/protocol.js`, `shared/sim/state.js` |
| **NET** | Wire, server loop, snapshots, bots, lag shim | `server/index.js`, `net.js`, `inputs.js`, `snapshot.js`, `bots.js` |
| **MOVE** | Movement sim, input, prediction | `shared/sim/movement.js`, `server/room.js`, `client/input.js`, `client/predict.js`, `client/net.js` |
| **BOOM** | Bombs, fire, blocks, death | `shared/sim/bombs.js`, `fire.js`, `blocks.js` |
| **ARENA** | Maps, camera, chunk renderer | `assets/maps/*`, `client/render/camera.js`, `chunks.js` |
| **LOOT** | Perks, drops, effects | `shared/sim/perks.js` |
| **PLAGUE** | Statuses and contagion | `shared/sim/statuses.js` |
| **ROUND** | Round lifecycle, scores, leaderboard | `server/leaderboard.js` |
| **SHELL** | Menu, HUD, scoreboard, chat, observer | `client/ui/*`, `render/hud.js`, `overlay.js` |
| **ART** | Sprites, tracer, audio | `assets/art.js`, `client/audio/*` |
| **DEPLOY** | Container, TLS, config, health | `Dockerfile`, `compose.yaml`, deploy docs |

`client/render/entities.js` is the one genuinely shared client file. Keep it a dispatcher of
small draw functions and merges stay trivial — add your entry, do not restructure it.

**Natural pairing**, if you want one: *NET + MOVE + BOOM + PLAGUE + ROUND + DEPLOY* on one side
(the wire and the simulation), *ARENA + LOOT + SHELL + ART* on the other (everything seen and
heard). FOUND is done by one person before the split.

---

## 3. Phase 0 — Foundations · slice FOUND

Nobody splits until these exist, because both sides import them.

| ID | Task | Acceptance |
|---|---|---|
| **F-1** | Repo skeleton. `package.json` (one dep: `ws`), `npm start` serves `public/index.html` on 8080, `npm test` runs an empty `node --test`. | `npm i && npm start` → a page loads. |
| **F-2** | `shared/constants.js` — every number in [RULES.md](RULES.md), plus enums for block/perk/status types including the reserved ones. Rank thresholds generated, not hand-typed. | Imports cleanly in Node and in the browser. **A starter file already ships in this repo** — review and extend it. |
| **F-3** | `shared/protocol.js` — builders and validators for every message in [PROTOCOL.md](PROTOCOL.md). Unknown types and fields are ignored, never thrown on. | `test/protocol.test.js` round-trips every message type; a message with an unknown field survives. |
| **F-4** | `shared/sim/state.js` — `createState(map, seed)`, `cloneState`, `hashState` (FNV-1a over a canonical field order). | Two states built from the same seed hash identically. |
| **F-5** | Map format + loader. ASCII `rows` JSON → packed byte array → base64. One placeholder 31×25 map. | Loader round-trips a map; a test asserts the byte layout from [PROTOCOL.md](PROTOCOL.md) §5. |

**Gate:** F-2 and F-3 are on `main` before anyone starts phase 1.

---

## 4. Phase 1 — The spine → M1

Goal: two players move around a map and it feels good on a bad connection.

### Slice NET

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **NET-1** | `ws` server on the same HTTP server and port. `hello` → seat 0–15 → `welcome` with full state. `reject` when full. | F-1, F-3 | Two tabs connect with distinct seats. A 17th gets `{"t":"reject","why":"full"}`. |
| **NET-2** | Room loop: 30 Hz with absolute-deadline drift correction, max 3 catch-up ticks per wake. Warn if a tick exceeds 20 ms. | NET-1 | Tick count after 60 s is 1800 ± 2. Force a 500 ms block and confirm it does **not** fire 15 ticks at once. |
| **NET-3** | Per-player input ring buffer keyed by tick. Missing input repeats the last mask; late input is discarded. | NET-2 | Dropped packets do not stall the player. |
| **NET-4** | Snapshot builder: `snap` at 15 Hz with a per-player `ack`. | NET-3 | JSON matches [PROTOCOL.md](PROTOCOL.md) §4 exactly. Measure its size with 16 fake players and put the number in the PR. |
| **NET-5** | Dev lag shim: `LAG=200 JITTER=40 npm start` delays outbound frames. | NET-4 | Visibly laggy, without it mattering. **Do not skip — this is how netcode bugs get found before Friday.** |
| **NET-6** | `npm run bots -- 15`: headless clients that connect, move and bomb. | NET-4 | 15 bots + you = 16, server stays under 20 ms per tick. |
| **NET-7** | Position sanity check: correct and log above `1.5 × maxSpeed × ticks`. Never kick. | NET-4 | Warning logged when a client teleports; the game continues. |

### Slice MOVE

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **MOVE-1** | `shared/sim/movement.js` — `step(state, inputs)`. Integer units, corner assist, bomb pass-through hook, no player-player collision. | F-4 | Approaching a wall corner at ≤96 units offset slides; at 97 it stops. Determinism test passes. |
| **CLI-1** | `client/net.js`: connect, `hello`, handle `welcome`/`snap`, clock lead per [NETCODE.md](NETCODE.md) §2, reconnect with backoff. ~10 lines of clock code — do not build a jitter model. | F-3 | At `LAG=200` the tick estimate stays within ±2 of the server's and does not oscillate. |
| **CLI-2** | `client/input.js`: keyboard → bitmask, arrows and WASD, repeat-safe, ignored while chat has focus. | — | Holding two directions behaves sanely. |
| **CLI-3** | `client/predict.js`: predict + replay per [NETCODE.md](NETCODE.md) §2. Roughly 40 lines. Ship it with no tolerance band and no blending; add a 100 ms lerp **only if** snapping is actually visible. | MOVE-1, CLI-1 | At `LAG=200` your own character has **zero** perceived input delay and never visibly rubber-bands on open ground. |

### Slice ARENA / ART (first pass)

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **REN-1** | Canvas boot, device-pixel-ratio handling, 32×20-tile viewport, camera follow with clamp. | — | Resizing the window does not blur the pixels. |
| **REN-2** | `render/chunks.js`: 8×8-tile cached chunk canvases, dirty tracking including neighbour borders. | F-5, REN-1 | Changing one cell redraws one chunk (two at a border), not the screen. Prove it with a counter. |
| **ART-1** | `assets/art.js`: palette, all 8 block painters, player sprite (4 dirs × 2 frames), boot-time baking, per-colour tinted copies. | — | `public/art-preview.html` shows every sprite. **A starter file already ships in this repo.** |

**M1 exit test:** `LAG=220 JITTER=50 npm start`, two tabs, drive both. Movement must feel local.
If it does not, stop and fix it — everything after this inherits the feel.

---

## 5. Phase 2 — It is a game → M2

### Slice BOOM

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **BOOM-1** | Placement rules: one per tile, bomb cap, `at` computed at placement, pass-through until you leave the tile. | MOVE-1 | You can walk off your own bomb and not back onto it. |
| **BOOM-2** | `fire.spread(map, bomb)` — pure, returns fire cells. Every stop/pass rule from [RULES.md](RULES.md) §3. | F-4 | Tests cover: iron stop, soft-wall stop-after-damage, shrub −1, column pass, radius 1 and 6. |
| **BOOM-3** | Chain detonation: same-tick queue, ascending `bombId`, 64-bomb cap. | BOOM-2 | A 20-bomb line detonates in one tick, identically every run. |
| **BOOM-4** | Block HP, destruction, `blockhit`/`blockdie` events, regeneration every 600 ticks with the exclusion radius. | BOOM-2 | A reinforced block takes six separate blasts. Regeneration never spawns on a player. |
| **BOOM-5** | Death and respawn: fire kills, shield absorbs, stats reset, perks drop, SPACE respawn with invulnerability, kill attribution. | BOOM-2 | Kill feed correct for suicide, kill, and a chain killed by two owners. |
| **BOOM-6** | Client-side fire prediction: compute fire from the bomb list at tick `at` using the **same** `fire.spread`. | BOOM-2, CLI-3 | At `LAG=250` fire appears on the same tick as the server's. Log both and compare. |

### Slice ARENA / ART / audio

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **ARENA-1** | Author the three maps from [RULES.md](RULES.md) §1 as ASCII JSON. Symmetric spawn rings, 16 spawn points, no instant-death starts. | F-5 | 16 bots spawn and survive 10 seconds without touching each other. |
| **ART-2** | Bomb (3 pulse frames), fire (centre/arm/tip × 4 rotations), block damage states, explosion flash. | ART-1 | A damaged reinforced block reads as damaged at a glance. |
| **AUD-1** | `audio/synth.js` + `sfx.js`: place, explode, pickup, death, step. Defaults **music 0.25 / SFX 0.75**, persisted. | — | Nothing is startling on first load. Volume sliders work. |

**M2 exit test:** four tabs, kill each other for five minutes, no desync, no console errors.
**From here on, play it daily.**

---

## 6. Phase 3 — It is the game → M3

### Slice PLAGUE

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **PLG-1** | All seven statuses from [RULES.md](RULES.md) §7: timers, expiry, `stat` bitmask. | MOVE-1, BOOM-1 | Each visibly changes play. Changeling inverts both axes. |
| **PLG-2** | Contagion: pairwise overlap, 1 s per-pair cooldown, invulnerability never spreads or is overwritten. | PLG-1 | A scrum does not ping-pong a status. 16 bots in a pile stays under 20 ms per tick. |
| **PLG-3** | Reduction interactions: half hitbox, passes columns, blast radius forced to 1. | PLG-1, BOOM-2 | A reduced player fits through a column gap and cannot blast past radius 1. |

### Slice ROUND

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **RND-1** | Round lifecycle: 28 800-tick timer, `roundend`, 20 s scoreboard, map rotation, state reset, scores committed. | NET-4 | Three rounds run back to back unattended, no leak, no tick drift. |
| **RND-2** | `leaderboard.json`: flush every 30 s and on SIGTERM, lifetime score, rank from the threshold table. | RND-1 | Kill the server mid-round; scores from the last flush survive. |

### Slice LOOT / ART

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **LOOT-1** | Drop roll, weighted table, Gift re-roll, caps with the +15 consolation, 45 s expiry, drop-on-death. | BOOM-4 | Weights honoured over 10 000 seeded rolls, asserted within tolerance. |
| **LOOT-2** | Perk effects on player stats, caps enforced, reserved types present at weight 0. | LOOT-1 | Adding Kick later is a weight change plus one function — prove it by stubbing it. |
| **ART-3** | Perk icons (5 live + 9 reserved), status visual effects, and the **tracer** (8 samples, every 3 ticks, 40 % alpha, shrinking). | ART-1 | With 16 bots on screen you can follow any one of them by tracer alone. |
| **AUD-2** | Three music loops, one per map. Simple, polyphonic, soft. Ducks to 40 % when chat is focused. | AUD-1 | Listen to one for a full 16 minutes without wanting to mute it. That is the real test. |

---

## 7. Phase 4 — It is a product → M4, then Phase 5 → M5

### Slice SHELL

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **SHELL-1** | Menu: name field (20 chars, sanitised), colour preview, three map cards, PLAY. Remembers your name. | ART-1 | Link → playing in under 10 seconds, no second click after PLAY. |
| **SHELL-2** | HUD: bombs / fire / speed / shield, round timer, your colour, connection dot, toast for reserved keys. | REN-1 | You can read your stats without looking away from your character. |
| **SHELL-3** | TAB scoreboard: sorted round scores, rank icons and titles, click a name to observe. | NET-4 | Sorting is stable. Clicking a dead player does something sensible. |
| **SHELL-4** | Chat: ENTER focus/send, ESC cancel, 140 chars, 1/s, last 50, kill feed in the same panel, `textContent` only. | NET-1 | Pasting `<img onerror=...>` renders as text. Typing WASD in chat does not move you. |
| **SHELL-5** | Q map overview, observer free-camera with arrows, SPACE rejoins. | REN-2 | Observing survives the observed player disconnecting. |

### Slice DEPLOY

| ID | Task | Depends | Acceptance |
|---|---|---|---|
| **DEP-1** | `Dockerfile` (no build step) and `compose.yaml`; identical locally and in production. | — | The same image runs on a laptop and on EC2. |
| **DEP-2** | TLS on 443: hostname, Let's Encrypt, auto-renew, HTTP→HTTPS redirect, `wss://` same origin. | DEP-1 | The [DEPLOY.md](DEPLOY.md) §3 checklist passes from a clean box. |
| **DEP-3** | Config by environment variable only. Nothing AWS-specific in the code. | DEP-1 | Moving to the eezi VPC is an env change — prove it against a second hostname. |
| **DEP-4** | `/healthz` with tick rate, player count, uptime. Strict CSP and security headers. | DEP-1 | `curl https://host/healthz` returns JSON. CSP blocks an injected external script. |
| **DEP-5** | The IT ticket paragraph, ready to paste. | DEP-2 | Sendable without editing. |
| **DEP-6** | Restart policy, log rotation, documented restore from the leaderboard file. | DEP-1 | `reboot` the instance; the game comes back by itself. |

### Phase 5 — Make it good

No new features. This is where the game becomes fun rather than correct.

| ID | Task | Acceptance |
|---|---|---|
| **TUNE-1** | Playtest with bots at `LAG=200`, then with four humans. Tune speed, fuse, drop rate, radius. Every change lands in `shared/constants.js`. | Write down what changed and why. |
| **TUNE-2** | 16-bot load test, full 16-minute round. Record tick time p50/p99, snapshot size, egress. | p99 tick under 10 ms. Numbers in the PR. |
| **TUNE-3** | Two-machine test over the real internet, from both developers' homes. | Both report it feels local. |
| **TUNE-4** | Fix the top five things that annoyed you during TUNE-1. Not the top twenty. | — |
| **TUNE-5** | `README.md` final pass: run, play, deploy, and a three-line "how to play" for the team. | A colleague who has never seen it gets in without asking anything. |

---

## 8. Master task list with sizes

Sizes are relative effort, not time. **S** trivial · **M** an afternoon's worth of thinking ·
**L** a real piece of work · **XL** the hard part of a slice · **XXL** needs breaking down before
starting · **XXXL** should not exist in this project (nothing here is one).

| ID | Slice | Task | Size |
|---|---|---|:--:|
| F-1 | FOUND | Repo skeleton, `npm start` serves the page, `npm test` runs | **S** |
| F-2 | FOUND | `shared/constants.js` — all tuning numbers and enums, generated rank table | **M** |
| F-3 | FOUND | `shared/protocol.js` — message builders, validators, ignore-unknown | **M** |
| F-4 | FOUND | `shared/sim/state.js` — create, clone, deterministic hash | **S** |
| F-5 | FOUND | Map format, ASCII→bytes loader, one placeholder map | **S** |
| NET-1 | NET | WebSocket server on the HTTP port, seating, `welcome`, `reject` | **M** |
| NET-2 | NET | 30 Hz room loop with drift correction and catch-up cap | **M** |
| NET-3 | NET | Per-player input buffer, tick matching, repeat-last-mask | **M** |
| NET-4 | NET | Snapshot builder at 15 Hz with per-player `ack` | **M** |
| NET-5 | NET | Dev lag/jitter shim — the highest-value tool in the project | **S** |
| NET-6 | NET | Headless bot harness, `npm run bots -- 15` | **M** |
| NET-7 | NET | Position sanity check with correct-and-log | **S** |
| MOVE-1 | MOVE | Movement sim: integer units, corner assist, no player collision | **L** |
| CLI-1 | MOVE | Client socket, clock lead, reconnect with backoff | **L** |
| CLI-2 | MOVE | Keyboard → input bitmask | **S** |
| CLI-3 | MOVE | Prediction + replay. ~40 lines. **The task the game lives or dies on.** | **L** |
| REN-1 | ARENA | Canvas boot, DPR handling, camera follow and clamp | **M** |
| REN-2 | ARENA | Cached 8×8-tile chunk renderer with dirty tracking | **L** |
| ART-1 | ART | Palette, 8 block painters, player sprite, boot-time baking | **L** |
| BOOM-1 | BOOM | Bomb placement rules, caps, pass-through | **M** |
| BOOM-2 | BOOM | `fire.spread()` — pure, every stop/pass rule | **L** |
| BOOM-3 | BOOM | Same-tick chain detonation with a cap | **M** |
| BOOM-4 | BOOM | Block HP, destruction events, brick regeneration | **L** |
| BOOM-5 | BOOM | Death, shield, respawn, perk drop, kill attribution | **L** |
| BOOM-6 | BOOM | Client-side fire prediction from the bomb list | **M** |
| ARENA-1 | ARENA | Author the three maps, spawn rings, balance pass | **L** |
| ART-2 | ART | Bomb, fire, damage states, explosion flash | **L** |
| AUD-1 | ART | WebAudio synth and the eight SFX, volume defaults, persistence | **L** |
| PLG-1 | PLAGUE | Seven statuses: timers, expiry, bitmask | **L** |
| PLG-2 | PLAGUE | Contagion with per-pair cooldown | **M** |
| PLG-3 | PLAGUE | Reduction interactions (hitbox, columns, radius 1) | **M** |
| RND-1 | ROUND | Round timer, end, intermission, map rotation, reset | **L** |
| RND-2 | ROUND | Leaderboard JSON, flush, lifetime score, ranks | **M** |
| LOOT-1 | LOOT | Drop roll, weighted table, Gift, caps, expiry, death drop | **L** |
| LOOT-2 | LOOT | Perk effects and caps, reserved types at weight 0 | **M** |
| ART-3 | ART | Perk icons, status effects, **the tracer** | **L** |
| AUD-2 | ART | Three music loops with a look-ahead scheduler | **XL** |
| SHELL-1 | SHELL | Menu: name, colour preview, map cards, PLAY | **L** |
| SHELL-2 | SHELL | HUD: stats, timer, connection indicator, toasts | **L** |
| SHELL-3 | SHELL | TAB scoreboard with click-to-observe | **L** |
| SHELL-4 | SHELL | Chat and kill feed | **M** |
| SHELL-5 | SHELL | Q map overview and observer free-camera | **L** |
| DEP-1 | DEPLOY | Dockerfile and compose, no build step | **S** |
| DEP-2 | DEPLOY | TLS on 443, Let's Encrypt, auto-renew | **L** |
| DEP-3 | DEPLOY | Environment-variable config, nothing AWS-specific | **S** |
| DEP-4 | DEPLOY | `/healthz`, CSP, security headers | **S** |
| DEP-5 | DEPLOY | IT ticket paragraph | **S** |
| DEP-6 | DEPLOY | Restart policy, log rotation, restore procedure | **S** |
| TUNE-1 | — | Playtest and tune the feel | **L** |
| TUNE-2 | — | 16-bot load test with recorded numbers | **M** |
| TUNE-3 | — | Two-machine internet test | **S** |
| TUNE-4 | — | Fix the top five annoyances. Not the top twenty. | **L** |
| TUNE-5 | — | README final pass and a three-line how-to-play | **S** |

**Totals:** 15 × S · 18 × M · 21 × L · 1 × XL · 0 × XXL · 0 × XXXL.

If anything on this list starts to feel XXL while you are in it, stop and split it — that is the
signal the design has a hole in it, not that you are slow.

---

## 9. Dependency graph

```
F-1 ─┬─ F-2 ─┬────────────────────────────────────────────────┐
     ├─ F-3 ─┤                                                │
     ├─ F-4 ─┤                                                │
     └─ F-5 ─┘                                                │
             │                                                │
 NET ────────┴─ NET-1 ─ NET-2 ─ NET-3 ─ NET-4 ─┬─ NET-5       │
                                               ├─ NET-6       │
MOVE ───────────  MOVE-1 ──────────────────┐   └─ NET-7       │
                  CLI-1 ─ CLI-3 ◄──────────┘                  │
                  CLI-2                                       │
ARENA ──────────  REN-1 ─ REN-2 ◄─────────────────────────────┘
ART ────────────  ART-1
        ════════════════════ M1 ════════════════════
BOOM    BOOM-1 ─ BOOM-2 ─┬─ BOOM-3
                         ├─ BOOM-4 ─ BOOM-5
                         └─ BOOM-6
ARENA   ARENA-1      ART   ART-2   AUD-1
        ════════════════════ M2 ════════════════════
PLAGUE  PLG-1 ─ PLG-2 ─ PLG-3      ROUND  RND-1 ─ RND-2
LOOT    LOOT-1 ─ LOOT-2            ART    ART-3   AUD-2
        ════════════════════ M3 ════════════════════
SHELL   SHELL-1..5                 DEPLOY DEP-1 ─ DEP-2 ─ DEP-3 ─ DEP-4 ─ DEP-5 ─ DEP-6
        ════════════════════ M4 ════════════════════
        TUNE-1..5                  ══ M5 ══
```

The only cross-slice blocks in the whole plan are **MOVE-1 → CLI-3** and **BOOM-2 → BOOM-6**, and
both are the same thing: a `shared/sim/` file that the client imports. Land MOVE-1 early on day
one and the dependency disappears.

---

## 10. Risks

| Risk | Likelihood | What we do |
|---|---|---|
| Netcode feels bad at 180 ms | Medium | NET-5 lag shim from day one. M1 does not pass until it feels local. If it still fails, move the server to `af-south-1` — a config change. |
| Sim desyncs between client and server | Medium | One shared implementation, integer maths, seeded RNG, determinism test. If it desyncs, hash the state on both sides every second and log the first diverging tick. |
| Slices collide anyway | Medium | File-level ownership. `render/entities.js` is the one shared file — keep it a dispatcher. |
| Corporate IT blocks it | Low | One hostname, port 443, `wss://`, no external requests. DEP-5 is the ticket text. |
| Art takes longer than anyone thinks | **High** | Art is code, procedural, with its own preview harness that needs no game. Ship with primitives if needed — the tracer carries readability on its own. |
| Scope creep into Kick / Detonator / Bat | **High** | They are reserved type ids at weight 0. Adding one mid-sprint is a conversation, not a commit. |
| It is fun for one Friday then nobody plays | Medium | The real risk. Ship M2 fast, play it daily, let what is actually fun drive phases 3–5. |

---

## 11. Deliberately not in this plan

- CI. Running `npm test` before a push is enough; add GitHub Actions if a bad merge ever reaches
  `main`.
- A staging environment. The game *is* the staging environment until Friday.
- Database, migrations, ORM. It is one JSON file.
- Compose with multiple services. One container.
- A design system. One stylesheet.
- Error tracking. `console.error` and the server log.

Each is a real thing to add the day it earns its place. None of them has yet.
