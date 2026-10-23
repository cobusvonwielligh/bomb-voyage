# Bomb Voyage — Wire Protocol v1

**This document is frozen on day 1.** Both developers build against it before either side exists.
Changing it mid-sprint means coordinating a release; adding an optional field does not.

Transport: a single WebSocket at `wss://<host>/ws`, same origin as the page. Payload: **JSON
text frames**. One message per frame.

---

## Why JSON

16 players at 15 Hz with full snapshots is roughly **22 KB/s down per client** and **350 KB/s up**
from the server. That is nothing for a `t3.micro`, and it means both of us can read every packet
in the browser's Network tab while debugging. A binary codec saves bandwidth we are not short of
and costs a class of bugs we cannot afford with two people.

**Trigger for revisiting:** if a real 16-player round shows server upstream above 2 MB/s, or any
client's parse time above 2 ms per snapshot, switch `players` and `bombs` to delta encoding
first (same JSON shape, only changed fields). Binary framing is the step after that, and only
then.

---

## 2. Envelope

Every message is an object with a `t` (type) field. Nothing else is required at the envelope
level.

```json
{ "t": "input", "...": "..." }
```

Types are lowercase strings. Unknown types must be **ignored, not rejected** — that is what makes
adding an optional message safe.

---

## 3. Client → Server

### `hello` — first message after the socket opens

```json
{
  "t": "hello",
  "name": "Cobus",
  "playerId": "p_8f2a...",      // from localStorage, or null for a new player
  "clientVersion": 1
}
```

Server replies `welcome` or `reject`.

### `input` — every tick (30 Hz)

```json
{
  "t": "input",
  "tick": 10432,                 // the client tick this input applies to
  "m": 5,                        // bitmask: 1=right 2=up 4=left 8=down 16=bomb
  "x": 4096, "y": 2816           // client's predicted position, for server sanity check
}
```

Send one per tick even when the mask is unchanged — it doubles as a heartbeat and keeps the clock
sync honest. 60 bytes × 30 Hz = 1.8 KB/s up per client. Fine.

### `respawn`

```json
{ "t": "respawn" }
```

### `chat`

```json
{ "t": "chat", "msg": "behind you" }
```

Server rate-limits to 1/s and truncates to 140 chars. Over-limit messages are dropped silently.

### `observe`

```json
{ "t": "observe", "target": 7 }   // playerIndex, or null for free camera
```

### `ping`

```json
{ "t": "ping", "c": 1729687012345 }   // client Date.now()
```

Send every 2 s. See [NETCODE.md](NETCODE.md) §4.

---

## 4. Server → Client

### `welcome` — once, in reply to `hello`

```json
{
  "t": "welcome",
  "you": 3,                       // your playerIndex, 0..15
  "playerId": "p_8f2a...",        // store this in localStorage
  "tick": 10401,                  // current server tick
  "roundEndsAtTick": 28800,
  "map": {
    "id": "arena",
    "w": 31, "h": 25,
    "cells": "AAABBB...",         // see §5
    "spawns": [[1,1],[29,1], ...]
  },
  "players": [ <playerState>, ... ],
  "bombs":   [ <bombState>, ... ],
  "perks":   [ <perkState>, ... ],
  "config":  { "tickHz": 30, "snapHz": 15, "tileSize": 32, "fuseTicks": 72, ... }
}
```

`config` carries every rule constant the client needs so a server tuning change does not require a
client deploy. The client must read these, never hardcode them.

### `snap` — 15 Hz

```json
{
  "t": "snap",
  "tick": 10404,
  "ack": 10402,                   // last input tick the server processed from YOU
  "players": [
    { "i": 0, "x": 4096, "y": 2816, "d": 2, "st": 1, "hp": 1,
      "b": 3, "f": 2, "sp": 1, "sh": 1, "s": 12, "k": 4, "dd": 2, "stat": 36 }
  ],
  "bombs": [
    { "id": 812, "x": 10, "y": 7, "o": 3, "r": 2, "at": 10470 }
  ],
  "ev": [ <event>, ... ]
}
```

Player fields: `i` index · `x`,`y` position units · `d` facing 0R 1U 2L 3D · `st` state
(0 dead, 1 alive, 2 observing) · `b` bombs · `f` fire radius · `sp` speed step · `sh` shields ·
`s` round score · `k` kills · `dd` deaths · `stat` status bitmask.

