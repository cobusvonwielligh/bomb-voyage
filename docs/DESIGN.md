# Bomb Voyage — Design

Date: 2026-10-23
Author: Cobus (with Claude)
Status: agreed, drives the plan in [PLAN.md](PLAN.md)

---

## 1. Intent

The eezi team wants something to play together on Friday afternoons. Game of Bombs is the
reference — some of us already played it — but it is someone else's server, it is flaky, and
corporate IT does not reliably let it through. We want our own: one box, one hostname, type
your name, play.

The success test is simple and social, not technical:

> On a Friday, 10–12 of us open a link, pick names, and spend 16 minutes blowing each other up
> without anyone saying "mine is lagging" or "how do I do the thing again".

That second half matters. People who played Game of Bombs should not have to relearn anything.
Movement feel, bomb fuse, blast shape, perk icons, the rhythm of the round — all of it should be
close enough that muscle memory transfers.

---

## 2. Goals

1. **16 concurrent players**, one shared arena, no lobbies or matchmaking.
2. **Feels right at high latency.** Designed so a player on a 180 ms link plays essentially the
   same game as a player on a 20 ms link. See §5.
3. **Zero-friction entry.** Type a name, press play. No email, no password, no confirmation.
4. **One IP, one port, one hostname.** An IT department unblocks a single thing and we are done.
5. **Trivially portable.** It runs on a personal AWS account today and inside the eezi VPC later
   with a config change, not a rewrite.
6. **Fast to run locally.** `npm install && npm start` and you are playing. One dependency.
7. **Splittable work.** Two developers working in parallel with near-zero merge conflicts.

## 3. Non-goals (v1)

Explicitly out. Not "later" — out of this build.

- Accounts, passwords, email, OAuth, social login.
- Payments, plutonium, gold, shops, skins, the skin constructor.
- A persistent streaming world. We have three fixed arenas.
- Mobile or touch controls.
- Matchmaking, multiple rooms, multiple server regions.
- Anti-cheat beyond a sanity check on reported position. This is a 12-person office game.
- Puzzles, iron chests, keys, locked gates, forts, warehouses, caches, soccer/goal mode, bosses,
  hamsters, the ball.
- Observer camera scroll-wheel zoom.

## 4. Anti-goals

Things that would make this a failure even if every feature ticked:

- **It is laggy.** If people feel their input is not landing, they will not come back. Latency
  tolerance is the single most important engineering property of this build.
- **It needs a build step to run.** Nobody should have to fight webpack on a Friday.
- **IT blocks it.** Multiple domains, odd ports, WebRTC, or a CDN dependency kills it dead.
- **It takes more than 10 seconds from link to playing.**
- **It is a different game.** If a Game of Bombs player has to relearn how bombs chain or how
  perks drop, we have failed goal 1's spirit.
- **One file both developers need to edit.** That is how a two-person project stalls.

## 5. The central constraint: latency

The server will sit on AWS free tier in Europe. Where the players sit is not yet settled, so the
design assumes the worst realistic case: **South Africa → eu-west-1, ≈180 ms round trip.**

Three things make this playable, and they are the heart of the architecture:

**(a) Explosions are derived, not announced.** When a bomb is placed, the server tells everyone
*when it will explode* (a fixed tick number), not *that it exploded*. Fuse is 2.4 s. A client
180 ms behind still has 2.2 s of warning and computes the identical blast locally. Nobody ever
dies to a blast they could not see. This single decision removes most of the latency problem.

**(b) Players do not collide with each other.** In classic Bomberman and in Game of Bombs you
walk through other players. Keeping that means nothing in the game depends on knowing exactly
where a remote player is *right now* — we can render them 130 ms in the past and it is invisible.

**(c) Your own movement is predicted and reconciled.** Your character responds to your keys on
the same frame. The server is still authoritative; mismatches are corrected by replaying your
unacknowledged inputs. The correction is almost always zero because the movement rules are
deterministic integer maths shared by both sides.

What is left that latency can still hurt: two players grabbing the same perk (server wins, the
loser's pickup flickers away), and catching a status by touching someone (resolved server-side,
appears ~RTT later). Both are acceptable.

Full detail: [NETCODE.md](NETCODE.md).

## 6. The how, as decided

