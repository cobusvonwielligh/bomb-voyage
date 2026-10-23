// One round: the authoritative loop, the seats, and the snapshots.
//
// The loop is the only thing in the project allowed to decide the order of operations — see
// docs/ARCHITECTURE.md §4. Everything it calls is a pure-ish system from shared/sim.

import {
  TICK_MS, TICK_HZ, SNAP_EVERY_TICKS, MAX_PLAYERS, ROUND_TICKS, STATUS, STATUS_TICKS,
  TILE_PX, UNITS_PER_TILE, FUSE_TICKS, FIRE_TICKS, playerColor, SCORE, ROUND_INTERMISSION_MS,
  progressFor,
  STREAK_WINDOW_TICKS, STREAK_NAMES, STREAK_ACE, GAMESPEED_MIN, GAMESPEED_MAX,
  SPAWN_CANDIDATES, IDLE_KICK_TICKS,
} from '../shared/constants.js';
import { MAPS, encodeCells } from '../shared/maps.js';
import { createState, createPlayer, expireStatuses, applyStatus, tileCentre } from '../shared/sim/state.js';
import { blocked, unstick } from '../shared/sim/movement.js';
import { tick as simTick } from '../shared/sim/round.js';
import { createBrain, think, dangerMap } from './ai.js';

// How long a seat is held for someone who vanished. A closed laptop lid, a wifi roam or a tunnel
// all look identical to a crash, and losing your stats to a two-second blip is maddening.
const RECONNECT_GRACE_TICKS = 45 * 30;      // 45 seconds
const INPUT_BUFFER_TICKS = 64;

// An ACE needs a crowd to mean anything. With two players seated, "everyone else" is one person
// and every ordinary kill would announce itself; three victims is the smallest sweep worth a
// banner. See docs/RULES.md §13.
const ACE_MIN_VICTIMS = 3;

const newStreak = () => ({ count: 0, lastTick: -1e9, victims: new Set() });

