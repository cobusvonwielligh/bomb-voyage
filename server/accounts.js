// Passwords, and the trusted browsers that mean you almost never type one.
//
// The problem this solves: the only identity in the game is the NAME (see careerKey in
// leaderboard.js), because in an office of people who know each other the name IS the person —
// and a career worth two months of Friday evenings was protected by nothing at all. Anybody
// could type "cobusvw" and inherit it.
//
// The problem it must not CREATE: a password prompt in front of a game people play for twenty
// minutes at a time. So the prompt happens twice — once when a name is first claimed, and again
// the first time that name arrives from a browser nobody has seen before. After that the browser
// carries a token and the prompt is gone.
//
// ─── what is stored, and what is not ─────────────────────────────────────────
//
// The plaintext password is never stored, never logged, never sent anywhere, and never kept in
// memory beyond the scrypt call that consumes it. What is on disk is scrypt(password, salt) with
// a 16-byte random salt per account — so two people with the same password have different
// hashes, and the file is useless to somebody who reads it without weeks of GPU time per
// account.
//
// Device tokens get the same treatment for the same reason: the token is a bearer credential, so
// the file holds sha256(token) and the only copy of the token itself lives in the browser that
// was given it. A stolen accounts.json therefore grants nothing — no passwords, no sessions.
// (sha256 and not scrypt, deliberately: a token is 256 bits of randomness from the CSPRNG, so
// there is no dictionary to attack and nothing for a slow hash to buy.)
//
// Comparisons are timing-safe. Not because a timing attack on a game server in an office is
// likely, but because `===` on a secret is the kind of thing that gets copied into somewhere it
// matters.
//
// ─── what this is NOT ────────────────────────────────────────────────────────
//
// It is not account recovery, email verification, or a session system with revocation. There is
// no way to reset a forgotten password except an admin deleting the account from the file, and
// that is the right size for a sixteen-seat office server. Spectating needs no password at all,
// which is also the escape hatch: you can always watch.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
// Shared with the client, which quotes the minimum in the sign-up hint. One source, so the hint
// and the rule can never disagree.
import { PASSWORD_MIN, PASSWORD_MAX } from '../shared/constants.js';

const VERSION = 1;

/* scrypt, at the parameters Node's own documentation suggests for interactive logins.
 *
 * N is the memory/time knob and the only one worth tuning: 2^15 with r=8 is 32 MB and lands
 * around 100 ms on a laptop, which is a cost nobody notices once or twice an evening and a wall
 * for anybody trying passwords in bulk. It runs on the libuv thread pool — `crypto.scrypt`, not
 * `scryptSync` — because 100 ms on the main thread is three ticks of the simulation, and a login
 * must never be something the room can feel.
 *
 * The parameters are stored WITH each hash, so raising them later does not invalidate a single
 * existing account: an old hash is still verified at the parameters it was made with, and only a
 * new password gets the new ones.
 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, len: 64 };
/* The memory ceiling has to be raised to let those parameters run at all.
 *
 * OpenSSL refuses any scrypt whose working set exceeds `maxmem`, and Node's default is exactly
 * 32 MB — which is 128·N·r to the byte for N=2^15, r=8, so the call fails on the limit rather
 * than under it. 64 MB gives the chosen parameters room and still refuses anything twice their
 * size, which is the point of having a ceiling.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

// How long a browser stays trusted, and how many a name may trust at once. Thirty days is "the
// season", and five is a desk, a laptop, a phone and two spare — past that the oldest is dropped,
// which is also the only cleanup this ever needs.
export const DEVICE_TTL_MS = 30 * 24 * 3600_000;
export const MAX_DEVICES = 5;

/* Guessing limits, in memory only.
 *
 * Five wrong answers and the name stops answering for a minute, doubling up to an hour for as
 * long as the wrong answers keep coming. Not persisted: a restart clears it, which is a tiny
 * weakness against an attacker who can restart the server — and anybody who can do that owns the
 * machine anyway — against a real benefit, which is that nobody can lock a colleague out of their
 * own account for an hour by typing rubbish at it and then leaving.
 */
const FAIL_LIMIT = 5;
const LOCK_BASE_MS = 60_000;
const LOCK_MAX_MS = 3600_000;

/** The key an account lives under: the name, lowercased. Matches careerKey's `n:` form. */
export const accountKey = name => String(name ?? '').trim().toLowerCase();

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/** Timing-safe string compare that does not leak the length either. */
function sameDigest(a, b) {
  const x = Buffer.from(sha256(String(a ?? '')), 'hex');
  const y = Buffer.from(sha256(String(b ?? '')), 'hex');
  return crypto.timingSafeEqual(x, y);
}

