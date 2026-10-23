#!/usr/bin/env bash
# Follow the server log.  npm run logs            (live)
#                        npm run logs -- --since 1h
set -euo pipefail

ini() { sed -n "/^\[$1\]/,/^\[/p" config.ini 2>/dev/null | sed -n "s/^ *$2 *= *//p" | head -1; }
SSH_HOST="${SSH_HOST:-$(ini deploy ssh_host)}"
SSH_USER="${SSH_USER:-$(ini deploy ssh_user)}"
KEY="${KEY:-$(ini deploy ssh_key)}"
: "${SSH_HOST:?set ssh_host in [deploy] of config.ini}"
KEY="${KEY/#\~/$HOME}"

ARGS=("$@")
[ ${#ARGS[@]} -eq 0 ] && ARGS=(-f -n 40)
exec ssh -t -i "$KEY" -o StrictHostKeyChecking=accept-new "${SSH_USER:-ec2-user}@$SSH_HOST" \
  sudo journalctl -u bomb-voyage --no-pager "${ARGS[@]}"
