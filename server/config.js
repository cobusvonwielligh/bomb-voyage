// Bomb Voyage — configuration.
//
// Precedence: environment variable > config.ini > built-in default.
// Env wins so CI and one-off runs (`LAG=200 npm start`) never need to touch a file.
//
// config.ini is gitignored and holds anything secret or machine-specific. config.example.ini
// is the committed template. On the server the real file lives at /opt/bomb-voyage/config.ini
// and is excluded from rsync, so a deploy never overwrites it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_BOTS_MIN } from '../shared/constants.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal INI: [section], key = value, # or ; comments. No nesting, no arrays, no quotes. */
export function parseIni(text) {
  const out = {};
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith(';')) continue;
    const head = s.match(/^\[(.+?)\]$/);
    if (head) { section = head[1].trim().toLowerCase(); out[section] ??= {}; continue; }
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim().toLowerCase();
    const value = s.slice(eq + 1).trim();
    (out[section] ??= {})[key] = value;
  }
  return out;
}

const iniPath = process.env.CONFIG || path.join(ROOT, 'config.ini');
const ini = fs.existsSync(iniPath) ? parseIni(fs.readFileSync(iniPath, 'utf8')) : {};

const pick = (env, section, key, fallback) =>
  process.env[env] ?? ini[section]?.[key] ?? fallback;

const num = (...a) => Number(pick(...a));

export const config = {
  iniPath: fs.existsSync(iniPath) ? iniPath : null,

  port: num('PORT', 'server', 'port', 8080),
  redirectPort: num('REDIRECT_PORT', 'server', 'redirect_port', 80),
  publicHost: pick('PUBLIC_HOST', 'server', 'public_host', 'localhost'),
  tlsCert: pick('TLS_CERT', 'server', 'tls_cert', ''),
  tlsKey: pick('TLS_KEY', 'server', 'tls_key', ''),
  dataDir: path.resolve(ROOT, pick('DATA_DIR', 'server', 'data_dir', './data')),
  maxPlayers: num('MAX_PLAYERS', 'server', 'max_players', 16),
  // Bots kept topped up while anybody is playing. 0 switches the policy off. See AUTO_BOTS_MIN.
  minBots: num('MIN_BOTS', 'server', 'min_bots', AUTO_BOTS_MIN),

  // Shared secret for POST /deploy. Empty disables the endpoint entirely.
  deployToken: pick('DEPLOY_TOKEN', 'deploy', 'token', ''),
  // Overridable so tests can exercise the accept path without actually redeploying anything.
  deployScript: pick('DEPLOY_SCRIPT', 'deploy', 'script', path.join(ROOT, 'infra/self-update.sh')),

  lag: num('LAG', 'dev', 'lag', 0),
  jitter: num('JITTER', 'dev', 'jitter', 0),

  // Who is always host. With a key set, it is whoever's browser presents the key — opened once
  // as /?admin=KEY, then remembered. Without one it falls back to the name, which is fine on a
  // laptop and nowhere else: names are not secret, and this one is in a public repository.
  adminKey: pick('ADMIN_KEY', 'admin', 'key', ''),
  adminName: String(pick('ADMIN_NAME', 'admin', 'name', 'cobusvw')).toLowerCase(),

  /* Do names need a password? On by default, and the default is the one that matters: the
   * leaderboard is keyed by name (see careerKey), so without this anybody can type your name and
   * inherit your career. See server/accounts.js.
   *
   * It is a switch because there is a real configuration where it is wrong: a LAN party, a demo,
   * a kiosk — anywhere the room is the access control and asking sixteen people to invent
   * passwords is friction for nothing. `REQUIRE_PASSWORD=0` turns the whole thing off and the
   * handshake is exactly what it was before passwords existed, which is also how the tests that
   * are about ROOMS rather than about sign-in keep being about rooms.
   */
  requirePassword: String(pick('REQUIRE_PASSWORD', 'server', 'require_password', '1')) !== '0',
};

export const usingTls = Boolean(config.tlsCert && config.tlsKey);

/** Constant-time comparison of a presented secret against the configured one. Blank never matches. */
export function sameSecret(given, want) {
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
