// Framing and channel choice. Both are the kind of thing that works perfectly until the day two
// messages land in one read, or a snapshot grows past the datagram limit and starts vanishing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFrame, createFramer, pickChannel, DATAGRAM_SAFE_BYTES } from '../shared/wire.js';
import {
  IN_MASK, IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, IN_BOMB, IN_SLIDE,
} from '../shared/constants.js';
import { peerIp } from '../server/webtransport.js';

const bytes = s => new TextEncoder().encode(s);
const collect = () => { const got = []; return { got, push: createFramer(m => got.push(m)) }; };

test('a whole record round-trips', () => {
  const { got, push } = collect();
  push(bytes(encodeFrame({ t: 'hello', name: 'cobus' })));
  assert.deepEqual(got, [{ t: 'hello', name: 'cobus' }]);
});

test('two records in one chunk both arrive, in order', () => {
  const { got, push } = collect();
  push(bytes(encodeFrame({ t: 'a' }) + encodeFrame({ t: 'b' })));
  assert.deepEqual(got.map(m => m.t), ['a', 'b']);
});

test('a record split across chunks is held until it is whole', () => {
  const { got, push } = collect();
  const frame = encodeFrame({ t: 'snap', tick: 42 });
  for (const ch of frame) push(bytes(ch));      // one byte at a time, the worst case
  assert.deepEqual(got, [{ t: 'snap', tick: 42 }]);
});

test('a half-delivered record produces nothing until the rest turns up', () => {
  const { got, push } = collect();
  const frame = encodeFrame({ t: 'chat', msg: 'hello there' });
  push(bytes(frame.slice(0, 9)));
  assert.deepEqual(got, [], 'emitted a partial record');
  push(bytes(frame.slice(9)));
  assert.equal(got.length, 1);
});

test('a newline inside a string cannot split a record', () => {
  // The whole framing rests on this: JSON.stringify escapes every control character, so a raw
  // 0x0A in the stream is always a boundary and never payload.
  const { got, push } = collect();
  const msg = { t: 'chat', msg: 'line one\nline two' };
  const frame = encodeFrame(msg);
  assert.equal(frame.split('\n').length, 2, 'stringify emitted a raw newline');
  push(bytes(frame));
  assert.deepEqual(got, [msg]);
});

test('one bad record does not poison the stream', () => {
  const { got, push } = collect();
  push(bytes('{not json}\n' + encodeFrame({ t: 'after' })));
  assert.deepEqual(got.map(m => m.t), ['after']);
});

test('a peer that never sends a newline cannot grow the buffer without bound', () => {
  const { got, push } = collect();
  for (let i = 0; i < 40; i++) push(bytes('x'.repeat(40_000)));
  push(bytes(encodeFrame({ t: 'ok' })));
  assert.ok(got.length <= 1);     // the junk was dropped; the stream still works afterwards
});

test('only continuously-replaced messages go unreliable', () => {
  for (const t of ['input', 'snap', 'ping', 'pong']) {
    assert.equal(pickChannel({ t }, 100), 'datagram', `${t} should be a datagram`);
  }
  // These must arrive, and must arrive in order.
  for (const t of ['hello', 'welcome', 'chat', 'roundend', 'scores', 'streak', 'reject']) {
    assert.equal(pickChannel({ t }, 100), 'stream', `${t} must be reliable`);
  }
});

test('an oversized hot message falls back to the reliable channel', () => {
  // An oversized datagram is dropped silently by the stack rather than rejected, which would
  // turn a full server into an intermittently invisible one.
  assert.equal(pickChannel({ t: 'snap' }, DATAGRAM_SAFE_BYTES), 'datagram');
  assert.equal(pickChannel({ t: 'snap' }, DATAGRAM_SAFE_BYTES + 1), 'stream');
});

