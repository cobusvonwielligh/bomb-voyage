# Bomb Voyage — Deployment

Two requirements shape all of this:

1. **Corporate IT must be able to unblock it by allowing one thing.** One hostname, one port.
2. **Moving from a personal AWS account into the eezi VPC later must be a config change, not a
   rewrite.**

**Current target:** `af-south-1` (Cape Town), one `t3.micro`, hostname
`15.240.88.189.sslip.io`. Cape Town puts the whole team at roughly **15 ms** instead of the
~165 ms the netcode was designed to survive, so the game will feel better than specified.

---

## 1. The shape

```
                    ┌──────────────────────────────────┐
  browser ──443──►  │ EC2 t3.micro · af-south-1        │
   wss://           │  systemd: bomb-voyage.service    │
   https://         │   node server/index.js           │
                    │   :443 HTTPS + WSS  :80 redirect │
                    │  /var/lib/bomb-voyage/           │
                    │    certs/ · leaderboard.json     │
                    └──────────────────────────────────┘
```

One instance. One process. No load balancer, no CDN, no bucket, no database, no second domain.
The WebSocket shares the HTTP server, so `wss://host/ws` is the same origin as the page — no
CORS, no preflight, nothing extra for IT to allow.

**No Docker.** The plan originally called for a container; building it, the honest answer was
that a single Node process with one dependency does not need one. systemd starts it, restarts
it on crash, and survives reboots, and `npm run deploy` is an rsync instead of an image build.
If this ever moves to ECS Fargate, the Dockerfile is six lines written on that day. *Skipped:
container runtime. Add when: the target is ECS or there is more than one service.*

**No load balancer.** It would add sticky-session concerns and cost, for one process serving
16 people. Add one the day there are two servers.

---

## 2. Why this survives corporate IT

Each row is a thing that commonly gets a game blocked, and the choice that avoids it:

| Common blocker | What we do |
|---|---|
| Non-standard ports | **All game traffic on 443.** Port 80 is open only for the HTTPS redirect and certificate renewal. |
| Plain `ws://` on 80 | **`wss://` on 443.** TLS-wrapped, so proxies pass it as ordinary HTTPS. |
| Multiple domains / CDNs | **One hostname.** `Content-Security-Policy: default-src 'self'` — the page is incapable of requesting another host. Verify in the Network tab. |
| Web fonts, analytics | None. Zero external requests. |
| WebRTC / UDP | Not used. |
| Category filters ("games") | Prefer a neutral hostname on an eezi domain over something obviously a game. |

**Ticket text for IT, paste as-is:**

> Please allow outbound HTTPS (TCP 443) to `game.<domain>` (`<elastic-ip>`) for the dev team.
> It is an internally hosted tool on infrastructure we control. It uses standard HTTPS and a
> WebSocket over the same port and hostname. No other hosts, ports or protocols are required.

---

## 3. Hostname without a domain

`sslip.io` resolves any embedded IP, so `15.240.88.189.sslip.io` → `15.240.88.189`, free, instant,
no account. Let's Encrypt issues for it happily.

```
$ dig +short 15.240.88.189.sslip.io
15.240.88.189
```

Swapping to a real eezi hostname later is a DNS record plus re-running `bootstrap.sh` with the
new `HOST`. Nothing in the code knows the name.

---

## 4. First-time setup

### On AWS (console)

1. **Instance** — `t3.micro`, Amazon Linux 2023, 16–20 GB gp3, in `af-south-1`.
2. **Elastic IP** — allocate, associate to the instance. (Since Feb 2024 every public IPv4 costs
   $0.005/h; Free Tier covers 750 h/month for 12 months, so one is free for a year.)
3. **Security group** — exactly three inbound rules, nothing else:

   | Port | Source | Purpose |
   |---|---|---|
   | 443 | `0.0.0.0/0` | the game |
   | 80 | `0.0.0.0/0` | HTTPS redirect + ACME renewal |
   | 22 | your IP | SSH |

   Specifically **not** 8080 — that is local dev only.

### On the box (once, ~3 minutes)

```bash
scp -i ~/Downloads/bombs-away.pem infra/bootstrap.sh ec2-user@15.240.88.189:
ssh -i ~/Downloads/bombs-away.pem ec2-user@15.240.88.189 \
  'HOST=15.240.88.189.sslip.io EMAIL=you@example.com bash bootstrap.sh'
```

