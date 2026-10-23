// Framing, shared by both transports.
//
// A WebSocket is message-oriented and needs none of this. A WebTransport stream is a raw byte
// stream, so anything sent over one has to carry its own boundaries — and getting that wrong
// produces a protocol that works perfectly until the day two messages land in one TCP read.
//
// Newline-delimited JSON, because `JSON.stringify` never emits a raw newline: every control
// character inside a string is escaped, and the structural whitespace it produces is none. So a
// 0x0A byte in the stream is unambiguously a record boundary, with no escaping layer needed.

/** Longest payload that may travel as a datagram. See pickChannel. */
export const DATAGRAM_SAFE_BYTES = 1100;

const NEWLINE = 10;

export const encodeFrame = obj => `${JSON.stringify(obj)}\n`;

/**
 * Pulls whole records out of a growing buffer.
 *
 * Returns a push function: feed it each chunk as it arrives, and it calls `onMessage` once per
 * complete record. Partial records are held until the rest turns up.
 */
export function createFramer(onMessage, { maxBytes = 1 << 20 } = {}) {
  let buf = new Uint8Array(0);
  const decoder = new TextDecoder();

  return function push(chunk) {
    if (!chunk || !chunk.length) return;
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0);
    merged.set(chunk, buf.length);
    buf = merged;

    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== NEWLINE) continue;
      const text = decoder.decode(buf.subarray(start, i));
      start = i + 1;
      if (!text) continue;
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }   // garbage: skip the record, keep the stream
      onMessage(msg);
    }
    buf = buf.subarray(start);

    // A peer that never sends a newline would otherwise grow this without bound.
    if (buf.length > maxBytes) buf = new Uint8Array(0);
  };
}

/**
 * Which channel a message belongs on.
 *
 * Datagrams are unreliable and unordered, which is exactly right for state that is continuously
 * replaced and wrong for anything else:
 *
 *   - `input`  a lost one is covered by the next tick's, and the server repeats the last mask
 *   - `snap`   a lost one is covered by the next, 66 ms later
 *   - `ping`   a lost one is covered by the next, 2 s later
 *
 * Everything else — the handshake, chat, round transitions — has to arrive and has to arrive in
 * order, so it goes on the reliable stream. This split IS the reason to use WebTransport at all;
 * sending everything reliably would be a WebSocket with extra steps.
 *
 * Size matters because an oversized datagram is dropped silently by the stack rather than
 * rejected, which would turn a full server into an intermittently invisible one.
 */
const HOT = new Set(['input', 'snap', 'ping', 'pong']);

export function pickChannel(msg, byteLength) {
  if (!HOT.has(msg.t)) return 'stream';
  return byteLength <= DATAGRAM_SAFE_BYTES ? 'datagram' : 'stream';
}
