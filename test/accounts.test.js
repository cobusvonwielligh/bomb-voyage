// Passwords, and the trusted browsers that mean you almost never type one.
//
// The properties worth a test are the ones that would be a disaster to get wrong quietly: the
// plaintext must never reach the disk, a wrong password must never be accepted, a token must only
// work for the name it was issued to, and guessing must get slower.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccounts, badPassword, DEVICE_TTL_MS } from '../server/accounts.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bv-accounts-'));
const PW = 'correct horse battery';

test('a new name is claimed with a password, and the password is not on disk', async () => {
  const d = dir();
  const a = createAccounts({ dataDir: d });
  assert.equal(a.has('Cobus'), false);

  const made = await a.register('Cobus', PW);
  assert.equal(made.ok, true);
  assert.ok(made.token, 'no device token was issued to the browser that claimed it');
  assert.equal(a.has('cobus'), true, 'the name should be matched case-insensitively');

  a.flushSync();
  const raw = fs.readFileSync(path.join(d, 'accounts.json'), 'utf8');
  assert.ok(!raw.includes(PW), 'THE PASSWORD IS ON DISK IN PLAINTEXT');
  assert.ok(!raw.includes(made.token), 'the device token is on disk in plaintext');
  const rec = JSON.parse(raw).accounts.cobus;
  assert.ok(rec.salt && rec.hash && rec.hash !== rec.salt);
  assert.ok(rec.hash.length >= 64, 'the hash is too short to be a scrypt output');
});

test('the right password gets in, the wrong one never does', async () => {
  const a = createAccounts({ dataDir: dir() });
  await a.register('cobus', PW);

  const good = await a.verify('cobus', PW);
  assert.equal(good.ok, true);
  assert.ok(good.token);

  for (const wrong of [`${PW} `, PW.toUpperCase(), '', 'hunter2', null, 12345, {}]) {
    const bad = await a.verify('cobus', wrong);
    assert.equal(bad.ok, false, `accepted ${JSON.stringify(wrong)}`);
  }
});

test('an unknown name is refused without saying that it is unknown', async () => {
  const a = createAccounts({ dataDir: dir() });
  const res = await a.verify('nobody', PW);
  assert.equal(res.ok, false);
  assert.equal(res.why, 'wrong password', 'the reply told an attacker the name does not exist');
});

test('a token vouches for its own name and nobody else"s', async () => {
  const a = createAccounts({ dataDir: dir() });
  const mine = await a.register('cobus', PW);
  await a.register('tango', 'another password');

  assert.equal(a.checkDevice('cobus', mine.token), true);
  assert.equal(a.checkDevice('COBUS', mine.token), true, 'the name key is case-sensitive');
  assert.equal(a.checkDevice('tango', mine.token), false, 'a token worked for another account');
  assert.equal(a.checkDevice('cobus', 'f'.repeat(64)), false);
  assert.equal(a.checkDevice('cobus', null), false);
  assert.equal(a.checkDevice('cobus', `${mine.token}00`), false);
});

test('a trusted browser survives a restart, and an expired one does not', async () => {
  const d = dir();
  const a = createAccounts({ dataDir: d });
  const { token } = await a.register('cobus', PW);
  a.flushSync();

  const b = createAccounts({ dataDir: d });
  assert.equal(b.checkDevice('cobus', token), true, 'the token did not survive a restart');

  // Age it past the window by hand, which is the only part of this nobody can wait for.
  const file = path.join(d, 'accounts.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const dev of parsed.accounts.cobus.devices) dev.exp = Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(parsed));
  const c = createAccounts({ dataDir: d });
  assert.equal(c.checkDevice('cobus', token), false, 'an expired token still vouched');
});

test('using a token pushes its expiry out, so a browser in weekly use never asks', async () => {
  const d = dir();
  const a = createAccounts({ dataDir: d });
  const { token } = await a.register('cobus', PW);
  a.flushSync();
  const file = path.join(d, 'accounts.json');
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).accounts.cobus.devices[0].exp;

  // Pretend the token was issued a fortnight ago, then use it.
  const aged = JSON.parse(fs.readFileSync(file, 'utf8'));
  aged.accounts.cobus.devices[0].exp = before - 14 * 24 * 3600_000;
  fs.writeFileSync(file, JSON.stringify(aged));

  const b = createAccounts({ dataDir: d });
  assert.equal(b.checkDevice('cobus', token), true);
  b.flushSync();
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).accounts.cobus.devices[0].exp;
  // The sliding expiry is what makes "almost never asked" true: without it, a browser is thrown
  // out thirty days after it FIRST signed in however often it is used since.
  assert.ok(after > before - 24 * 3600_000, 'using a token did not extend it');
});

