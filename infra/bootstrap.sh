#!/usr/bin/env bash
# Bomb Voyage — one-time server setup. Amazon Linux 2023.
#
#   scp -i key.pem infra/bootstrap.sh ec2-user@HOST:
#   ssh -i key.pem ec2-user@HOST 'HOST=<hostname> EMAIL=<you@x.com> bash bootstrap.sh'
#
# Idempotent: safe to re-run. Does not deploy the app — that is infra/deploy.sh.

#
# SKIP_TLS=1 provisions everything except the certificate and leaves the server on plain HTTP
# port 8080. Useful before the security group opens 80/443, or behind a load balancer that
# terminates TLS for you. Re-run without it to switch to HTTPS.

set -euo pipefail

HOST="${HOST:?set HOST to the public hostname, e.g. 16.28.138.34.sslip.io}"
SKIP_TLS="${SKIP_TLS:-0}"
EMAIL="${EMAIL:-}"
# Note: no apostrophes inside ${...:?msg} — bash parses them as a quote and dies at EOF.
[ "$SKIP_TLS" = 1 ] || : "${EMAIL:?set EMAIL for certificate expiry notices}"
APP_DIR=/opt/bomb-voyage
DATA_DIR=/var/lib/bomb-voyage
CERT_DIR="$DATA_DIR/certs"

echo "==> packages"
# `npm` pulls in nodejs18 as a dependency and wins the alternatives link, so install 22
# explicitly and then claim the link. Without the --set, `node` is silently 18.
sudo dnf -q -y install nodejs22 nodejs22-npm rsync python3-pip
sudo alternatives --set node /usr/bin/node-22
node --version
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "need node >= 20"; exit 1; }

echo "==> directories"
sudo mkdir -p "$APP_DIR" "$DATA_DIR" "$CERT_DIR"
sudo chown -R ec2-user:ec2-user "$APP_DIR" "$DATA_DIR"

if [ "$SKIP_TLS" = 1 ]; then
  echo "==> SKIP_TLS=1 — plain HTTP on 8080, no certificate"
  sudo tee /etc/bomb-voyage.env >/dev/null <<ENV
PORT=8080
PUBLIC_HOST=$HOST
DATA_DIR=$DATA_DIR
MAX_PLAYERS=16
ENV
  sudo systemctl daemon-reload
  echo
  echo "bootstrap done (no TLS). Deploy with:   HOST=$HOST npm run deploy"
  echo "Re-run this script without SKIP_TLS once ports 80 and 443 are open."
  exit 0
fi

echo "==> certbot"
if [ ! -x /opt/certbot/bin/certbot ]; then
  sudo python3 -m venv /opt/certbot
  sudo /opt/certbot/bin/pip install -q --upgrade pip certbot
fi

# Certbot standalone binds :80, so the game server must be out of the way for the moment it runs.
sudo systemctl stop bomb-voyage 2>/dev/null || true

echo "==> certificate for $HOST"
sudo /opt/certbot/bin/certbot certonly --standalone --non-interactive --agree-tos \
  --keep-until-expiring -m "$EMAIL" -d "$HOST"

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
Description=Renew Let's Encrypt certificates
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
sudo tee /etc/bomb-voyage.env >/dev/null <<ENV
PORT=443
REDIRECT_PORT=80
PUBLIC_HOST=$HOST
TLS_CERT=$CERT_DIR/fullchain.pem
TLS_KEY=$CERT_DIR/privkey.pem
DATA_DIR=$DATA_DIR
MAX_PLAYERS=16
ENV

sudo cp "$APP_DIR/infra/bomb-voyage.service" /etc/systemd/system/ 2>/dev/null \
  || echo "   (service file arrives with the first deploy)"
sudo systemctl daemon-reload
sudo systemctl enable certbot-renew.timer
sudo systemctl start certbot-renew.timer

echo
echo "bootstrap done for https://$HOST"
echo "now run, from your laptop:   HOST=$HOST npm run deploy"
