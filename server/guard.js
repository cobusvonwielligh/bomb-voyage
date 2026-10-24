// Flood protection. Not anti-cheat and not a firewall — one box, sixteen seats, and the aim is
// that nobody can knock the game over by accident or on purpose from a single address.
//
// Every limit is per remote address and generous on purpose, because an office is many people
// behind ONE address: sixteen colleagues, each with a tab or two, all arriving at 13:00 on a
// Friday, must never trip it. What it stops is the thing an office never does — hundreds of
// requests a second, or a pile of sockets, or a socket spraying messages.
//
// Token buckets throughout: a steady rate plus a burst allowance, so a page load (a dozen files
// at once) or a reconnect storm after a wifi blip passes, and a sustained flood does not.

const now = () => Date.now();

/** The peer address of an incoming request. No proxy sits in front of this server. */
export const addressOf = req => req?.socket?.remoteAddress ?? 'unknown';

function bucket(rate, burst) {
  return { tokens: burst, at: now(), rate, burst };
}

/** Take one token. False when the bucket is empty. */
function take(b) {
  const t = now();
  b.tokens = Math.min(b.burst, b.tokens + ((t - b.at) / 1000) * b.rate);
  b.at = t;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export const GUARD_DEFAULTS = Object.freeze({
  httpPerSec: 40, httpBurst: 200,          // a full page load is ~15 requests
  connectsPerMin: 90, connectBurst: 40,    // new sockets, per address
  socketsPerIp: 64,                        // open at once, per address: an office, not a botnet
  msgsPerSec: 120, msgBurst: 360,          // per socket: 60 inputs/s at 200% gamespeed, plus pings
});

export function createGuard(opts = {}) {
  const o = { ...GUARD_DEFAULTS, ...opts };
  const http = new Map();       // ip -> bucket
  const connects = new Map();   // ip -> bucket
  const open = new Map();       // ip -> count of open sockets

  // Forget idle addresses, or the maps are a slow leak of every address that ever visited.
  const sweep = setInterval(() => {
    const cutoff = now() - 120_000;
    for (const m of [http, connects]) for (const [ip, b] of m) if (b.at < cutoff) m.delete(ip);
  }, 60_000);
  sweep.unref();

  return {
    /** One HTTP request. False means answer 429. */
    allowRequest(ip) {
      let b = http.get(ip);
      if (!b) http.set(ip, b = bucket(o.httpPerSec, o.httpBurst));
      return take(b);
    },

    /** A new socket is asking to open. False means refuse it. Pair a true with `closed`. */
    allowConnect(ip) {
      if ((open.get(ip) || 0) >= o.socketsPerIp) return false;
      let b = connects.get(ip);
      if (!b) connects.set(ip, b = bucket(o.connectsPerMin / 60, o.connectBurst));
      if (!take(b)) return false;
      open.set(ip, (open.get(ip) || 0) + 1);
      return true;
    },

    /** A socket that `allowConnect` let in has gone. */
    closed(ip) {
      const n = (open.get(ip) || 0) - 1;
      if (n > 0) open.set(ip, n); else open.delete(ip);
    },

    /** A per-socket message budget. Call the returned function per message; false means flooding. */
    messageBudget() {
      const b = bucket(o.msgsPerSec, o.msgBurst);
      return () => take(b);
    },

    stop() { clearInterval(sweep); },
  };
}