export function createRoom({ onKick, onBroadcast, adminName = '', maxPlayers = MAX_PLAYERS, leaderboard = null,
  // Overridable so a test can watch a seat be recycled without waiting 45 real seconds.
  graceTicks = RECONNECT_GRACE_TICKS,
}) {
  // Start somewhere random rather than always on the first map. Rotation between rounds works
  // fine, but a server that restarts — a deploy, a crash, a reboot — always came back to Arena,
  // so in practice that is the only map anybody ever saw.
  let mapIndex = (Math.random() * MAPS.length) | 0;
  let state = createState(MAPS[mapIndex]);

  // seat -> { playerId, name, mask, inputs, lastAckTick, connected, goneSince }
  const seats = new Array(maxPlayers).fill(null);
  let timer = null;
  let nextDeadline = 0;
  let between = false;      // intermission: scoreboard up, simulation paused
  const tickTimes = [];

  // The handle for the intermission's "start the next round" timer. Kept so /restart and /map can
  // cancel it; see cancelIntermission.
  let roundTimer = null;

  // Percent of the real-time tick rate. The tick itself is always 1/30 s of simulated time.
  let gamespeed = 100;
  const tickMs = () => TICK_MS * 100 / gamespeed;

  // Monotonic, so "the most recently added bot" survives bots being removed from the middle.
  let botSeq = 0;

  // seat -> { count, lastTick, victims:Set }. Server-side presentation only: nothing in here is
  // read by the simulation, so it cannot affect determinism.
  const streaks = new Array(maxPlayers).fill(null).map(() => newStreak());

  // ─── seating ────────────────────────────────────────────────────────────────

  const findSeatByPlayerId = id => (id ? seats.findIndex(s => s && s.playerId === id) : -1);

  /** Seat of a living or reserved player by name, case-insensitively. -1 for nobody. */
  const seatOfName = name => {
    const want = String(name ?? '').toLowerCase();
    return seats.findIndex(s => s && s.name.toLowerCase() === want);
  };

  /** The bot that joined most recently, or -1. */
  const newestBotSeat = () => {
    let seat = -1, newest = -1;
    for (let i = 0; i < maxPlayers; i++) {
      if (seats[i]?.isBot && seats[i].addedAt > newest) { newest = seats[i].addedAt; seat = i; }
    }
    return seat;
  };

  /** Vacate a seat without banking anything. Bots have no career to bank. */
  function clearSeat(seat) {
    seats[seat] = null;
    state.players[seat] = null;
    streaks[seat] = newStreak();
  }

  function join(playerId, name) {
    const existing = findSeatByPlayerId(playerId);

    if (existing >= 0) {
      const held = seats[existing];

      // An id is one person, and one person plays once. A second window on the same identity is
      // turned away rather than quietly handed a second seat or allowed to steal the first — a
      // sixteen-seat server where one person can hold two of them is a smaller server.
      //
      // Only a LIVE seat refuses. A socket that has actually gone is the reconnect case, and
      // that has to keep working: a wifi roam must not lock you out of your own score.
      if (held.connected) {
        return { seat: -1, resumed: false, playerId: null, displaced: null, why: 'already-playing' };
      }

      held.connected = true;
      held.goneSince = 0;
      held.lastInputAt = state.tick;
      held.name = name || held.name;
      if (state.players[existing]) state.players[existing].name = held.name;
      return { seat: existing, resumed: true, playerId, displaced: null };
    }

    // A full server that is full of bots is not full. Turning away a real person so a brain we
    // wrote can keep playing is the wrong answer every time, so the newest bot gives up its seat
    // — newest because the bots that have been in longest are the ones already in a fight.
    let seat = seats.findIndex(s => s === null);
    let displaced = null;
    if (seat === -1) {
      const bot = newestBotSeat();
      if (bot >= 0) { displaced = seats[bot].name; clearSeat(bot); seat = bot; }
    }
    if (seat === -1) return { seat: -1, resumed: false, playerId: null, displaced: null };

    const id = playerId || `p_${seat}_${Date.now().toString(36)}_${(Math.random() * 1e6) | 0}`;
    seats[seat] = {
      playerId: id, name, mask: 0, inputs: new Map(), lastAckTick: 0,
      connected: true, goneSince: 0, lastInputAt: state.tick,
    };
    streaks[seat] = newStreak();
    const p = createPlayer(seat, name);
    state.players[seat] = p;
    respawn(p);
    return { seat, resumed: false, playerId: id, displaced };
  }

  function disconnect(seat) {
    const s = seats[seat];
    if (!s) return;
    s.connected = false;
    s.goneSince = state.tick;
    s.mask = 0;                 // stop walking into a wall while you are away
  }

  function release(seat) {
    const s = seats[seat], p = state.players[seat];
    // Bank what they earned before the seat is recycled, or a disconnect loses the round.
    if (s && p && !s.isBot) {
      leaderboard?.record(s.playerId, { name: p.name, score: p.score, kills: p.kills, deaths: p.deaths });
    }
    clearSeat(seat);
  }

  /**
   * Admin kick. Banks a human's score exactly as a disconnect would — being thrown out of a round
   * is annoying enough without also losing the career points you earned in it.
   *
   * The socket is not ours to close; net.js does that when this returns a name.
   */
  function kickSeat(seat) {
    const s = seats[seat];
    if (!s) return null;
    const info = { name: s.name, bot: !!s.isBot };
    release(seat);
    return info;
  }

  // ─── input ──────────────────────────────────────────────────────────────────

  function input(seat, tick, mask) {
    const s = seats[seat];
    if (!s) return;
    if (tick <= s.lastAckTick) return;                 // already simulated; too late to matter
    s.lastInputAt = state.tick;
    s.inputs.set(tick, mask & 0x1f);
    if (s.inputs.size > INPUT_BUFFER_TICKS) {
      // Drop the oldest rather than growing without bound if a client floods us.
      const oldest = Math.min(...s.inputs.keys());
      s.inputs.delete(oldest);
    }
  }

  // ─── spawning ───────────────────────────────────────────────────────────────

  /**
   * Spawn as far as possible from the nearest living player, so nobody lands in a firefight.
   *
   * Only legal spawns are candidates. A spawn tile is not guaranteed clear: a wall can regrow on
   * one, a map change replaces the whole grid under a seated player, and a hand-authored map could
   * simply get it wrong — and a player written into a wall is entombed rather than inconvenienced.
   * `unstick` is the seatbelt for the case where every spawn is blocked; `step` calls it each tick
   * anyway, so doing it here only saves a one-frame pop.
   */
  function respawn(p) {
    // Statuses go first: Reduction changes the hitbox and what counts as walkable, so a legality
    // check run before the clear would be answering for a body shape this player is about to lose.
    p.status = 0;
    p.statusUntil = {};

    const spawns = state.map.spawns;
    const legal = spawns.filter(([tx, ty]) => !blocked(state, p, tileCentre(tx), tileCentre(ty)));
    const pool = legal.length ? legal : spawns;

    // Score every legal spawn by how far the nearest living player is, then pick at RANDOM from
    // the best handful rather than always taking the single best.
    //
    // Always taking the best is deterministic, and deterministic means every death sends you to
    // the same two corners for sixteen minutes — which is both boring and exploitable, because
    // anyone can learn where you are about to appear. Choosing among the top few keeps the
    // "nobody lands in a firefight" guarantee and makes it a genuine shuffle. Math.random is fine
    // here: respawn position is decided by the server and shipped in a snapshot, so it is not
    // part of the deterministic simulation the client replays.
    const scored = pool.map(([tx, ty]) => {
      let nearest = Infinity;
      for (const q of state.players) {
        if (!q || !q.alive || q === p) continue;
        const d = Math.abs(q.x - tileCentre(tx)) + Math.abs(q.y - tileCentre(ty));
        if (d < nearest) nearest = d;
      }
      return { tx, ty, nearest };
    }).sort((a, b) => b.nearest - a.nearest);

    const top = scored.slice(0, Math.max(1, Math.min(SPAWN_CANDIDATES, scored.length)));
    const pick = top[(Math.random() * top.length) | 0];
    p.x = tileCentre(pick.tx);
    p.y = tileCentre(pick.ty);
    p.alive = true;
    unstick(state, p);
    applyStatus(state, p, STATUS.INVULN, STATUS_TICKS[STATUS.INVULN]);
    state.events.push({ e: 'spawn', tick: state.tick, i: p.i, x: p.x, y: p.y });
  }

  // ─── kill streaks ───────────────────────────────────────────────────────────

  /**
   * An ACE is the whole room, by one person, in one streak.
   *
   * Precisely: at the instant of this kill the killer is alive, every other occupied seat is dead,
   * every one of those seats was killed by this player inside the current streak, and there were
   * at least three of them. Respawning is a key press away and a corpse is only on the floor for a
   * second, so "everyone else down at once" is a genuinely hard thing to arrange — which is the
   * point. A streak that scores an ACE then starts its victim list again, so the next one needs
   * another full sweep rather than one more kill while the room happens to still be empty.
   */
  function isAce(seat, st) {
    if (st.victims.size < ACE_MIN_VICTIMS) return false;
    if (!state.players[seat]?.alive) return false;
    for (let i = 0; i < maxPlayers; i++) {
      if (i === seat || !seats[i]) continue;
      if (state.players[i]?.alive) return false;      // somebody is still standing
      if (!st.victims.has(i)) return false;           // down, but not by this player's hand
    }
    return true;
  }

  /**
   * Read this tick's `died` events and escalate or reset.
   *
   * Driven from events rather than from inside the simulation on purpose: streaks are pure
   * presentation and the sim is shared with the browser, so keeping them out here means no new
   * state to keep in step across the two environments.
   */
  function trackStreaks(from) {
    for (let n = from; n < state.events.length; n++) {
      const e = state.events[n];
      if (e.e !== 'died') continue;

      // Dying ends your own streak, whoever ended it. A suicide is only ever a death.
      const died = streaks[e.i];
      if (died) { died.count = 0; died.lastTick = -1e9; died.victims.clear(); }
      if (e.by === e.i) continue;

      const st = streaks[e.by];
      const killer = state.players[e.by];
      if (!st || !killer) continue;

      if (e.tick - st.lastTick > STREAK_WINDOW_TICKS) { st.count = 0; st.victims.clear(); }
      st.count++;
      st.lastTick = e.tick;
      st.victims.add(e.i);

      if (isAce(e.by, st)) {
        st.victims.clear();
        onBroadcast({ t: 'streak', i: e.by, name: killer.name, kind: STREAK_ACE, ace: true });
      } else if (st.count >= 2) {
        const kind = STREAK_NAMES[Math.min(st.count, 5)];
        onBroadcast({ t: 'streak', i: e.by, name: killer.name, kind, ace: false });
      }
    }
  }

  // ─── the tick ───────────────────────────────────────────────────────────────

  function tick() {
    if (between) return;
    const t0 = performance.now();
    const inputs = new Array(maxPlayers).fill(0);

    // Computed once per tick and shared by every bot — it is the same answer for all of them.
    const danger = seats.some(s => s?.isBot) ? dangerMap(state) : null;

    for (let i = 0; i < maxPlayers; i++) {
      const s = seats[i];
      if (!s) continue;
      if (s.isBot) {
        inputs[i] = think(state, state.players[i], s.brain, danger);
        s.lastAckTick = state.tick;
        continue;
      }
      if (s.inputs.has(state.tick)) {
        s.mask = s.inputs.get(state.tick);
        s.inputs.delete(state.tick);
      }
      // Missing input repeats the last mask. A dropped packet should not make you stutter.
      s.lastAckTick = state.tick;
      inputs[i] = s.mask;

      if (!s.connected && state.tick - s.goneSince > graceTicks) release(i);

      // Connected but silent. A playing client sends an input every tick, including a mask of
      // zero while standing still, so silence means the tab is backgrounded, frozen or on a
      // sleeping laptop — not that somebody is thinking. Give the seat back: sixteen is a hard
      // cap, and a seat held by a closed lid is a person who cannot join.
      else if (s.connected && !s.isBot &&
               state.tick - (s.lastInputAt ?? state.tick) > IDLE_KICK_TICKS) {
        onBroadcast({ t: 'chat', i: -1, name: 'SERVER', msg: `${s.name} left (idle)` });
        onKick?.(i, 'idle');
        release(i);
      }
    }

    // Where the new events start, so the streak scan reads only this tick's deaths. Events linger
    // for two ticks because snapshots do, so the length before the step is the only safe cursor.
    const evFrom = state.events.length;
    simTick(state, inputs, { onRespawn: respawn });
    trackStreaks(evFrom);

    const ms = performance.now() - t0;
    tickTimes.push(ms);
    if (tickTimes.length > 300) tickTimes.shift();
    if (ms > 20) console.warn(`slow tick: ${ms.toFixed(1)}ms at ${state.tick}`);

    if (state.tick % TICK_HZ === 0) emitScores();

    // Events accumulate until a snapshot actually carries them.
    //
    // This used to clear them every tick while snapshots go out every *second* tick, which threw
    // half of every event away. It cost: deaths that never showed a death screen or a kill-feed
    // line, so bombs looked like they did no damage; blocks that broke on the server and stayed
    // drawn here; and — worst — every single `blocknew`, because wall regrowth lands on tick
    // 600, 1200, 1800, always even. Clients never heard about a regenerated wall, so prediction
    // happily walked straight through it. That is the "I clip through walls" bug.
    if (state.tick % SNAP_EVERY_TICKS === 0) {
      emitSnapshot();
      state.events.length = 0;
    } else if (state.events.length > 1024) {
      state.events.length = 0;      // nobody listening; do not grow without bound
    }

    if (state.tick >= ROUND_TICKS) endRound();
  }

  /**
   * End of round: bank everyone's score into the leaderboard, show the standings, then start
   * the next map. The simulation is paused during the intermission — people deserve to read
   * the scoreboard without being blown up behind it.
   */
  function endRound() {
    between = true;
    const standings = state.players
      .filter(Boolean)
      .map(p => ({ i: p.i, name: p.name, s: p.score, k: p.kills, d: p.deaths }))
      .sort((a, b) => b.s - a.s || b.k - a.k);

    for (const p of state.players) {
      if (!p) continue;
      const seat = seats[p.i];
      if (seat) leaderboard?.record(seat.playerId, { name: p.name, score: p.score, kills: p.kills, deaths: p.deaths });
      if (p.alive) p.score += SCORE.SURVIVE_ROUND;
    }
    leaderboard?.flush();

    onBroadcast({
      t: 'roundend',
      winner: standings[0]?.i ?? -1,
      standings,
      nextMap: MAPS[(mapIndex + 1) % MAPS.length].id,
      startsInMs: ROUND_INTERMISSION_MS,
    });
    // Keep the handle. /restart and /map both install a fresh state, and a forgotten timer then
    // fired against the round that had already replaced the one it was waiting for.
    roundTimer = setTimeout(startNextRound, ROUND_INTERMISSION_MS);
    roundTimer.unref?.();
  }

  function cancelIntermission() {
    if (!roundTimer) return;
    clearTimeout(roundTimer);
    roundTimer = null;
  }

  /**
   * Install a fresh state on `index`, keeping everyone seated, and tell the clients.
   *
   * One helper, two callers. There used to be two copies of this — startNextRound and
   * restartRound, identical apart from the map — and the seat-carrying bug below existed in both
   * precisely because it had to be fixed twice.
   *
   * The thing that has to happen here: a fresh `createState` restarts the tick at 0, so every
   * seat field measured in ticks has to come back to 0 with it. A carried `goneSince` of 20 000
   * can never satisfy `state.tick - goneSince > graceTicks` again, so a reserved seat was never
   * recycled and never banked — it leaked for the lifetime of the process. A carried `lastAckTick`
   * is just as bad in the other direction: `input()` drops anything `<= lastAckTick`, so a client
   * would be silently unable to move for the first 28 800 ticks of the new round.
   */
  function resetRound(index) {
    cancelIntermission();
    mapIndex = index;
    const carried = seats.map(s =>
      (s ? { ...s, inputs: new Map(), mask: 0, goneSince: 0, lastAckTick: 0, lastInputAt: 0 } : null));
    state = createState(MAPS[mapIndex]);
    for (let i = 0; i < maxPlayers; i++) {
      seats[i] = carried[i];
      streaks[i] = newStreak();
      if (!carried[i]) continue;
      const p = createPlayer(i, carried[i].name);
      state.players[i] = p;
      respawn(p);
    }
    between = false;
    nextDeadline = performance.now() + tickMs();
    onBroadcast(seat => welcomeFor(seat));
  }

  const startNextRound = () => {
    roundTimer = null;
    resetRound((mapIndex + 1) % MAPS.length);
  };

  // ─── snapshots ──────────────────────────────────────────────────────────────

  const playerWire = p => ({
    i: p.i, x: p.x, y: p.y, d: p.dir, st: p.alive ? 1 : 0,
    b: p.bombs, f: p.radius, sp: p.speed, sh: p.shields,
    s: p.score, k: p.kills, dd: p.deaths, stat: p.status,
  });

  function emitSnapshot() {
    const players = [];
    for (const p of state.players) if (p) players.push(playerWire(p));
    const ev = state.events.slice();
    onBroadcast(seat => ({
      t: 'snap',
      tick: state.tick,
      ack: seats[seat]?.lastAckTick ?? 0,
      players,
      bombs: state.bombs,
      perks: state.perks,
      ev,
    }));
  }

  /**
   * Lifetime rank, once a second.
   *
   * Deliberately NOT in the snapshot: rank changes a handful of times an hour and the snapshot
   * goes out fifteen times a second, so putting a rank name in there would spend most of the
   * bandwidth on a string that never changes. The round score in the snapshot is the live number;
   * this is the career one.
   *
   * It is the round score *plus* what is already banked, because the board is only written on
   * disconnect and at the end of a round — without the addition your rank would visibly refuse to
   * move for sixteen minutes while you earned it.
   */
  function emitScores() {
    if (!leaderboard) return;
    const ranks = [];
    for (let i = 0; i < maxPlayers; i++) {
      const s = seats[i], p = state.players[i];
      if (!s || !p) continue;
      const banked = leaderboard.get(s.playerId);
      const lifetime = (banked?.score ?? 0) + Math.max(0, p.score);
      ranks.push({ i, bot: !!s.isBot, ...progressFor(lifetime) });
    }
    onBroadcast({ t: 'scores', ranks, host: hostSeat(), top: leaderboard.top(5) });
  }

  const welcomePayloadBase = () => ({
    t: 'mapchange',
    map: {
      id: state.map.id, name: state.map.name, w: state.map.w, h: state.map.h,
      cells: encodeCells(state.map.cells), spawns: state.map.spawns,
    },
  });

  function welcomeFor(seat) {
    const players = [];
    for (const p of state.players) if (p) players.push({ ...playerWire(p), name: p.name, c: p.i });
    return {
      t: 'welcome',
      you: seat,
      // Every welcome carries the resume token, not just the one sent on `hello`. A round restart
      // broadcasts welcomes too, and without this the client stored `undefined` over its real id
      // and came back after the next drop claiming a seat under the literal string "undefined" —
      // which two clients would then fight over.
      playerId: seats[seat]?.playerId ?? null,
      tick: state.tick,
      roundEndsAtTick: ROUND_TICKS,
      color: playerColor(seat),
      map: welcomePayloadBase().map,
      players,
      bombs: state.bombs,
      perks: state.perks,
      // Every rule constant the client needs, so a server tuning change needs no client deploy.
      config: {
        tickHz: TICK_HZ, snapEvery: SNAP_EVERY_TICKS, tileSize: TILE_PX,
        unitsPerTile: UNITS_PER_TILE, maxPlayers, fuseTicks: FUSE_TICKS, fireTicks: FIRE_TICKS,
        // Percent of real time the ticks are being issued at. `tickHz` is still the tick's
        // meaning; this is how fast they arrive, so a client can scale its own clock by it.
        gamespeed,
      },
    };
  }

  // ─── loop ───────────────────────────────────────────────────────────────────

  function start() {
    if (timer) return;
    const step = tickMs();
    nextDeadline = performance.now() + step;
    timer = setInterval(() => {
      const now = performance.now();
      // Absolute deadlines, so the tick rate does not drift. Capped catch-up, so a long GC pause
      // cannot trigger a storm of ticks that makes everyone teleport. Both still hold at any
      // gamespeed — the deadline spacing is the only thing that changes.
      let guard = 0;
      while (now >= nextDeadline && guard < 3) {
        tick();
        nextDeadline += step;
        guard++;
      }
      if (now > nextDeadline + step * 10) nextDeadline = now + step;        // way behind: resync
    }, Math.max(1, Math.floor(step / 2)));
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    cancelIntermission();
  }

  const stats = () => {
    const sorted = [...tickTimes].sort((a, b) => a - b);
    return {
      tick: state.tick,
      map: state.map.id,
      players: seats.filter(s => s && s.connected).length,
      reserved: seats.filter(s => s && !s.connected).length,
      bots: botCount(),
      gamespeed,
      tickMsP50: +(sorted[sorted.length >> 1] || 0).toFixed(2),
      tickMsP99: +(sorted[Math.floor(sorted.length * 0.99)] || 0).toFixed(2),
    };
  };

  // ─── bots and admin ─────────────────────────────────────────────────────────

  /**
   * Who is in charge.
   *
   * The named admin whenever they are connected, and otherwise the longest-standing human — the
   * lowest occupied seat, which is the first person who joined and has not left. A room always
   * has exactly one host while anybody is in it, and losing one promotes the next without
   * anybody having to do anything.
   */
  function hostSeat() {
    let admin = -1, first = -1;
    for (let i = 0; i < maxPlayers; i++) {
      const s = seats[i];
      if (!s || s.isBot || !s.connected) continue;
      if (first < 0) first = i;
      if (adminName && (s.name ?? '').toLowerCase() === adminName) { admin = i; break; }
    }
    return admin >= 0 ? admin : first;
  }

  const botCount = () => seats.filter(s => s?.isBot).length;

  /** Make the number of bots exactly n, adding or removing from the end. */
  function setBots(n) {
    n = Math.max(0, Math.min(maxPlayers - 1, n | 0));   // never fill the last human seat
    while (botCount() > n) {
      const seat = seats.findLastIndex(s => s?.isBot);
      if (seat < 0) break;
      clearSeat(seat);
      // No hand-rolled snapshot here. One without an `ack` made every client replay its whole
      // unacknowledged input queue on top of the server position, which rubber-banded everyone
      // forward. The next real snapshot drops the seat anyway — applySnap removes whoever is
      // missing from it.
    }
    while (botCount() < n) {
      const seat = seats.findIndex(s => s === null);
      if (seat < 0) break;
      const name = `bot-${seat}`;
      seats[seat] = {
        playerId: `bot_${seat}`, name, mask: 0, inputs: new Map(), lastAckTick: 0,
        connected: true, goneSince: 0, isBot: true, brain: createBrain(), addedAt: ++botSeq,
      };
      streaks[seat] = newStreak();
      const p = createPlayer(seat, name);
      state.players[seat] = p;
      respawn(p);
    }
    return botCount();
  }

  /** Start the round over on the same map, keeping everyone seated. */
  const restartRound = () => resetRound(mapIndex);

  /** Switch map immediately, which is a round restart on a different map. */
  function setMap(index) {
    const i = (index | 0);
    if (i < 0 || i >= MAPS.length) return null;
    resetRound(i);
    return MAPS[i].id;
  }

  /**
   * Percent of the real-time tick rate: 200 runs the clock twice as fast, 50 half as fast.
   *
   * What changes is the wall-clock interval between ticks, never the tick's meaning. A tick stays
   * 1/30 s of simulated time, because the client predicts its own movement by running the same
   * `step()` once per tick and derives explosions from a bomb's `at` tick — redefining the tick
   * would desync every one of those. The poller period is re-derived too, because an interval
   * fixed at half of 33 ms cannot deliver a tick every 16 ms at 200 %.
   */
  function setGameSpeed(pct) {
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n) || n < GAMESPEED_MIN || n > GAMESPEED_MAX) return null;
    gamespeed = n;
    if (timer) { stop(); start(); }
    onBroadcast({ t: 'gamespeed', pct: gamespeed });
    return gamespeed;
  }

  /** Toggle permanent invulnerability. Re-applied every tick would be neater, but this is a
   *  very long status and nothing else writes INVULN except respawn, which also sets it. */
  function toggleGod(seat) {
    const p = state.players[seat];
    if (!p) return false;
    const on = !p.god;
    p.god = on;
    if (on) applyStatus(state, p, STATUS.INVULN, 1e9);
    else { p.status &= ~STATUS.INVULN; delete p.statusUntil[STATUS.INVULN]; }
    return on;
  }

  /**
   * Give up the seat and the identity. The score is banked on the way out by `release`, so
   * signing out is not a way to dodge a bad round.
   */
  function logout(seat) {
    if (!seats[seat]) return false;
    release(seat);
    return true;
  }

  /** Pressing SPACE while dead. Kept separate from the input mask so the intent is explicit. */
  function requestRespawn(seat) {
    const p = state.players[seat];
    if (p && !p.alive && state.tick >= p.respawnAt) respawn(p);
  }

  const roundInfo = () => ({ tick: state.tick, endsAt: ROUND_TICKS, between, map: state.map.id });

  return {
    start, stop, join, disconnect, input, requestRespawn, welcomeFor, roundInfo, stats,
    setBots, botCount, restartRound, toggleGod, logout, hostSeat,
    kickSeat, seatOfName, setMap, setGameSpeed,
    isBot: seat => !!seats[seat]?.isBot,
    maps: () => MAPS.map(m => m.id),
    gamespeed: () => gamespeed,
    // Exactly one tick, by hand. The loop calls this; tests call it directly so that behaviour
    // measured in thousands of ticks does not need thousands of ticks of wall clock.
    tick,
    get state() { return state; },
  };
}
