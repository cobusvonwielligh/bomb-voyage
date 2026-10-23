#!/usr/bin/env bash
# Bomb Voyage — one-time server setup. Amazon Linux 2023. Idempotent: safe to re-run, and
# re-running is exactly how you switch to a new domain.
#
#   scp -i key.pem infra/bootstrap.sh ec2-user@HOST:/tmp/
#   ssh -i key.pem ec2-user@HOST 'HOST=bombvoyage.online \
#                                 ALT_HOSTS="www.bombvoyage.online 15.240.88.189.sslip.io" \
#                                 EMAIL=you@example.com bash /tmp/bootstrap.sh'
#
# HOST is the canonical name. Everything in ALT_HOSTS is answered and then 301d to HOST, so the
# address bar only ever shows one URL — see the canonical-host block in server/index.js.
#
# Variables:
#   HOST       required. Primary hostname. Must already resolve to this box.
#   ALT_HOSTS  optional. Space-separated extra names for the same certificate (e.g. www).
#   EMAIL      required unless SKIP_TLS=1. For certificate expiry notices.
#   SKIP_TLS=1 provision everything except the certificate; serve plain HTTP on 8080. Use this
#              before DNS has propagated, or behind a load balancer that terminates TLS.
#   REPO       git remote to clone if /opt/bomb-voyage is not already a clone.
#
# Note: no apostrophes inside ${VAR:?msg} — bash parses them as a quote and dies at EOF.

set -euo pipefail

HOST="${HOST:?set HOST to the public hostname, e.g. bombvoyage.co.za}"
ALT_HOSTS="${ALT_HOSTS:-}"
SKIP_TLS="${SKIP_TLS:-0}"
EMAIL="${EMAIL:-}"
# SSH form, because the repo is private. The box authenticates with a read-only deploy key that
# this script generates; add the printed public key under GitHub > Settings > Deploy keys.
REPO="${REPO:-git@github.com:cobusvonwielligh/bomb-voyage.git}"
[ "$SKIP_TLS" = 1 ] || : "${EMAIL:?set EMAIL for certificate expiry notices}"

APP_DIR=/opt/bomb-voyage
DATA_DIR=/var/lib/bomb-voyage
CERT_DIR="$DATA_DIR/certs"
UNIT=/etc/systemd/system/bomb-voyage.service

echo "==> packages"
# `npm` pulls in nodejs18 as a dependency and wins the alternatives link, so install 22
# explicitly and then claim the link. Without the --set, `node` is silently 18.
sudo dnf -q -y install nodejs22 nodejs22-npm git rsync python3-pip
sudo alternatives --set node /usr/bin/node-22
node --version
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "need node >= 20"; exit 1; }

echo "==> directories"
sudo mkdir -p "$APP_DIR" "$DATA_DIR" "$CERT_DIR"
sudo chown -R ec2-user:ec2-user "$APP_DIR" "$DATA_DIR"

echo "==> deploy key"
# The key lives under $DATA_DIR, not ~/.ssh, because self-update.sh runs inside the unit's
# sandbox where ProtectHome=true makes /home invisible. See infra/self-update.sh.
SSH_DIR="$DATA_DIR/ssh"
mkdir -p "$SSH_DIR"
if [ ! -f "$SSH_DIR/deploy_key" ]; then
  if [ -f ~/.ssh/bomb_voyage_deploy ]; then
    # Reuse a key already registered on GitHub rather than making the user add a second one.
    cp ~/.ssh/bomb_voyage_deploy "$SSH_DIR/deploy_key"
  else
    ssh-keygen -t ed25519 -N "" -C "bomb-voyage deploy key (read-only)" -f "$SSH_DIR/deploy_key" -q
  fi
fi
chmod 700 "$SSH_DIR"; chmod 600 "$SSH_DIR/deploy_key"
ssh-keygen -y -f "$SSH_DIR/deploy_key" > "$SSH_DIR/deploy_key.pub"
ssh-keyscan -t ed25519,rsa github.com > "$SSH_DIR/known_hosts" 2>/dev/null

# A matching config for interactive git as ec2-user, which is outside the sandbox.
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat > ~/.ssh/config <<SSHCFG
Host github.com
  IdentityFile $SSH_DIR/deploy_key
  IdentitiesOnly yes
  UserKnownHostsFile $SSH_DIR/known_hosts
  StrictHostKeyChecking accept-new
SSHCFG
chmod 600 ~/.ssh/config

echo "==> source"
# A failed clone must not abort the run: TLS, config.ini and the unit still need installing, and
# the tree can arrive by rsync in the meantime. Only the self-update webhook needs git.
GIT_OK=1
if [ ! -d "$APP_DIR/.git" ]; then
  # Clone into a temp dir and move only .git across, because $APP_DIR may already hold an rsync.
  rm -rf /tmp/bv-clone
  if git clone --quiet --depth 50 "$REPO" /tmp/bv-clone; then
    mv /tmp/bv-clone/.git "$APP_DIR/.git"
    rm -rf /tmp/bv-clone
    cd "$APP_DIR" && git reset --hard --quiet origin/main
  else
    GIT_OK=0
    echo "    !! clone failed. Add this public key as a read-only deploy key at"
    echo "       https://github.com/cobusvonwielligh/bomb-voyage/settings/keys/new"
    echo
    sed 's/^/       /' "$SSH_DIR/deploy_key.pub"
    echo
    echo "    Continuing without git. Push code with 'npm run deploy' until it is added;"
    echo "    re-run this script afterwards to enable CI deploys."
  fi
