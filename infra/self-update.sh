#!/usr/bin/env bash
# Pull the latest main and restart. Triggered by POST /deploy, which GitHub Actions calls after
# the tests pass. Runs detached from the request that started it, because it restarts that
# process. Requires /opt/bomb-voyage to be a git clone, plus the sudoers drop-in bootstrap.sh
# installs (three exact commands, nothing broader).

set -euo pipefail

APP=/opt/bomb-voyage
DATA=/var/lib/bomb-voyage
UNIT=/etc/systemd/system/bomb-voyage.service

# This script is spawned by the server, so it inherits the unit's sandbox — and the unit sets
# ProtectHome=true. /home is therefore invisible: ssh cannot read ~/.ssh and npm cannot write
# ~/.npm. Everything this needs lives under $DATA instead, which is in ReadWritePaths.
export HOME="$DATA"
export GIT_SSH_COMMAND="ssh -i $DATA/ssh/deploy_key -o IdentitiesOnly=yes \
  -o UserKnownHostsFile=$DATA/ssh/known_hosts -o StrictHostKeyChecking=yes"

mkdir -p "$DATA"
cd "$APP"
exec >>"$DATA/self-update.log" 2>&1
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
sudo -n /usr/bin/cp "$APP/infra/bomb-voyage.service" "$UNIT"
sudo -n /usr/bin/systemctl daemon-reload
sudo -n /usr/bin/systemctl restart bomb-voyage
echo "restarted"
