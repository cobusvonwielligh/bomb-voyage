// WebSocket hub: sockets in, room out. The simulation lives in room.js.
// Protocol: docs/PROTOCOL.md.

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  MAX_MESSAGE_BYTES, NAME_MAX_CHARS, CHAT_MAX_CHARS, CHAT_MIN_INTERVAL_MS,
  BAN_MAX_HOURS, GAMESPEED_MIN, GAMESPEED_MAX, ROUNDTIME_MIN_MIN, ROUNDTIME_MAX_MIN, TICK_HZ,
} from '../shared/constants.js';
import { createRoom } from './room.js';
import { createGuard, addressOf } from './guard.js';
import { sameSecret } from './config.js';

// Open sessions — playing or watching — one browser may hold at once. See claimDevice.
export const MAX_SESSIONS_PER_DEVICE = 2;

/* Wire values are coerced by type, never by `String()` or `| 0`: both call the object's own
 * toString/valueOf, and `{"toString":1,"valueOf":1}` off the wire makes either one throw. */
const text = raw => (typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '');
const int = raw => (typeof raw === 'number' ? raw | 0 : 0);

/** Strip control characters, trim, cap length. Names are rendered with textContent, never HTML. */
export const sanitizeName = raw =>
  text(raw)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, NAME_MAX_CHARS) || 'anon';

