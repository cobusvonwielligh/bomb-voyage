#!/usr/bin/env bash
# Bomb Voyage — manual deploy. Pushes your working tree, including uncommitted work.
#
#   npm run deploy            tests, then deploy
#   npm run deploy:fast       skip the tests
#   npm run rollback          back to the previous deploy
#   npm run logs              follow the server journal
#
# Reads [deploy] from config.ini; environment variables override it.
#
# Three things make this quick on a 60 ms link:
#   1. One multiplexed SSH connection for every remote step, instead of a handshake each.
#   2. npm ci only when package-lock.json actually changed.
#   3. A hardlinked snapshot before syncing, so rollback is a directory swap.

set -euo pipefail
START=$(date +%s)

ini() { sed -n "/^\[$1\]/,/^\[/p" config.ini 2>/dev/null | sed -n "s/^ *$2 *= *//p" | head -1; }

SSH_HOST="${SSH_HOST:-$(ini deploy ssh_host)}"
SSH_USER="${SSH_USER:-$(ini deploy ssh_user)}"
KEY="${KEY:-$(ini deploy ssh_key)}"
: "${SSH_HOST:?set ssh_host in [deploy] of config.ini, or SSH_HOST in the environment}"
SSH_USER="${SSH_USER:-ec2-user}"
KEY="${KEY/#\~/$HOME}"

APP=/opt/bomb-voyage
# Under /var/lib, not beside the app: /opt is root-owned and ec2-user cannot create there.
PREV=/var/lib/bomb-voyage/prev
CTRL="/tmp/bv-%r@%h:%p"
SSH_OPTS="-i $KEY -o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=$CTRL -o ControlPersist=120"
# shellcheck disable=SC2086
ssh_() { ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" "$@"; }

# Ctrl-C has to leave nothing behind, including the shared connection.
cleanup() {
  local code=$?
  # shellcheck disable=SC2086
  ssh $SSH_OPTS -O exit "$SSH_USER@$SSH_HOST" 2>/dev/null || true
  [ $code -ne 0 ] && [ $code -ne 130 ] && echo "deploy failed ($code)" >&2
  [ $code -eq 130 ] && echo "cancelled — the server was not touched if this stopped before 'sync'" >&2
  exit $code
}
trap cleanup EXIT INT TERM

step() { printf '\033[2m%6ss\033[0m %s\n' "$(( $(date +%s) - START ))" "$1"; }

if [ "${SKIP_TESTS:-0}" != 1 ]; then
  step "tests"
  npm test --silent >/dev/null
fi

step "connect"
ssh_ true   # opens the master connection; everything after rides on it

step "snapshot for rollback"
# Hardlinked, so it costs near-zero time and disk. Warn rather than swallow: a silent failure
# here means `npm run rollback` has nothing to go back to, and you find out at the worst moment.
ssh_ "mkdir -p $PREV && rsync -a --delete --exclude node_modules --link-dest=$APP/ $APP/ $PREV/" \
  || echo "       WARNING: snapshot failed, rollback will not be available" >&2

step "sync"
# Stamp what is really going up. rsync does not touch .git, so without this /healthz would
# report the last commit the box pulled rather than the tree now on disk.
printf '%s%s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" \
  "$([ -n "$(git status --porcelain 2>/dev/null)" ] && echo '+local')" > .version
# .git and config.ini stay as they are on the server: one is how the box self-updates, the
# other holds the deploy token and the production paths.
# shellcheck disable=SC2086
# .deps-hash lives only on the server; without this exclude, --delete removes it every run and
# npm ci stops being skippable.
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude data \
  --exclude config.ini --exclude '*.pem' --exclude .deps-hash \
  -e "ssh $SSH_OPTS" \
  ./ "$SSH_USER@$SSH_HOST:$APP/"

step "deps and restart"
LOCK=$(shasum -a 256 package-lock.json | cut -d' ' -f1)
ssh_ "bash -s" <<REMOTE
set -euo pipefail
cd $APP
# Installing takes seconds and almost never changes. Only pay for it when the lockfile moved.
if [ "\$(cat .deps-hash 2>/dev/null)" != "$LOCK" ] || [ ! -d node_modules ]; then
  echo "       npm ci (lockfile changed)"
  npm ci --omit=dev --silent
  echo "$LOCK" > .deps-hash
fi

# Put the locally-built QUIC addon back.
#
# @fails-components/webtransport-transport-http3-quiche ships a prebuilt binary that needs
# glibc 2.38; this box has 2.34, so the addon is compiled here (clang 19 + libstdc++ 14, about
# an hour) and the result stashed outside the app directory. npm ci blows node_modules away,
# which would silently drop the server back to WebSocket-only on the next deploy that touches
# the lockfile — silently, because the transport is additive and nothing would look broken.
STASH=/var/lib/bomb-voyage/webtransport.node
DEST=$APP/node_modules/@fails-components/webtransport-transport-http3-quiche/build_linux_x64/Release
if [ -f "\$STASH" ]; then
  if [ ! -f "\$DEST/webtransport.node" ] || ! cmp -s "\$STASH" "\$DEST/webtransport.node"; then
    mkdir -p "\$DEST" && cp -f "\$STASH" "\$DEST/webtransport.node"
    echo "       restored the QUIC addon"
  fi
fi
sudo -n /usr/bin/cp $APP/infra/bomb-voyage.service /etc/systemd/system/bomb-voyage.service
sudo -n /usr/bin/systemctl daemon-reload
sudo -n /usr/bin/systemctl restart bomb-voyage
REMOTE

step "health"
# Poll tightly: the restart takes well under a second, and a 1s sleep was most of the wait.
for i in $(seq 1 60); do
  if out=$(ssh_ "curl -sfk https://localhost/healthz || curl -sf http://localhost:8080/healthz" 2>/dev/null); then
    step "live"
    echo "$out"
    exit 0
  fi
  sleep 0.25
done

echo "health check never answered — last 40 log lines:" >&2
ssh_ "sudo journalctl -u bomb-voyage -n 40 --no-pager" >&2
exit 1
