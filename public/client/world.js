// The client's mirror of the simulation, plus prediction and replay.
//
// Your own player is predicted from your keys and corrected by replaying unacknowledged inputs.
// Everyone else is drawn from snapshots, a little in the past. docs/NETCODE.md §2.

import { INTERP_DELAY_TICKS, TRACER_SAMPLES, TRACER_EVERY_TICKS, FIRE_TICKS } from '/shared/constants.js';
import { createPlayer } from '/shared/sim/state.js';
import { decodeCells, packCell, cellType } from '/shared/maps.js';
import { BLOCK, BLOCK_HP } from '/shared/constants.js';
import { step, blocked } from '/shared/sim/movement.js';
import { spread } from '/shared/sim/fire.js';

export function createWorld() {
  const w = {
    ready: false,
    you: -1,
    tick: 0,
    map: null,
    players: [],          // index = seat
    bombs: [],
    perks: [],
    fires: [],            // derived locally, never sent — see docs/NETCODE.md §1a
    burst: new Set(),     // bomb ids already turned into fire here
    pending: [],          // inputs sent but not yet acknowledged
    lastCorrection: 0,
  };

  w.me = () => w.players[w.you] || null;

  w.applyWelcome = m => {
    if (m.map) {
      w.map = { id: m.map.id, w: m.map.w, h: m.map.h, cells: decodeCells(m.map.cells), spawns: m.map.spawns };
    }
    if (m.mapOnly) return;
    w.you = m.you;
    w.roundEndsAtTick = m.roundEndsAtTick ?? w.roundEndsAtTick;
    w.tick = m.tick;
    w.players = [];
    for (const p of m.players) w.players[p.i] = hydrate(p);
    w.bombs = m.bombs || [];
    w.perks = m.perks || [];
    // Derived state belongs to the old map; a new round must not inherit its fires.
    w.fires.length = 0;
    w.burst.clear();
    w.pending.length = 0;
    w.ready = true;
  };

  function hydrate(wire, existing) {
    const p = existing || createPlayer(wire.i, wire.name || `p${wire.i}`);
    p.x = wire.x; p.y = wire.y; p.dir = wire.d;
    p.alive = wire.st === 1;
    p.bombs = wire.b; p.radius = wire.f; p.speed = wire.sp; p.shields = wire.sh;
    p.score = wire.s; p.kills = wire.k; p.deaths = wire.dd; p.status = wire.stat;
    if (wire.name) p.name = wire.name;
    p.rx ??= p.x; p.ry ??= p.y;        // rendered position, smoothed for remotes
    p.trail ??= [];
    p.buf ??= [];                       // recent snapshots, for interpolation
    return p;
  }

  /** One local tick: predict our own movement immediately, and remember the input for replay. */
  w.predict = (tick, mask) => {
    const me = w.me();
    if (!me) return;
    w.pending.push({ tick, mask });
    if (w.pending.length > 200) w.pending.shift();   // connection is gone; stop growing
    step(w, me, mask);
    // Deliberately does NOT touch rx/ry. The rendered position eases toward the simulated one in
    // interpolate(), which is what absorbs reconciliation corrections instead of showing them.
  };

  /**
   * Turn a bomb into fire, locally, using the same spread function the server runs.
   *
   * This is the whole latency story: the explosion tick is fixed when the bomb is placed, so a
   * client computes the identical blast at the identical tick without being told. Nobody ever
   * dies to a blast that had not appeared on their screen. docs/NETCODE.md §1a.
   */
  w.burstBomb = bomb => {
    if (!bomb || w.burst.has(bomb.id) || !w.map) return;
    w.burst.add(bomb.id);
    const { cells } = spread(w.map, { tx: bomb.tx, ty: bomb.ty, radius: bomb.r ?? bomb.radius });
    const until = w.tick + FIRE_TICKS;
    for (const c of cells) w.fires.push({ ...c, until, owner: bomb.o ?? bomb.owner });
    w.bombs = w.bombs.filter(b => b.id !== bomb.id);
    w.onBoom?.(bomb);
  };

  /** Called every frame: fuses that have run out, and fire that has burned out. */
  w.updateFires = () => {
    for (const b of w.bombs.slice()) if (w.tick >= b.at) w.burstBomb(b);
    if (w.fires.length) w.fires = w.fires.filter(f => f.until > w.tick);
    if (w.burst.size > 256) w.burst.clear();      // ids only ever grow; this is cheap bookkeeping
  };

  /** Keep the local map in step with the server so predicted blasts stop at the right walls. */
  w.applyBlockEvent = e => {
    if (!w.map) return;
    const i = e.y * w.map.w + e.x;
    if (e.e === 'blockhit') w.map.cells[i] = packCell(cellType(w.map.cells[i]), e.hp);
    else if (e.e === 'blockdie') w.map.cells[i] = packCell(BLOCK.FLOOR, 0);
    else if (e.e === 'blocknew') w.map.cells[i] = packCell(e.b, BLOCK_HP[e.b] || 0);
  };

  w.applySnap = snap => {
    w.tick = snap.tick;
    w.perks = snap.perks || [];

    // Keep any bomb we already know about: the server drops it from the snapshot the moment it
    // explodes, and we may not have reached its fuse tick yet.
    const incoming = new Map((snap.bombs || []).map(b => [b.id, b]));
    for (const b of w.bombs) if (!incoming.has(b.id) && !w.burst.has(b.id)) incoming.set(b.id, b);
    w.bombs = [...incoming.values()].filter(b => !w.burst.has(b.id));

    for (const wire of snap.players) {
      const existing = w.players[wire.i];
      if (wire.i === w.you) {
        const me = existing || (w.players[wire.i] = hydrate(wire));
        reconcile(me, wire, snap.ack);
        continue;
      }
      const p = existing ? hydrate(wire, existing) : (w.players[wire.i] = hydrate(wire));
      // Keep two snapshots so we can interpolate between them instead of teleporting.
      p.buf.push({ tick: snap.tick, x: wire.x, y: wire.y });
      if (p.buf.length > 3) p.buf.shift();
    }

    // Anyone absent from the snapshot has left.
    const present = new Set(snap.players.map(p => p.i));
    for (let i = 0; i < w.players.length; i++) if (w.players[i] && !present.has(i)) delete w.players[i];
  };

  /**
   * Drop acknowledged inputs, then replay whatever is left on top of the server's answer.
   * Because movement.step is the same function on both sides, the result is normally identical
   * and nothing visibly moves. Deliberately no tolerance band and no blending — add a 100 ms
   * lerp here only if snapping turns out to be visible in practice.
   */
  function reconcile(me, wire, ack) {
    while (w.pending.length && w.pending[0].tick <= ack) w.pending.shift();

    const before = { x: me.x, y: me.y };
    me.x = wire.x; me.y = wire.y;
    me.alive = wire.st === 1;
    me.bombs = wire.b; me.radius = wire.f; me.speed = wire.sp; me.shields = wire.sh;
    me.score = wire.s; me.kills = wire.k; me.deaths = wire.dd; me.status = wire.stat;

    for (const inp of w.pending) step(w, me, inp.mask);

    if (Math.abs(me.x - before.x) > 8 || Math.abs(me.y - before.y) > 8) w.lastCorrection = performance.now();
  }

  /** Called every frame: advance rendered positions and sample tracers. */
  w.interpolate = (serverTickNow, dtMs = 16) => {
    const renderTick = serverTickNow - INTERP_DELAY_TICKS;
    for (const p of w.players) {
      if (!p) continue;

      if (p.i === w.you) {
        // Ease the drawn position toward the simulated one. Reconciliation runs 15 times a
        // second and is usually a no-op, but when it is not, a hard assignment shows up as a
        // stutter. An ~80 ms time constant hides a correction without feeling floaty.
        const k = 1 - Math.exp(-dtMs / 80);
        const dx = p.x - p.rx, dy = p.y - p.ry;
        // A whole tile out means a respawn or a teleport, not a correction — just go.
        if (Math.abs(dx) > 256 || Math.abs(dy) > 256) { p.rx = p.x; p.ry = p.y; }
        else {
          const nx = p.rx + dx * k, ny = p.ry + dy * k;
          // The eased path is a straight line and the simulated one was not, so easing across a
          // corner can draw you briefly inside a wall. If the smoothed point is solid, skip the
          // smoothing for this frame rather than clipping.
          if (blocked(w, p, nx, ny)) { p.rx = p.x; p.ry = p.y; }
          else { p.rx = nx; p.ry = ny; }
        }
      } else if (p.buf.length >= 2) {
        const [a, b] = p.buf.slice(-2);
        const span = b.tick - a.tick || 1;
        const f = Math.max(0, Math.min(1, (renderTick - a.tick) / span));
        // Movement is axis-locked: step() only ever moves on one axis per tick. So interpolate
        // along an L, x first, rather than along the diagonal. A straight lerp between two
        // snapshots that turned a corner cuts straight through the corner block, which is
        // exactly the "players walk through walls" everyone sees first.
        const dx = b.x - a.x, dy = b.y - a.y;
        const travel = (Math.abs(dx) + Math.abs(dy)) * f;
        p.rx = a.x + Math.sign(dx) * Math.min(Math.abs(dx), travel);
        p.ry = a.y + Math.sign(dy) * Math.max(0, Math.min(Math.abs(dy), travel - Math.abs(dx)));
      }
      if (p.trailAt === undefined) p.trailAt = 0;
      if (w.tick - p.trailAt >= TRACER_EVERY_TICKS) {
        p.trailAt = w.tick;
        p.trail.push([p.rx, p.ry]);
        if (p.trail.length > TRACER_SAMPLES) p.trail.shift();
      }
    }
  };

  return w;
}
