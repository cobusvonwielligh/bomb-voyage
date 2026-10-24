#!/usr/bin/env bash
# Pull the latest main and restart. Triggered by POST /deploy. Runs detached from the request
# that started it, because it restarts that process. Requires /opt/bomb-voyage to be a git clone.

set -euo pipefail

APP=/opt/bomb-voyage
DATA=/var/lib/bomb-voyage

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
  # npm ci deletes the QUIC addon compiled on this box; put it back, as infra/deploy.sh does.
  STASH=$DATA/webtransport.node
  DEST=$APP/node_modules/@fails-components/webtransport-transport-http3-quiche/build_linux_x64/Release
  if [ -f "$STASH" ]; then mkdir -p "$DEST" && cp -f "$STASH" "$DEST/webtransport.node"; fi
fi

# The unit sets NoNewPrivileges, so sudo is impossible from here — on purpose. Ask the server to
# shut down cleanly instead (it banks the round first) and Restart=always brings up the new code.
# A changed unit file is therefore only installed by `npm run deploy`, which comes in over SSH.
echo "restarting"
kill -TERM "${BV_SERVER_PID:?the server passes its pid}"
