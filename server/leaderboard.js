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
// Ten seconds, down from thirty: the most a crash that skips the shutdown path can cost anybody.
const FLUSH_EVERY_MS = 10_000;

/** Deltas are sim scores: finite and never negative. Anything else is an upstream bug. */
const positive = v => (Number.isFinite(v) && v >= 0 ? v : 0);

/** Podium finishes, in place order. Index is the place: 0 is first. */
export const MEDALS = ['gold', 'silver', 'bronze'];

/* Nobody loses XP or a medal to a bad disk day. The rules that make that true:
 *
 *   1. A board that cannot be read is NEVER written over. It used to be: any parse error or
 *      version mismatch started an empty board, and the first save thirty seconds later replaced
 *      everybody's career with it. Now the unreadable file is set aside under a timestamped name,
 *      the previous good copy (`.bak`) is loaded in its place, and only if that is unreadable
 *      too does the board start empty — with both originals still on disk to recover from.
 *   2. Every save writes a fresh temporary file, fsyncs it, keeps the current board as `.bak`,
 *      renames the new one into place and fsyncs the directory. A rename without the fsync can
 *      survive a power cut while the data it points at does not, which is a zero-byte board.
 *   3. Saves never overlap. Two in flight used to share one temporary file name.
 *   4. There is a synchronous save for the paths that cannot wait: a crash and a shutdown whose
 *      backstop timer would otherwise cut an asynchronous one off halfway.
 */