test('signing out everywhere revokes every browser at once', async () => {
  const a = createAccounts({ dataDir: dir() });
  const first = await a.register('cobus', PW);
  const second = await a.verify('cobus', PW);
  assert.equal(a.forgetDevices('cobus'), 2);
  assert.equal(a.checkDevice('cobus', first.token), false);
  assert.equal(a.checkDevice('cobus', second.token), false);
});

test('guessing gets locked out, and the lock says how long', async () => {
  const a = createAccounts({ dataDir: dir() });
  await a.register('cobus', PW);
  for (let i = 0; i < 5; i++) await a.verify('cobus', 'nope');
  assert.ok(a.lockedFor('cobus') > 0, 'five wrong answers did not slow anything down');
  const locked = await a.verify('cobus', PW);
  assert.equal(locked.ok, false, 'the correct password got in during a lockout');
  assert.equal(locked.why, 'too many attempts');
  assert.ok(locked.waitMs > 0);
});

test('a name cannot be claimed twice', async () => {
  const a = createAccounts({ dataDir: dir() });
  await a.register('cobus', PW);
  const again = await a.register('COBUS', 'a different password');
  assert.equal(again.ok, false);
  // And the original still works, which is the thing that would actually hurt.
  assert.equal((await a.verify('cobus', PW)).ok, true);
});

test('two browsers claiming the same new name at once: one wins', async () => {
  const a = createAccounts({ dataDir: dir() });
  const [x, y] = await Promise.all([
    a.register('cobus', PW),
    a.register('cobus', 'a different password'),
  ]);
  assert.equal([x.ok, y.ok].filter(Boolean).length, 1, 'both registrations succeeded');
  // Whichever won, exactly one password opens the account.
  const winner = x.ok ? PW : 'a different password';
  const loser = x.ok ? 'a different password' : PW;
  assert.equal((await a.verify('cobus', winner)).ok, true);
  assert.equal((await a.verify('cobus', loser)).ok, false);
});

test('password rules: length is the only one', () => {
  assert.ok(badPassword('short'), 'seven characters was allowed');
  assert.equal(badPassword('eightorm'), null);
  assert.ok(badPassword('x'.repeat(5000)), 'an enormous password was allowed into scrypt');
  assert.ok(badPassword('with a \x00 null'), 'a control character was allowed');
  assert.equal(badPassword('😀😀😀😀😀😀😀😀'), null, 'emoji are characters too');
  assert.ok(badPassword(undefined));
});

test('an unreadable file is never written over', async () => {
  const d = dir();
  const a = createAccounts({ dataDir: d });
  await a.register('cobus', PW);
  a.flushSync();
  // A second save, because that is what makes the first one the backup — the very first write
  // has nothing to copy aside, so an account one save old is the one case with no second copy.
  await a.register('tango', 'another password');
  a.flushSync();
  const file = path.join(d, 'accounts.json');
  fs.writeFileSync(file, '{ this is not json');

  const b = createAccounts({ dataDir: d });
  // The good copy is the backup, and that is what should have been loaded.
  assert.equal(b.has('cobus'), true, 'a corrupt file lost every account on the server');
  assert.ok(fs.readdirSync(d).some(f => f.includes('unreadable')),
    'the corrupt file was not set aside for recovery');
});

test('the store is written with an owner-only mode', async () => {
  const d = dir();
  const a = createAccounts({ dataDir: d });
  await a.register('cobus', PW);
  a.flushSync();
  const mode = fs.statSync(path.join(d, 'accounts.json')).mode & 0o777;
  assert.equal(mode, 0o600, `accounts.json is mode ${mode.toString(8)}`);
});

test('DEVICE_TTL_MS is a month, not a session', () => {
  // Guards a tuning mistake that would be invisible until a Friday: too short and everybody is
  // asked for a password every week, which is the thing this whole file exists to avoid.
  assert.ok(DEVICE_TTL_MS >= 7 * 24 * 3600_000);
});
