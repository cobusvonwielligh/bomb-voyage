# Bomb Voyage

A lightweight 16-player browser clone of [Game of Bombs](https://gameofbombs.com), built for
Friday-afternoon games at eezi.

**Status: planning complete, no code yet.** Everything in `docs/` is the agreed spec. Start at
[docs/PLAN.md](docs/PLAN.md).

---

## What this is

- Up to **16 players**, 3 maps, 16-minute rounds.
- Grid-based Bomberman rules, matched closely enough that Game of Bombs veterans feel at home.
- One server, one hostname, one port (443). No CDNs, no third-party domains, no build step.
- Vanilla JS + jQuery on the client, Node + `ws` on the server. No framework.
- Art and audio are generated in code. There are no binary assets to download.

## What this is not

See [docs/DESIGN.md](docs/DESIGN.md) → Non-goals. Short version: no accounts, no payments,
no persistent world, no mobile, no matchmaking, no anti-cheat.

---

## Repo map

| Path | What lives here | Slice |
|---|---|---|
| `docs/` | The spec. Read before writing code. | — |
| `shared/` | Code imported by **both** server and client. Tuning constants, pure sim systems. | FOUND (frozen), MOVE, BOOM, LOOT, PLAGUE |
| `server/` | Node process: HTTP static serving, WebSocket, authoritative sim loop, persistence. | NET, ROUND |
| `public/` | Everything the browser downloads. Served raw, no bundler. | — |
| `public/client/` | Game client: prediction, renderer, input, audio. | MOVE, ARENA, SHELL, ART |
| `public/assets/` | Art and map data (code and JSON, no images). | ART, ARENA |
| `tools/` | Dev-only helpers that never ship to players. | NET |
| `test/` | `node --test` suites. | whichever slice owns the system |

Slice boundaries and the file-ownership table: [docs/PLAN.md](docs/PLAN.md) §2 and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5.

---

## Running locally (target state)

```bash
git clone <this repo>
cd bomb-voyage
npm install            # installs exactly one dependency: ws
npm start              # http://localhost:8080
```

Open two browser tabs at `http://localhost:8080`, enter two different names, and you are in the
same round. No database, no Docker, no env file needed for local dev.

Useful:

```bash
npm test               # node --test, no framework
npm run bots -- 15     # spawn 15 headless bots so you can test a full lobby alone
npm run art            # opens tools/art-preview.html in a browser
```

`npm run bots` matters — do not wait for 16 humans to find a desync. See
[docs/PLAN.md](docs/PLAN.md) → Task NET-6.

---

## Key decisions already made

These are settled. If you want to reopen one, raise it before writing code, not after.

| Decision | Why | Detail |
|---|---|---|
| JSON over WebSocket, not a binary codec | 16 players is tiny. Debuggable in devtools. | [PROTOCOL.md](docs/PROTOCOL.md) |
| Explosions are **derived**, not pushed | Fuse is deterministic, so a 180 ms client predicts fire perfectly and nobody dies to lag | [NETCODE.md](docs/NETCODE.md) |
| Players do not collide with each other | Deletes the entire "I'm seeing you 150 ms in the past" problem | [RULES.md](docs/RULES.md) |
| No build step, raw ES modules | One less thing to break at 16:45 on a Friday | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Art is drawn in code from shapes | No sprite sheets to version, free recolouring per player | [ART-AUDIO.md](docs/ART-AUDIO.md) |
| One port, one hostname, TLS on 443 | Corporate IT unblocks one thing | [DEPLOY.md](docs/DEPLOY.md) |

---

## Credits

Game design is Game of Bombs'. This is a clone for private office play, not a product.
Do not copy their art assets into this repo — everything here is drawn from scratch in code.
