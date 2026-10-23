// Socket, clock, and reconnect. See docs/NETCODE.md §2 — this is deliberately small.
//
// Resume rather than redundancy: if the socket drops we reconnect immediately and send the same
// playerId, and the server hands back the seat, score and position it was holding. A second
// parallel socket would share the same wifi, NAT and server, so it would die in the same breath.

import { PING_EVERY_MS, RTT_SAMPLES, CLOCK_SAFETY_MS, TICK_MS } from '/shared/constants.js';

export function createNet({ onWelcome, onSnap, onChat, onStatus }) {
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

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const rttMin = () => (rtts.length ? Math.min(...rtts) : 0);

  /** Where we think the server is right now. */
  function serverTickNow() {
    if (tickOffset === null) return clientTick;
    return performance.now() / TICK_MS + tickOffset;
  }

  /** Blend a fresh measurement in rather than jumping to it. */
  function observeServerTick(serverTick) {
    const implied = serverTick + (rttMin() / 2) / TICK_MS - performance.now() / TICK_MS;
    if (tickOffset === null || Math.abs(implied - tickOffset) > 25) tickOffset = implied;
    else tickOffset += (implied - tickOffset) * 0.15;
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
      backoff = 0;
      onStatus?.('open');
      ws.send(JSON.stringify(hello));
      ping();
    };

    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      switch (m.t) {
        case 'welcome':
          localStorage.setItem('bv.playerId', m.playerId);
          hello = { ...hello, playerId: m.playerId };
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
          }
          break;
        }
        case 'reject': onStatus?.(`rejected: ${m.why}`); closedByUs = true; break;
        case 'mapchange': onWelcome?.({ ...m, mapOnly: true }); break;
      }
    };

    ws.onclose = () => {
      onStatus?.('reconnecting');
      if (closedByUs) return;
      // First retry is immediate: most drops are a blip, and sub-second resume is invisible.
      const wait = backoff === 0 ? 150 : Math.min(8000, backoff * 2);
      backoff = wait;
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
      hello = { t: 'hello', name, playerId: localStorage.getItem('bv.playerId') || null };
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