These were chosen, not discovered. A builder may push back but should not quietly change them.

| Area | Decision |
|---|---|
| Server runtime | Node 20+. One dependency: `ws`. HTTP + WebSocket in the same process on the same port. |
| Client | Vanilla ES modules served raw. jQuery for menu/HUD DOM only — never in the game loop. |
| Rendering | Canvas 2D. Static map drawn once into cached 8×8-tile chunk canvases, dirty-redrawn on change. Entities drawn per frame on top. Same approach Game of Bombs uses. |
| Shared code | `shared/` directory, ES modules, imported unchanged by Node and the browser. The simulation is literally the same file on both sides. |
| Wire format | JSON over WebSocket. Full snapshots at 15 Hz. Binary is a later optimisation with a stated trigger, not a day-one cost. |
| Simulation | Fixed 30 Hz tick, integer fixed-point positions (1 tile = 256 units), fully deterministic. |
| Art | Generated in code from shapes at boot into offscreen canvases. No image files. Per-player tint is free. |
| Audio | WebAudio synthesis. No audio files. Music 25 % volume by default, SFX 75 %. |
| Persistence | A JSON file on disk, flushed every 30 s. Leaderboard only. No database. |
| Identity | A name plus a `playerId` in `localStorage`. Name collisions get a numeric suffix. |
| Build | None. `node server/index.js`. |
| Tests | `node --test`. No framework, no fixtures. |
| Deployment | Single container, single port 443, TLS. Portable from personal EC2 to eezi VPC by changing environment variables. |

## 7. Scope: what is in v1

Agreed in planning:

- **Core**: movement, bombs, fire, destructible blocks, death, respawn, 16-minute round,
  scoreboard, name entry, per-player random colour with a motion tracer, 3 maps.
- **Perks**: Bomb +1, Fire +1, Roller-skates +1, Shield, Gift (random).
- **Statuses** (the contagious diseases): Invulnerability, Pacifism, Slowdown, Invisibility,
  Changeling, Reduction, Fast Detonation.
- **Chat** (ENTER) and **observer mode** (TAB → click a name).
- **Leaderboard** with the 16 Game of Bombs rank titles.

Designed-for but **not built** in v1 — the architecture leaves explicit, named slots so adding
them later is a new file, not a refactor:

- Kick, Jelly, Detonator (radio bombs), Bat (charge-throw), Jetpack, Nuclear charge, Blue fire,
  Heart, Key.
- Nyan disease and nyan bombs.
- Rocks, ore, treasure, chests, bridges, arrows, buttons, cabins.

Exact numbers for everything in scope: [RULES.md](RULES.md).

## 8. Constraints

- AWS free tier: one `t3.micro`/`t2.micro`, 1 GB RAM, burstable CPU. The sim must stay well
  inside one core at 30 Hz with 16 players. It will — this is a grid game with ~1 200 cells.
- Free tier egress is 100 GB/month. At 15 Hz JSON snapshots a full 16-player round costs about
  180 MB. That is roughly 500 rounds a month. Comfortable, but it is the number to watch if we
  ever raise the snapshot rate.
- Corporate network: must work over `wss://` on 443 to a single hostname, with a strict
  `default-src 'self'` content security policy and no external requests of any kind.
- Two developers, roughly a week of part-time work, split as vertical slices.

## 9. What is left to the builder

Deliberately unspecified — make the call, write it down in the PR:

- Exact easing on the camera follow.
- Menu layout and copy, beyond "name field, three map cards, play button".
- How bots behave in `npm run bots` (they only need to move and bomb plausibly).
- The shape of the status visual effects, as long as each is distinguishable at a glance.
- Internal naming inside a slice you own.

## 10. Open questions

- **Where the players sit.** Design assumes worst case. If everyone turns out to be in one
  office in South Africa, moving the server to `af-south-1` drops RTT to ~15 ms and we get a
  better game for free. Decide before the first real session; it is a config change, not a code
  change. Note that `af-south-1` is not always covered by the EC2 free tier — check before
  switching.
- **Domain name.** Needed for TLS on 443. If there is no spare eezi domain, use a free
  `*.duckdns.org` or `*.sslip.io` host — still one hostname, still one port, still free.
  See [DEPLOY.md](DEPLOY.md).