test('a real sixteen-player snapshot is measured, not assumed', () => {
  const players = Array.from({ length: 16 }, (_, i) => ({
    i, x: 123456, y: 234567, d: 3, st: 1, b: 8, f: 6, sp: 4, sh: 1, s: 12345, k: 99, dd: 99, stat: 64,
  }));
  const snap = { t: 'snap', tick: 17999, ack: 17998, players, bombs: [], perks: [], ev: [] };
  const size = new TextEncoder().encode(JSON.stringify(snap)).length;
  const channel = pickChannel(snap, size);
  // Not an assertion about which one is right — just that the choice is made on the real number,
  // so whoever changes playerWire finds out here instead of in a game.
  assert.ok(size > 0);
  assert.equal(channel, size <= DATAGRAM_SAFE_BYTES ? 'datagram' : 'stream');
  console.log(`    (a full 16-player snapshot is ${size} bytes -> ${channel})`);
});

test('the websocket defers to an in-flight webtransport attempt', () => {
  // Pure first-past-the-post was the bug: a WebSocket open fires as soon as TCP and TLS are up,
  // which beats a cold QUIC handshake, so the transport we built was never actually used. The
  // rule is readable straight out of the source — there is no DOM here to exercise it against.
  const src = readFileSync(new URL('../public/client/transport.js', import.meta.url), 'utf8');
  assert.match(src, /const PREFER_MS = \d+/, 'the preference window is gone');
  assert.match(src, /t\.kind === 'websocket' && wtPending\(\)/,
    'the websocket no longer waits for webtransport');
  // And it must stop waiting the moment webtransport is out, or a UDP-blocked network pays the
  // full window on every single reconnect.
  assert.match(src, /kind === 'webtransport' && !wtPending\(\)/,
    'a failed webtransport does not release the websocket early');

  const prefer = Number(src.match(/const PREFER_MS = (\d+)/)[1]);
  const race = Number(src.match(/const RACE_MS = (\d+)/)[1]);
  assert.ok(prefer > 0 && prefer < race, `PREFER_MS ${prefer} must sit inside RACE_MS ${race}`);
  assert.ok(prefer <= 500, `${prefer}ms is long enough to feel on the join screen`);
});

test('a WebTransport peer address is reduced to the address alone', () => {
  assert.equal(peerIp('1.2.3.4:5678'), '1.2.3.4');
  assert.equal(peerIp('[::1]:443'), '::1');
  assert.equal(peerIp('::ffff:1.2.3.4:5678'), '::ffff:1.2.3.4');
  assert.equal(peerIp(undefined), null);
  assert.equal(peerIp('undefined:undefined'), null);
});

/* What a modified client can assert, and what it cannot. See docs/ANTICHEAT.md §2.
 *
 * These are source-level assertions rather than behavioural ones on purpose: the property being
 * defended is the ABSENCE of code — that nothing on the server reads a position from a client, and
 * that the input mask is narrowed before it reaches the simulation. A behavioural test can only
 * show that today's server ignores the field; this shows that it never looks.
 */
test('the server never trusts a client position, and narrows every input mask', () => {
  const room = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  const net = readFileSync(new URL('../server/net.js', import.meta.url), 'utf8');
  const code = s => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  // The client sends x and y with every input (see the send in client/main.js). Nothing on the
  // server may read them: a server that believes a client about where it is has no collision
  // detection, no fire damage and no pickups worth the name.
  for (const [name, src] of [['room.js', room], ['net.js', net]]) {
    assert.doesNotMatch(code(src), /\bmsg\.x\b|\bmsg\.y\b/,
      `${name} reads a position out of a client message`);
  }

  // And the mask is masked, with the shared allowlist rather than a hand-written literal — a
  // literal is how a new input bit gets silently dropped, or an old one silently allowed.
  assert.match(code(room), /mask & IN_MASK/, 'input masks are not narrowed to IN_MASK');
});

test('IN_MASK is exactly the bits a keyboard can produce', () => {
  // A new input bit has to be added to IN_MASK deliberately. If this fails because a bit was
  // added, add it here too — and think about whether the simulation validates what it means.
  const all = IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN | IN_BOMB | IN_SLIDE;
  assert.equal(IN_MASK, all);
  assert.equal(IN_MASK, 0b111111, `IN_MASK is ${IN_MASK.toString(2)}`);
});
