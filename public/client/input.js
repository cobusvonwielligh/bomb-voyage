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

/**
 * True whenever focus is in anything that takes text. Checking the element rather than naming
 * specific fields is what stops the next input anyone adds from silently eating WASD.
 */
export const typingSomewhere = () => {
  const el = document.activeElement;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
};

export function createInput({ onReserved, isTyping = typingSomewhere }) {
  let mask = 0;
  const down = new Set();

  const recompute = () => {
    mask = 0;
    for (const code of down) mask |= BINDINGS[code] || 0;
  };

  addEventListener('keydown', e => {
    if (isTyping?.()) return;
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

  return { get mask() { return mask; }, clear() { down.clear(); recompute(); } };
}
