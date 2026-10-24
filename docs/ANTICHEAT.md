# Anti-cheat

What the client is trusted with (nothing that matters), what it is not, what has been done, and
what is worth doing next. Written after an audit of every path by which a browser can influence
the game.

The short version: **the simulation is on the server and the client is a renderer with an
opinion.** Everything below follows from that one sentence, and every future feature has to keep
it true.

---

## 1. The threat model

One office, sixteen seats, a public URL, and colleagues who know how to open devtools. The
realistic attacks, in the order somebody would actually try them:

| # | Attack | Where it would land |
|---|--------|---------------------|
| 1 | Edit values in the console (`world.players[0].speed = 9`) | the client's own prediction |
| 2 | Edit `localStorage` (identity, name, settings) | who the server thinks you are |
| 3 | Craft `input` packets by hand over the open socket | the authoritative simulation |
| 4 | Flood packets, chat, joins | availability |
| 5 | Replay or steal somebody's identity | the lifetime leaderboard |
| 6 | Read the page's own source for secrets | nothing, if there are none |
| 7 | A scripted player — an aimbot or a perfect-dodge loop | the game, legitimately |

Only (3), (4), (5) and (7) can affect anybody else's round. (1) and (2) are self-harm. (6) is a
question about what we store, answered in §4.

---

## 2. What the client cannot do, and why

### Movement and position

`shared/sim/movement.js` runs on the server for every player, every tick. The client runs the same
function for its own player as a *prediction*, and every snapshot overwrites the predicted state
with the server's and replays the unacknowledged inputs on top (`reconcile` in
`public/client/world.js`). So:

* setting `speed`, `x`, `y`, `stamina` or `slideV` in the console changes what you SEE for at most
  two ticks, and the next snapshot drags you back. This is the rubber-banding the netcode is
  designed to absorb, pointed at yourself on purpose.
* **the server never reads a position from a client.** The input packet carries `x` and `y` — the
  client's idea of where it is — and `room.input()` ignores them completely; they exist for a
  future desync log. Nothing else on the server touches them. Verified by test
  (`test/wire.test.js`, "the server never trusts a client's position").

### Input

`room.input(seat, tick, mask)` is the only way into the simulation, and it is narrow by
construction:

* `mask & IN_MASK` — six bits, exactly the ones a keyboard can produce. Extra bits are dropped
  rather than carried into the sim.
* `tick <= lastAckTick` is refused: an input for a tick the server has already simulated is too
  late, so there is no rewriting the past.
* the buffer holds `INPUT_BUFFER_TICKS` (64) entries and evicts the oldest, so stuffing it with
  far-future ticks costs the attacker memory on their own machine and the server nothing.
* one mask per tick. Sending a thousand inputs for one tick is a thousand overwrites of one slot:
  **you cannot move twice in a tick, place two bombs in a tick, or slide twice.** Every rate in
  the game is a rule in the simulation, not a property of how often the client speaks.

Bomb placement, the slide, stamina, pickups, damage, shields and the gull payout are all decided
server-side from the mask. The slide is worth calling out because it is new and it is the one
mechanic with a *gesture*: the double-tap is detected in the browser and arrives as a single bit,
and the simulation then applies its own cost, cooldown and velocity. A client that sets that bit
every tick gets exactly what a player who double-taps perfectly gets — one slide per
`SLIDE_COOLDOWN_TICKS`, each costing `SLIDE_STAMINA_COST` — which is why the gesture can live in
the client at all.

### Availability

`server/guard.js`: per-address connection limits before the socket exists, and a per-socket
message budget (a thousand dropped in ten seconds closes it). Chat is rate-limited; commands have
their own shorter throttle; one browser may hold `MAX_SESSIONS_PER_DEVICE` sessions.

### Identity

Until recently: none. The leaderboard is keyed by NAME (`careerKey`), because in an office the
name is the person — and that meant anybody could type `cobusvw` and inherit the career. Now names
are owned: see §3.

### Commands

The dangerous ones (`/restart`, `/godmode`, `/gamespeed`, `/roundtime`, `/map`, `/kick NAME`) are
gated on `room.isAdminSeat` — the admin key, or the configured admin name where no key is set —
and **not** on `hostSeat`, which falls back to whoever joined first. They are also absent from
`/help` for everybody else, and refusing one returns the unknown-command reply rather than "not for
you": a refusal that confirms the command exists is an invitation.

---

## 3. Passwords (done)

`server/accounts.js`. A name is claimed once with a password; after that it needs either the
password or a token the server issued to this browser.