`bootstrap.sh` is idempotent — re-run it any time. It installs Node, creates
`/opt/bomb-voyage` and `/var/lib/bomb-voyage`, issues the certificate, installs a deploy hook
that copies the cert somewhere the unprivileged service can read it, and arms a weekly renewal
timer for 03:00 Sunday.

### From your laptop, every deploy after that

```bash
HOST=15.240.88.189.sslip.io npm run deploy
```

Runs the tests, rsyncs, `npm ci --omit=dev`, restarts the service, and polls `/healthz` until it
answers. On failure it prints the last 40 journal lines. Takes a few seconds; do it between
rounds.

---

## 5. Configuration — `config.ini`

All settings and secrets live in **`config.ini`**, which is gitignored and never rsynced, so a
deploy can never clobber it and a secret can never reach GitHub. `config.example.ini` is the
committed template. On the server the real file is `/opt/bomb-voyage/config.ini`, written by
`bootstrap.sh`.

Precedence is **environment variable > `config.ini` > built-in default**, so a one-off like
`LAG=200 npm start` never needs a file edit, and CI can override anything.

| Section | Key | Env | Default | Meaning |
|---|---|---|---|---|
| `server` | `port` | `PORT` | `8080` | `443` in production. |
| | `redirect_port` | `REDIRECT_PORT` | `80` | Plain-HTTP redirect. Only used when TLS is on. |
| | `public_host` | `PUBLIC_HOST` | `localhost` | Redirect targets and logging. |
| | `tls_cert` / `tls_key` | `TLS_CERT` / `TLS_KEY` | blank | Blank → plain HTTP, which is local dev. |
| | `data_dir` | `DATA_DIR` | `./data` | Leaderboard and certificate copies. |
| | `max_players` | `MAX_PLAYERS` | `16` | |
| | `min_bots` | `MIN_BOTS` | `6` | Bots kept topped up while anyone plays; 0 turns it off |
| `deploy` | `token` | `DEPLOY_TOKEN` | blank | Secret for `POST /deploy`. **Blank disables the endpoint entirely** — correct on a laptop. |
| | `ssh_host` / `ssh_user` / `ssh_key` | same | — | Used by `infra/deploy.sh`. |
| `admin` | `key` | `ADMIN_KEY` | blank | Whoever's browser presents it is always host. Open `https://<host>/?admin=<key>` once; the browser keeps it and the address bar drops it. `bootstrap.sh` generates one. |
| | `name` | `ADMIN_NAME` | `cobusvw` | Only used when `key` is blank, which is right on a laptop and wrong anywhere else: names are not secret. |
| `dev` | `lag` / `jitter` | `LAG` / `JITTER` | `0` | Outbound delay in ms. The process **refuses to start** if either is non-zero while TLS is configured. |

Local development needs no file at all: `npm start` → `http://localhost:8080`.

Nothing AWS-specific appears anywhere in the code. That, plus the single JSON state file, is
what makes the VPC move a config change.

---

## 6. CI/CD

```
push to main ─► GitHub Actions ─► npm ci && npm test
                                      │ pass
                                      ▼
                            POST https://host/deploy
                            X-Deploy-Token: <secret>
                                      │ 202
                                      ▼
                     server runs infra/self-update.sh:
                     git reset --hard origin/main
                     npm ci --omit=dev
                     SIGTERM to the server → systemd restarts it
                                      │
                      Actions polls /healthz until
                      "version" equals the pushed sha
```

**Deployment is pull-based, and that is the point.** Port 22 is locked to one IP, and GitHub
runners have dynamic addresses. The alternatives were opening SSH to the world or chasing
GitHub's IP ranges; instead the box updates *itself* over its own outbound HTTPS. GitHub never
holds an SSH key.

The endpoint is deliberately unhelpful to strangers:

- Missing, wrong, or wrong-length token → **404**, not 401. An unauthenticated caller learns
  nothing about whether the endpoint exists.
- Comparison is `crypto.timingSafeEqual` on equal-length buffers.
- 10-second cooldown, so a stuck workflow cannot restart the box in a loop.
- No token configured → the route does not exist at all. That is the default everywhere except
  the server.
- The script cannot sudo: the unit sets `NoNewPrivileges`. It restarts the server by sending it
  SIGTERM (which banks the round) and letting `Restart=always` bring the new code up. A changed
  unit file is therefore only installed by `npm run deploy`, which comes in over SSH.

### Secrets to set once

