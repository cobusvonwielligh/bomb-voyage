// Keyboard to input bitmask. Arrows and WASD, per docs/RULES.md §10.

import {
  IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, IN_BOMB, SLIDE_DOUBLE_TAP_MS,
} from '/shared/constants.js';

const BINDINGS = {
  ArrowRight: IN_RIGHT, KeyD: IN_RIGHT,
  ArrowUp: IN_UP, KeyW: IN_UP,
  ArrowLeft: IN_LEFT, KeyA: IN_LEFT,
  ArrowDown: IN_DOWN, KeyS: IN_DOWN,
  Space: IN_BOMB, KeyK: IN_BOMB,
};

// Keys Game of Bombs has and this build does not. Swallowing them with a hint beats doing
// nothing, which just reads as broken to a returning player.
/* Keys Game of Bombs has and this build does not. Swallowing them with a hint beats doing
 * nothing, which just reads as broken to a returning player.
 *
 * Shift used to be here. It is the emote modifier now — see createInput's `onEmote` — which is
 * a better use of a key people already reach for, and the detonator hint survives on L. */
const RESERVED = {
  KeyL: 'detonator',
  KeyI: 'safe-house', KeyF: 'jetpack',
};

/* Hold Shift, tap a direction. Four emotes, on the four keys your hand is already on.
 *
 * WASD and the arrows both, because both already mean "a direction" here and somebody who
 * plays on arrows should not have to move their hand to use this. The mapping is the compass:
 * up, left, down, right — so the picker can be drawn as a cross and there is nothing to learn.
 */
const EMOTE_KEYS = {
  KeyW: 0, ArrowUp: 0,
  KeyA: 1, ArrowLeft: 1,
  KeyS: 2, ArrowDown: 2,
  KeyD: 3, ArrowRight: 3,
};

// Input types that take no text. A denylist rather than an allowlist of text types, so the next
// field anyone adds is gated by default — which is the property that stopped the name box from
// eating WASD in the first place.
const NON_TEXT_INPUT = /^(range|checkbox|radio|button|submit|reset|file|color|image)$/;

/**
 * True whenever focus is in anything that takes text. Checking the element rather than naming
 * specific fields is what stops the next input anyone adds from silently eating WASD.
 *
 * The volume sliders are the reason for the type check: they are `<input>` elements, so the naive
 * version treated them as text fields, and one click on the music slider killed the keyboard for
 * the rest of the round. A bare `<input>` reports type 'text', so chat and the name box stay gated.
 */
export const typingSomewhere = () => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !NON_TEXT_INPUT.test(el.type);
};

/**
 * One-shot guard for anything that must happen on a PRESS rather than while a key is held.
 *
 * Two separate things are being defended against and they need different answers:
 *
 *   1. **Auto-repeat.** Hold a key and the browser fires `keydown` thirty times a second. That
 *      is correct for walking and catastrophic for anything that toggles: a held Tab opens and
 *      closes the scoreboard thirty times, a held Escape leaves the game, a held Space sends a
 *      respawn request every frame. Dealt with by refusing `event.repeat`.
 *   2. **Chatter and double-fire.** Two paths can reach the same action — Space while the
 *      respawn button has focus is both a keypress and a synthetic click — and a key can bounce.
 *      Dealt with by a short cooldown per action.
 *
 * Deliberately NOT applied to movement or to placing bombs. Debouncing those would be adding
 * latency to fix a problem they do not have: movement is a held state, not an event, and
 * hold-to-drop is how Bomberman has always worked.
 */
export const TAP_COOLDOWN_MS = 250;

export function createTap(ms = TAP_COOLDOWN_MS, now = () => performance.now()) {
  let last = -Infinity;
  return fn => (...args) => {
    const t = now();
    if (t - last < ms) return undefined;
    last = t;
    return fn(...args);
  };
}