Bomb fields: `id` · `x`,`y` **tile** coords · `o` owner index · `r` radius at placement ·
`at` the tick it explodes. **`at` is what makes client-side fire prediction work — it is
authoritative and never changes.**

Only **alive or observing** players appear in `players`. A disconnected player is removed and a
`leave` event fires.

### `ev` — events, carried inside `snap`

Events are things that happen at an instant and must not be missed. Each has `e` and a tick.

```json
{ "e": "bomb",     "tick": 10404, "id": 812, "x": 10, "y": 7, "o": 3, "r": 2, "at": 10470 }
{ "e": "blockhit", "tick": 10470, "x": 11, "y": 7, "hp": 3 }
{ "e": "blockdie", "tick": 10470, "x": 11, "y": 7 }
{ "e": "blocknew", "tick": 11000, "x": 11, "y": 7, "b": 1 }
{ "e": "perkadd",  "tick": 10470, "id": 55, "x": 11, "y": 7, "p": 1 }
{ "e": "perkget",  "tick": 10480, "id": 55, "i": 3 }
{ "e": "died",     "tick": 10471, "i": 3, "by": 7, "x": 10, "y": 7 }
{ "e": "spawn",    "tick": 10560, "i": 3, "x": 2816, "y": 2816 }
{ "e": "status",   "tick": 10480, "i": 3, "s": 4, "until": 10780 }
{ "e": "join",     "tick": 10400, "i": 5, "name": "Francois", "c": 7, "rank": 2 }
{ "e": "leave",    "tick": 10900, "i": 5 }
```

**Reliability.** WebSocket is ordered and reliable, so events cannot be lost in transit. They can
still be *missed by a client that joined late* — which is why `welcome` carries full state. A
client must tolerate an event for an entity it has never seen by ignoring it.

### `chat`

```json
{ "t": "chat", "i": 3, "name": "Cobus", "msg": "behind you", "tick": 10480 }
```

### `scores` — 1 Hz, and at round end

```json
{
  "t": "scores",
  "round": [ { "i": 0, "name": "Cobus", "s": 420, "k": 4, "d": 2, "rank": 3, "c": 7 } ],
  "allTime": [ { "name": "Cobus", "s": 18402, "rank": 3 } ]
}
```

### `roundend`

```json
{ "t": "roundend", "winner": 3, "nextMap": "catacombs", "startsInMs": 20000 }
```

### `pong`

```json
{ "t": "pong", "c": 1729687012345, "tick": 10404, "s": 1729687012421 }
```

`c` is echoed verbatim. `tick` is the server tick at send time.

### `reject`

```json
{ "t": "reject", "why": "full" }   // "full" | "badname" | "version" | "banned"
```

---

## 5. Map encoding

`map.cells` is a **base64 string of one byte per cell**, row-major, `w × h` bytes. Byte layout:

```
bits 0-3  block type   0 floor · 1 soft · 2 reinforced · 3 monolith
                       4 iron  · 5 column · 6 shrub walk · 7 shrub solid
bits 4-7  remaining HP (0-9), 0 for indestructible types
```

A 41 × 29 map is 1 189 bytes → ~1.6 KB base64. Sent once in `welcome`; all later changes come as
`blockhit` / `blockdie` / `blocknew` events.

Map files live in `public/assets/maps/*.json` with a readable ASCII `rows` array; the server
converts to bytes at boot. Authoring stays human-editable, the wire stays small.

```json
{ "id": "arena", "name": "Arena", "legend": { "#": "iron", "." : "floor", "b": "soft" },
  "rows": ["###########", "#.b.b.b.b.#", "..."] }
```

---

## 6. Rules both sides must obey

1. **Never trust client position for anything but a sanity check.** The server compares the
   reported `x`,`y` to its own simulation; if the gap exceeds `1.5 × maxSpeed × ticksElapsed`, the
   server's value wins and it logs a warning. No kicking, no bans.
2. **Ignore unknown message types and unknown fields.** This is the whole forward-compatibility
   story.
3. **Every tick number is a server tick.** The client's own tick estimate converges onto it
   (see [NETCODE.md](NETCODE.md) §4). There is no second clock.
4. **Iterate collections in ascending id.** Object key order is not a contract.
5. **No floats on the wire** except `pong` timestamps. Positions are integer units.
