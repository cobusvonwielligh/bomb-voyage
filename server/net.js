// WebSocket hub: sockets in, room out. The simulation lives in room.js.
// Protocol: docs/PROTOCOL.md.

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  MAX_MESSAGE_BYTES, NAME_MAX_CHARS, CHAT_MAX_CHARS, CHAT_MIN_INTERVAL_MS,
  BAN_MAX_HOURS, GAMESPEED_MIN, GAMESPEED_MAX, ROUNDTIME_MIN_MIN, ROUNDTIME_MAX_MIN,
} from '../shared/constants.js';
import { createRoom } from './room.js';
import { createGuard, addressOf } from './guard.js';

// Open sessions — playing or watching — one browser may hold at once. See claimDevice.
export const MAX_SESSIONS_PER_DEVICE = 2;

/** Strip control characters, trim, cap length. Names are rendered with textContent, never HTML. */
export const sanitizeName = raw =>
  String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, NAME_MAX_CHARS) || 'anon';

/** "30s", "45m", "2h 15m" — short enough to fit in a reject reason. */
export function humanDuration(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Name bans, held in memory only.
 *
 * Deliberately not persisted. The leaderboard file is for scores; moderation state that survives
 * a restart is a bigger decision than one chat command should be able to make, and there is no
 * /unban to undo a mistake with. A restart clears every ban — which is also the escape hatch.
 *
 * Keyed by the sanitised, lowercased name, because that is the only identity a joining client
 * cannot simply choose not to send: `playerId` comes from its own sessionStorage.
 */
export function createBans({ now = Date.now } = {}) {
  const until = new Map();
  const key = name => sanitizeName(name).toLowerCase();

  /** @returns the hours actually applied, after the cap. */
  function add(name, hours) {
    const h = Math.min(Math.max(Number(hours) || 0, 0), BAN_MAX_HOURS);
    if (!h) return 0;
    until.set(key(name), now() + h * 3600_000);
    return h;
  }

  /** Milliseconds left, or 0. Expired entries are dropped as they are found — no sweeper needed. */
  function remainingMs(name) {
    const k = key(name);
    const at = until.get(k);
    if (at === undefined) return 0;
    const left = at - now();
    if (left > 0) return left;
    until.delete(k);
    return 0;
  }

  return Object.freeze({ add, remainingMs, count: () => until.size });
}

/**
 * The chat command table.
 *
 * A factory taking its dependencies rather than a closure inside attachHub, so the parsing and
 * the permission checks can be tested without a socket, a port or a running room.
 */
export function createCommands({ room, config, reply, announce, kick, bans }) {
  const PUBLIC = `commands: /bots N (0-${config.maxPlayers - 1}) · /who · /logout · /help`;
  const ADMIN = 'admin: /restart · /godmode · /kick bot N · /kick NAME [hours] · ' +
    `/map 0-${room.maps().length - 1} · /gamespeed ${GAMESPEED_MIN}-${GAMESPEED_MAX} · ` +
    `/roundtime ${ROUNDTIME_MIN_MIN}-${ROUNDTIME_MAX_MIN}`;

  // Host privileges, not a name check. The host is the named admin when they are here and the
  // longest-standing player otherwise, so a room is never left without somebody who can restart
  // it — which is the whole reason the commands exist.
  const isAdmin = seat => seat >= 0 && seat === room.hostSeat();

  const nameOf = seat => room.state.players[seat]?.name ?? '?';

  /** `/kick bot N` · `/kick NAME` · `/kick NAME HOURS` */
  function kickCommand(ws, seat, args) {
    if (!args.length) return reply(ws, 'usage: /kick bot N | /kick NAME [hours]');

    if (args[0].toLowerCase() === 'bot') {
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 0 || n >= config.maxPlayers) {
        return reply(ws, `usage: /kick bot <1-${config.maxPlayers - 1}>`);
      }
      if (!room.isBot(n)) return reply(ws, `seat ${n} is not a bot`);
      const info = room.kickSeat(n);
      return announce(`${nameOf(seat)} kicked ${info.name}`);
    }

    const target = room.seatOfName(args[0]);
    if (target < 0) return reply(ws, `nobody here called "${args[0]}"`);
    const victim = room.state.players[target]?.name ?? args[0];

    // Hours are optional, and a bad number is a typo rather than an instruction to ban forever.
    let hours = 0;
    if (args.length > 1) {
      const h = Number(args[1]);
      if (!Number.isFinite(h) || h <= 0) return reply(ws, 'usage: /kick NAME [hours]');
      hours = bans.add(victim, h);
    }

    kick(target, hours ? `banned for ${hours}h` : 'kicked');
    return announce(hours
      ? `${nameOf(seat)} banned ${victim} for ${hours}h`
      : `${nameOf(seat)} kicked ${victim}`);
  }

  function run(ws, seat, text) {
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const admin = isAdmin(seat);

    switch (cmd.toLowerCase()) {
      case 'help':
        return reply(ws, admin ? `${PUBLIC} · ${ADMIN}` : PUBLIC);

      case 'bots': {
        if (!args.length) return reply(ws, `${room.botCount()} bots. /bots N to change.`);
        const n = Number(args[0]);
        if (!Number.isFinite(n)) return reply(ws, 'usage: /bots N');
        const got = room.setBots(n, { byHand: true });
        return announce(`${nameOf(seat)} set bots to ${got}`);
      }

      case 'logout':
      case 'signout': {
        const who = room.state.players[seat]?.name ?? '?';
        // Tell this client to forget its stored id BEFORE the seat goes, or the close races the
        // message and it reconnects straight back into the identity it just gave up.
        sendTo(ws, { t: 'reject', why: 'signed out', forget: true });
        room.logout(seat);
        bySeat.delete(seat);
        announce(`${who} signed out`);
        ws.close(4002, 'signed out');
        return;
      }

      case 'who':
        return reply(ws, room.state.players.filter(Boolean)
          .map(p => `${p.name}${p.god ? '*' : ''}`).join(', ') || 'nobody');

      // ── admin ──
      case 'restart':
        if (!admin) return reply(ws, 'not for you');
        announce('round restarted');
        return room.restartRound();

      case 'godmode': {
        if (!admin) return reply(ws, 'not for you');
        const on = room.toggleGod(seat);
        return reply(ws, `godmode ${on ? 'on' : 'off'}`);
      }

      case 'kick':
        if (!admin) return reply(ws, 'not for you');
        return kickCommand(ws, seat, args);

      case 'map': {
        if (!admin) return reply(ws, 'not for you');
        const id = args.length ? room.setMap(Number(args[0])) : null;
        if (!id) return reply(ws, `usage: /map <0-${room.maps().length - 1}>`);
        return announce(`${nameOf(seat)} switched the map to ${id}`);
      }

      case 'gamespeed': {
        if (!admin) return reply(ws, 'not for you');
        if (!args.length) return reply(ws, `game speed is ${room.gamespeed()}%`);
        const pct = room.setGameSpeed(args[0]);
        if (pct === null) {
          return reply(ws, `usage: /gamespeed <${GAMESPEED_MIN}-${GAMESPEED_MAX}>`);
        }
        return announce(`${nameOf(seat)} set game speed to ${pct}%`);
      }

      case 'roundtime': {
        if (!admin) return reply(ws, 'not for you');
        if (!args.length) return reply(ws, `rounds are ${room.roundMinutes()} minutes`);
        const mins = room.setRoundTime(args[0]);
        if (mins === null) {
          return reply(ws, `usage: /roundtime <${ROUNDTIME_MIN_MIN}-${ROUNDTIME_MAX_MIN}> minutes`);
        }
        return announce(`${nameOf(seat)} set the round to ${mins} minutes`);
      }

      default:
        return reply(ws, `unknown command. ${PUBLIC}`);
    }
  }

  return Object.freeze({ run, isAdmin });
}

