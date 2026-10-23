#!/usr/bin/env bash
# Bomb Voyage — deploy straight from your laptop, including uncommitted work.
#
#   npm run deploy
#
# Reads [deploy] from config.ini; environment variables override it. Run infra/bootstrap.sh on
# the box once first.
#
# This is the fast path for iterating. The real path is CI: push to main, GitHub Actions runs
# the tests and pokes the self-update webhook. A later CI deploy will overwrite whatever this
# pushed, which is correct — git is the source of truth.

set -euo pipefail

ini() { sed -n "/^\[$1\]/,/^\[/p" config.ini 2>/dev/null | sed -n "s/^ *$2 *= *//p" | head -1; }

SSH_HOST="${SSH_HOST:-$(ini deploy ssh_host)}"
SSH_USER="${SSH_USER:-$(ini deploy ssh_user)}"
KEY="${KEY:-$(ini deploy ssh_key)}"
: "${SSH_HOST:?set ssh_host in [deploy] of config.ini, or SSH_HOST in the environment}"
SSH_USER="${SSH_USER:-ec2-user}"
KEY="${KEY/#\~/$HOME}"

APP_DIR=/opt/bomb-voyage
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$SSH_HOST")

echo "==> tests"
npm test --silent

echo "==> sync to $SSH_HOST:$APP_DIR"
# .git and config.ini stay as they are on the server: one is how CI updates, the other holds
# the deploy token and the production paths.
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude data \
  --exclude config.ini --exclude '*.pem' \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  ./ "$SSH_USER@$SSH_HOST:$APP_DIR/"

echo "==> install and restart"
"${SSH[@]}" bash -se <<'REMOTE'
set -euo pipefail
cd /opt/bomb-voyage
npm ci --omit=dev --silent
sudo /usr/bin/cp /opt/bomb-voyage/infra/bomb-voyage.service /etc/systemd/system/bomb-voyage.service
sudo /usr/bin/systemctl daemon-reload
sudo /usr/bin/systemctl restart bomb-voyage
REMOTE

echo "==> health"
# Works before TLS (plain 8080) and after (443). Whichever answers first wins.
for i in $(seq 1 10); do
  if out=$("${SSH[@]}" "curl -sfk https://localhost/healthz || curl -sf http://localhost:8080/healthz" 2>/dev/null); then
    echo "$out"
    echo
    echo "deployed"
    exit 0
  fi
  sleep 1
done

echo "health check failed — last 40 log lines:" >&2
"${SSH[@]}" "sudo journalctl -u bomb-voyage -n 40 --no-pager" >&2
exit 1
