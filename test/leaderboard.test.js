// Lifetime scores have to survive a restart, a crash mid-write and a mangled file — docs/PLAN.md
// RND-2. Every test gets its own temporary data dir, because the file *is* the state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NAME_MAX_CHARS, xpForLevel, tierForLevel, VETERAN_LEVEL } from '../shared/constants.js';
import { createLeaderboard } from '../server/leaderboard.js';
import { createRoom } from '../server/room.js';
import fss from 'node:fs';

/** An isolated data dir, removed when the subtest ends. */
async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-leaderboard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const read = async dir => JSON.parse(await fs.readFile(path.join(dir, 'leaderboard.json'), 'utf8'));

test('leaderboard', async t => {
  await t.test('rounds accumulate into one lifetime total', async t => {
    const dir = await tempDir(t);
    const lb = createLeaderboard({ dataDir: dir });

    lb.record('p1', { name: 'alpha', score: 150, kills: 1, deaths: 0 });
    lb.record('p1', { name: 'alpha', score: 75, kills: 0, deaths: 2 });
    lb.record('p1', { name: 'alpha-two', score: 25, kills: 1, deaths: 1 });

    const me = lb.get('p1');
    assert.equal(me.score, 250);
    assert.equal(me.kills, 2);
    assert.equal(me.deaths, 3);
    assert.equal(me.name, 'alpha-two', 'the most recent name wins');
    assert.equal(lb.get('never-played'), null);
    await lb.stop();
  });

  await t.test('rubbish deltas and names cannot poison a total', async t => {
    const dir = await tempDir(t);
    const lb = createLeaderboard({ dataDir: dir });

    lb.record('p1', { name: 'alpha', score: 100, kills: 1, deaths: 1 });
    lb.record('p1', { score: NaN, kills: -5, deaths: Infinity });
    lb.record('p1', { score: '300' });

    const me = lb.get('p1');
    assert.equal(me.score, 100, 'non-finite and non-numeric deltas are ignored');
    assert.equal(me.kills, 1, 'negative deltas are ignored');
    assert.equal(me.deaths, 1);

    lb.record('p2', { name: `bad\x07name${'x'.repeat(NAME_MAX_CHARS)}`, score: 1 });
    const other = lb.get('p2');
    assert.equal(other.name.length, NAME_MAX_CHARS, 'truncated');
    assert.ok(!/[\x00-\x1f]/.test(other.name), 'control characters stripped');

    lb.record('', { score: 999 });
    assert.equal(lb.top().length, 2, 'an empty player id records nothing');
    await lb.stop();
  });

  await t.test('a level flips exactly on its threshold, never a point early', async t => {
    const dir = await tempDir(t);
    const lb = createLeaderboard({ dataDir: dir });

    lb.record('p', { name: 'climber', score: xpForLevel(1) - 1 });
    const below = lb.get('p');
    assert.equal(below.level, 0);
    assert.equal(below.tier, 'Rookie');
    assert.equal(below.nextAt, xpForLevel(1));
    assert.equal(below.into, below.xp, 'level 0 starts at zero, so into is the whole total');

    lb.record('p', { score: 1 });                     // lands on the threshold itself
    const on = lb.get('p');
    assert.equal(on.level, 1);
    assert.equal(on.into, 0, 'a fresh level starts the bar empty');
    assert.equal(on.nextAt, xpForLevel(2));

    lb.record('v', { name: 'veteran', score: xpForLevel(VETERAN_LEVEL) });
    const vet = lb.get('v');
    assert.equal(vet.level, VETERAN_LEVEL);
    assert.equal(vet.tier, 'Veteran');
    assert.equal(vet.tier, tierForLevel(VETERAN_LEVEL));
    // Veteran is a floor, not a ceiling: levelling does not stop, the name just stops changing.
    assert.ok(vet.nextAt > vet.xp, 'there should still be a next level above Veteran');
    await lb.stop();
  });

  await t.test('top() sorts by score, then kills, then name', async t => {
    const dir = await tempDir(t);
    const lb = createLeaderboard({ dataDir: dir });

    lb.record('a', { name: 'ann', score: 100, kills: 1 });
    lb.record('b', { name: 'bob', score: 300, kills: 2 });
    lb.record('c', { name: 'cid', score: 100, kills: 5 });
    lb.record('d', { name: 'dee', score: 100, kills: 1 });

    assert.deepEqual(lb.top().map(p => p.playerId), ['b', 'c', 'a', 'd']);
    assert.deepEqual(lb.top(2).map(p => p.playerId), ['b', 'c'], 'n caps the list');
    assert.equal(lb.top().length, 4, 'fewer players than the default n is fine');
    await lb.stop();
  });

  await t.test('flush and reload round-trip exactly', async t => {
    const dir = await tempDir(t);
    const first = createLeaderboard({ dataDir: dir });
    first.record('a', { name: 'ann', score: xpForLevel(3) + 7, kills: 9, deaths: 4 });
    first.record('b', { name: 'bob', score: 42, kills: 0, deaths: 11 });
    const before = first.top();
    await first.stop();

    const saved = await read(dir);
    assert.equal(saved.version, 1);
    assert.equal(Object.keys(saved.players).length, 2);

    const second = createLeaderboard({ dataDir: dir });
    assert.deepEqual(second.top(), before, 'same scores, same ranks, same order');
    await second.stop();
  });

  await t.test('the write is atomic and leaves no tmp file behind', async t => {
    const dir = await tempDir(t);
    const lb = createLeaderboard({ dataDir: dir });
    lb.record('a', { name: 'ann', score: 10 });
    await lb.flush();
    // `history/` holds the daily copies; see keepHistory in server/leaderboard.js.
    assert.deepEqual((await fs.readdir(dir)).filter(f => f !== 'history'), ['leaderboard.json']);

    lb.record('a', { score: 10 });
    await lb.stop();
    // The second save leaves the first behind as `.bak`, on purpose; still no temporary file.
    assert.deepEqual((await fs.readdir(dir)).filter(f => f !== 'history'),
      ['leaderboard.json', 'leaderboard.json.bak'], 'and none after stop() either');
    assert.equal((await read(dir)).players.a.score, 20);
  });

  await t.test('a tmp file left by a crash is ignored, not loaded', async t => {
    const dir = await tempDir(t);
    const first = createLeaderboard({ dataDir: dir });
    first.record('a', { name: 'ann', score: 500 });
    await first.stop();
    await fs.writeFile(path.join(dir, 'leaderboard.json.tmp'), '{"version":1,"players":{"a":{"sc');

    const second = createLeaderboard({ dataDir: dir });
    assert.equal(second.get('a').score, 500, 'the last complete board is what loads');
    await second.stop();
  });

  await t.test('a broken file costs the history, never the boot', async t => {
    for (const [why, contents] of [
      ['invalid json', '{ this is not json at all'],
      ['empty file', ''],
      ['wrong version', '{"version":99,"players":{"a":{"name":"ann","score":5}}}'],
      ['missing version', '{"players":{"a":{"name":"ann","score":5}}}'],
      ['players is not an object', '{"version":1,"players":"nonsense"}'],
    ]) {
      const dir = await tempDir(t);
      await fs.writeFile(path.join(dir, 'leaderboard.json'), contents);

      const lb = createLeaderboard({ dataDir: dir });
      assert.deepEqual(lb.top(), [], `${why}: started empty`);
      lb.record('a', { name: 'ann', score: 5 });
      await lb.stop();
      assert.equal((await read(dir)).players.a.score, 5, `${why}: and recovered on the next save`);
    }
  });

  await t.test('a missing file and a missing data dir both just work', async t => {
    const dir = path.join(await tempDir(t), 'nested', 'data');
    const lb = createLeaderboard({ dataDir: dir });
    assert.deepEqual(lb.top(), []);
    assert.equal(lb.get('anyone'), null);

    lb.record('a', { name: 'ann', score: 10, kills: 1 });
    await lb.stop();
    assert.equal((await read(dir)).players.a.name, 'ann', 'the dir was created on demand');
  });
});

