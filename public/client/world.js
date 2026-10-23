// The client's mirror of the simulation, plus prediction and replay.
//
// Your own player is predicted from your keys and corrected by replaying unacknowledged inputs.
// Everyone else is drawn from snapshots, a little in the past. docs/NETCODE.md §2.

import { INTERP_DELAY_TICKS, TRACER_SAMPLES, TRACER_EVERY_TICKS } from '/shared/constants.js';
import { createPlayer } from '/shared/sim/state.js';
import { decodeCells } from '/shared/maps.js';
import { step } from '/shared/sim/movement.js';

export function createWorld() {
  const w = {
    ready: false,
    you: -1,
    tick: 0,
    map: null,
    players: [],          // index = seat
    bombs: [],
    pending: [],          // inputs sent but not yet acknowledged
    dirtyTiles: [],       // cells changed since the renderer last looked
    lastCorrection: 0,
  };

  w.me = () => w.players[w.you] || null;

  w.applyWelcome = m => {
    if (m.map) {
      w.map = { id: m.map.id, w: m.map.w, h: m.map.h, cells: decodeCells(m.map.cells), spawns: m.map.spawns };
      w.dirtyTiles.push('all');
    }
    if (m.mapOnly) return;
    w.you = m.you;
    w.tick = m.tick;
    w.players = [];
    for (const p of m.players) w.players[p.i] = hydrate(p);
    w.bombs = m.bombs || [];
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
    step({ map: w.map }, me, mask);
    me.rx = me.x; me.ry = me.y;                      // our own player is never interpolated
  };

  w.applySnap = snap => {
    w.tick = snap.tick;
    w.bombs = snap.bombs || [];

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

    for (const inp of w.pending) step({ map: w.map }, me, inp.mask);

    if (Math.abs(me.x - before.x) > 8 || Math.abs(me.y - before.y) > 8) w.lastCorrection = performance.now();
    me.rx = me.x; me.ry = me.y;
  }

  /** Called every frame: advance rendered positions and sample tracers. */
  w.interpolate = serverTickNow => {
    const renderTick = serverTickNow - INTERP_DELAY_TICKS;
    for (const p of w.players) {
      if (!p) continue;
      if (p.i !== w.you && p.buf.length >= 2) {
        const [a, b] = p.buf.slice(-2);
        const span = b.tick - a.tick || 1;
        let f = (renderTick - a.tick) / span;
        f = Math.max(0, Math.min(1.5, f));          // a little extrapolation, then hold
        if (f > 1) f = 1;
        p.rx = a.x + (b.x - a.x) * f;
        p.ry = a.y + (b.y - a.y) * f;
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