const scrypt = (password, salt, opts) => new Promise((resolve, reject) => {
  crypto.scrypt(
    password, salt, opts.len,
    { N: opts.N, r: opts.r, p: opts.p, maxmem: SCRYPT_MAXMEM },
    (err, key) => { if (err) reject(err); else resolve(key.toString('hex')); },
  );
});

/**
 * Is this a password we are willing to store? The message is returned rather than thrown, because
 * it is shown to the person typing it.
 *
 * @returns null when it is fine, otherwise why not
 */
export function badPassword(pw) {
  if (typeof pw !== 'string') return 'a password is needed';
  if (pw.length < PASSWORD_MIN) return `at least ${PASSWORD_MIN} characters`;
  if (pw.length > PASSWORD_MAX) return `at most ${PASSWORD_MAX} characters`;
  // Control characters only. No composition rules: length is the only requirement that survives
  // contact with people, and a rule that forces a digit on the end produces "password1".
  if (/[\x00-\x1f\x7f]/.test(pw)) return 'no control characters';
  return null;
}

/**
 * @param dataDir where accounts.json lives. The same directory as the leaderboard.
 */
export function createAccounts({ dataDir }) {
  const file = path.join(dataDir, 'accounts.json');
  const bakFile = `${file}.bak`;
  let accounts = new Map();        // key -> record
  let dirty = false;
  let saving = null;
  let tmpSeq = 0;
  // key -> { fails, until }. See FAIL_LIMIT.
  const guesses = new Map();

  /* 0600 on everything.
   *
   * This file is the one thing in the project that is actually worth stealing, and the default
   * mask on a shared box is world-readable. Applied to the directory too — on the server this is
   * ./data, which also holds the TLS key copies.
   */
  const MODE = 0o600;

  function load() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const candidate of [file, bakFile]) {
      let raw;
      try { raw = fs.readFileSync(candidate, 'utf8'); } catch { continue; }
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.version !== VERSION || typeof parsed.accounts !== 'object') throw new Error('shape');
        accounts = new Map(Object.entries(parsed.accounts));
        if (candidate === bakFile) console.warn('accounts: loaded the backup copy');
        return;
      } catch {
        /* Never written over. The same rule the leaderboard follows, and it matters more here:
         * an unreadable accounts file that got replaced with an empty one would hand every name
         * in the office back to whoever claimed it first. Set aside, try the backup, and if that
         * fails too start empty with both originals still on disk. */
        const aside = `${candidate}.unreadable-${Date.now()}`;
        try { fs.renameSync(candidate, aside); } catch { /* already gone */ }
        console.error(`accounts: ${candidate} is unreadable; moved to ${path.basename(aside)}`);
      }
    }
  }

  const snapshot = () => JSON.stringify({
    version: VERSION,
    accounts: Object.fromEntries(accounts),
  });

  /** Durable write: temp file, fsync, keep the old copy as .bak, rename, fsync the directory. */
  async function flush() {
    if (!dirty || saving) return saving ?? undefined;
    dirty = false;
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    saving = (async () => {
      try {
        const body = snapshot();
        const h = await fsp.open(tmp, 'w', MODE);
        try { await h.writeFile(body); await h.sync(); } finally { await h.close(); }
        try { await fsp.copyFile(file, bakFile); } catch { /* first save: nothing to back up */ }
        await fsp.rename(tmp, file);
        try {
          const d = await fsp.open(dataDir, 'r');
          try { await d.sync(); } finally { await d.close(); }
        } catch { /* not supported everywhere; best effort */ }
      } catch (err) {
        dirty = true;                 // try again on the next change
        console.error('accounts: save failed', err.message);
        try { await fsp.unlink(tmp); } catch { /* nothing to clean up */ }
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  /**
   * The synchronous path, for shutdown and crash handlers.
   *
   * Writes whatever is in memory, dirty or not. The asynchronous `flush` clears the flag the
   * moment it STARTS, so a crash a millisecond later would find nothing marked dirty and write
   * nothing at all — and the thing not written would be somebody's new password. A redundant
   * write at shutdown costs nothing; a skipped one locks a person out of their own name.
   */
  function flushSync() {
    dirty = false;
    const tmp = `${file}.${process.pid}.sync.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', MODE);
      try { fs.writeFileSync(fd, snapshot()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.copyFileSync(file, bakFile); } catch { /* first save */ }
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('accounts: sync save failed', err.message);
    }
  }

  load();

  const has = name => accounts.has(accountKey(name));

  /** Milliseconds until this name will answer again, or 0. */
  function lockedFor(name) {
    const g = guesses.get(accountKey(name));
    if (!g?.until) return 0;
    const left = g.until - Date.now();
    if (left > 0) return left;
    guesses.delete(accountKey(name));
    return 0;
  }

  function noteFail(name) {
    const key = accountKey(name);
    const g = guesses.get(key) ?? { fails: 0, until: 0, locks: 0 };
    g.fails++;
    if (g.fails >= FAIL_LIMIT) {
      g.fails = 0;
      g.locks = (g.locks ?? 0) + 1;
      g.until = Date.now() + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (g.locks - 1));
    }
    guesses.set(key, g);
  }

  /** A fresh device token for this account, stored as its digest. Returns the token ONCE. */
  function issueToken(rec) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    rec.devices = (rec.devices ?? [])
      .filter(d => d.exp > now)                    // expired ones go as we touch the list
      .sort((a, b) => b.seen - a.seen)
      .slice(0, MAX_DEVICES - 1);
    rec.devices.push({ h: sha256(token), at: now, seen: now, exp: now + DEVICE_TTL_MS });
    dirty = true;
    return token;
  }

  return Object.freeze({
    has,
    lockedFor,
    get size() { return accounts.size; },

    /**
     * Claim a name for the first time.
     *
     * @returns { ok: true, token } with a token for the browser that claimed it, or
     *          { ok: false, why } — which is either a bad password or somebody got there first.
     */
    async register(name, password) {
      const key = accountKey(name);
      if (!key) return { ok: false, why: 'a name is needed' };
      if (accounts.has(key)) return { ok: false, why: 'that name is taken' };
      const bad = badPassword(password);
      if (bad) return { ok: false, why: bad };

      const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
      const hash = await scrypt(password, salt, SCRYPT);
      // Re-checked after the await: two browsers can claim the same new name inside the ~100 ms
      // the hash takes, and without this the second one silently replaces the first.
      if (accounts.has(key)) return { ok: false, why: 'that name is taken' };
      const rec = {
        name: String(name), salt, hash, kdf: { ...SCRYPT }, created: Date.now(), devices: [],
      };
      accounts.set(key, rec);
      const token = issueToken(rec);
      dirty = true;
      flush();
      return { ok: true, token };
    },

    /**
     * Check a password, and on success hand this browser a token so it stops being asked.
     *
     * @returns { ok, token?, why?, waitMs? }
     */
    async verify(name, password) {
      const key = accountKey(name);
      const rec = accounts.get(key);
      const waitMs = lockedFor(key);
      if (waitMs) return { ok: false, why: 'too many attempts', waitMs };
      if (!rec) {
        /* No such account, and we still pay the cost of a hash.
         *
         * Returning instantly for an unknown name tells an attacker which names exist, by timing
         * alone and with no password needed. One scrypt against a throwaway salt makes the two
         * answers indistinguishable. The result is discarded on purpose.
         */
        await scrypt(String(password ?? ''), 'absent', SCRYPT);
        noteFail(key);
        return { ok: false, why: 'wrong password' };
      }
      if (typeof password !== 'string' || password.length > PASSWORD_MAX) {
        noteFail(key);
        return { ok: false, why: 'wrong password' };
      }
      const hash = await scrypt(password, rec.salt, { ...SCRYPT, ...rec.kdf });
      if (!sameDigest(hash, rec.hash)) {
        noteFail(key);
        return { ok: false, why: 'wrong password' };
      }
      guesses.delete(key);
      const token = issueToken(rec);
      rec.lastSeen = Date.now();
      dirty = true;
      flush();
      return { ok: true, token };
    },

    /**
     * Does this browser's token still vouch for this name?
     *
     * Sliding expiry: every successful use pushes the token's life out again, so a browser you
     * play from every Friday never asks, and one you used once in March stops being trusted in
     * April. Synchronous — a digest comparison, not a password hash — so the hello path pays
     * nothing in the overwhelmingly common case.
     */
    checkDevice(name, token) {
      if (typeof token !== 'string' || token.length !== TOKEN_BYTES * 2) return false;
      const rec = accounts.get(accountKey(name));
      if (!rec?.devices?.length) return false;
      const now = Date.now();
      const want = sha256(token);
      for (const d of rec.devices) {
        if (d.exp <= now || !sameDigest(d.h, want)) continue;
        d.seen = now;
        d.exp = now + DEVICE_TTL_MS;
        rec.lastSeen = now;
        dirty = true;
        return true;
      }
      return false;
    },

    /** Forget every trusted browser for this name. The way back from "I shared my laptop". */
    forgetDevices(name) {
      const rec = accounts.get(accountKey(name));
      if (!rec) return 0;
      const n = rec.devices?.length ?? 0;
      rec.devices = [];
      dirty = true;
      flush();
      return n;
    },

    flush,
    flushSync,
  });
}