export function createInput({ onReserved, onEmote, onEmoteMenu, isTyping = typingSomewhere,
  now = () => performance.now() }) {
  let mask = 0;
  const down = new Set();
  // Shift held: the picker is open and WASD chooses rather than walks.
  let picking = false;

  /* The slide gesture: the same direction, twice, inside SLIDE_DOUBLE_TAP_MS.
   *
   * Kept here rather than in the simulation on purpose. The server is told "slide" by one bit in
   * the input mask and never learns that it came from two taps, so the gesture costs nothing on
   * the wire, works identically under any amount of lag, and could be rebound to a key tomorrow
   * without the rules changing at all.
   *
   * Tracked per DIRECTION rather than per key code, so tapping Left on the arrows and then A
   * counts — they are the same instruction, and a player with a hand on each is not making two
   * different requests. Auto-repeat never reaches here (see the repeat guard in keydown), which is
   * what stops holding a direction from reading as an endless stream of taps.
   */
  const lastTap = new Map();      // direction bit -> timestamp of the last fresh press
  let slideTap = false;           // armed by a double-tap, consumed by the next tick

  const recompute = () => {
    mask = 0;
    for (const code of down) mask |= BINDINGS[code] || 0;
  };

  const setPicking = on => {
    if (picking === on) return;
    picking = on;
    /* Everything stops when the picker opens.
     *
     * Holding Shift takes WASD away from walking, so the mask has to be cleared or you keep
     * sliding in whatever direction you were last pressing — which is the single worst thing
     * a UI mode can do in a game where standing still is a decision. You stop, you choose, you
     * let go. Deliberate, brief, and entirely yours: nothing opens this but your own hand. */
    if (on) { down.clear(); recompute(); }
    onEmoteMenu?.(on);
  };

  addEventListener('keydown', e => {
    if (isTyping?.()) return;

    // Shift down: open the picker. Before the repeat guard, because the FIRST shift keydown is
    // the one that opens it and a held shift repeats like anything else.
    if (e.key === 'Shift') { e.preventDefault(); setPicking(true); return; }

    if (picking) {
      const slot = EMOTE_KEYS[e.code];
      if (slot !== undefined) {
        e.preventDefault();
        if (!e.repeat) onEmote?.(slot);
        return;
      }
      // Any other key while picking: close rather than swallow. Escape should always escape.
      if (e.code === 'Escape') { e.preventDefault(); setPicking(false); return; }
    }
    // Auto-repeat carries no information here: the key is already in `down`, so the mask is
    // already right. Swallowing it early keeps the reserved-key hint from firing thirty times a
    // second at somebody leaning on Shift.
    if (e.repeat) { if (BINDINGS[e.code] || RESERVED[e.code]) e.preventDefault(); return; }
    if (RESERVED[e.code]) { e.preventDefault(); onReserved?.(RESERVED[e.code]); return; }
    if (!BINDINGS[e.code]) return;
    e.preventDefault();
    const bit = BINDINGS[e.code];
    if (bit !== IN_BOMB) {
      const t = now();
      const prev = lastTap.get(bit);
      // Armed, and the clock is cleared: a third tap starts a new pair rather than firing again.
      if (prev !== undefined && t - prev <= SLIDE_DOUBLE_TAP_MS) { slideTap = true; lastTap.delete(bit); }
      else lastTap.set(bit, t);
    }
    if (!down.has(e.code)) { down.add(e.code); recompute(); }
  });

  addEventListener('keyup', e => {
    if (e.key === 'Shift') { setPicking(false); return; }
    if (!BINDINGS[e.code]) return;
    // Never gate keyup on isTyping: focusing a field mid-stride would otherwise strand the key
    // down forever and you would walk into a wall until you pressed it again.
    e.preventDefault();
    down.delete(e.code);
    recompute();
  });

  // Losing focus mid-stride would otherwise leave you walking into a wall forever.
  // Losing focus mid-stride would otherwise leave you walking into a wall forever — and would
  // leave the picker open over a game you are no longer looking at.
  addEventListener('blur', () => {
    down.clear(); recompute(); setPicking(false);
    // An armed slide must not survive the tab losing focus: coming back to a launch nobody asked
    // for, several seconds after the taps, is the worst kind of surprise in a game about position.
    lastTap.clear(); slideTap = false;
  });

  return {
    /* Zero while the picker is open. The simulation reads this, so a held Shift is genuinely
     * "no input" rather than a UI overlay with movement continuing underneath it. */
    get mask() { return picking ? 0 : mask; },
    get picking() { return picking; },
    /**
     * Was a slide asked for? One-shot: it reads and clears, so one double-tap is one slide
     * whatever the frame rate — several simulation steps in one frame cannot launch twice.
     */
    takeSlide() {
      if (!slideTap || picking) { slideTap = false; return false; }
      slideTap = false;
      return true;
    },
    /** Is this physical key down right now? Edge detection lives with the caller. */
    isDown(code) { return down.has(code); },
    clear() { down.clear(); recompute(); },
  };
}