export function createLeaderboard({ dataDir }) {
  const file = path.join(dataDir, 'leaderboard.json');
  const bakFile = `${file}.bak`;
  let dirty = false;
  let tmpSeq = 0;
  const tmpName = () => `${file}.${process.pid}.${++tmpSeq}.tmp`;

  /** Parse one board file into a Map, or throw. */
  function readBoard(from) {
    const data = JSON.parse(fs.readFileSync(from, 'utf8'));
    if (data?.version !== VERSION) throw new Error(`version ${data?.version}, expected ${VERSION}`);
    return data;
  }

  // Synchronous: nothing should serve a request against a half-read board, and this runs once.
  function load() {
    fs.mkdirSync(dataDir, { recursive: true });
    let data = null;
    try {
      data = readBoard(file);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Set it aside rather than let the next save destroy it. See rule 1 above.
        const aside = `${file}.unreadable-${Date.now()}`;
        try { fs.renameSync(file, aside); } catch { /* already gone */ }
        console.error(`leaderboard: ${file} unreadable (${err.message}); kept as ${aside}`);
      }
      try {
        data = readBoard(bakFile);
        console.warn(`leaderboard: loaded the previous good copy, ${bakFile}`);
      } catch (bakErr) {
        if (err.code === 'ENOENT' && bakErr.code === 'ENOENT') {
          console.warn('leaderboard: starting empty (no file yet)');
        } else {
          // The backup is set aside too, or the first save would copy over it.
          if (bakErr.code !== 'ENOENT') {
            try { fs.renameSync(bakFile, `${bakFile}.unreadable-${Date.now()}`); } catch { /* gone */ }
          }
          console.error(`leaderboard: no readable board or backup (${bakErr.message}); starting empty`);
        }
        return new Map();
      }
    }

    const out = new Map();
    for (const [id, e] of Object.entries(data.players ?? {})) {
      if (!id || !e || typeof e !== 'object') continue;
      out.set(id, {
        name: sanitizeName(e.name),
        score: positive(e.score),
        kills: positive(e.kills),
        deaths: positive(e.deaths),
        // Added later than the rest. A board written before medals existed simply has none,
        // which is the truth — no version bump, nothing to migrate.
        gold: positive(e.gold),
        silver: positive(e.silver),
        bronze: positive(e.bronze),
        // Gold COINS, which are a different thing entirely from a gold medal — see the note
        // on `coins` in shared/sim/state.js for how nearly those two became one field.
        coins: positive(e.coins),
      });
    }
    return out;
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
    // Medals are podium finishes; coins are picked up off the floor. Two features, two fields,
    // one very nearly shared name.
    gold: e.gold ?? 0,
    silver: e.silver ?? 0,
    bronze: e.bronze ?? 0,
    coins: e.coins ?? 0,
    // Lifetime score IS the XP, so the level comes straight off it rather than being stored.
    // One derivation, in shared/, used by the server and the client alike.
    ...progressFor(e.score),
  });

  /** Everything earned by playing. Medals come from `award` instead — see below. */
  function record(playerId, { name, score, kills, deaths, coins } = {}) {
    if (typeof playerId !== 'string' || !playerId) return;
    // `coins` defaults in for every record written before coins existed, so an old file loads
    // without a migration and a player who has never seen one starts at zero rather than NaN.
    const e = players.get(playerId) ?? { name: 'anon', score: 0, kills: 0, deaths: 0, coins: 0 };
    if (name != null) e.name = sanitizeName(name);
    e.score += positive(score);
    e.kills += positive(kills);
    e.deaths += positive(deaths);
    e.coins = (e.coins || 0) + positive(coins);
    players.set(playerId, e);
    dirty = true;
  }

  /** A podium finish. `place` is 0 for first; anything off the podium is ignored. */
  function award(playerId, place, name) {
    const medal = MEDALS[place];
    if (!medal || typeof playerId !== 'string' || !playerId) return;
    const e = players.get(playerId) ?? { name: 'anon', score: 0, kills: 0, deaths: 0 };
    if (name != null) e.name = sanitizeName(name);
    e[medal] = (e[medal] ?? 0) + 1;
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

  const snapshot = () =>
    JSON.stringify({ version: VERSION, players: Object.fromEntries(players) }, null, 2);

  /** fsync a directory so a rename inside it is durable. Not supported everywhere; best effort. */
  async function syncDir() {
    let h;
    try { h = await fsp.open(dataDir, 'r'); await h.sync(); } catch { /* Windows, mostly */ }
    finally { await h?.close().catch(() => {}); }
  }

  async function writeOnce() {
    dirty = false;
    const tmp = tmpName();
    try {
      await fsp.mkdir(dataDir, { recursive: true });
      const h = await fsp.open(tmp, 'w');
      try { await h.writeFile(snapshot()); await h.sync(); } finally { await h.close(); }
      // The board being replaced becomes the backup. A copy, not a rename, so there is never a
      // moment with no `leaderboard.json` on disk.
      await fsp.copyFile(file, bakFile).catch(err => { if (err.code !== 'ENOENT') throw err; });
      // Rename is atomic, so a crash leaves either the previous board or the new one, never a
      // truncated mixture of the two.
      await fsp.rename(tmp, file);
      await syncDir();
    } catch (err) {
      // Never rejects: a failed save must not take down a SIGTERM handler or the flush timer.
      dirty = true;
      console.warn(`leaderboard: could not save (${err.message})`);
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /* One dated copy a day, the last HISTORY_DAYS kept.
   *
   * `.bak` covers a save that went wrong; it is ten seconds old. This covers the board itself
   * going wrong — a bug that zeroed somebody, an operator mistake — which can only be put right
   * from a copy older than the mistake. A day's worth of these is a few kilobytes. */
  const HISTORY_DAYS = 30;
  const historyDir = path.join(dataDir, 'history');
  let historyDay = '';
  async function keepHistory() {
    const day = new Date().toISOString().slice(0, 10);
    if (day === historyDay) return;
    try {
      await fsp.mkdir(historyDir, { recursive: true });
      const dest = path.join(historyDir, `leaderboard-${day}.json`);
      await fsp.copyFile(file, dest, fs.constants.COPYFILE_EXCL).catch(err => {
        if (err.code !== 'EEXIST' && err.code !== 'ENOENT') throw err;
      });
      historyDay = day;
      const old = (await fsp.readdir(historyDir)).filter(f => /^leaderboard-\d{4}-\d\d-\d\d\.json$/.test(f))
        .sort().slice(0, -HISTORY_DAYS);
      for (const f of old) await fsp.rm(path.join(historyDir, f), { force: true });
    } catch (err) {
      console.warn(`leaderboard: could not keep a daily copy (${err.message})`);
    }
  }

  // Saves queue behind each other rather than overlapping. See rule 3.
  let chain = Promise.resolve();
  function flush() {
    chain = chain.then(keepHistory).then(writeOnce);
    return chain;
  }

  /** The same save, synchronously, for a crash or a shutdown with a clock running. */
  function flushSync() {
    const tmp = tmpName();
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeFileSync(fd, snapshot()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.copyFileSync(file, bakFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      fs.renameSync(tmp, file);
      dirty = false;
      return true;
    } catch (err) {
      console.error(`leaderboard: could not save (${err.message})`);
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      return false;
    }
  }

  const timer = setInterval(() => { if (dirty) flush(); }, FLUSH_EVERY_MS);
  timer.unref();   // a save timer is not a reason to keep the process alive

  // Only if something changed: an extra identical save would copy the board over its own `.bak`
  // and throw away the one previous version the backup exists to keep.
  const stop = () => {
    clearInterval(timer);
    return dirty ? flush() : chain;
  };

  return Object.freeze({ record, award, get, top, flush, flushSync, stop, file });
}
