// Headless bot benchmark: how well do the bots in ai.js actually play?
//
//   node server/botbench.js [minutes per map] [bots]
//
// Fifteen bots, every map, ticked by hand as fast as the CPU allows — ten simulated minutes is a
// few seconds of wall clock. Prints deaths, suicides and kills per bot per minute, which are the
// numbers STATUS.md quotes. Run it before and after touching ai.js; a change that is not visible
// here is not a change.
//
// Suicides are the number to push down. Kills are the number that must not collapse while you do
// it — a bot that never bombs never dies, and is also not worth playing against.

import { pathToFileURL } from 'node:url';
import { createRoom } from './room.js';
import { MAPS } from '../shared/maps.js';
import { TICK_HZ } from '../shared/constants.js';

export function bench({ minutes = 5, bots = 15, maps = MAPS.map((_, i) => i) } = {}) {
  const totals = { ticks: 0, botMinutes: 0, deaths: 0, suicides: 0, kills: 0, bombs: 0, perks: 0 };
  const perMap = [];

  for (const mi of maps) {
    const t = { map: MAPS[mi].id, deaths: 0, suicides: 0, kills: 0, bombs: 0, perks: 0 };
    const room = createRoom({
      onBroadcast: msg => {
        if (typeof msg !== 'function') return;
        const snap = msg(0);
        if (snap?.t !== 'snap') return;
        for (const e of snap.ev) {
          if (e.e === 'died') { t.deaths++; if (e.by === e.i) t.suicides++; else t.kills++; }
          else if (e.e === 'bomb') t.bombs++;
          else if (e.e === 'perkget') t.perks++;
        }
      },
    });
    room.setMap(mi);
    room.setBots(bots);
    room.setRoundTime?.(minutes + 1);
    const ticks = minutes * 60 * TICK_HZ;
    for (let n = 0; n < ticks; n++) room.tick();

    perMap.push(t);
    totals.ticks += ticks;
    totals.botMinutes += bots * minutes;
    for (const k of ['deaths', 'suicides', 'kills', 'bombs', 'perks']) totals[k] += t[k];
  }
  return { totals, perMap, bots, minutes };
}

export function report({ totals, perMap, bots, minutes }) {
  const per = (n, botMin) => (n / botMin).toFixed(2);
  const lines = [`${bots} bots, ${minutes} min per map, ${perMap.length} maps (per bot per minute)`];
  lines.push('map         deaths  suicide  kills   bombs   perks');
  for (const t of perMap) {
    const bm = bots * minutes;
    lines.push(`${t.map.padEnd(11)} ${per(t.deaths, bm).padStart(6)}  ${per(t.suicides, bm).padStart(7)}  ` +
      `${per(t.kills, bm).padStart(5)}  ${per(t.bombs, bm).padStart(6)}  ${per(t.perks, bm).padStart(6)}`);
  }
  const bm = totals.botMinutes;
  lines.push(`${'ALL'.padEnd(11)} ${per(totals.deaths, bm).padStart(6)}  ${per(totals.suicides, bm).padStart(7)}  ` +
    `${per(totals.kills, bm).padStart(5)}  ${per(totals.bombs, bm).padStart(6)}  ${per(totals.perks, bm).padStart(6)}`);
  lines.push(`suicide share of deaths: ${(100 * totals.suicides / Math.max(1, totals.deaths)).toFixed(0)}%`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const minutes = Number(process.argv[2]) || 5;
  const bots = Number(process.argv[3]) || 15;
  const t0 = performance.now();
  const r = bench({ minutes, bots });
  console.log(report(r));
  console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s wall clock)`);
}
