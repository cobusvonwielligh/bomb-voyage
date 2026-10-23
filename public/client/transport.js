// One connection, two possible pipes.
//
// WebTransport runs on QUIC over UDP/443. The win is the absence of head-of-line blocking: over
// TCP a single lost packet stalls every byte queued behind it, so one drop delays the next three
// snapshots as well as the one it hit. Inputs and snapshots are continuously replaced — a lost
// one is superseded 33 ms later — so they want a channel that drops rather than waits.
//
// The catch is that corporate firewalls block UDP/443 far more often than TCP, and this game
// exists to be played in an office. So both are dialled at once and whichever answers first wins.
// Nobody behind a hostile firewall ever notices; everybody else gets QUIC. Falling back after a
// failure is not good enough: a firewall that silently drops UDP does not fail, it hangs, and a
// five-second hang on the join screen is indistinguishable from the game being broken.

import { encodeFrame, createFramer, pickChannel } from '/shared/wire.js';

/* How long WebTransport gets before WebSocket is taken instead.
 *
 * This is not a plain first-past-the-post race, and it took measuring to see why. A WebSocket
 * open fires as soon as TCP and TLS are up, which on a warm connection is quicker than a cold
 * QUIC handshake plus a stream — so pure "whoever answers first" meant the WebSocket won almost
 * every time and the QUIC path, once built, was never actually used by anybody.
 *
 * So WebSocket waits. When it connects first it is held as a provisional winner for PREFER_MS,
 * and if WebTransport lands inside that window it takes the connection instead. Measured from
 * an external network, a QUIC session to this server is ready in about 50 ms, so 350 ms is a
 * wide margin — and it only ever costs anything on a network where UDP is being dropped
 * silently, which is exactly the case that should pay rather than everybody else.
 *
 * RACE_MS is the outer backstop for when both are slow.
 */
const PREFER_MS = 350;
const RACE_MS = 1200;

const encoder = new TextEncoder();

/**
 * @param onMessage called with each decoded message object
 * @param onOpen    called once, with the name of the transport that won
 * @param onClose   called when the winning transport goes away
 */
