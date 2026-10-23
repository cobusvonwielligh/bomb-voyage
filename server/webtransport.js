// WebTransport over HTTP/3, on UDP/443, alongside the WebSocket server on TCP/443.
//
// It is additive on purpose. UDP/443 is blocked by corporate firewalls far more often than TCP
// is, so WebTransport can never be the only way in — the client races both and uses whichever
// connects. Behind a hostile firewall nobody notices; everywhere else you get QUIC.
//
// What QUIC actually buys here is the absence of head-of-line blocking. Over TCP a single lost
// packet stalls every byte behind it, so one drop delays the next three snapshots as well as the
// one it hit. Inputs and snapshots are continuously replaced — a lost one is superseded 33 ms
// later — so they want a channel that drops rather than waits. That is what datagrams are.
//
// Each session is wrapped in a `ws`-shaped adapter so server/net.js never learns which transport
// a player arrived on.

import { EventEmitter } from 'node:events';
import { encodeFrame, createFramer, pickChannel } from '../shared/wire.js';

const encoder = new TextEncoder();

/**
 * One WebTransport session, pretending to be a `ws` WebSocket.
 *
 * Implements only the surface server/net.js actually uses: send, close, readyState, ping, and
 * 'message' / 'close' / 'error' / 'pong' events. Anything beyond that is deliberately absent, so
 * a future use of some other ws API fails loudly here rather than behaving subtly differently
 * for half the players.
 */
class SessionSocket extends EventEmitter {
  constructor(session, writer) {
    super();
    this.session = session;
    this.writer = writer;
    this.readyState = 1;        // ws.OPEN
    this.OPEN = 1;
    this.isAlive = true;
    this.transport = 'webtransport';
    this.datagramWriter = null;
    this.stats = { datagrams: 0, streamed: 0, tooBig: 0 };
  }

  send(data) {
    if (this.readyState !== 1) return;
    let msg;
    try { msg = JSON.parse(data); } catch { msg = { t: '' }; }
    const bytes = encoder.encode(data);

    if (pickChannel(msg, bytes.length) === 'datagram' && this.datagramWriter) {
      this.stats.datagrams++;
      // Fire and forget. A datagram that cannot be written right now is one the network was
      // going to drop anyway, and the next tick supersedes it — queueing would add latency to
      // fix a problem that solves itself.
      this.datagramWriter.write(bytes).catch(() => {});
      return;
    }
    if (msg.t && pickChannel(msg, bytes.length) === 'stream' && bytes.length > 1100) {
      this.stats.tooBig++;
    }
    this.stats.streamed++;
    this.writer.write(encoder.encode(encodeFrame(msg))).catch(() => this._gone());
  }

  /** QUIC has its own keepalive and reports a dead path itself, so this only has to not throw. */
  ping() { this.isAlive = true; this.emit('pong'); }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { this.session.close({ closeCode: code ?? 1000, reason: String(reason ?? '') }); } catch { /* already gone */ }
    this.emit('close');
  }

  terminate() { this.close(1006, 'terminated'); }

  _gone() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

/**
 * Start the HTTP/3 listener and hand every session to `onSocket` as a ws-shaped object.
 *
 * Returns null — never throws — when WebTransport cannot start: a missing native binary for this
 * platform, a port already taken, a kernel that will not give us UDP. The game must survive all
 * of those by simply being WebSocket-only, because that is the configuration most players behind
 * a corporate firewall will be in regardless.
 */
export async function startWebTransport({ port, cert, privKey, path = '/wt', onSocket, log = console }) {
  let Http3Server, quicheLoaded;
  try {
    ({ Http3Server, quicheLoaded } = await import('@fails-components/webtransport'));
    await quicheLoaded;
  } catch (err) {
    log.warn?.(`webtransport: unavailable, WebSocket only (${err.message})`);
    return null;
  }

  let server, sessions;
  try {
    // IPv4 any-address. Binding '::' relies on dual-stack being enabled, which is a per-kernel
    // setting, and when it is not the listener silently answers nothing on IPv4 — which is every
    // player.
    server = new Http3Server({ port, host: '0.0.0.0', secret: 'bomb-voyage', cert, privKey });
    // The session reader has to exist before any client arrives: sessions that show up with
    // nobody reading the stream are dropped, and it looks exactly like a failed handshake.
    sessions = server.sessionStream(path).getReader();
    server.startServer();
    await server.ready;
  } catch (err) {
    log.warn?.(`webtransport: could not listen on udp/${port}, WebSocket only (${err.message})`);
    return null;
  }

  let open = 0;

  (async () => {
    for (;;) {
      const { done, value: session } = await sessions.read();
      if (done) break;
      accept(session).catch(err => log.warn?.(`webtransport: session failed (${err.message})`));
    }
  })().catch(err => log.warn?.(`webtransport: session loop ended (${err.message})`));

  async function accept(session) {
    await session.ready;

    // One bidirectional stream carries everything that must arrive in order. The client opens
    // it immediately after connecting, so waiting for it is the handshake.
    const streams = session.incomingBidirectionalStreams.getReader();
    const { value: stream } = await streams.read();
    if (!stream) { session.close(); return; }

    const socket = new SessionSocket(session, stream.writable.getWriter());
    open++;

    try { socket.datagramWriter = session.datagrams.writable.getWriter(); }
    catch { /* no datagram support: everything falls back to the stream, which still works */ }

    const push = createFramer(msg => socket.emit('message', JSON.stringify(msg)));

    // Reliable half.
    (async () => {
      const r = stream.readable.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        push(value);
      }
    })().catch(() => {}).finally(() => socket._gone());

    // Unreliable half. One datagram is exactly one message — no framing needed.
    (async () => {
      const r = session.datagrams.readable.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        socket.emit('message', Buffer.from(value).toString('utf8'));
      }
    })().catch(() => {});

    session.closed.then(() => socket._gone()).catch(() => socket._gone());
    socket.once('close', () => { open--; });

    onSocket(socket);
  }

  log.log?.(`webtransport listening on udp/${port}${path}`);
  return {
    get open() { return open; },
    async stop() { try { await server.stopServer(); } catch { /* already down */ } },
  };
}
