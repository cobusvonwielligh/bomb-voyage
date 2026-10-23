// Socket, clock, and reconnect. See docs/NETCODE.md §2 — this is deliberately small.
//
// Resume rather than redundancy: if the socket drops we reconnect immediately and send the same
// playerId, and the server hands back the seat, score and position it was holding. A second
// parallel socket would share the same wifi, NAT and server, so it would die in the same breath.

import { PING_EVERY_MS, RTT_SAMPLES, CLOCK_SAFETY_MS, TICK_MS } from '/shared/constants.js';

export function createNet({ onWelcome, onSnap, onChat, onStatus, onRoundEnd, onScores, onStreak }) {
  let ws = null;
  // serverTick ≈ performance.now()/TICK_MS + tickOffset. Keeping an offset rather than a
  // timestamped sample means the estimate is continuous: a new ping nudges it instead of
  // restarting it, which is the difference between smooth remote players and a hitch every
  // two seconds.
  let tickOffset = null;
  let clientTick = 0;
  const rtts = [];
  const pending = new Map();
  let backoff = 0;
  let closedByUs = false;
  let hello = null;
  let sinceCorrection = 0;
  let connectedAt = 0;

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const rttMin = () => (rtts.length ? Math.min(...rtts) : 0);

  /** Where we think the server is right now. */
  function serverTickNow() {
    if (tickOffset === null) return clientTick;
    return performance.now() / TICK_MS + tickOffset;
  }

  /**
   * Blend a fresh measurement in rather than jumping to it.
   *
   * Except while `rtts` is still empty or nearly so. The `welcome` that seeds the clock arrives
   * before any pong, so `rttMin()` is 0 and the estimate omits the travel correction twice —
   * leaving a lead of `2.5 - travel` ticks instead of `travel + 2.5`. Above about 83 ms of RTT
   * that lead is negative, every input packet lands after the server already simulated that tick,
   * and `room.input` drops it silently: several seconds of rubber-banding in place on every join.
   * Blending from a known-wrong seed takes five pings to crawl out of, so do not blend yet.
   */
  function observeServerTick(serverTick) {
    const implied = serverTick + (rttMin() / 2) / TICK_MS - performance.now() / TICK_MS;
    if (tickOffset === null || rtts.length < 2 || Math.abs(implied - tickOffset) > 25) {
      tickOffset = implied;
    } else {
      tickOffset += (implied - tickOffset) * 0.15;
    }
  }

  /** Run far enough ahead that this tick's input lands before the server simulates it. */
  function targetTick() {
    return Math.ceil(serverTickNow() + (rttMin() / 2 + CLOCK_SAFETY_MS) / TICK_MS) + 1;
  }

  function open() {
    closedByUs = false;
    onStatus?.('connecting');
    ws = new WebSocket(url);

    ws.onopen = () => {
      onStatus?.('open');
      ws.send(JSON.stringify(hello));
      ping();
    };

    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      switch (m.t) {
        case 'welcome':
          // sessionStorage, not localStorage: the resume token identifies a TAB, not a browser.
          // localStorage is shared across tabs, so two tabs both claimed the same seat, each
          // hello evicted the other, and the pair flapped forever. It survives a reload, which
          // is the case resume actually exists for.
          // Guarded: a welcome with no id (a round restart used to send one) must not overwrite
          // a good token with the string "undefined", which the server then accepts as a real id.
          if (m.playerId) {
            sessionStorage.setItem('bv.playerId', m.playerId);
            hello = { ...hello, playerId: m.playerId };
          }
          connectedAt = performance.now();
          observeServerTick(m.tick);
          clientTick = targetTick();
          onWelcome?.(m);
          break;
        case 'snap': onSnap?.(m); break;
        case 'chat': onChat?.(m); break;
        case 'pong': {
          const sent = pending.get(m.c);
          if (sent !== undefined) {
            pending.delete(m.c);
            rtts.push(performance.now() - sent);
            if (rtts.length > RTT_SAMPLES) rtts.shift();
            // Rolling minimum, not an average: one jitter spike should not shove the clock.
            observeServerTick(m.tick);
            // The very first real RTT sample: re-seed the lead, which until now was computed as
            // if the connection were instant. Safe because this fires microseconds after
            // `welcome`, long before prediction has produced anything worth keeping.
            if (rtts.length === 1) clientTick = targetTick();
          }
          break;
        }
        case 'reject': onStatus?.(`rejected: ${m.why}`); closedByUs = true; break;
        case 'mapchange': onWelcome?.({ ...m, mapOnly: true }); break;
        case 'roundend': onRoundEnd?.(m); break;
        case 'scores': onScores?.(m); break;
        case 'streak': onStreak?.(m); break;
      }
    };

    ws.onclose = ev => {
      if (closedByUs) return;
      // Reset the backoff only after a connection that actually lasted. Resetting it in onopen
      // means a connection that opens and immediately dies never backs off at all, which turns
      // any repeating problem into a reconnect storm.
      if (connectedAt && performance.now() - connectedAt > 3000) backoff = 0;
      connectedAt = 0;
      const wait = backoff === 0 ? 150 : Math.min(8000, backoff * 2);
      backoff = wait;
      onStatus?.(`reconnecting in ${(wait / 1000).toFixed(1)}s`);
      if (ev?.code === 4000) console.warn('replaced by another connection:', ev.reason);
      setTimeout(open, wait);
    };

    ws.onerror = () => {};
  }

  function ping() {
    if (!ws || ws.readyState !== 1) return;
    const c = Date.now();
    pending.set(c, performance.now());
    ws.send(JSON.stringify({ t: 'ping', c }));
    if (pending.size > 8) pending.delete(pending.keys().next().value);
  }
  setInterval(ping, PING_EVERY_MS);

  return {
    connect(name) {
      hello = { t: 'hello', name, playerId: sessionStorage.getItem('bv.playerId') || null };
      open();
    },
    send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },

    /** Leave on purpose. Must suppress the reconnect, or we would immediately rejoin. */
    close() {
      closedByUs = true;
      ws?.close();
      ws = null;
    },
    get clientTick() { return clientTick; },
    get rtt() { return Math.round(rttMin()); },
    serverTickNow,

    /**
     * The frame loop deliberately discarded wall-clock time — a clamped `dt` after an alt-tab, or
     * a dumped accumulator after a stall. The clock has to jump with it.
     *
     * Without this, `clientTick` sits permanently N ticks behind real time with N between 3 and
     * 25: too small for advanceTick's hard resync, and corrected at one tick per second. Every
     * input in the meantime lands in the server's past and is dropped, so a half-second hitch
     * costs about ten seconds of being unable to move.
     */
    resync() { clientTick = targetTick(); sinceCorrection = 0; },

    /**
     * Exactly one tick per simulated step. Always.
     *
     * The obvious implementation — step twice when behind, skip when ahead — is a trap: the
     * clock correction lands on the *simulation*, so every small drift correction becomes a
     * visible jump or stall in your own movement. Instead the step count is sacred, and drift
     * is corrected rarely and by one tick at a time, which is imperceptible.
     */
    advanceTick() {
      clientTick++;
      if (++sinceCorrection >= 30) {           // about once a second
        sinceCorrection = 0;
        const drift = targetTick() - clientTick;
        if (Math.abs(drift) > 25) clientTick += drift;    // backgrounded tab: just resync
        else if (drift > 2) clientTick += 1;
        else if (drift < -2) clientTick -= 1;
      }
      return clientTick;
    },
  };
}
