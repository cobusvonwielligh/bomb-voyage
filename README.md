# Bomb Voyage

A lightweight 16-player browser clone of [Game of Bombs](https://gameofbombs.com), built for
Friday-afternoon games at eezi.

**Live:** https://bombvoyage.online · **Health:** [/healthz](https://bombvoyage.online/healthz)
· **Sprites:** [/art-preview.html](https://bombvoyage.online/art-preview.html)

`www.bombvoyage.online`, `15.240.88.189.sslip.io` and the bare IP all answer and 301 to the apex,
so old links keep working and only one URL ever shows in the address bar.

---

## Status

| | |
|---|---|
| ✅ Spec | All of `docs/`. Read [docs/PLAN.md](docs/PLAN.md) first. |
| ✅ Deployment spine | Server, TLS, systemd, smoke tests, reboot-safe. |
| ✅ CI | Tests on every push and PR. No secrets needed. |
| ✅ Deploy | Manual, ~4 s, with one-level rollback. Auto-deploy is built but switched off. |
| ✅ Domain | `bombvoyage.online`, canonical. Aliases redirect to it. |
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

Manual, and quick — about **4 seconds** end to end. Pushes your working tree, uncommitted work
included.

```bash
npm run deploy        # tests, then deploy          ~5s
npm run deploy:fast   # skip the tests              ~4s
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
