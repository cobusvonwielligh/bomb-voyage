#!/usr/bin/env bash
# Pull the latest main and restart. Triggered by POST /deploy, which GitHub Actions calls after
# the tests pass. Runs detached from the request that started it, because it restarts that
# process. Requires /opt/bomb-voyage to be a git clone, plus the sudoers drop-in bootstrap.sh
# installs (three exact commands, nothing broader).

set -euo pipefail

APP=/opt/bomb-voyage
UNIT=/etc/systemd/system/bomb-voyage.service

cd "$APP"
mkdir -p /var/lib/bomb-voyage
exec >>/var/lib/bomb-voyage/self-update.log 2>&1
echo "=== $(date -Is) self-update ==="

git fetch --quiet origin main
BEFORE=$(git rev-parse --short HEAD)
git reset --hard --quiet origin/main
AFTER=$(git rev-parse --short HEAD)
echo "$BEFORE -> $AFTER"

if [ "$BEFORE" != "$AFTER" ] || [ ! -d node_modules ]; then
  npm ci --omit=dev --silent
fi

# The unit file can change with the code. These three commands are exactly what sudoers allows.
sudo /usr/bin/cp "$APP/infra/bomb-voyage.service" "$UNIT"
sudo /usr/bin/systemctl daemon-reload
sudo /usr/bin/systemctl restart bomb-voyage
echo "restarted"
