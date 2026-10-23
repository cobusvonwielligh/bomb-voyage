#!/usr/bin/env bash
# Bomb Voyage — deploy from your laptop. Run infra/bootstrap.sh on the box once first.
#
#   HOST=16.12.138.34.sslip.io npm run deploy
#
# Env: HOST (required) · SSH_HOST (defaults to HOST) · KEY (ssh key) · USER (ec2-user)

set -euo pipefail

HOST="${HOST:?set HOST, e.g. 16.12.138.34.sslip.io}"
SSH_HOST="${SSH_HOST:-$HOST}"
KEY="${KEY:-$HOME/Downloads/bombs-away.pem}"
SSH_USER="${SSH_USER:-ec2-user}"
APP_DIR=/opt/bomb-voyage
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$SSH_HOST")

echo "==> tests"
npm test --silent

echo "==> sync to $SSH_HOST:$APP_DIR"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude data --exclude '*.pem' \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  ./ "$SSH_USER@$SSH_HOST:$APP_DIR/"

echo "==> install and restart"
"${SSH[@]}" bash -se <<'REMOTE'
set -euo pipefail
cd /opt/bomb-voyage
npm ci --omit=dev --silent
sudo cp infra/bomb-voyage.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bomb-voyage
sudo systemctl restart bomb-voyage
REMOTE

echo "==> health"
# Works before TLS (plain 8080) and after (443). Whichever answers first wins.
for i in $(seq 1 10); do
  if out=$("${SSH[@]}" "curl -sfk https://localhost/healthz || curl -sf http://localhost:8080/healthz" 2>/dev/null); then
    echo "$out"
    echo
    echo "live: https://$HOST"
    exit 0
  fi
  sleep 1
done

echo "health check failed — last 40 log lines:" >&2
"${SSH[@]}" "sudo journalctl -u bomb-voyage -n 40 --no-pager" >&2
exit 1
