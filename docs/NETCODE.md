# Bomb Voyage — Netcode

Target: a player on a 180 ms link plays the same game as a player on a 20 ms link.

**This is a short document on purpose.** Most latency machinery exists to solve "I shot you but
you had already moved". Bomberman does not have that problem — the dangerous thing announces
itself 2.4 seconds in advance. So we solve it by *removing* the need for the machinery, not by
building it.

---

## 1. Two design choices do almost all the work

### (a) Fire is derived, not pushed

A bomb's snapshot carries `at` — the exact server tick it explodes. Nobody ever sends "it
exploded". Every client computes the blast itself at tick `at` from the bomb list and the map,
using the same `fire.spread()` function the server uses.

A 180 ms player learns about the bomb ~90 ms after placement and still has 2.3 s of warning. The
blast lands on the same tick on every screen.

**So: no rollback, no lag compensation, no server rewind.** They are not simplifications we are
making — they are genuinely not needed. The one rule this buys with: explosion timing is a pure
function of `(bombs, map, tick)`. No wall clock, no `Math.random()`, iterate bombs by ascending
id.

### (b) Players do not collide with each other

Faithful to Game of Bombs, and it means a stale remote position affects only what you *see*,
never what happens to you. Rendering other players 130 ms in the past becomes invisible.

---

## 2. The only three mechanisms we build

Each is small. If any grows past the sizes below, something has gone wrong.

### Prediction + replay — the local player *(~40 lines)*

```
every tick:  mask = readKeys()
             pending.push({tick, mask})
             send input
             movement.step(me, mask)        // instant response

on snap:     drop pending where tick <= snap.ack
             if (snap.me differs from my position):
                 me = snap.me
                 for (p of pending) movement.step(me, p.mask)   // replay
```

That is the whole thing. It works because `movement.step()` is one function in `shared/`,
integer maths, imported by both sides — so the replay reproduces the server exactly and the
correction is usually zero.

Do **not** add: a position history ring buffer, an error tolerance band, smoothed blending.
Start without them. If players report visible snapping on open ground, add a 100 ms lerp toward
the corrected position — one line — and nothing more.

### Clock lead *(~10 lines)*

The client must run slightly ahead so its input for tick T lands before the server simulates T.

```
ping every 2 s:  rtt = now - pong.c
                 serverTick ≈ pong.tick + (rtt/2)/33.3
                 clientTick = serverTick + ceil((rtt/2 + 50ms)/33.3)
```

Smooth `clientTick` by moving it one tick at a time toward the target instead of jumping. At
180 ms RTT the lead is about 5 ticks. Use a short rolling minimum of RTT (say 5 samples) so one
jitter spike does not shove the clock — that is one `Math.min`, not a jitter model.

If the estimate is ever off by more than 20 ticks, hard-snap and log it. That means the tab was
backgrounded, not that the network is interesting.

### Remote interpolation *(~15 lines)*

Keep the last two snapshots per remote player. Draw them at `serverTick - 4` (≈133 ms behind),
lerping between the bracketing snapshots. If the buffer runs dry, **hold the last position** and
fade the sprite — never extrapolate. A ghost standing still reads as a hiccup; a ghost sliding
through a wall reads as a bug.

---

## 3. Server side

- Buffer inputs per player keyed by tick. At tick T use the input for T; if it is missing,
  **repeat the last mask** (a dropped packet should not make you stutter). Discard inputs for
  ticks already simulated.
- Sanity-check reported position against the simulated one. Above `1.5 × maxSpeed × ticksElapsed`,
  the server's value wins and it logs a warning. Never kick — this is there to catch our bugs,
  not cheaters.

---

## 4. What latency still costs

| | 180 ms player sees | OK? |
|---|---|---|
| Own movement | instant | ✅ |
| Own bomb | ghost at 70 % alpha, confirmed ~180 ms later | ✅ |
| Dying to fire | exactly on time, same tick as everyone | ✅ |
| Other players | ~130 ms behind — no collision, so no consequence | ✅ |
| Racing for a perk | server decides; loser sees it vanish | ✅ annoying once a round |
| Catching a status | applies ~RTT after contact | ✅ |

Perk contention is the only genuinely degraded thing, and it is a flicker, not a death.

---

## 5. Budget

| | |
|---|---|
| Snapshot, 16 players | ~1.5 KB JSON |
| Down per client | ~22 KB/s |
| Up from server | ~350 KB/s |
| Egress per 16-min round | ~180 MB (free tier = ~550 rounds/month) |

Log a warning if any tick exceeds 20 ms. That is the early signal that something went quadratic.

---

## 6. Failure handling

- **Socket closes:** reconnect with backoff 1 → 2 → 4 → 8 s, re-send `hello` with the stored
  `playerId`, get re-seated.
- **Tab backgrounded:** on resume, hard-resync the clock and throw away all pending inputs. Do
  not replay two minutes of simulation.
- **Server restart:** clients reconnect and get a fresh `welcome`. The round is lost, the
  leaderboard file is not.
- **Client falls behind** (pending inputs > 60): stop predicting, show the connection warning,
  follow the server until it recovers.

---

## 7. Verify before Friday

Do not discover netcode problems with 12 colleagues watching.

1. **`LAG=200 JITTER=40 npm start` from day one.** Develop at that setting permanently. This is
   the single highest-value thing in this document.
2. **Determinism test**: same inputs through the sim twice → identical state hash.
3. **`npm run bots -- 15`**: a full lobby before a full lobby exists.
4. **Two machines over the real internet**, both devs, before the first session.
