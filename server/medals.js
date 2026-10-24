// Grant podium medals by hand — for testing persistence, or putting right a medal somebody was
// owed. Operator tool, not a game feature: there is deliberately no chat command for this.
//
//   node server/medals.js --name cobusvw --gold 1 --silver 2 --bronze 3
//   node server/medals.js --name cobusvw                     (just show what they have)
//
// THE SERVER MUST BE STOPPED. A running server holds the whole board in memory and saves it every
// few seconds, so an edit made underneath it is overwritten almost at once. This refuses to run
// while anything answers on the configured port:
//
//   sudo systemctl stop bomb-voyage && node server/medals.js ... && sudo systemctl start bomb-voyage
//
// Writes through the leaderboard module itself, so it gets the same fsync, the same `.bak` of
// the previous board and the same refusal to touch an unreadable file as the server does.

import net from 'node:net';
import { config } from './config.js';
import { createLeaderboard, MEDALS } from './leaderboard.js';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

const listening = port => new Promise(resolve => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.setTimeout(800, () => { s.destroy(); resolve(false); });
});

const a = args(process.argv.slice(2));
if (!a.name) {
  console.error('usage: node server/medals.js --name NAME [--gold N] [--silver N] [--bronze N]');
  process.exit(2);
}
const counts = MEDALS.map(m => Math.max(0, Math.floor(Number(a[m] ?? 0)) || 0));
const granting = counts.some(n => n > 0);

if (granting && await listening(config.port)) {
  console.error(`something is answering on port ${config.port}. Stop the game server first —`);
  console.error('it would save its own copy of the board straight over this edit.');
  process.exit(1);
}

const board = createLeaderboard({ dataDir: config.dataDir });
const want = String(a.name).toLowerCase();
const matches = board.top(1e9).filter(e => e.name.toLowerCase() === want);
if (!matches.length) {
  console.error(`nobody called "${a.name}" on the board in ${board.file}. They need to have played once.`);
  await board.stop();
  process.exit(1);
}
// One name, several identities (two browsers, a cleared localStorage): the one with the most XP.
const target = matches[0];
if (matches.length > 1) {
  console.log(`"${a.name}" has ${matches.length} identities; using the one with the most XP:`);
  for (const m of matches) console.log(`  ${m.playerId}  ${m.score} xp`);
}

const show = e => `${e.name} (${e.playerId}): ${e.gold} gold, ${e.silver} silver, ${e.bronze} bronze, ${e.score} xp`;
console.log(`before  ${show(target)}`);
if (granting) {
  counts.forEach((n, place) => { for (let k = 0; k < n; k++) board.award(target.playerId, place); });
  if (!board.flushSync()) process.exit(1);
  console.log(`after   ${show(board.get(target.playerId))}`);
  console.log(`saved to ${board.file} (previous board kept as ${board.file}.bak)`);
}
await board.stop();