GitHub → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `DEPLOY_URL` | `https://<host>/deploy` |
| `DEPLOY_TOKEN` | printed at the end of `bootstrap.sh`, and stored in `config.ini` under `[deploy] token` |

Until they are set the deploy job logs a skip and goes green — tests still gate every push.

### Deploying from a laptop

`npm run deploy` rsyncs your working tree, including uncommitted work. It is the fast path for
iterating. A later CI deploy overwrites whatever it pushed, which is correct: git is the source
of truth.

---

## 7. Moving to `bombvoyage.co.za`

Everything is already parameterised. The whole switch:

1. **Buy the domain**, then at the registrar create two records pointing at the Elastic IP:

   | Type | Name | Value |
   |---|---|---|
   | A | `@` | `15.240.88.189` |
   | A | `www` | `15.240.88.189` |

2. **Wait for DNS**, and confirm before going further — certbot fails loudly if the name does
   not resolve to the box yet:

   ```bash
   dig +short bombvoyage.co.za      # must print 15.240.88.189
   ```

3. **Re-run bootstrap** with the new names. It is idempotent, `--expand` adds them to the
   existing certificate, and the existing deploy token is preserved:

   ```bash
   scp -i ~/Downloads/bombs-away.pem infra/bootstrap.sh ec2-user@15.240.88.189:/tmp/
   ssh -i ~/Downloads/bombs-away.pem ec2-user@15.240.88.189 \
     'HOST=bombvoyage.online ALT_HOSTS="www.bombvoyage.online 15.240.88.189.sslip.io" \
      EMAIL=you@example.com bash /tmp/bootstrap.sh'
   ```

   `HOST` is the canonical name and goes into `config.ini` as `public_host`. Everything in
   `ALT_HOSTS` is covered by the same certificate, answered, and then **301d to `HOST`** by
   `server/canonical.js` — so one URL shows in the address bar and every old link still works.

4. **Update the GitHub secret** `DEPLOY_URL` to `https://bombvoyage.online/deploy`.

5. **Update your local `config.ini`** `[deploy] ssh_host` if you want to SSH by name.

6. **Send IT the ticket** in §2 with the real hostname.

There is no cutover moment: the old name stays on the certificate and keeps resolving, it just
bounces. `/healthz` and `/deploy` are exempt from the bounce, because the deploy script polls
`https://localhost/healthz` and a 301 there would make every deploy look like a failure.

*Why `.co.za` is worth it beyond looking right: corporate filters classify unknown
`sslip.io`-style hostnames far more aggressively than a registered company domain.*

---

## 8. Moving into the eezi VPC later

| Thing | Personal AWS account today | eezi VPC later |
|---|---|---|
| Compute | EC2 + systemd | Same, in a private subnet — or ECS with a six-line Dockerfile |
| TLS | Let's Encrypt on the box | ACM certificate on an ALB; the app drops to plain HTTP by unsetting `TLS_CERT` |
| Hostname | `15.240.88.189.sslip.io` | `game.<eezi domain>` in Route 53 |
| Access | Public internet | VPC + VPN or an internal ALB — **then IT does not need to unblock anything at all** |
| Data | `/var/lib/bomb-voyage/` | EFS mount, same path |
| Config | `/etc/bomb-voyage.env` | Task definition env or SSM Parameter Store |

Three properties make this a config change rather than a project:

1. The only state is one JSON file behind `DATA_DIR`.
2. The app **never calls an AWS API.** No SDK, no IAM role, no region in the code.
3. TLS is **optional in the app**, so behind an ALB it simply serves HTTP.

Do not pre-build for this. No SDK, no filesystem abstraction, no Terraform. It is a day's work
when it happens and nothing today gets easier by guessing now.

---

## 9. Operations

**Logs.** `sudo journalctl -u bomb-voyage -f`, or `--since 1h` to debug a Friday session.
systemd rotates them. No log shipping.

**Health.** `https://<host>/healthz` → `{ ok, players, maxPlayers, lag, uptimeS }`. Check it by
eye before a session; that is the whole monitoring story.

**Restart / reboot.** `Restart=always` plus `systemctl enable`, so a crash recovers in two
seconds and a reboot comes back unattended. On SIGTERM the server closes sockets cleanly.

**Backup.** `leaderboard.json` is the only state. A daily `cp` to a dated file, keep seven. If it
is ever lost, everyone's lifetime score resets and we live.