* scrypt (N=2^15, r=8) with a 16-byte random salt per account, parameters stored alongside each
  hash so they can be raised later without invalidating anybody.
* the plaintext is never stored, never logged, never echoed, and never kept past the hash call.
* device tokens are 256 random bits; the server keeps only `sha256(token)`, so a stolen
  `accounts.json` yields no passwords and no sessions.
* timing-safe comparisons; an unknown name still pays for a hash, so timing does not reveal which
  names exist.
* five wrong answers locks the name for a minute, doubling to an hour.
* tokens expire after `DEVICE_TTL_MS` (30 days) and slide forward on every use. `forgetDevices`
  revokes every browser for a name at once.
* `accounts.json` is written 0600, with the same never-overwrite-an-unreadable-file rule the
  leaderboard uses.
* spectating needs no password, which is both correct (a watcher has no identity to protect) and
  the escape hatch when somebody forgets theirs.
* `REQUIRE_PASSWORD=0` turns the whole thing off for a LAN party.

Tested in `test/accounts.test.js` (the store) and `test/password.test.js` (the handshake, over a
real socket against a real server).

---

## 4. Local storage (done, with an honest caveat)

`public/client/store.js`. Every value the client keeps — identity, name, device id, trust tokens,
volumes, the auto-respawn preference — goes through a seal: XOR-obfuscated, base64'd, and carrying
a checksum over (key, value, per-browser salt).

**This is tamper evidence and obfuscation, not encryption.** A page cannot keep a secret from its
own console: anything the page can decrypt, a person with devtools can decrypt by calling the same
function, and fetching a key from the server only moves it to the network tab. Any product that
claims otherwise is wrong. What the seal does buy:

* a hand-edited or half-written value fails its checksum and is discarded rather than used;
* the key is part of the checksum, so one value cannot be pasted over another;
* the salt is per browser, so a sealed value from one machine is rejected on another;
* nothing in storage is a readable invitation — `bv.name` is not a text field inviting an edit.

And what makes all of that *sufficient* is §2: there is nothing in local storage worth having.
The identity is now password-backed, and every rule is enforced on the server.

---

## 5. What is left — the plan

In priority order. Nothing here is urgent, because nothing in §2 is currently broken; this is the
list for when the server is played by people who did not write it.

### 5.1 Server-side plausibility logging (cheap, do first)

The server already receives the client's own idea of its position in every input packet and
ignores it. Compare it instead: `|client − server| > N units` for `K` consecutive ticks is either a
desync bug or a modified client, and both are things we want to know about. Log it with the seat
and the name; do not act on it. This is the single highest-value addition, because it turns an
invisible class of problem into a line in a log — and it is five lines in `room.input`.

### 5.2 Input cadence sanity

A player sends about 32 input messages a second. A client sending 300 is not a player, and the
message budget in `guard.js` only catches a flood an order of magnitude bigger. Track per-seat
input rate over a sliding second and log (later: throttle) anything far outside the band.

### 5.3 Win-rate and accuracy telemetry

The honest answer to (7) — a scripted player — is not detection in the simulation, it is
statistics over rounds: kills per bomb, dodge rate, time-to-first-input after a blast appears. All
of it is derivable from what the server already sees. A bot does not have to be banned
automatically; it has to be visible to a human.

### 5.4 Server-authoritative round state for the count-in

The five-second count-in is presentation only: the round is live underneath it. That is a
deliberate scope decision, not an oversight, but it does mean a client could be moving during a
count that tells everybody else the fight has not started. If the count-in is ever meant to GATE
play, it needs a flag in the snapshot and a check in `stepAll`, not a tidier client.

### 5.5 Things deliberately NOT planned

* **Obfuscating or minifying the client.** There is no build step
  (`docs/ARCHITECTURE.md`), the source is public on GitHub, and nothing in it is a secret. Minified
  code would cost every future debugging session and buy an afternoon's delay.
* **Detecting devtools.** Trivially bypassed, insulting to the honest, and it tells you nothing you
  could act on.
* **Client-side integrity checks of the client.** A modified client can report that it is
  unmodified. This is theatre.
* **A real encryption scheme for `localStorage`.** See §4: there is no key that the attacker does
  not also have.

---

## 6. The rule for new features

Every time something is added, ask the two questions that keep §2 true:

1. **Does the server decide it?** If a rule's outcome depends on a number the client sent, the
   client owns that rule. The gesture may live in the browser; the consequence may not.
2. **Would it matter if a client lied about it?** If the answer is no, the client can keep it (the
   slide's double-tap, the dust, the count-in digit). If the answer is yes, it belongs in
   `shared/sim` and is run on the server with the client merely predicting it.
