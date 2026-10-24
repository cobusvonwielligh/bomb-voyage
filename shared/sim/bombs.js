// Bomb placement, fuses, and same-tick chain reactions.

import {
  FUSE_TICKS, FUSE_TICKS_FAST, FIRE_TICKS, CHAIN_CAP_PER_TICK, IN_BOMB, STATUS, MAX_RADIUS,
  BLOCK, POWDER_RADIUS, DIR_R, DIR_U, DIR_L, DIR_D,
} from '../constants.js';
import { has, toTile, tileAt } from './state.js';
import { spread } from './fire.js';
import { damage, melt } from './blocks.js';
import { maybeDrop } from './perks.js';

export const bombAt = (state, tx, ty) => state.bombs.find(b => b.tx === tx && b.ty === ty);

/* Which tile a bomb from this player would land on.
 *
 * In FRONT of them, not underneath. You face a direction and the bomb goes there, which turns
 * placing one into an aimed action rather than a thing that happens where you happen to be
 * standing. The tile you are standing in is the guide: the facing tile is the neighbour of
 * `toTile(p.x), toTile(p.y)`, so it changes the instant your centre crosses a tile boundary and
 * never depends on where inside the tile you are.
 *
 * It falls back to the tile underneath when the facing one cannot take a bomb — a wall, the
 * sea, the map edge, or another bomb. That fallback is not a compromise, it is the only way the
 * game still works: the commonest reason to bomb anything is to break the wall you are facing,
 * and a rule that refused would mean walls could never be broken by somebody looking at them.
 *
 * Exported because three other places have to agree with it exactly: the client's local
 * feedback sound, and the bots' "is this worth bombing" and "where would the blast go".
 */
export function bombTile(state, p) {
  const tx = toTile(p.x), ty = toTile(p.y);
  const d = DIR_STEP[p.dir] ?? DIR_STEP[DIR_D];
  const fx = tx + d.dx, fy = ty + d.dy;
  const free = tileAt(state.map, fx, fy) === BLOCK.FLOOR && !bombAt(state, fx, fy);
  return free ? { tx: fx, ty: fy } : { tx, ty };
}

const DIR_STEP = {
  [DIR_R]: { dx: 1, dy: 0 },
  [DIR_U]: { dx: 0, dy: -1 },
  [DIR_L]: { dx: -1, dy: 0 },
  [DIR_D]: { dx: 0, dy: 1 },
};

export function place(state, p, mask) {
  /* One bomb per PRESS, not per tick the key is down.
   *
   * It was per tick, and that was survivable only because the bomb landed underneath you and
   * the second attempt found the tile already taken. Aimed placement broke it: the first bomb
   * goes in front, the next tick finds that tile occupied and falls back to the tile underfoot,
   * and a single tap lays two bombs a third of a second apart.
   *
   * The edge is tracked on the player rather than in the client, so prediction and the server
   * agree without the client having to send anything new — it replays the same masks through
   * the same function and arrives at the same answer.
   */
  const held = (mask & IN_BOMB) !== 0;
  const pressed = held && !p.bombHeld;
  p.bombHeld = held;
  if (!pressed || !p.alive) return;
  if (has(p, STATUS.PACIFISM)) return;
  // Seeing stars: somebody slid through you and for the next second and a half you cannot find
  // the fuse. The edge above has already been consumed, so holding the key through it does not
  // bank a bomb that fires the moment it wears off — you have to press again.
  if (has(p, STATUS.CONFUSED)) return;
  // A slide in progress is hands-full. Without this the slide becomes a bomb-delivery vehicle:
  // launch, cross three tiles in a third of a second, and drop one at the far end from safety.
  if (p.slideV > 0) return;

  const { tx, ty } = bombTile(state, p);
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

    // The live bomb list goes in so arms stop at other bombs instead of overshooting them.
    const { cells, hits } = spread(state.map, bomb, state.bombs);

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
      if (res.type === BLOCK.ICE) { melt(state, tx, ty); continue; }   // the water is the drop
      maybeDrop(state, tx, ty, res.type);
    }

    for (const c of cells) {
      // `src` is which blast this is, so a hit can be counted once per blast — see killInFire.
      state.fires.push({ tx: c.tx, ty: c.ty, kind: c.kind, rot: c.rot, until: state.tick + FIRE_TICKS, owner: bomb.owner, src: bomb.id });
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