else
  cd "$APP_DIR" && git fetch --quiet origin main && git reset --hard --quiet origin/main
fi
cd "$APP_DIR"
[ -f package.json ] && npm ci --omit=dev --silent || true

echo "==> sudoers for self-update (three exact commands, nothing broader)"
sudo tee /etc/sudoers.d/bomb-voyage >/dev/null <<SUDO
Cmnd_Alias BOMB_VOYAGE = /usr/bin/systemctl restart bomb-voyage, \\
                         /usr/bin/systemctl daemon-reload, \\
                         /usr/bin/cp $APP_DIR/infra/bomb-voyage.service $UNIT
ec2-user ALL=(root) NOPASSWD: BOMB_VOYAGE
SUDO
sudo chmod 440 /etc/sudoers.d/bomb-voyage
sudo visudo -c -f /etc/sudoers.d/bomb-voyage >/dev/null

# config.ini is never in git and never rsynced, so a deploy cannot clobber it. Preserve an
# existing deploy token across re-runs — regenerating it would silently break CI.
# Guard the file test rather than relying on 2>/dev/null: with `set -o pipefail` a missing file
# makes the whole pipeline fail and takes the script with it.
TOKEN=""
if [ -f "$APP_DIR/config.ini" ]; then
  TOKEN=$(sed -n 's/^ *token *= *//p' "$APP_DIR/config.ini" | head -1 || true)
fi
[ -n "$TOKEN" ] || TOKEN=$(openssl rand -hex 32)

write_config() {
  cat > "$APP_DIR/config.ini" <<CFG
; Generated by infra/bootstrap.sh on $(date -Is). Not in git.
[server]
port          = $1
redirect_port = $2
public_host   = $HOST
tls_cert      = $3
tls_key       = $4
data_dir      = $DATA_DIR
max_players   = 16

[deploy]
token = $TOKEN

[dev]
lag    = 0
jitter = 0
CFG
  chmod 600 "$APP_DIR/config.ini"
}

install_unit() {
  sudo cp "$APP_DIR/infra/bomb-voyage.service" "$UNIT"
  sudo systemctl daemon-reload
  sudo systemctl enable --now bomb-voyage
  sudo systemctl restart bomb-voyage
}

if [ "$SKIP_TLS" = 1 ]; then
  echo "==> SKIP_TLS=1 — plain HTTP on 8080, no certificate"
  write_config 8080 0 "" ""
  install_unit
  echo
  echo "bootstrap done (no TLS). Re-run without SKIP_TLS once DNS and ports 80/443 are ready."
  echo "deploy token: $TOKEN"
  exit 0
fi

echo "==> certbot"
if [ ! -x /opt/certbot/bin/certbot ]; then
  sudo python3 -m venv /opt/certbot
  sudo /opt/certbot/bin/pip install -q --upgrade pip certbot
fi

# Certbot standalone binds :80, so the game server must be out of the way for the moment it runs.
sudo systemctl stop bomb-voyage 2>/dev/null || true

DOMAIN_ARGS=(-d "$HOST")
for h in $ALT_HOSTS; do DOMAIN_ARGS+=(-d "$h"); done

echo "==> certificate for $HOST ${ALT_HOSTS:+(+ $ALT_HOSTS)}"
# --cert-name pins the lineage to $HOST. Without it certbot names the directory after whichever
# domain happened to come first and can fork a second lineage when the list changes, at which
# point the deploy hook below is copying from a path that no longer gets renewed.
sudo /opt/certbot/bin/certbot certonly --standalone --non-interactive --agree-tos \
  --cert-name "$HOST" --keep-until-expiring --expand -m "$EMAIL" "${DOMAIN_ARGS[@]}"

# Node runs unprivileged and cannot read /etc/letsencrypt. Copy the pair somewhere it can,
# on issue and on every renewal.
echo "==> certificate deploy hook"
sudo tee /etc/letsencrypt/renewal-hooks/deploy/bomb-voyage.sh >/dev/null <<HOOK
#!/usr/bin/env bash
set -eu
install -o ec2-user -g ec2-user -m 0644 "/etc/letsencrypt/live/$HOST/fullchain.pem" "$CERT_DIR/fullchain.pem"
install -o ec2-user -g ec2-user -m 0600 "/etc/letsencrypt/live/$HOST/privkey.pem"  "$CERT_DIR/privkey.pem"
systemctl restart bomb-voyage || true
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/bomb-voyage.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/bomb-voyage.sh || true

echo "==> renewal timer (03:00 Sunday — nobody is playing)"
sudo tee /etc/systemd/system/certbot-renew.service >/dev/null <<'UNIT'
[Unit]
Description=Renew TLS certificates
[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet --standalone --pre-hook "systemctl stop bomb-voyage" --post-hook "systemctl start bomb-voyage"
UNIT
sudo tee /etc/systemd/system/certbot-renew.timer >/dev/null <<'UNIT'
[Unit]
Description=Weekly certificate renewal
[Timer]
OnCalendar=Sun *-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT

echo "==> service"
write_config 443 80 "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem"
install_unit
sudo systemctl daemon-reload
sudo systemctl enable --now certbot-renew.timer

echo
echo "bootstrap done: https://$HOST"
echo
echo "GitHub repo secrets to set (Settings > Secrets and variables > Actions):"
echo "  DEPLOY_URL   = https://$HOST/deploy"
echo "  DEPLOY_TOKEN = $TOKEN"