export function createTransport({ onMessage, onOpen, onClose, onNote }) {
  let active = null;           // { kind, send, close }
  let settled = false;
  let preferTimer = null;
  const candidates = [];

  const clearPrefer = () => { if (preferTimer) { clearTimeout(preferTimer); preferTimer = null; } };

  /** A WebSocket that is up, but is waiting to see whether WebTransport turns up too. */
  const wtPending = () => candidates.some(c => c.kind === 'webtransport' && !c.dead);

  const win = t => {
    if (settled) { t.close(); return; }
    // The WebSocket defers to a WebTransport attempt that is still in flight. See PREFER_MS.
    if (t.kind === 'websocket' && wtPending() && !preferTimer) {
      preferTimer = setTimeout(() => {
        preferTimer = null;
        if (!settled && !t.dead) win(t);
      }, PREFER_MS);
      return;
    }
    clearPrefer();
    settled = true;
    active = t;
    for (const other of candidates) if (other !== t) other.close();
    candidates.length = 0;
    onOpen?.(t.kind);
  };

  const lose = (kind, why) => {
    onNote?.(`${kind} unavailable: ${why}`);
    if (settled) return;
    // WebTransport is out: stop making the WebSocket wait for it.
    if (kind === 'webtransport' && !wtPending()) {
      clearPrefer();
      const ws = candidates.find(c => c.kind === 'websocket' && !c.dead && c.ws?.readyState === 1);
      if (ws) { win(ws); return; }
    }
    // Only give up on the race once every candidate has failed.
    if (candidates.every(c => c.dead)) { settled = true; onClose?.(); }
  };

  // ─── WebSocket ──────────────────────────────────────────────────────────────

  function dialWebSocket(url) {
    const c = { kind: 'websocket', dead: false, ws: null };
    const ws = new WebSocket(url);
    c.ws = ws;
    c.send = data => { if (ws.readyState === 1) ws.send(data); };
    c.close = () => { c.dead = true; try { ws.close(); } catch { /* already closing */ } };

    ws.onopen = () => win(c);
    ws.onmessage = e => { if (active === c) onMessage(JSON.parse(e.data)); };
    ws.onerror = () => { c.dead = true; lose('websocket', 'error'); };
    ws.onclose = ev => {
      c.dead = true;
      // The close code has to travel: 4000 means the server gave our seat to a newer sign-in,
      // and a client that cannot tell that from a dropped connection will reconnect and take it
      // straight back.
      if (active === c) { active = null; onClose?.({ code: ev?.code, reason: ev?.reason }); }
      else lose('websocket', 'closed');
    };
    candidates.push(c);
  }

  // ─── WebTransport ───────────────────────────────────────────────────────────

  function dialWebTransport(url) {
    if (typeof WebTransport !== 'function') { onNote?.('webtransport not supported'); return; }
    const c = { kind: 'webtransport', dead: false };
    let writer = null, datagrams = null;
    let wt;
    try { wt = new WebTransport(url); } catch (err) { onNote?.(`webtransport: ${err.message}`); return; }

    c.send = data => {
      if (c.dead) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      const bytes = encoder.encode(data);
      if (datagrams && pickChannel(msg, bytes.length) === 'datagram') {
        // Fire and forget: a datagram that cannot be written now is one the network was going to
        // drop anyway, and the next tick supersedes it.
        datagrams.write(bytes).catch(() => {});
        return;
      }
      writer?.write(encoder.encode(encodeFrame(msg))).catch(() => {});
    };
    c.close = () => { c.dead = true; try { wt.close(); } catch { /* already closing */ } };
    candidates.push(c);

    (async () => {
      await wt.ready;
      // One bidirectional stream carries everything that must arrive in order. Opening it is the
      // handshake as far as the server is concerned, so it happens before we claim the race.
      const stream = await wt.createBidirectionalStream();
      writer = stream.writable.getWriter();
      try { datagrams = wt.datagrams.writable.getWriter(); } catch { datagrams = null; }

      const push = createFramer(m => { if (active === c) onMessage(m); });
      (async () => {
        const r = stream.readable.getReader();
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          push(value);
        }
      })().catch(() => {});

      (async () => {
        const r = wt.datagrams.readable.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          if (active !== c) continue;
          try { onMessage(JSON.parse(dec.decode(value))); } catch { /* truncated: next one covers it */ }
        }
      })().catch(() => {});

      const ended = info => {
        c.dead = true;
        if (active === c) { active = null; onClose?.({ code: info?.closeCode, reason: info?.reason }); }
      };
      wt.closed.then(ended).catch(ended);

      win(c);
    })().catch(err => { c.dead = true; lose('webtransport', err.message || 'failed'); });
  }

  return {
    get kind() { return active?.kind ?? null; },
    get open() { return !!active; },

    connect({ ws: wsUrl, wt: wtUrl }) {
      settled = false;
      active = null;
      candidates.length = 0;
      // Both at once. Sequential dialling would mean waiting out a firewall that drops UDP
      // silently, and silence has no timeout of its own.
      if (wtUrl) dialWebTransport(wtUrl);
      dialWebSocket(wsUrl);
      // If WebTransport is still thinking after the race window, stop waiting for it. The
      // WebSocket has almost certainly already won by here; this only matters when both are slow.
      setTimeout(() => {
        if (settled) return;
        const ws = candidates.find(c => c.kind === 'websocket' && !c.dead);
        if (ws?.ws?.readyState === 1) win(ws);
      }, RACE_MS);
    },

    send(obj) { active?.send(JSON.stringify(obj)); },

    close() {
      clearPrefer();
      settled = true;
      for (const c of candidates) c.close();
      active?.close();
      active = null;
      candidates.length = 0;
    },
  };
}
