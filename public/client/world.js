// The client's mirror of the simulation, plus prediction and replay.
//
// Your own player is predicted from your keys and corrected by replaying unacknowledged inputs.
// Everyone else is drawn from snapshots, a little in the past. docs/NETCODE.md §2.

import { INTERP_DELAY_TICKS, TRACER_SAMPLES, TRACER_EVERY_TICKS, FIRE_TICKS } from '/shared/constants.js';
import { createPlayer, tileCentre } from '/shared/sim/state.js';
import { decodeCells, packCell, cellType } from '/shared/maps.js';
import { BLOCK, BLOCK_HP } from '/shared/constants.js';
import { step, blocked } from '/shared/sim/movement.js';
import { spread } from '/shared/sim/fire.js';
import { pickPair } from '/shared/util/interp.js';

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
    if (wire.sta !== undefined) { p.stamina = wire.sta; p.staminaLevel = wire.stl; p.tired = !!wire.tr; }
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
  /** Mark a player as having just appeared, so the renderer can make it impossible to miss. */
  w.markSpawn = i => {
    const p = w.players[i];
    if (p) p.spawnAt = w.tick;
  };

  w.applyBlockEvent = e => {
    if (!w.map) return;
    const i = e.y * w.map.w + e.x;
    if (e.e === 'blockhit') w.map.cells[i] = packCell(cellType(w.map.cells[i]), e.hp);
    else if (e.e === 'blockdie') w.map.cells[i] = packCell(BLOCK.FLOOR, 0);
    else if (e.e === 'blocknew') w.map.cells[i] = packCell(e.b, BLOCK_HP[e.b] || 0);
  };

  w.applySnap = snap => {
    // Before the welcome there is no map, no seat and no names: a snapshot applied here would
    // create every player as "p<seat>" and hydrate() keeps the first name it is given.
    if (!w.ready) return;
    // A snapshot older than one already applied is not news. TCP cannot reorder, but the dev lag
    // shim can, and a rewound tick would unburst bombs and walk the interpolation backwards.
    if (snap.tick < w.tick) return;
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
      // Snapshots arrive every 2 ticks and remotes are drawn INTERP_DELAY_TICKS behind, so the
      // pair that brackets the render time can be three entries back. Keeping only three meant
      // the right pair had usually already been shifted out.
      p.buf.push({ tick: snap.tick, x: wire.x, y: wire.y });
      if (p.buf.length > 6) p.buf.shift();
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
  // `ack = -1` on purpose: a snapshot without one must drop nothing, rather than compare every
  // pending tick against undefined and then replay the entire queue.
  function reconcile(me, wire, ack = -1) {
    while (w.pending.length && w.pending[0].tick <= ack) w.pending.shift();

    const before = { x: me.x, y: me.y };
    me.x = wire.x; me.y = wire.y;
    me.alive = wire.st === 1;
    me.bombs = wire.b; me.radius = wire.f; me.speed = wire.sp; me.shields = wire.sh;
    me.score = wire.s; me.kills = wire.k; me.deaths = wire.dd; me.status = wire.stat;
    // Stamina is simulated locally too, so it is replayed with the inputs below rather than
    // simply trusted — the server's value is the one the replay starts from.
    if (wire.sta !== undefined) { me.stamina = wire.sta; me.staminaLevel = wire.stl; me.tired = !!wire.tr; }

    for (const inp of w.pending) step(w, me, inp.mask);

    if (Math.abs(me.x - before.x) > 8 || Math.abs(me.y - before.y) > 8) w.lastCorrection = performance.now();
  }

  /**
   * Keep a drawn player out of the walls.
   *
   * The useful observation is that the *tile* a player is in is the whole truth as far as the
   * rules go — fire, pickups and contagion all resolve per tile — and the sub-tile offset is
   * purely presentation. So when smoothing or interpolation puts the drawn point somewhere
   * illegal, the tile index is still trustworthy and we can fall back to it: pull the offending
   * axis onto the centre line of the tile the simulation says they occupy.
   *
   * Movement is axis-locked and auto-centring, so in a corridor that centre line is where they
   * really are to within a few units. You get the fine movement everywhere it is legal, and a
   * silent snap to the lane exactly where it is not. No more walking through corners.
   */
  function settleToLane(p) {
    if (!w.map || !blocked(w, p, p.rx, p.ry)) return;
    const cx = tileCentre(p.x >> 8), cy = tileCentre(p.y >> 8);
    // Slide onto the lane rather than jumping onto it. A hard assignment here is a visible
    // flick — the drawn position is usually only a few units inside the wall, and moving a few
    // units a frame hides the correction completely. A floor of 4 units makes it terminate.
    const ease = (from, to) => {
      const d = to - from;
      return from + Math.sign(d) * Math.min(Math.abs(d), Math.max(4, Math.abs(d) * 0.25));
    };
    if (!blocked(w, p, cx, p.ry)) { p.rx = ease(p.rx, cx); return; }
    if (!blocked(w, p, p.rx, cy)) { p.ry = ease(p.ry, cy); return; }
    p.rx = ease(p.rx, cx); p.ry = ease(p.ry, cy);
  }

  /**
   * Hard cut, not a slide. The tracer is sampled from the *rendered* position, so without
   * clearing it a respawn leaves a stripe of coloured dots across the map from where you died.
   */
  function teleport(p) {
    p.rx = p.x; p.ry = p.y;
    p.trail.length = 0;
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
        // A longer time constant while being pushed out of something solid: the simulation is
        // already moving slowly and deliberately there, and a fast follow would reintroduce
        // exactly the flick the slow push exists to avoid.
        const pushed = blocked(w, p, p.x, p.y);
        const k = 1 - Math.exp(-dtMs / (pushed ? 180 : 80));
        const dx = p.x - p.rx, dy = p.y - p.ry;
        // A whole tile out means a respawn or a teleport, not a correction — just go.
        if (Math.abs(dx) > 256 || Math.abs(dy) > 256) teleport(p);
        else {
          const nx = p.rx + dx * k, ny = p.ry + dy * k;
          // The eased path is a straight line and the simulated one was not, so easing across a
          // corner can draw you briefly inside a wall. Rather than snapping to the simulated
          // position — which is the flick this used to produce — try each axis on its own: one
          // of them is almost always legal, and taking just that one keeps the motion smooth.
          if (!blocked(w, p, nx, ny)) { p.rx = nx; p.ry = ny; }
          else if (!blocked(w, p, nx, p.ry)) { p.rx = nx; }
          else if (!blocked(w, p, p.rx, ny)) { p.ry = ny; }
          else { p.rx = p.x; p.ry = p.y; }      // genuinely boxed in; nothing smooth left to do
        }
      } else if (p.buf.length >= 2) {
        // The pair that BRACKETS the time being drawn, not the two newest — see pickPair. Taking
        // the newest two pinned every remote player to one snapshot until the next arrived, which
        // is a teleport fifteen times a second and the single biggest source of "the movement is
        // laggy". It was never the transport.
        const pair = pickPair(p.buf, renderTick);
        const { a, b, f } = pair;
        const dx = b.x - a.x, dy = b.y - a.y;

        // Further than anyone can walk in one snapshot means a respawn, not a walk. Interpolating
        // it would drag the sprite across the whole map, straight through everything in between.
        if (Math.abs(dx) > 512 || Math.abs(dy) > 512) {
          teleport(p);                    // p.x is already b.x — hydrate ran before this
        } else {
          // Movement is axis-locked: step() only ever moves on one axis per tick. So interpolate
          // along an L rather than along the diagonal — a straight lerp between two snapshots
          // that turned a corner cuts through the corner block, which is the "players walk
          // through walls" everyone sees first. Which arm of the L comes first is unknowable
          // from two samples, so try x-first and fall back to y-first when the x-first elbow is
          // solid. One of the two is always the path actually taken.
          const t = (Math.abs(dx) + Math.abs(dy)) * f;
          const xFirst = !blocked(w, p, b.x, a.y);
          const [u, v] = xFirst ? [dx, dy] : [dy, dx];
          const pu = a[xFirst ? 'x' : 'y'] + Math.sign(u) * Math.min(Math.abs(u), t);
          const pv = a[xFirst ? 'y' : 'x'] + Math.sign(v) * Math.max(0, Math.min(Math.abs(v), t - Math.abs(u)));
          p.rx = xFirst ? pu : pv;
          p.ry = xFirst ? pv : pu;
          // Walking is whether the drawn position is actually changing. The wire has no `moving`
          // flag, and without this every remote player slid around in their standing frame.
          p.moving = Math.abs(dx) + Math.abs(dy) > 2 && f < 1;
        }
      }

      settleToLane(p);
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
