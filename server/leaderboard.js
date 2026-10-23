// Lifetime scores — the only state the server keeps between restarts.
//
// One JSON file in data_dir, no database (docs/DESIGN.md). Round score resets every round; what
// lands here is the running total that drives rank, per docs/RULES.md §8.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { progressFor } from '../shared/constants.js';
// Names arrive from the same place the hub gets them, so they are capped and stripped identically.
import { sanitizeName } from './net.js';

const VERSION = 1;
const FLUSH_EVERY_MS = 30_000;

/** Deltas are sim scores: finite and never negative. Anything else is an upstream bug. */
const positive = v => (Number.isFinite(v) && v >= 0 ? v : 0);

export function createLeaderboard({ dataDir }) {
  const file = path.join(dataDir, 'leaderboard.json');
  const tmpFile = `${file}.tmp`;
  let dirty = false;

  // Synchronous: nothing should serve a request against a half-read board, and this runs once.
  function load() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.version !== VERSION) throw new Error(`version ${data?.version}, expected ${VERSION}`);
      const out = new Map();
      for (const [id, e] of Object.entries(data.players ?? {})) {
        if (!id || !e || typeof e !== 'object') continue;
        out.set(id, {
          name: sanitizeName(e.name),
          score: positive(e.score),
          kills: positive(e.kills),
          deaths: positive(e.deaths),
        });
      }
      return out;
    } catch (err) {
      // Missing, empty, mangled or from another version: none of it is worth refusing to boot over.
      const why = err.code === 'ENOENT' ? 'no file yet' : err.message;
      console.warn(`leaderboard: starting empty (${why})`);
      return new Map();
    }
  }

  // A Map, not a plain object: insertion order is then stable even for numeric-looking ids, which
  // is what makes top()'s tie-breaking reproducible.
  const players = load();

  const view = (playerId, e) => ({
    playerId,
    name: e.name,
    score: e.score,
    kills: e.kills,
    deaths: e.deaths,
    // Lifetime score IS the XP, so the level comes straight off it rather than being stored.
    // One derivation, in shared/, used by the server and the client alike.
    ...progressFor(e.score),
  });

  function record(playerId, { name, score, kills, deaths } = {}) {
    if (typeof playerId !== 'string' || !playerId) return;
    const e = players.get(playerId) ?? { name: 'anon', score: 0, kills: 0, deaths: 0 };
    if (name != null) e.name = sanitizeName(name);
    e.score += positive(score);
    e.kills += positive(kills);
    e.deaths += positive(deaths);
    players.set(playerId, e);
    dirty = true;
  }

  const get = playerId => {
    const e = players.get(playerId);
    return e ? view(playerId, e) : null;
  };

  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const top = (n = 10) => [...players]
    .map(([id, e]) => view(id, e))
    .sort((a, b) => b.score - a.score || b.kills - a.kills || byName(a, b))
    .slice(0, n);

  async function flush() {
    dirty = false;
    try {
      await fsp.mkdir(dataDir, { recursive: true });
      const text = JSON.stringify({ version: VERSION, players: Object.fromEntries(players) }, null, 2);
      // Rename is atomic, so a crash leaves either the previous board or the new one, never a
      // truncated mixture of the two.
      await fsp.writeFile(tmpFile, text);
      await fsp.rename(tmpFile, file);
    } catch (err) {
      // Never rejects: a failed save must not take down a SIGTERM handler or the flush timer.
      dirty = true;
      console.warn(`leaderboard: could not save (${err.message})`);
      await fsp.rm(tmpFile, { force: true }).catch(() => {});
    }
  }

  const timer = setInterval(() => { if (dirty) flush(); }, FLUSH_EVERY_MS);
  timer.unref();   // a save timer is not a reason to keep the process alive

  const stop = () => {
    clearInterval(timer);
    return flush();
  };

  return Object.freeze({ record, get, top, flush, stop });
}
