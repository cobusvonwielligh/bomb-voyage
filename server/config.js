// Bomb Voyage — configuration.
//
// Precedence: environment variable > config.ini > built-in default.
// Env wins so CI and one-off runs (`LAG=200 npm start`) never need to touch a file.
//
// config.ini is gitignored and holds anything secret or machine-specific. config.example.ini
// is the committed template. On the server the real file lives at /opt/bomb-voyage/config.ini
// and is excluded from rsync, so a deploy never overwrites it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // Shared secret for POST /deploy. Empty disables the endpoint entirely.
  deployToken: pick('DEPLOY_TOKEN', 'deploy', 'token', ''),
  // Overridable so tests can exercise the accept path without actually redeploying anything.
  deployScript: pick('DEPLOY_SCRIPT', 'deploy', 'script', path.join(ROOT, 'infra/self-update.sh')),

  lag: num('LAG', 'dev', 'lag', 0),
  jitter: num('JITTER', 'dev', 'jitter', 0),
};

export const usingTls = Boolean(config.tlsCert && config.tlsKey);
