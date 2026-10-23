// The 1 Hz lifetime-rank broadcast.
//
// The one thing worth pinning: lifetime is banked + round score, not banked alone. The board is
// only written on disconnect and at the end of a round, so without the addition your rank would
// visibly refuse to move for a whole sixteen-minute round while you earned it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoom } from '../server/room.js';
import { createLeaderboard } from '../server/leaderboard.js';
import { SCORE, rankForScore, RANK_NAMES } from '../shared/constants.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

async function withRoom(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-scores-'));
  const leaderboard = createLeaderboard({ dataDir });
  const scores = [];
  const room = createRoom({
    onBroadcast: m => {
      const x = typeof m === 'function' ? m(0) : m;
      if (x.t === 'scores') scores.push(x);
    },
    leaderboard,
  });
  try {
    await fn({ room, leaderboard, scores });
  } finally {
    room.stop();
    await leaderboard.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('lifetime rank is banked plus the round in progress', async () => {
  await withRoom(async ({ room, leaderboard, scores }) => {
    leaderboard.record('bot_0', { name: 'veteran', score: 5000, kills: 40, deaths: 10 });
    room.setBots(2);
    // Earn something this round, before a single byte has been written to the board.
    room.state.players[0].score = 300;

    room.start();
    await wait(1200);

    const last = scores.at(-1);
    assert.ok(last, 'no scores message in 1.2 s — the 1 Hz broadcast is not firing');

    const seat0 = last.ranks.find(r => r.i === 0);
    assert.ok(seat0, 'seated bot missing from the ranks');
    assert.ok(seat0.lifetime >= 5300,
      `lifetime ${seat0.lifetime} ignores the round in progress (banked 5000 + 300 earned)`);
    assert.equal(seat0.rank, rankForScore(seat0.lifetime));
    assert.equal(seat0.rankName, RANK_NAMES[seat0.rank]);
    assert.equal(seat0.bot, true);

    const seat1 = last.ranks.find(r => r.i === 1);
    assert.equal(seat1.rankName, 'Rookie', 'a fresh seat starts at the bottom of the ladder');

    // The all-time five rides along, so the scoreboard needs no second request.
    assert.equal(last.top[0].name, 'veteran');
    assert.equal(last.top[0].rankName, RANK_NAMES[rankForScore(5000)]);
  });
});

test('empty seats are simply absent, and it does not throw with nobody at all', async () => {
  await withRoom(async ({ room, scores }) => {
    room.start();
    await wait(1200);
    const last = scores.at(-1);
    assert.ok(last, 'the broadcast should still fire for an empty room');
    assert.deepEqual(last.ranks, []);
  });
});

test('a negative round score cannot drag a career rank below what is banked', async () => {
  // Suicides are worth SCORE.SUICIDE. The sim floors a player at zero, but the clamp here is what
  // guarantees it, and a career total going backwards would be the one unforgivable bug in a
  // leaderboard.
  assert.ok(SCORE.SUICIDE < 0, 'this test is pointless if suicide is not a penalty');
  await withRoom(async ({ room, leaderboard, scores }) => {
    leaderboard.record('bot_0', { name: 'unlucky', score: 2000 });
    room.setBots(1);
    room.state.players[0].score = -500;      // force it past what the sim would allow
    room.start();
    await wait(1200);
    const seat0 = scores.at(-1).ranks.find(r => r.i === 0);
    assert.equal(seat0.lifetime, 2000, 'a negative round score must count as zero, never subtract');
  });
});
