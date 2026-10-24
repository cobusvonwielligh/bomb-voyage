// Medals and XP survive. Every way the board on disk can be lost or damaged that we know of,
// pinned â€” because the rule is that nobody ever loses either, and a rule like that only holds if
// something fails the build the day it stops being true.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLeaderboard } from '../server/leaderboard.js';
import { createRoom } from '../server/room.js';
import { SCORE } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bv-persist-'));

async function board(dataDir, fn) {
  const b = createLeaderboard({ dataDir });
  try { return await fn(b); } finally { await b.stop(); }
}

test('medals and XP survive a restart', async () => {
  const dir = tmp();
  await board(dir, async b => {
    b.record('me', { name: 'cobus', score: 1234, kills: 5, deaths: 2, coins: 1 });
    b.award('me', 0); b.award('me', 1); b.award('me', 1);
    b.award('me', 2); b.award('me', 2); b.award('me', 2);
    await b.flush();
  });
  await board(dir, async b => {
    const e = b.get('me');
    assert.deepEqual([e.gold, e.silver, e.bronze], [1, 2, 3]);
    assert.equal(e.score, 1234);
    assert.equal(e.coins, 1);
  });
});

test('an unreadable board is never written over: the backup is loaded instead', async () => {
  const dir = tmp();
  await board(dir, async b => { b.award('me', 0); await b.flush(); });   // board v1
  await board(dir, async b => { b.award('me', 0); await b.flush(); });   // board v2, v1 -> .bak
  const file = path.join(dir, 'leaderboard.json');
  fs.writeFileSync(file, '{"version":1,"players":{"me":{"gold":');   // a torn write

  await board(dir, async b => {
    assert.equal(b.get('me')?.gold, 1, 'the previous good copy was not loaded');
    b.record('me', { score: 10 });
    await b.flush();
  });
  const aside = fs.readdirSync(dir).filter(f => f.includes('unreadable'));
  assert.equal(aside.length, 1, 'the damaged board was not kept for recovery');
  assert.match(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), /"gold":$/);
});

test('with no readable board or backup it starts empty but destroys neither', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'leaderboard.json'), 'not json');
  fs.writeFileSync(path.join(dir, 'leaderboard.json.bak'), 'not json either');
  await board(dir, async b => { b.record('x', { name: 'x', score: 1 }); await b.flush(); await b.flush(); });
  const kept = fs.readdirSync(dir).filter(f => f.includes('unreadable'))
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).sort();
  assert.deepEqual(kept, ['not json', 'not json either']);
});

test('overlapping saves never produce a damaged file', async () => {
  const dir = tmp();
  await board(dir, async b => {
    const writes = [];
    for (let i = 0; i < 25; i++) { b.record(`p${i}`, { name: `p${i}`, score: i }); writes.push(b.flush()); }
    await Promise.all(writes);
  });
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'leaderboard.json'), 'utf8'));
  assert.equal(Object.keys(data.players).length, 25);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'temporary files left behind');
});

test('the synchronous save â€” the one a crash uses â€” writes everything', async () => {
  const dir = tmp();
  const b = createLeaderboard({ dataDir: dir });
  b.award('me', 2);
  assert.equal(b.flushSync(), true);
  await b.stop();
  await board(dir, async again => assert.equal(again.get('me').bronze, 1));
});

test('a round won is a gold medal and XP that are still there after a restart', async () => {
  const dir = tmp();
  const lb = createLeaderboard({ dataDir: dir });
  const room = createRoom({ countIn: 0, onBroadcast: () => {}, leaderboard: lb });
  try {
    const { seat } = room.join('cobus-id', 'cobus');
    room.setBots(2);
    room.state.players[seat].score = 500;
    room.setRoundTime(0.1);
    for (let i = 0; i < 400 && !room.roundInfo().between; i++) room.tick();
    assert.ok(room.roundInfo().between, 'the round never ended');
  } finally {
    room.stop();
    await lb.stop();
  }
  await board(dir, async b => {
    const e = b.get('n:cobus');
    assert.equal(e?.gold, 1, 'the winner has no gold medal after a restart');
    assert.ok(e.score >= 500, `XP ${e?.score} is less than the round earned`);
  });
});

test('progress is banked during a round, not only at its end', async () => {
  const dir = tmp();
  const lb = createLeaderboard({ dataDir: dir });
  const room = createRoom({ countIn: 0, onBroadcast: () => {}, leaderboard: lb });
  try {
    const { seat } = room.join('mid-id', 'mid');
    room.state.players[seat].score = SCORE.KILL;
    for (let i = 0; i < 10 * 30 + 1; i++) room.tick();
    assert.ok(lb.get('n:mid')?.score >= SCORE.KILL, 'ten seconds in and nothing banked');
  } finally {
    room.stop();
    await lb.stop();
  }
});

test('the medal tool grants, saves, and keeps the board from before as the backup', () => {
  const dir = tmp();
  const seed = createLeaderboard({ dataDir: dir });
  seed.record('cid', { name: 'Cobus', score: 100 });
  seed.flushSync();
  const run = (port, ...a) => spawnSync(process.execPath, ['server/medals.js', ...a], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: dir, PORT: String(port) },
  });

  const ok = run(8191, '--name', 'cobus', '--gold', '1', '--silver', '2', '--bronze', '3');
  assert.equal(ok.status, 0, ok.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'leaderboard.json'), 'utf8')).players.cid;
  assert.deepEqual([after.gold, after.silver, after.bronze, after.score], [1, 2, 3, 100]);
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'leaderboard.json.bak'), 'utf8')).players.cid;
  assert.equal(bak.gold ?? 0, 0, 'the backup should be the board from before the grant');
});
