# Bomb Voyage — Deployment

Two requirements shape all of this:

1. **Corporate IT must be able to unblock it by allowing one thing.** One hostname, one port.
2. **Moving from a personal AWS account into the eezi VPC later must be a config change, not a
   rewrite.**

---

## 1. The shape

```
                    ┌──────────────────────────────┐
  browser ──443──►  │ EC2 t3.micro (free tier)     │
   wss://           │  docker: bomb-voyage         │
   https://         │   node server/index.js       │
                    │   :443  HTTP + WS, one port  │
                    │   /data/leaderboard.json     │
                    └──────────────────────────────┘
```

One instance. One container. One port. No load balancer, no CDN, no bucket, no database, no
second domain. The WebSocket shares the HTTP server, so `wss://game.example.com/ws` is the same
origin as the page — no CORS, no preflight, nothing extra for IT to allow.

**There is deliberately no load balancer.** It would add a second thing to configure, sticky
session concerns, and cost — for one process serving 16 people. Add one the day there are two
servers.

---

## 2. Why this survives corporate IT

Every one of these is a thing that commonly gets a game blocked, and the choice that avoids it:

| Common blocker | What we do |
|---|---|
| Non-standard ports | **All game traffic on 443.** Port 80 is open inbound too, but only to serve the HTTP→HTTPS redirect and Let's Encrypt renewals — never game traffic. Nothing else is exposed. |
| Plain `ws://` upgrade on port 80 | **`wss://` on 443.** TLS-wrapped, so proxies pass it as HTTPS. |
| Multiple domains / CDNs | **One hostname.** `Content-Security-Policy: default-src 'self'` — the page is incapable of requesting anything else. |
| Web fonts, analytics, Google APIs | None. Zero external requests. Verify in the Network tab. |
| WebRTC / UDP | Not used. |
| Category filters ("games") | Use a neutral hostname on an eezi-owned domain rather than something obviously a game. |

**Ticket text for IT — DEP-5 ships this verbatim:**

> Please allow outbound HTTPS (TCP 443) to `game.<domain>` (`<elastic-ip>`) for the dev team.
> It is an internally hosted tool on infrastructure we control. It uses standard HTTPS and a
> WebSocket over the same port and hostname. No other hosts, ports or protocols are required.

---

## 3. Standing it up — first deployment checklist

1. **Instance.** EC2 `t3.micro`, Amazon Linux 2023, in the region nearest the players — see §6.
   Attach an **Elastic IP** so the address is stable for the IT allow-list.
2. **Security group.** Inbound: 443 from `0.0.0.0/0`, 80 from `0.0.0.0/0` (redirect + ACME only),
   22 from your IP only. Nothing else — specifically **not** 8080.
3. **DNS.** An `A` record for `game.<domain>` → the Elastic IP. No domain available? Use
   `<name>.duckdns.org` or `<ip>.sslip.io` — still one hostname, still free, still works with
   Let's Encrypt.
4. **Docker.** `dnf install -y docker && systemctl enable --now docker`.
5. **TLS.** Certbot in standalone mode to issue the first certificate, then mount
   `/etc/letsencrypt` into the container. A weekly renewal timer that stops the container,
   renews, and starts it. Renewal at 03:00 Sunday — nobody is playing.
6. **Run.** `docker compose up -d`.
7. **Verify.** `curl https://game.<domain>/healthz` → JSON. Open the page, play a round with
   yourself in two tabs, confirm the Network tab shows **only** your own hostname.
8. **Survive a reboot.** `reboot` the instance and confirm the game comes back unattended.

---

## 4. Configuration — all of it by environment variable

Nothing AWS-specific appears anywhere in the code. This is what makes the VPC move trivial.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listening port. `443` in production. |
| `TLS_CERT` / `TLS_KEY` | unset | Paths. If unset, serve plain HTTP (local dev). |
| `PUBLIC_HOST` | `localhost` | Used only for redirects and logging. |
| `DATA_DIR` | `./data` | Where `leaderboard.json` lives. |
| `MAX_PLAYERS` | `16` | |
| `LAG` / `JITTER` | `0` | **Dev only.** Outbound delay in ms. Refuse to start if set while `TLS_CERT` is set. |
| `LOG_LEVEL` | `info` | |

Local development needs none of them: `npm start` → `http://localhost:8080`.

---

## 5. Moving into the eezi VPC later

Designed-for, not done now. When the time comes:

| Thing | Personal AWS account today | eezi VPC later |
|---|---|---|
| Compute | EC2 + docker compose | Same container on ECS Fargate, or an EC2 in a private subnet |
| TLS | Let's Encrypt on the box | ACM certificate on an ALB, container drops to plain HTTP on 8080 |
| Hostname | `game.<personal domain>` | `game.<eezi domain>`, internal Route 53 |
| Access | Public internet | VPC + VPN, or an internal ALB — **then IT does not need to unblock anything at all** |
| Data | `./data/leaderboard.json` | EFS mount, or S3 with the same JSON |
| Config | `.env` | Task definition environment / SSM Parameter Store |

Three properties make this a config change rather than a project:

1. The app is a **single stateless-ish process** — the only state is one JSON file behind
   `DATA_DIR`.
2. It **never calls an AWS API.** No SDK, no IAM role, no region in the code.
3. TLS is **optional in the app.** Behind an ALB it simply serves HTTP and the ALB terminates.

Do **not** pre-build for this: no SDK, no abstraction layer over the filesystem, no
Terraform. The move is a day of work when it happens, and nothing today gets easier by guessing
at it now.

---

## 6. Region choice

The design assumes the worst case (South Africa → Europe, ~180 ms) and the netcode holds up
there. But if everyone turns out to be in one South African office:

| Region | RTT from Johannesburg | Free tier |
|---|---|---|
| `eu-west-1` Ireland | ~165 ms | yes |
| `eu-central-1` Frankfurt | ~155 ms | yes |
| `af-south-1` Cape Town | **~15 ms** | **check — not always covered** |

`af-south-1` is a dramatically better game for roughly the price of a coffee a month if it is not
free-tier eligible. **Decide this before the first real session** — it is a `terraform`-less
rebuild of one instance and a DNS change, about 30 minutes.

---

## 7. Operations

**Logs.** stdout → `docker logs`, rotated by Docker's `json-file` driver capped at 10 MB × 3.
No log shipping. If you need to debug a Friday session, `docker logs --since 1h`.

**Health.** `GET /healthz` → `{ ok, uptimeS, players, tickMsP50, tickMsP99, roundTick }`.
Check it by eye before a session; that is the whole monitoring story.

**Backup.** `leaderboard.json` is the only state. A daily `cp` to a dated file in `DATA_DIR`, and
keep seven. If it is ever lost, everyone's lifetime score resets and we live.

**Restart.** `restart: unless-stopped` in compose. On SIGTERM the server flushes the leaderboard,
sends `roundend`, closes sockets, and exits — so a deploy mid-round is rude but not lossy.

**Updating.** `git pull && docker compose up -d --build`. There is no build step inside the
image beyond `npm ci --omit=dev`, so this is fast. Do it between rounds.

---

## 8. Cost

| Item | Monthly |
|---|---|
| EC2 `t3.micro` | $0 first 12 months, then ~$8 |
| Elastic IP (attached) | $0 |
| Egress | ~180 MB/round; free tier 100 GB → effectively $0 |
| TLS | $0 (Let's Encrypt) |
| Domain | ~$1/month, or $0 with DuckDNS |

Essentially free, and about $9/month after the free tier expires.