test('the round in progress survives a restart', async () => {
  // The whole point. Scores used to reach the file only at a round boundary or on disconnect,
  // so a deploy mid-round threw away everything since the last round end — and on a build day
  // that is most deploys.
  const dataDir = fss.mkdtempSync(path.join(os.tmpdir(), 'bv-bank-'));
  try {
    const board = createLeaderboard({ dataDir });
    const room = createRoom({ onBroadcast: () => {}, leaderboard: board });
    room.setBots(2);
    const p = room.state.players[0];
    p.score = 450; p.kills = 4; p.deaths = 1;

    room.bankScores();
    await board.flush();
    room.stop();

    const reloaded = createLeaderboard({ dataDir });
    const got = reloaded.get('bot_0');
    assert.ok(got, 'nothing was written');
    assert.equal(got.score, 450);
    assert.equal(got.kills, 4);
    await reloaded.stop();
  } finally {
    fss.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('medals', async t => {
  await t.test('an award counts, persists, and an old board loads with none', async t => {
    const dir = await tempDir(t);
    // A board written before medals existed: the fields are simply absent.
    await fs.writeFile(path.join(dir, 'leaderboard.json'),
      JSON.stringify({ version: 1, players: { a: { name: 'ann', score: 50, kills: 1, deaths: 2 } } }));
    const lb = createLeaderboard({ dataDir: dir });
    const before = lb.get('a');
    assert.deepEqual([before.gold, before.silver, before.bronze], [0, 0, 0]);

    lb.award('a', 0); lb.award('a', 0); lb.award('a', 2);
    lb.award('a', 3);                       // fourth is not a medal
    lb.award('b', 1, 'bob');                // a medal can be somebody's first entry
    await lb.flush();

    const again = createLeaderboard({ dataDir: dir });
    const a = again.get('a'), b = again.get('b');
    assert.deepEqual([a.gold, a.silver, a.bronze], [2, 0, 1]);
    assert.equal(a.score, 50, 'medals touched the score');
    assert.deepEqual([b.gold, b.silver, b.bronze, b.name], [0, 1, 0, 'bob']);
    assert.deepEqual(again.top(5).map(e => e.gold), [2, 0], 'top() does not carry medals');
    await lb.stop(); await again.stop();
  });

  /** Play a room to the end of a round with these scores, return the medals banked per seat. */
  async function finishRound(scores) {
    const dataDir = fss.mkdtempSync(path.join(os.tmpdir(), 'bv-medal-'));
    try {
      const board = createLeaderboard({ dataDir });
      const room = createRoom({ onBroadcast: () => {}, leaderboard: board });
      room.setBots(scores.length);
      room.setRoundTime(0.1);
      // Freeze everyone in place for the round so the bots cannot score on their own.
      const ticks = Math.round(0.1 * 60 * 30);
      for (let n = 0; n < ticks - 1; n++) room.tick();
      scores.forEach((s, i) => { const p = room.state.players[i]; p.score = s; p.kills = 0; p.alive = false; });
      // And nothing still burning: a bomb going off on the final tick pays its owner for the
      // blocks it breaks, dead or not, which turned a zero-point round into a two-point one about
      // one run in three.
      room.state.bombs.length = 0;
      room.state.fires.length = 0;
      room.tick();                          // the round ends on this one
      const got = scores.map((_, i) => {
        const e = board.get(`bot_${i}`);
        return e ? [e.gold, e.silver, e.bronze] : [0, 0, 0];
      });
      room.restartRound();
      room.stop();
      await board.stop();
      return got;
    } finally {
      fss.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  await t.test('the top three of a full round get gold, silver and bronze', async () => {
    const got = await finishRound([300, 900, 100, 500, 50]);
    assert.deepEqual(got[1], [1, 0, 0], 'first did not get gold');
    assert.deepEqual(got[3], [0, 1, 0], 'second did not get silver');
    assert.deepEqual(got[0], [0, 0, 1], 'third did not get bronze');
    assert.deepEqual(got[2], [0, 0, 0], 'fourth got a medal');
    assert.deepEqual(got[4], [0, 0, 0], 'last got a medal');
  });

  await t.test('last place is never on the podium', async () => {
    const two = await finishRound([200, 100]);
    assert.deepEqual(two, [[1, 0, 0], [0, 0, 0]], 'a two-player round paid more than a gold');
    const three = await finishRound([300, 200, 100]);
    assert.deepEqual(three[2], [0, 0, 0], 'third of three got bronze');
  });

  await t.test('a finish on zero points wins nothing', async () => {
    const got = await finishRound([0, 0, 0, 0]);
    assert.deepEqual(got, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  });
});

test('banking twice does not pay twice', async () => {
  // It has to be safe to call on every shutdown AND at every round end, so it writes deltas.
  // A running total written twice would double somebody's whole afternoon.
  const dataDir = fss.mkdtempSync(path.join(os.tmpdir(), 'bv-bank2-'));
  try {
    const board = createLeaderboard({ dataDir });
    const room = createRoom({ onBroadcast: () => {}, leaderboard: board });
    room.setBots(1);
    const p = room.state.players[0];

    p.score = 100;
    room.bankScores();
    room.bankScores();                       // a shutdown straight after a round end
    assert.equal(board.get('bot_0').score, 100, 'paid twice for the same points');

    p.score = 175;                           // kept playing
    room.bankScores();
    assert.equal(board.get('bot_0').score, 175, 'the second bank lost the difference');

    room.stop();
    await board.stop();
  } finally {
    fss.rmSync(dataDir, { recursive: true, force: true });
  }
});
