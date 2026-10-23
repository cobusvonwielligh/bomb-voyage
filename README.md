# Bomb Voyage

A lightweight 16-player browser clone of [Game of Bombs](https://gameofbombs.com), built for
Friday-afternoon games at eezi.

**Live:** https://bombvoyage.online · **Health:** [/healthz](https://bombvoyage.online/healthz)
· **Sprites:** [/art-preview.html](https://bombvoyage.online/art-preview.html)
· **Where we stand:** [docs/STATUS.md](docs/STATUS.md)

---

## Status

**The game is built and live.** Read [docs/STATUS.md](docs/STATUS.md) first — it is the current
state of play, what changed direction, and what is still missing. `docs/PLAN.md` is the original
work breakdown and is now history.

| | |
|---|---|
| ✅ The game | 16 players, 5 maps, 10-minute rounds, bots, perks, stamina, powder kegs |
| ✅ Transport | **WebTransport over QUIC**, racing WebSocket, whichever connects first wins |
| ✅ Deployment | TLS, systemd, reboot-safe, one-level rollback, ~6 s end to end |
| ✅ Tests | 227, `node --test`, no framework. Green on every push. |
| ✅ Domain | `bombvoyage.online`, canonical. Aliases redirect to it. |
| ✅ Observer mode | Spectate from the menu, or from the death card without losing your seat to nobody |

Measured round trip from Cape Town to the box: **62 ms min / 73 ms median**, and a QUIC session
is ready in about **50 ms**. The netcode is designed to survive 180 ms, so there is headroom.

---

## What this is

- Up to **16 players**, 5 maps, 10-minute rounds (`/roundtime` to change it live).
- Grid-based Bomberman rules, matched closely enough that Game of Bombs veterans feel at home,
  plus **stamina** and **powder kegs** of our own.
- One server, one hostname, one port — **443, both TCP and UDP**. No CDNs, no third-party
  domains, no build step.
- Vanilla JS on the client, Node on the server. Two runtime dependencies: `ws` and the
  WebTransport/QUIC pair. No framework.
- Art and audio are generated in code. Four decorative PNGs on the landing page are the only
  binary assets; nothing inside the game is an image.

What it is **not**: see [docs/DESIGN.md](docs/DESIGN.md) → Non-goals. Short version: no accounts,
no payments, no persistent world, no mobile, no matchmaking, no anti-cheat.

---

## Run it locally

```bash
npm install                        # ws, plus the WebTransport pair
cp config.example.ini config.ini   # optional — defaults work without it
npm start                          # http://localhost:8080
npm test                           # 227 tests, node --test, no framework
```

WebTransport needs TLS and a native addon, so locally you get WebSocket and the client never
notices. That is the same fallback everybody behind a UDP-blocking firewall gets in production.

Open two tabs. No database, no Docker.

**`config.ini` is gitignored** and holds every setting and secret; `config.example.ini` is the
committed template. Environment variables override it, so `LAG=200 npm start` works without
editing anything. Full table: [docs/DEPLOY.md](docs/DEPLOY.md) §5.

**Develop with the lag shim on.** This is the single highest-value habit on the project:

```bash
npm run dev          # LAG=200 JITTER=40 — what a bad connection feels like
```

If your own character ever feels delayed at that setting, that is the bug, and it outranks
everything else. See [docs/NETCODE.md](docs/NETCODE.md) §7.

## Deploy

Manual, and quick — about **6 seconds** end to end. Pushes your working tree, uncommitted work
included.

```bash
npm run deploy        # tests, then deploy          ~6s
npm run deploy:fast   # skip the tests              ~5s
npm run rollback      # back to the previous deploy ~2s
npm run logs          # follow the server journal
```

Ctrl-C is safe at any point: if it lands before `sync`, the server has not been touched.

What makes it fast — one multiplexed SSH connection for every remote step instead of a handshake
each, `npm ci` only when `package-lock.json` actually changed, and a hardlinked snapshot so
rollback is a directory swap rather than a transfer. Rollback is its own undo: run it twice and
you are back where you started.

GitHub Actions runs the tests on every push but **does not deploy**. The server still has a
token-gated `POST /deploy`, so switching automatic deploys on later is a job block plus two
repo secrets — [docs/DEPLOY.md](docs/DEPLOY.md) §6.

First-time server setup, the domain switch, and operations:
[docs/DEPLOY.md](docs/DEPLOY.md).

---

## Repo map

| Path | What lives here | Slice |
|---|---|---|
| `docs/` | The spec. Read before writing code. | — |
| `shared/` | Code imported by **both** server and client. Tuning constants, pure sim systems. | FOUND (frozen), MOVE, BOOM, LOOT, PLAGUE |
| `server/` | Node process: static serving, WebSocket hub, authoritative loop, persistence. | NET, ROUND |
| `public/` | Everything the browser downloads. Served raw, no bundler. | — |
| `public/client/` | Game client: prediction, renderer, input, audio. | MOVE, ARENA, SHELL, ART |
| `public/assets/` | `art.js` — everything in the game, drawn from shapes. Four decorative PNGs. | ART, ARENA |
| `infra/` | `bootstrap.sh` (once per box), `deploy.sh`, systemd unit. | DEPLOY |
| `test/` | `node --test` suites. | whichever slice owns the system |

Slice boundaries and file ownership: [docs/PLAN.md](docs/PLAN.md) §2 and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5. What each file actually does today:
[docs/STATUS.md](docs/STATUS.md) §3.

---

## Key decisions already made

Settled. Reopen one before writing code, not after.

| Decision | Why | Detail |
|---|---|---|
| JSON, not a binary codec | 16 players is tiny. Debuggable in devtools, on either transport. | [PROTOCOL.md](docs/PROTOCOL.md) |
| Two transports, raced, never one | QUIC where UDP is allowed; WebSocket where it is not. Nobody is ever locked out. | [NETCODE.md](docs/NETCODE.md) §8 |
| Explosions are **derived**, not pushed | Fuse is deterministic, so a 180 ms client predicts fire perfectly and nobody dies to lag | [NETCODE.md](docs/NETCODE.md) |
| Players do not collide with each other | Deletes the entire "I'm seeing you 150 ms in the past" problem | [RULES.md](docs/RULES.md) |
| No build step, raw ES modules | One less thing to break at 16:45 on a Friday | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| systemd, not Docker | One process, one dependency. Deploy is an rsync, not an image build. | [DEPLOY.md](docs/DEPLOY.md) §1 |
| Art is drawn in code from shapes | No sprite sheets to version, free recolouring per player | [ART-AUDIO.md](docs/ART-AUDIO.md) |
| One port, one hostname, TLS on 443 | Corporate IT unblocks one thing | [DEPLOY.md](docs/DEPLOY.md) §2 |

---

## Credits

Game design is Game of Bombs'. This is a clone for private office play, not a product.
Do not copy their art assets into this repo — everything here is drawn from scratch in code.
