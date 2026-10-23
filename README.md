# Bomb Voyage

A lightweight 16-player browser clone of [Game of Bombs](https://gameofbombs.com), built for
Friday-afternoon games at eezi.

**Live:** https://16.28.138.34.sslip.io · **Health:** [/healthz](https://16.28.138.34.sslip.io/healthz)
· **Sprites:** [/art-preview.html](https://16.28.138.34.sslip.io/art-preview.html)

---

## Status

| | |
|---|---|
| ✅ Spec | All of `docs/`. Read [docs/PLAN.md](docs/PLAN.md) first. |
| ✅ Deployment spine | Server, TLS, systemd, smoke tests, reboot-safe. |
| ✅ CI/CD | Tests on every push; `main` deploys itself. Needs `DEPLOY_URL` and `DEPLOY_TOKEN` repo secrets. |
| ⬜ The game | Not started. Phase 0 onward in [docs/PLAN.md](docs/PLAN.md). |

What works end to end today: HTTPS on 443, `wss://` on the same origin, static serving, the
`/shared` dual-mount, seating up to 16 players, health, certificate auto-renewal, and automatic
recovery after a reboot (verified: back in ~50 s unattended).

Measured round trip from Cape Town to the box: **62 ms min / 73 ms median**. The netcode is
designed to survive 180 ms, so there is plenty of headroom.

---

## What this is

- Up to **16 players**, 3 maps, 16-minute rounds.
- Grid-based Bomberman rules, matched closely enough that Game of Bombs veterans feel at home.
- One server, one hostname, one port (443). No CDNs, no third-party domains, no build step.
- Vanilla JS + jQuery on the client, Node + `ws` on the server. No framework.
- Art and audio are generated in code. There are no binary assets to download.

What it is **not**: see [docs/DESIGN.md](docs/DESIGN.md) → Non-goals. Short version: no accounts,
no payments, no persistent world, no mobile, no matchmaking, no anti-cheat.

---

## Run it locally

```bash
npm install                        # one dependency: ws
cp config.example.ini config.ini   # optional — defaults work without it
npm start                          # http://localhost:8080
npm test                           # node --test, no framework
```

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

**Push to `main`.** GitHub Actions runs the tests, then pokes `POST /deploy` on the server,
which pulls from git and restarts itself. Deployment is pull-based so GitHub never holds an SSH
key and port 22 stays locked to one IP. [docs/DEPLOY.md](docs/DEPLOY.md) §6.

For iterating on uncommitted work, push your working tree straight up:

```bash
npm run deploy      # reads [deploy] from config.ini
```

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
| `public/assets/` | Art and map data (code and JSON, no images). | ART, ARENA |
| `infra/` | `bootstrap.sh` (once per box), `deploy.sh`, systemd unit. | DEPLOY |
| `test/` | `node --test` suites. | whichever slice owns the system |

Slice boundaries and file ownership: [docs/PLAN.md](docs/PLAN.md) §2 and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5.

---

## Key decisions already made

Settled. Reopen one before writing code, not after.

| Decision | Why | Detail |
|---|---|---|
| JSON over WebSocket, not a binary codec | 16 players is tiny. Debuggable in devtools. | [PROTOCOL.md](docs/PROTOCOL.md) |
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