/** A sanitised name that cannot pass for the server's own announcements in chat. */
export const playerName = raw => {
  const name = sanitizeName(raw);
  return name.toLowerCase() === 'server' ? 'anon' : name;
};

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
export function createCommands({ room, config, reply, announce, kick, signOut, bans }) {
  /* Two tiers, and the line between them is "can this ruin somebody else's round".
   *
   * HOST things are safe to hand to whoever happens to be in charge: adding bots, and throwing a
   * bot out again. A room with nobody in it who can top the bots up is a worse room, and the
   * worst a mistake there can do is change who you are playing against.
   *
   * OWNER things are not. Restarting the round throws away everybody's score, godmode makes one
   * player unkillable, /gamespeed and /roundtime change the rules under sixteen people, /map
   * replaces the board mid-fight, and /kick NAME can ban a person for hours. Those belong to the
   * one account that owns the server — the admin key, or `adminName` where no key is configured
   * — and emphatically NOT to "the longest-standing player", which is what `hostSeat` falls back
   * to and which is simply whoever joined first.
   *
   * They are also not advertised. `PUBLIC` is what everybody sees from /help, and it does not
   * mention them: a command somebody cannot use is noise, and a command nobody knows about is
   * not one they will spend the evening trying.
   */
  const PUBLIC = `commands: /bots N (0-${config.maxPlayers - 1}) · /kick bot N · /who · /logout · /help`;
  const OWNER = 'owner: /restart · /godmode · /kick NAME [hours] · ' +
    `/map 0-${room.maps().length - 1} · /gamespeed ${GAMESPEED_MIN}-${GAMESPEED_MAX} · ` +
    `/roundtime ${ROUNDTIME_MIN_MIN}-${ROUNDTIME_MAX_MIN}`;

  // Host privileges: the named admin when they are here, the longest-standing player otherwise.
  // Only /bots and /kick bot are gated on this.
  const isHost = seat => seat >= 0 && seat === room.hostSeat();
  // The real thing. Everything that can spoil a round in progress is gated on this.
  const isOwner = seat => seat >= 0 && room.isAdminSeat(seat);

  /* One answer for "you may not", and it is the same answer as for a command that does not
   * exist.
   *
   * Deliberate: "not for you" confirms that the command is real and that somebody else can use
   * it, which is an invitation to keep trying. An unknown-command reply tells a stranger nothing
   * they did not already know, and tells the owner nothing they need — they can always use it.
   */
  const deny = ws => reply(ws, `unknown command. ${PUBLIC}`);

  const nameOf = seat => room.state.players[seat]?.name ?? '?';

  /** `/kick bot N` · `/kick NAME` · `/kick NAME HOURS` */
  /** @param owner whether this seat may kick PEOPLE. A bot is anybody's to remove. */
  function kickCommand(ws, seat, args, owner) {
    if (!args.length) return reply(ws, owner ? 'usage: /kick bot N | /kick NAME [hours]' : 'usage: /kick bot N');

    if (args[0].toLowerCase() === 'bot') {
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 0 || n >= config.maxPlayers) {
        return reply(ws, `usage: /kick bot <1-${config.maxPlayers - 1}>`);
      }
      if (!room.isBot(n)) return reply(ws, `seat ${n} is not a bot`);
      const info = room.kickSeat(n);
      return announce(`${nameOf(seat)} kicked ${info.name}`);
    }

    // Past here it is a person. Not for the host, and not even acknowledged as possible.
    if (!owner) return deny(ws);

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
    const owner = isOwner(seat);

    switch (cmd.toLowerCase()) {
      case 'help':
        return reply(ws, owner ? `${PUBLIC} · ${OWNER}` : PUBLIC);

      case 'bots': {
        if (!args.length) return reply(ws, `${room.botCount()} bots. /bots N to change.`);
        const n = Number(args[0]);
        if (!Number.isFinite(n)) return reply(ws, 'usage: /bots N');
        const got = room.setBots(n, { byHand: true });
        return announce(`${nameOf(seat)} set bots to ${got}`);
      }

      case 'logout':
      case 'signout': {
        const who = nameOf(seat);
        signOut(ws, seat);
        return announce(`${who} signed out`);
      }

      case 'who':
        return reply(ws, room.state.players.filter(Boolean)
          .map(p => `${p.name}${p.god ? '*' : ''}`).join(', ') || 'nobody');

      /* ── the owner's own ──
       *
       * Every one of these refuses with `deny`, which is the unknown-command reply. See the note
       * on it: "not for you" is an advertisement.
       */
      case 'restart':
        if (!owner) return deny(ws);
        announce('round restarted');
        return room.restartRound();

      case 'godmode': {
        if (!owner) return deny(ws);
        const on = room.toggleGod(seat);
        return reply(ws, `godmode ${on ? 'on' : 'off'}`);
      }

      // The one split command: a bot is anybody's to remove, a person is not. See kickCommand.
      case 'kick':
        return kickCommand(ws, seat, args, owner);

      case 'map': {
        if (!owner) return deny(ws);
        const id = args.length ? room.setMap(Number(args[0])) : null;
        if (!id) return reply(ws, `usage: /map <0-${room.maps().length - 1}>`);
        return announce(`${nameOf(seat)} switched the map to ${id}`);
      }

      case 'gamespeed': {
        if (!owner) return deny(ws);
        if (!args.length) return reply(ws, `game speed is ${room.gamespeed()}%`);
        const pct = room.setGameSpeed(args[0]);
        if (pct === null) {
          return reply(ws, `usage: /gamespeed <${GAMESPEED_MIN}-${GAMESPEED_MAX}>`);
        }
        return announce(`${nameOf(seat)} set game speed to ${pct}%`);
      }

      case 'roundtime': {
        if (!owner) return deny(ws);
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

  return Object.freeze({ run, isHost, isOwner });
}

export function attachHub(server, config) {
  const guard = config.guard ?? createGuard();
  /* The password store, or null.
   *
   * Null is a supported configuration and the tests run in it: without an accounts store the
   * hello path is exactly what it was before passwords existed, so every test that opens a room
   * and joins it stays a test about rooms rather than about authentication. See `authorise`.
   */
  const accounts = config.accounts ?? null;
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
    // With a key configured the name grants nothing: see `adminKey` in server/config.js.
    adminName: config.adminKey ? '' : config.adminName,
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
    // Seconds on the wire, ticks in the room. See `countIn` in server/config.js.
    ...(config.countIn === undefined ? null : { countIn: Math.round(config.countIn * TICK_HZ) }),
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

  /**
   * Give a seat up for good, at the player's own request.
   *
   * The client is told to forget its stored id BEFORE the seat goes, or the close races the
   * message and it reconnects straight back into the identity it just gave up. Marked like a
   * kick, so the close handler does not put a seat that may already be someone else's on hold.
   */
  function signOut(ws, seat) {
    sendTo(ws, { t: 'reject', why: 'signed out', forget: true });
    room.logout(seat);
    ws.bvKicked = true;
    bySeat.delete(seat);
    ws.close(4002, 'signed out');
  }

  const commands = createCommands({ room, config, reply, announce, kick, signOut, bans });

  /**
   * One connected player, whatever pipe they arrived down.
   *
   * Factored out of the WebSocket `connection` handler so a WebTransport session — wrapped in a
   * ws-shaped adapter by server/webtransport.js — runs this exact code. Nothing below this line
   * knows or cares which transport it is talking to, which is the only way a dual transport
   * stays honest: one protocol, one implementation, two pipes.
   */
  function handleSocket(ws, req) {
    // Set by verifyClient for WebSocket and by attachSocket for WebTransport; `guard.closed` gives
    // the address its slot back when the socket goes.
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
      // One player's message going wrong is logged, not thrown: an uncaught exception ends the
      // process, and with it everybody's round. /logout once did exactly that.
      try { onMessage(msg); } catch (err) {
        console.error(`message ${msg.t} from seat ${seat} failed`, err);
      }
    });

    function onMessage(msg) {
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
          const name = playerName(msg.name);

          const banned = bans.remainingMs(name);
          if (banned > 0) {
            return sendTo(ws, { t: 'reject', why: `banned, ${humanDuration(banned)} left` });
          }

          /* The name's owner has to be the one claiming it.
           *
           * Everything about this is in `authorise` below; what matters here is that it may need
           * to hash a password, which takes about a tenth of a second — so this path became
           * asynchronous, and the `seat >= 0` guard at the top of the case is no longer enough on
           * its own. `ws.bvAuthing` closes that window: two hellos arriving back to back would
           * otherwise both get past the guard and claim two seats for one socket.
           */
          if (accounts) {
            if (ws.bvAuthing) return;
            ws.bvAuthing = true;
            authorise(ws, name, msg)
              .then(auth => {
                ws.bvAuthing = false;
                if (!auth.ok) return sendTo(ws, { t: 'reject', ...auth.reject });
                // The socket may have gone while we were hashing, or a second hello may have
                // seated it. Either way there is nothing left to do here.
                if (ws.readyState !== ws.OPEN || seat >= 0) return;
                seatPlayer(msg, name, playerId, auth.trust);
              })
              .catch(err => {
                ws.bvAuthing = false;
                // Never leak the reason: it is either a disk problem or a bug, and in both cases
                // the useful thing for the player is "try again", not a stack trace.
                console.error('auth failed', err.message);
                sendTo(ws, { t: 'reject', why: 'could not check that password — try again' });
              });
            return;
          }
          seatPlayer(msg, name, playerId, null);
          break;
        }

        case 'input':
          if (seat < 0) return;
          room.input(seat, int(msg.tick), int(msg.m));
          break;

        case 'chat': {
          if (seat < 0) return;
          const now = Date.now();
          const said = text(msg.msg).replace(/[\x00-\x1f\x7f]/g, '').slice(0, CHAT_MAX_CHARS);
          if (!said) return;

          // Commands get their own, much shorter throttle. The one-second chat limit exists to
          // stop someone flooding the channel; applying it to /bots meant a second command typed
          // straight after the first silently vanished, which reads as a broken feature.
          if (said[0] === '/') {
            if (now - lastCommand < 250) return;
            lastCommand = now;
            commands.run(ws, seat, said);
            break;
          }

          if (now - lastChat < CHAT_MIN_INTERVAL_MS) return;
          lastChat = now;
          broadcast({ t: 'chat', i: seat, name: room.state.players[seat]?.name ?? '?', msg: said });
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
    }

    /**
     * Take the seat and say hello back.
     *
     * Split out of the `hello` case because authentication made that path asynchronous, and this
     * is the part that has to run identically whether a password was involved or not.
     *
     * @param trust a device token to hand this browser, or null to leave what it has alone. It
     *   travels in the welcome, is written to localStorage, and is the reason the password box
     *   does not appear again on this machine.
     */
    function seatPlayer(msg, name, playerId, trust) {
      const res = room.join(playerId, name, { admin: sameSecret(msg.adminKey, config.adminKey) });
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
      sendTo(ws, {
        ...room.welcomeFor(seat), playerId: res.playerId, resumed: res.resumed,
        ...(trust ? { trust } : null),
      });
      if (res.displaced) announce(`${res.displaced} made way for ${name}`);
      broadcast({ t: 'chat', i: -1, name: 'SERVER',
        msg: `${name} ${res.resumed ? 'reconnected' : 'joined'}` });
      console.log(`${res.resumed ? 'resume' : 'join  '} seat ${seat} "${name}" (${bySeat.size}/${config.maxPlayers})`);
    }

    /**
     * May this socket play as this name?
     *
     * The whole password design lives in the order of these four questions:
     *
     *   1. **Does this browser already hold a token for the name?** Then nothing is asked. This is
     *      the answer almost every time anybody ever joins, and it costs one sha256.
     *   2. **Is the name unclaimed?** Then this is a sign-up: a password is required, and once it
     *      is set the name belongs to whoever set it. No password in the hello means "ask me" —
     *      the client shows the box and sends the hello again.
     *   3. **Is a password supplied for a claimed name?** Verify it. Right: in, with a token for
     *      this browser. Wrong: refused, and after a few of those the name stops answering for a
     *      while (see FAIL_LIMIT in accounts.js).
     *   4. **Neither?** A known name from an unknown browser. Ask for the password.
     *
     * Spectators never reach here — see the `observe` branch in `hello`. That is deliberate: a
     * watcher holds no seat, cannot chat and is not in the standings, so there is no identity to
     * protect, and it leaves one way into the server that a forgotten password cannot block.
     *
     * The returned object carries either `{ ok: true, trust }` or `{ ok: false, reject }`, and
     * `reject` is a message the client can act on: `need` opens the password box, `signup` opens
     * it in "choose one" mode, `bad` reopens it with the error.
     */
    async function authorise(socket, name, msg) {
      const pw = typeof msg.pw === 'string' ? msg.pw : null;
      const token = typeof msg.trust === 'string' ? msg.trust : null;

      if (token && accounts.checkDevice(name, token)) return { ok: true, trust: null };

      if (!accounts.has(name)) {
        if (!pw) {
          return { ok: false, reject: { why: `pick a password for "${name}"`, auth: 'signup' } };
        }
        const made = await accounts.register(name, pw);
        if (!made.ok) return { ok: false, reject: { why: made.why, auth: 'signup' } };
        console.log(`signup "${name}"`);           // the name only. Never the password, ever.
        return { ok: true, trust: made.token };
      }

      if (!pw) return { ok: false, reject: { why: `"${name}" needs its password`, auth: 'need' } };

      const waitMs = accounts.lockedFor(name);
      if (waitMs) {
        return { ok: false,
          reject: { why: `too many tries — wait ${humanDuration(waitMs)}`, auth: 'wait' } };
      }
      const check = await accounts.verify(name, pw);
      if (!check.ok) {
        console.warn(`auth   wrong password for "${name}" from ${socket.bvIp ?? '?'}`);
        return { ok: false, reject: { why: check.why, auth: 'bad' } };
      }
      return { ok: true, trust: check.token };
    }

    ws.on('close', () => {
      releaseDevice(ws);
      if (ws.bvIp) guard.closed(ws.bvIp);
      watchers.delete(ws);
      if (seat < 0) return;
      // Kicked sockets have already given the seat up, and it may have a new occupant by now.
      if (ws.bvKicked) return;
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
     * `ip` is the peer address, held to the same per-address limits as a WebSocket.
     */
    attachSocket(ws, ip = null) {
      if (ip && !guard.allowConnect(ip)) { ws.close(1008, 'too many connections'); return; }
      extraSockets.add(ws);
      ws.once('close', () => extraSockets.delete(ws));
      handleSocket(ws, { bvIp: ip });
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
