// Local storage, sealed.
//
// ─── what this is, and what it cannot be ─────────────────────────────────────
//
// A web page cannot keep a secret from its own console. Anything this module can decrypt, a
// person with devtools open can decrypt by calling the same function — and if the key were
// fetched from the server instead, they could read it out of the network tab. Any claim that
// browser-side storage is "encrypted" against the person using the browser is false, and building
// on that claim is how you end up trusting a client that cannot be trusted.
//
// So this is not secrecy. It is TAMPER EVIDENCE plus obfuscation, and those are both worth having:
//
//   * every value carries a checksum over (key, value, per-browser salt), so a hand-edited or
//     half-written entry is detected and treated as absent rather than fed into the game;
//   * values are not stored as plain readable text, so `bv.name` is not a field in a list of
//     settings that invites being edited to somebody else's name;
//   * one value cannot be copied over another — the key is part of the checksum, so pasting the
//     `bv.sfx` blob into `bv.playerId` fails the check instead of being honoured;
//   * the salt is per browser, so a sealed value from one machine is rejected on another.
//
// None of that stops a determined person with the console open. What stops THEM is that there is
// nothing in here worth having: the simulation is authoritative on the server (docs/NETCODE.md),
// so no amount of editing local state changes what the game does. See docs/ANTICHEAT.md for the
// full statement of what the client is and is not trusted with.
//
// ─── why not WebCrypto ───────────────────────────────────────────────────────
//
// AES-GCM through `crypto.subtle` is asynchronous, and these values are read during module
// initialisation and inside constructors — the volume before the audio graph exists, the identity
// before the socket opens. Making those paths async to add encryption that is, as above, not
// actually secret against the only adversary present would be a large change in exchange for the
// appearance of security. The checksum below uses the same hash the determinism check uses and is
// synchronous, which is the property that matters.

const SALT_KEY = 'bv.salt';
const SEAL = 'bv1:';          // version tag, so the format can change without losing everybody's settings

/** FNV-1a over a string, as eight hex digits. Not a MAC — see the header. */
function sum(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= s.charCodeAt(i) >>> 8;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* The per-browser salt.
 *
 * Deliberately NOT the device id: that one is sent to the server (see deviceId in net.js) and a
 * value that travels is a value that could be used to pre-compute a sealed blob for somebody
 * else's browser. This one never leaves the machine.
 */
let salt = null;
function getSalt() {
  if (salt) return salt;
  try {
    salt = localStorage.getItem(SALT_KEY);
    if (!salt) {
      salt = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(SALT_KEY, salt);
    }
  } catch {
    // Storage blocked entirely (private mode with cookies off). Everything below degrades to
    // "nothing is stored", which every caller already has to cope with.
    salt = 'ephemeral';
  }
  return salt;
}

/** XOR the text against a keystream derived from the key and the salt, then base64 it. */
function mask(key, text) {
  const k = `${getSalt()}|${key}`;
  const out = new Array(text.length);
  // The keystream is the hash of (key, salt, block index), so it does not repeat within a value
  // and differs per key — a 16-character window of two values under the same key cannot be
  // lined up against each other.
  for (let i = 0; i < text.length; i++) {
    if (i % 8 === 0) var stream = sum(`${k}|${i >> 3}`);       // eslint-disable-line no-var
    const pad = parseInt(stream[i % 8], 16) * 17;              // 0..255 from one hex digit
    out[i] = String.fromCharCode(text.charCodeAt(i) ^ pad);
  }
  return out.join('');
}

// Unicode-safe base64 both ways: `btoa` throws on anything past U+00FF, and names contain emoji.
const toB64 = s => btoa(unescape(encodeURIComponent(s)));
const fromB64 = s => decodeURIComponent(escape(atob(s)));

export const store = {
  /**
   * Read a sealed value, or null.
   *
   * Anything that fails the checksum — edited by hand, written by an older format, truncated by a
   * full disk — is removed and reported as absent. That is the only safe answer: a value that has
   * been tampered with is not a value, and keeping it would mean deciding how much of it to trust.
   */
  get(key) {
    let raw;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (raw === null) return null;
    if (!raw.startsWith(SEAL)) {
      /* An unsealed value from before this module existed. Honoured once, then sealed on the way
       * past, so nobody loses their name or their volume to the upgrade — and so a hand-written
       * plain value is not silently accepted forever. */
      this.set(key, raw);
      return raw;
    }
    const body = raw.slice(SEAL.length);
    const cut = body.indexOf('.');
    if (cut < 0) { this.remove(key); return null; }
    const check = body.slice(0, cut);
    let value;
    try { value = mask(key, fromB64(body.slice(cut + 1))); } catch { this.remove(key); return null; }
    if (check !== sum(`${getSalt()}|${key}|${value}`)) {
      console.warn(`store: ${key} failed its checksum and was discarded`);
      this.remove(key);
      return null;
    }
    return value;
  },

  set(key, value) {
    const v = String(value);
    try {
      localStorage.setItem(key, `${SEAL}${sum(`${getSalt()}|${key}|${v}`)}.${toB64(mask(key, v))}`);
    } catch { /* storage blocked or full: the setting simply does not persist */ }
  },

  remove(key) {
    try { localStorage.removeItem(key); } catch { /* nothing to do */ }
  },

  /** Read a number in a range, or the fallback. Every numeric preference wants this. */
  number(key, fallback, min = -Infinity, max = Infinity) {
    const v = parseFloat(this.get(key));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  },
};
