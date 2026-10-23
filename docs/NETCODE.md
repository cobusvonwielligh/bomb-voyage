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

---

## 8. Two transports, raced

The game dials **WebTransport over HTTP/3** and **WebSocket** at the same time and plays on
whichever connects. Neither is a fallback in the usual sense — both are dialled on every
connection, every time.

### Why bother

Head-of-line blocking. Over TCP a single lost packet stalls every byte queued behind it, so one
drop delays the next three snapshots as well as the one it hit. Inputs and snapshots are
continuously replaced — a lost one is superseded 33 ms later — so they want a channel that drops
rather than waits. QUIC datagrams are exactly that.

### Why it can never be the only way in

UDP/443 is blocked by corporate firewalls far more often than TCP is, and this game exists to be
played in an office. A firewall that drops UDP does not *fail*, it **hangs**, and a five-second
hang on the join screen is indistinguishable from the game being broken. So both are dialled at
once and the slow one is simply never used.

### What goes down which channel

`shared/wire.js` decides, and both ends use the same function:

| Message | Channel | Why |
|---|---|---|
| `input` | datagram | superseded by the next tick's |
| `snap` | datagram | superseded 66 ms later |
| `ping` / `pong` | datagram | superseded 2 s later |
| everything else | reliable stream | handshake, chat, round transitions — must arrive, in order |

A datagram over `DATAGRAM_SAFE_BYTES` (1100) falls back to the stream, because an oversized
datagram is dropped *silently* by the stack rather than rejected — that would turn a full server
into an intermittently invisible one. A real sixteen-player snapshot measures 1749 bytes, so it
takes the stream; that is asserted by a test rather than assumed.

The stream is newline-delimited JSON. `JSON.stringify` never emits a raw newline — every control
character inside a string is escaped — so a `0x0A` byte is unambiguously a record boundary and
no escaping layer is needed.

### The race, and the trap in it

A WebSocket `open` fires as soon as TCP and TLS are up, which beats a cold QUIC handshake. A
plain first-past-the-post race therefore hands the win to the WebSocket almost every time, and
the QUIC path — once built — is never actually used by anybody.

So the WebSocket **waits**. When it connects first it is held as a provisional winner for
`PREFER_MS` (350 ms); if WebTransport lands inside that window it takes the connection instead.
The moment WebTransport fails, the wait is cancelled and the WebSocket goes through immediately,
so a UDP-blocked network does not pay the window on every reconnect. `RACE_MS` (1200 ms) is the
outer backstop for when both are slow.

Measured: a QUIC session to the live server is ready in about **50 ms** from an external
network, so 350 ms is a wide margin.

### Server side

`server/webtransport.js` wraps every session in a `ws`-shaped adapter, so `server/net.js` never
learns which transport a player arrived on. It implements only what net.js actually uses — send,
close, readyState, ping, and the `message` / `close` / `error` / `pong` events — so a future use
of some other `ws` API fails loudly here rather than behaving subtly differently for half the
players.

`startWebTransport` returns `null` rather than throwing on any failure: a missing native binary,
a port already taken, a kernel that will not hand over UDP. The game has to survive all of those
by simply being WebSocket-only, because that is the configuration most players behind a
corporate firewall are in regardless.

> **One ordering bug worth never reintroducing.** The socket must be handed to net.js *before*
> the read loops start. They emit `message` the instant bytes arrive, and a client that sends
> its `hello` in the same breath as opening the stream — which both our clients do — can have
> that message delivered before net.js has attached a listener. EventEmitter drops an event with
> no listener silently, so the symptom is a QUIC session that connects perfectly and then sits
> there receiving nothing.

### Checking it

`/healthz` reports `transports: { websocket, webtransport }`. A **number** under `webtransport`
means the HTTP/3 listener is up; **`null`** means it failed to start and everyone is on
WebSocket. The browser console logs `transport: webtransport` on connect, and the connection dot
in the HUD carries it in its tooltip — a silent fallback is invisible by design, so it needs
somewhere to say so.
