// Socket, clock, and reconnect. See docs/NETCODE.md §2 — this is deliberately small.
//
// Resume rather than redundancy: if the socket drops we reconnect immediately and send the same
// playerId, and the server hands back the seat, score and position it was holding. A second
// parallel socket would share the same wifi, NAT and server, so it would die in the same breath.

import { PING_EVERY_MS, RTT_SAMPLES, CLOCK_SAFETY_MS, TICK_MS } from '/shared/constants.js';

export function createNet({ onWelcome, onSnap, onChat, onStatus }) {
  let ws = null;
  let serverTickAtSample = 0, sampleAt = 0;
  let clientTick = 0;
  const rtts = [];
  const pending = new Map();
  let backoff = 0;
  let closedByUs = false;
  let hello = null;

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const rttMin = () => (rtts.length ? Math.min(...rtts) : 0);

  /** Where we think the server is right now. */
  function serverTickNow() {
    if (!sampleAt) return clientTick;
    return serverTickAtSample + (performance.now() - sampleAt) / TICK_MS;
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
          serverTickAtSample = m.tick; sampleAt = performance.now();
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
            serverTickAtSample = m.tick + rttMin() / 2 / TICK_MS;
            sampleAt = performance.now();
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
    get clientTick() { return clientTick; },
    get rtt() { return Math.round(rttMin()); },
    serverTickNow,

    /**
     * Converge on the target one tick at a time rather than jumping, so a jitter spike does not
     * teleport the local player. A gap this large means the tab was backgrounded, not that the
     * network got interesting — snap and move on.
     */
    advanceTick() {
      const want = targetTick();
      if (Math.abs(want - clientTick) > 20) clientTick = want;
      else if (want > clientTick) clientTick += 2;
      else if (want < clientTick) clientTick += 0;
      else clientTick += 1;
      return clientTick;
    },
  };
}