**Certificates.** Renewed by `certbot-renew.timer` at 03:00 Sunday. The deploy hook copies the
new pair into `/var/lib/bomb-voyage/certs` and restarts the service. Check with
`systemctl list-timers certbot-renew`.

---

## 10. Cost

| Item | Monthly |
|---|---|
| EC2 `t3.micro` | $0 for 12 months, then ~$8 |
| Public IPv4 | $0 for 12 months (750 h Free Tier), then ~$3.60 |
| Egress | ~180 MB/round against 100 GB free → effectively $0 |
| TLS | $0 (Let's Encrypt) |
| Hostname | $0 (sslip.io) |

Free for a year, about $12/month after.

---

## 11. Troubleshooting

| Symptom | Cause, in order of likelihood |
|---|---|
| **CI deploy returns 404** | Wrong `DEPLOY_TOKEN`, or `config.ini` on the server has no `[deploy] token`. The endpoint answers 404 to anything it does not like, on purpose. |
| **CI deploy returns 429** | Two deploys within 10 s. The workflow `concurrency` group should prevent it; check for a manual `curl`. |
| **Deploy accepted but version never changes** | `sudo journalctl -u bomb-voyage` plus `/var/lib/bomb-voyage/self-update.log`. Usually the deploy key cannot fetch — re-run `bootstrap.sh`. |
| **Nobody has host commands, including you** | Your browser has no admin key yet, or an old one. Open `https://<host>/?admin=<key>` once; the key is `[admin] key` in the server's `config.ini`. |
| **Server came up on 8080 without TLS** | `config.ini` is missing or has blank `tls_cert`. The service reads only that file now; `/etc/bomb-voyage.env` is no longer used. |
| **No music in the browser** | Autoplay is blocked until a gesture. The page arms a one-shot click/keypress listener; if it still fails, check the console for an AudioContext error. |
| **All ports time out** (22, 80, 443) | Security group does not have the rule, *or* the Elastic IP is not associated with a running instance. A timeout means the packet was dropped; a *refused* would mean it arrived and nothing was listening. |
| Port 22 times out, 443 works | SSH rule source is a different IP than yours now. EC2 → Security Groups → Edit inbound → set **My IP** again. Do not reopen 22 to `0.0.0.0/0`. |
| `certbot` fails with a connection error | Port 80 not open, or DNS not yet pointing at the box. `dig +short <host>` must return the Elastic IP. |
| Service dies on start | `journalctl -u bomb-voyage -n 50`. Usually a cert path or a port permission — check `AmbientCapabilities` survived in the unit file. |
| Page loads, WebSocket does not | Mixed content (page on https, socket on ws). The client derives the scheme from `location.protocol`; if you hardcoded one, that is the bug. |

---

## 12. Security

What stands between the internet and the box, checked end to end on 2026-10-24 for v1.0.0.

| Layer | What it does |
|---|---|
| **Security group** | 443 and 80 to the world, 22 to one address. sshd logged no attempt from anywhere else in the three days checked. |
| **sshd** | Keys only, no root login, no X11, three tries per connection — `/etc/ssh/sshd_config.d/00-bomb-voyage.conf`, written by `bootstrap.sh`. |
| **The service** | Runs as `ec2-user` with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome` and a private `/tmp`. `ec2-user` can sudo anything, so `NoNewPrivileges` is the line that keeps a hole in the game from becoming root. |
| **HTTP** | Per-address token bucket (40/s, burst 200) on both listeners; headers must arrive within 10 s; `GET /%`-style junk is a 404, never an exception. CSP `default-src 'self'`, `frame-ancestors 'none'`, HSTS, `nosniff`. |
| **Sockets** | WebSocket *and* WebTransport share the per-address limits: 90 connects a minute (burst 40), 64 open at once, 120 messages a second per socket, 4 KB per message. A socket that keeps flooding is closed. |
| **Messages** | Every field is type-checked, and a message handler that throws is logged and dropped rather than taking the process down. |
| **Host commands** | Gated by `[admin] key`, compared in constant time. Without it the host is the longest-standing human, as before. |
| **`/deploy`** | 404 to anything but a POST with the right token; 10 s cooldown. |
| **Secrets** | `config.ini` only, `chmod 600`, never in git (the history was checked). |

The regressions that were found doing that check — a stray `%` in a URL, `/logout`, and a message
field whose `toString` is not a function each ended the process — are locked in by
`test/smoke.test.js`.