export function attachHub(server, config) {
  const guard = config.guard ?? createGuard();
  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES,
    // Refused before the upgrade completes, so a flood never gets as far as a socket object.
    verifyClient: (info, done) => {
      const ip = addressOf(info.req);
      if (guard.allowConnect(ip)) { info.req.bvIp = ip; return done(true); }
      done(false, 429, 'too many connections');
    },
  });

  /* Sessions per browser: at most MAX_SESSIONS_PER_DEVICE, playing and watching together.
   *
   * Per BROWSER, because that is the only "computer" a web page can identify: a MAC address
   * never leaves the local network and no browser will reveal one, and an IP address is the
   * whole office at once. The browser keeps a random device id in localStorage — separate from
   * the player identity, so /logout does not reset it — and sends it with every hello. A second
   * browser or a private window is a different device; this stops the easy case, tabs. */
  const devices = new Map();     // device id -> Set of ws
  const deviceOf = raw => (typeof raw === 'string' && /^[\w-]{8,64}$/.test(raw) ? raw : null);
  function claimDevice(ws, device) {
    if (!device) return true;
    let set = devices.get(device);
    if (!set) devices.set(device, set = new Set());
    if (!set.has(ws) && set.size >= MAX_SESSIONS_PER_DEVICE) return false;
    set.add(ws);
    ws.bvDevice = device;
    return true;
  }
  function releaseDevice(ws) {
    const set = ws.bvDevice && devices.get(ws.bvDevice);
    if (!set) return;
    set.delete(ws);
    if (!set.size) devices.delete(ws.bvDevice);
  }
  const bySeat = new Map();      // seat -> ws
  /* Spectators. No seat, no inputs, no place in the simulation at all.
   *
   * Held in their own set rather than as seats with a flag, because a seat is the scarce thing
   * — sixteen of them — and the whole point of spectating is that it costs nobody a place. It
   * also means every rule that iterates seats stays exactly as it was: a spectator cannot win a
   * round, cannot be kicked for idling, cannot be host, and cannot appear on the scoreboard,
   * without a single one of those places having to learn the word.
   */
  const watchers = new Set();    // ws

  /** Outbound delay, dev only. Refuses to coexist with TLS — see server/index.js. */
  const sendTo = (ws, msg) => {
    if (!ws || ws.readyState !== ws.OPEN) return;
    const data = JSON.stringify(msg);
    if (!config.lag) return ws.send(data);
    const delay = config.lag + (Math.random() * 2 - 1) * config.jitter;
    setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(data); }, Math.max(0, delay));
  };

  /** The room hands us either a message or a per-seat builder (snapshots carry your own ack). */
  const broadcast = msgOrFn => {
    for (const [seat, ws] of bySeat) {
      sendTo(ws, typeof msgOrFn === 'function' ? msgOrFn(seat) : msgOrFn);
    }
    // Spectators get the same stream, built for seat -1: the per-seat builder only varies the
    // `ack`, and a spectator has no inputs to acknowledge.
    for (const ws of watchers) {
      sendTo(ws, typeof msgOrFn === 'function' ? msgOrFn(-1) : msgOrFn);
    }
  };

  const room = createRoom({
    onBroadcast: broadcast,
    adminName: config.adminName,
    // The room decided this seat is gone. Close the socket too, or the client sits there happily
    // predicting into a seat that no longer exists.
    onKick: (seat, why) => {
      const ws = bySeat.get(seat);
      bySeat.delete(seat);
      if (ws) { sendTo(ws, { t: 'reject', why }); ws.close(4001, why); }
      console.log(`kick   seat ${seat} (${why})`);
    },
    maxPlayers: config.maxPlayers,
    leaderboard: config.leaderboard,
    minBots: config.minBots ?? 0,
  });
  room.start();

  // ─── chat commands ──────────────────────────────────────────────────────────

  const reply = (ws, msg) => sendTo(ws, { t: 'chat', i: -1, name: 'SERVER', msg });
  const announce = msg => broadcast({ t: 'chat', i: -1, name: 'SERVER', msg });

  const bans = createBans();

  /**
   * Throw someone out: free the seat, then tell their socket why.
   *
   * `reject` before `close` on purpose — it is what stops the client reconnecting straight back
   * in (see onclose in public/client/net.js, which honours `closedByUs`). The socket is marked so
   * its own close handler does not then hand the freed seat a reconnect grace period it no longer
   * has any claim to.
   */
  function kick(seat, why) {
    const ws = bySeat.get(seat);
    const info = room.kickSeat(seat);
    if (ws) {
      ws.bvKicked = true;
      bySeat.delete(seat);
      sendTo(ws, { t: 'reject', why });
      ws.close(4001, why);
    }
    return info;
  }

  const commands = createCommands({ room, config, reply, announce, kick, bans });

  /**
   * One connected player, whatever pipe they arrived down.
   *
   * Factored out of the WebSocket `connection` handler so a WebTransport session — wrapped in a
   * ws-shaped adapter by server/webtransport.js — runs this exact code. Nothing below this line
   * knows or cares which transport it is talking to, which is the only way a dual transport
   * stays honest: one protocol, one implementation, two pipes.
   */
  function handleSocket(ws, req) {
    // Set by verifyClient for WebSocket; WebTransport sessions arrive without one and are only
    // budgeted per socket.
    ws.bvIp = req?.bvIp ?? null;
    let seat = -1;
    let lastChat = 0;
    let lastCommand = 0;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // A playing client sends about 32 messages a second. Far past that is a flood, not a player.
    const budget = guard.messageBudget();

    ws.on('message', raw => {
      // Over budget: dropped, not fatal — a tab coming back from the background can burst. Only a
      // socket that KEEPS flooding, a thousand dropped in ten seconds, is closed.
      if (!budget()) {
        const t = Date.now();
        if (t - (ws.bvDropFrom || 0) > 10_000) { ws.bvDropFrom = t; ws.bvDropped = 0; }
        if (++ws.bvDropped > 1000 && !ws.bvFlooded) {
          ws.bvFlooded = true;
          console.warn(`flood  seat ${seat} closed for sending too fast`);
          ws.close(1008, 'too many messages');
        }
        return;
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;

      switch (msg.t) {
        case 'hello': {
          if (seat >= 0 || watchers.has(ws)) return;

          if (!claimDevice(ws, deviceOf(msg.device))) {
            sendTo(ws, { t: 'reject',
              why: `this browser already has ${MAX_SESSIONS_PER_DEVICE} sessions open — close one first` });
            ws.close(4003, 'too many sessions in this browser');
            return;
          }

          /* Spectating. Always allowed, even on a full server — that is the entire feature.
           *
           * It happens before the name and ban checks on purpose: a spectator occupies nothing,
           * says nothing and is not in the player list, so there is nothing for a ban to
           * protect and nothing for a name to collide with.
           */
          if (msg.observe) {
            watchers.add(ws);
            sendTo(ws, { ...room.welcomeFor(-1), you: -1, observing: true });
            console.log(`watch  (${watchers.size} watching, ${bySeat.size}/${config.maxPlayers} playing)`);
            break;
          }
          const playerId = typeof msg.playerId === 'string' && msg.playerId.length <= 64
            ? msg.playerId : `p_${randomUUID()}`;
          const name = sanitizeName(msg.name);

          const banned = bans.remainingMs(name);
          if (banned > 0) {
            return sendTo(ws, { t: 'reject', why: `banned, ${humanDuration(banned)} left` });
          }

          const res = room.join(playerId, name);
          if (res.seat < 0) {
            // `forget` tells the client its stored identity is the problem, so it can offer to
            // drop it rather than leaving somebody stuck on a screen that just says no.
            return sendTo(ws, res.why === 'already-playing'
              ? { t: 'reject', why: 'that name is already playing in another window', forget: true }
              : { t: 'reject', why: 'server is full' });
          }

          // Resuming a seat whose socket the server had not yet noticed was dead. Close the old
          // one rather than ending up with two on one seat.
          const previous = bySeat.get(res.seat);
          if (previous && previous !== ws) previous.close(4000, 'replaced by a newer connection');

          seat = res.seat;
          bySeat.set(seat, ws);
          // Return the id the ROOM settled on, not the one we were handed. A second tab arriving with
          // an id that is already in use is given a fresh one, and it has to learn about it or it
          // will come back claiming the same seat again.
          sendTo(ws, { ...room.welcomeFor(seat), playerId: res.playerId, resumed: res.resumed });
          if (res.displaced) announce(`${res.displaced} made way for ${name}`);
          broadcast({ t: 'chat', i: -1, name: 'SERVER',
            msg: `${name} ${res.resumed ? 'reconnected' : 'joined'}` });
          console.log(`${res.resumed ? 'resume' : 'join  '} seat ${seat} "${name}" (${bySeat.size}/${config.maxPlayers})`);
          break;
        }

        case 'input':
          if (seat < 0) return;
          room.input(seat, msg.tick | 0, msg.m | 0);
          break;

        case 'chat': {
          if (seat < 0) return;
          const now = Date.now();
          const text = String(msg.msg ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, CHAT_MAX_CHARS);
          if (!text) return;

          // Commands get their own, much shorter throttle. The one-second chat limit exists to
          // stop someone flooding the channel; applying it to /bots meant a second command typed
          // straight after the first silently vanished, which reads as a broken feature.
          if (text[0] === '/') {
            if (now - lastCommand < 250) return;
            lastCommand = now;
            commands.run(ws, seat, text);
            break;
          }

          if (now - lastChat < CHAT_MIN_INTERVAL_MS) return;
          lastChat = now;
          broadcast({ t: 'chat', i: seat, name: room.state.players[seat]?.name ?? '?', msg: text });
          break;
        }

        case 'respawn':
          if (seat >= 0) room.requestRespawn(seat);
          break;

        case 'ping':
          sendTo(ws, { t: 'pong', c: msg.c, tick: room.state.tick, s: Date.now() });
          break;

        // Unknown types are ignored on purpose — that is the forward-compatibility story.
      }
    });

    ws.on('close', () => {
      releaseDevice(ws);
      if (ws.bvIp) guard.closed(ws.bvIp);
      watchers.delete(ws);
      if (seat < 0) return;
      // Kicked sockets have already given the seat up, and it may have a new occupant by now.
      if (ws.bvKicked) return;
      watchers.delete(ws);
      if (bySeat.get(seat) === ws) bySeat.delete(seat);
      // The seat, the score and the position are held for a while; see RECONNECT_GRACE_TICKS.
      room.disconnect(seat);
      console.log(`leave  seat ${seat} (${bySeat.size}/${config.maxPlayers}) — seat reserved`);
    });

    ws.on('error', () => {});
  }

  wss.on('connection', handleSocket);

  // Sockets that did not come from `ws`. QUIC reports a dead path itself, but the heartbeat and
  // the shutdown path both need to see them.
  const extraSockets = new Set();
  const allSockets = () => [...wss.clients, ...extraSockets];

  // Drop sockets that stopped answering, and keep corporate proxies from closing an idle one.
  const heartbeat = setInterval(() => {
    for (const ws of allSockets()) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15_000);

  return {
    /**
     * Adopt a socket from another transport. It must present the parts of the ws API that
     * handleSocket uses: send, close, readyState/OPEN, ping, and message/close/error events.
     */
    attachSocket(ws) {
      extraSockets.add(ws);
      ws.once('close', () => extraSockets.delete(ws));
      handleSocket(ws);
    },
    get transportCounts() {
      let wt = 0;
      for (const ws of extraSockets) if (ws.readyState === 1) wt++;
      return { websocket: wss.clients.size, webtransport: wt };
    },
    broadcast,
    health: extra => ({ ok: true, maxPlayers: config.maxPlayers, lag: config.lag, ...room.stats(), ...extra }),
    /** Write the round in progress to the board. Called before shutdown closes anything. */
    bankScores: () => room.bankScores(),
    shutdown() {
      clearInterval(heartbeat);
      room.stop();
      for (const ws of allSockets()) ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
