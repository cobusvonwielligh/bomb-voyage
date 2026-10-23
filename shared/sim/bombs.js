// Bomb placement, fuses, and same-tick chain reactions.

import {
  FUSE_TICKS, FUSE_TICKS_FAST, FIRE_TICKS, CHAIN_CAP_PER_TICK, IN_BOMB, STATUS, MAX_RADIUS,
  BLOCK, POWDER_RADIUS,
} from '../constants.js';
import { has, toTile, tileCentre } from './state.js';
import { spread } from './fire.js';
import { damage } from './blocks.js';
import { maybeDrop } from './perks.js';

export const bombAt = (state, tx, ty) => state.bombs.find(b => b.tx === tx && b.ty === ty);

/** A bomb is solid to everyone except the player still standing on the tile they placed it on. */
export function blocksPlayer(state, p, tx, ty) {
  const b = bombAt(state, tx, ty);
  if (!b) return false;
  if (b.owner !== p.i) return true;
  return !(toTile(p.x) === tx && toTile(p.y) === ty);
}

export function place(state, p, mask) {
  if (!(mask & IN_BOMB) || !p.alive) return;
  if (has(p, STATUS.PACIFISM)) return;

  const tx = toTile(p.x), ty = toTile(p.y);
  if (bombAt(state, tx, ty)) return;

  const live = state.bombs.reduce((n, b) => n + (b.owner === p.i ? 1 : 0), 0);
  if (live >= p.bombs) return;

  const fuse = has(p, STATUS.FAST_DET) ? FUSE_TICKS_FAST : FUSE_TICKS;
  const bomb = {
    id: state.nextBombId++,
    tx, ty,
    o: p.i, owner: p.i,
    r: Math.min(p.radius, MAX_RADIUS), radius: Math.min(p.radius, MAX_RADIUS),
    at: state.tick + fuse,
  };
  state.bombs.push(bomb);
  state.events.push({ e: 'bomb', tick: state.tick, id: bomb.id, x: tx, y: ty, o: p.i, r: bomb.radius, at: bomb.at });
}

/**
 * Detonate everything due this tick, including whatever the blasts set off.
 *
 * Resolved as a queue in one tick, always in ascending bomb id, with a hard cap — a 16-player
 * bomb carpet must not be able to stall the loop. Deterministic ordering matters more than it
 * looks: it decides who gets credit for a chain kill.
 */
export function detonate(state) {
  const due = state.bombs.filter(b => b.at <= state.tick).sort((a, b) => a.id - b.id);
  if (!due.length) return;

  const queue = [...due];
  const burst = new Set();
  let guard = 0;

  while (queue.length && guard++ < CHAIN_CAP_PER_TICK) {
    const bomb = queue.shift();
    if (burst.has(bomb.id)) continue;
    burst.add(bomb.id);

    const { cells, hits } = spread(state.map, bomb);

    // `boom` must come out BEFORE the block events this same blast produces.
    //
    // The client replays a snapshot's events strictly in order and only derives the blast when it
    // reaches `boom` — by running the same `spread` against its own map. Emitted last, the block
    // the arm was supposed to stop at has already been turned to floor by the preceding
    // `blockdie`, so the client draws fire two tiles past where the server actually burned. That
    // happened on roughly half of all bombs (both fuse lengths are even, so `at` shares parity
    // with the placement tick and lands in the same snapshot as its own block events) and on every
    // chain-detonated bomb regardless of parity.
    //
    // The alternative — buffering block events on the client until after the booms — is wrong: a
    // snapshot spans two ticks, so it would mis-order block changes from the earlier tick.
    state.events.push({
      e: 'boom', tick: state.tick, id: bomb.id,
      x: bomb.tx, y: bomb.ty, o: bomb.owner, r: bomb.radius,
    });

    for (const { tx, ty } of hits) {
      const res = damage(state, tx, ty, bomb.owner);
      if (!res?.destroyed) continue;
      if (res.type === BLOCK.POWDER) {
        // A keg IS a bomb, so it goes on the same queue as any other chained bomb. Nothing in
        // the blast code needs to know about kegs: it chains through other kegs, through bombs
        // and through walls exactly the way a bomb already does.
        queue.push({
          id: state.nextBombId++, tx, ty,
          owner: bomb.owner, radius: POWDER_RADIUS, at: state.tick,
        });
        continue;                                   // kegs hold powder, not pickups
      }
      maybeDrop(state, tx, ty, res.type);
    }

    for (const c of cells) {
      state.fires.push({ tx: c.tx, ty: c.ty, kind: c.kind, rot: c.rot, until: state.tick + FIRE_TICKS, owner: bomb.owner });
      // Anything caught in the blast goes off now, not on its own fuse.
      const neighbour = bombAt(state, c.tx, c.ty);
      if (neighbour && !burst.has(neighbour.id)) queue.push(neighbour);
    }
  }

  state.bombs = state.bombs.filter(b => !burst.has(b.id));
}

export function expireFires(state) {
  if (state.fires.length) state.fires = state.fires.filter(f => f.until > state.tick);
}

/** Where a bomb sits, in sim units — used for drop placement and rendering. */
export const bombCentre = b => ({ x: tileCentre(b.tx), y: tileCentre(b.ty) });
