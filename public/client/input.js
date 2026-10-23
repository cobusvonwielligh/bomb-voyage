// Keyboard to input bitmask. Arrows and WASD, per docs/RULES.md §10.

import { IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, IN_BOMB } from '/shared/constants.js';

const BINDINGS = {
  ArrowRight: IN_RIGHT, KeyD: IN_RIGHT,
  ArrowUp: IN_UP, KeyW: IN_UP,
  ArrowLeft: IN_LEFT, KeyA: IN_LEFT,
  ArrowDown: IN_DOWN, KeyS: IN_DOWN,
  Space: IN_BOMB, KeyK: IN_BOMB,
};

// Keys Game of Bombs has and this build does not. Swallowing them with a hint beats doing
// nothing, which just reads as broken to a returning player.
const RESERVED = {
  ShiftLeft: 'detonator', ShiftRight: 'detonator', KeyL: 'detonator',
  KeyI: 'safe-house', KeyF: 'jetpack',
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

export function createInput({ onReserved, isTyping = typingSomewhere }) {
  let mask = 0;
  const down = new Set();

  const recompute = () => {
    mask = 0;
    for (const code of down) mask |= BINDINGS[code] || 0;
  };

  addEventListener('keydown', e => {
    if (isTyping?.()) return;
    // Auto-repeat carries no information here: the key is already in `down`, so the mask is
    // already right. Swallowing it early keeps the reserved-key hint from firing thirty times a
    // second at somebody leaning on Shift.
    if (e.repeat) { if (BINDINGS[e.code] || RESERVED[e.code]) e.preventDefault(); return; }
    if (RESERVED[e.code]) { e.preventDefault(); onReserved?.(RESERVED[e.code]); return; }
    if (!BINDINGS[e.code]) return;
    e.preventDefault();
    if (!down.has(e.code)) { down.add(e.code); recompute(); }
  });

  addEventListener('keyup', e => {
    if (!BINDINGS[e.code]) return;
    // Never gate keyup on isTyping: focusing a field mid-stride would otherwise strand the key
    // down forever and you would walk into a wall until you pressed it again.
    e.preventDefault();
    down.delete(e.code);
    recompute();
  });

  // Losing focus mid-stride would otherwise leave you walking into a wall forever.
  addEventListener('blur', () => { down.clear(); recompute(); });

  return {
    get mask() { return mask; },
    /** Is this physical key down right now? Edge detection lives with the caller. */
    isDown(code) { return down.has(code); },
    clear() { down.clear(); recompute(); },
  };
}
