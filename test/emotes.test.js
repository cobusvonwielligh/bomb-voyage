// The emote system, which is deliberately not a system.
//
// An emote is a very short chat message. That one decision is what makes this two features for
// the price of none: the server already sanitises, rate-limits and broadcasts chat, the log
// already shows it, and short messages already get a bubble over the speaker's head. Anything
// that re-implements any of that is the bug this file exists to catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const main = read('public/client/main.js');
const input = read('public/client/input.js');
const render = read('public/client/render.js');
const html = read('public/index.html');
const css = read('public/style.css');

test('an emote goes down the ordinary chat path', () => {
  assert.match(main, /net\.send\(\{ t: 'chat', msg: e \}\)/,
    'emotes are not sent as chat — that means a new protocol message to keep in step');
  const server = read('server/net.js');
  assert.ok(!/emote/i.test(server), 'the server grew emote-specific code; it should need none');
});

test('holding the modifier stops you moving', () => {
  /* The picker takes WASD away from walking. If the mask kept its old value you would keep
   * sliding in whatever direction you were last pressing, which is the worst thing a UI mode
   * can do in a game where standing still is a decision. */
  assert.match(input, /get mask\(\) \{ return picking \? 0 : mask; \}/,
    'the input mask is not zeroed while the picker is open');
  assert.match(input, /if \(on\) \{ down\.clear\(\); recompute\(\); \}/,
    'held keys are not released when the picker opens');
});

test('the picker closes on blur, so it cannot be left open over a game you left', () => {
  const blur = input.slice(input.indexOf("addEventListener('blur'"));
  assert.match(blur.slice(0, 220), /setPicking\(false\)/);
});

test('every emote key maps to a real emote, and the legend shows the same ones', () => {
  const keys = input.match(/const EMOTE_KEYS = \{([\s\S]*?)\};/);
  assert.ok(keys, 'EMOTE_KEYS not found');
  const slots = [...keys[1].matchAll(/:\s*(\d)/g)].map(m => +m[1]);
  assert.ok(slots.length >= 4, 'fewer than four keys are bound');

  const emotes = main.match(/const EMOTES = \[([^\]]*)\]/);
  assert.ok(emotes, 'EMOTES not found');
  const count = (emotes[1].match(/'/g) || []).length / 2;
  assert.equal(count, 4, `expected four emotes, found ${count}`);
  for (const s of slots) assert.ok(s < count, `a key maps to slot ${s}, which has no emote`);

  // The legend is filled from the same array rather than written into the markup, or the two
  // drift apart the first time somebody changes one of them.
  assert.match(main, /#emotePick \.ekey b/, 'the picker legend is not filled from EMOTES');
  assert.ok(!/<b>[\u{1F300}-\u{1FAFF}]/u.test(html),
    'an emoji is hard-coded in index.html; the legend and what it sends would drift apart');
});

test('EMOTES is declared before the code that fills the legend from it', () => {
  // `const` in a module is a temporal dead zone, not an undefined: reading it early throws and
  // takes the whole client down at boot. This ordering was wrong once.
  assert.ok(main.indexOf('const EMOTES =') < main.indexOf('EMOTES[i] ??'),
    'the legend is filled before EMOTES is declared, which throws at module evaluation');
});

test('the bubbles are actually painted', () => {
  /* drawSays existed, was correct, and was never called from frame() — so every bubble was
   * built, aged and expired without a single pixel reaching the screen. A renderer function
   * nothing calls is the one bug reading the function will never show you. */
  const body = render.slice(render.indexOf('function frame('), render.indexOf('function drawSays'));
  assert.match(body, /drawSays\(ox, oy, zoom\)/, 'frame() does not call drawSays');
});

test('emotes are rate-limited on the client, and never faster than the server allows', () => {
  /* The server drops chat sent inside CHAT_MIN_INTERVAL_MS without a word back, so a client
   * that let you fire faster would be firing emotes that silently never happened. */
  assert.match(main, /EMOTE_COOLDOWN_MS = CHAT_MIN_INTERVAL_MS \+ \d+/,
    'the emote cooldown is not derived from the server-side chat interval');
  assert.match(main, /now - emoteAt < EMOTE_COOLDOWN_MS\) return/,
    'the cooldown is not actually checked before sending');
});

test('picking an emote closes the wheel until the modifier is released', () => {
  // Holding Shift is the question and picking is the answer; a legend left over the board after
  // it has been answered is in the way of seeing what you walked into.
  assert.match(main, /pickerSpent = true;/, 'the wheel is not marked spent when you pick');
  assert.match(main, /if \(!on\) pickerSpent = false;/,
    'releasing the modifier does not re-arm the wheel');
  assert.match(main, /on && !pickerSpent/, 'a spent wheel can still be shown');
});

test('commands and server lines never appear over somebody’s head', () => {
  /* `/kick bob` is addressed to the server and the reply comes back as a SERVER line. Putting
   * the command itself over a player's head broadcasts something they typed privately. */
  assert.match(main, /if \(m\.i >= 0 && m\.msg\.length <= SAY_MAX && !m\.msg\.startsWith\('\/'\)\)/,
    'the bubble guard is missing, weakened or reworded');
});

test('the picker does not reuse another component’s class name', () => {
  // `.slot` is the volume fader's pop-out, and it sets opacity:0 and height:0 on ITSELF.
  // Sharing the name made the picker invisible once already.
  assert.ok(!/class="slot (up|left|down|right)"/.test(html),
    'the emote picker is using .slot again, which the volume fader already owns');
  assert.match(css, /\.ring \.ekey \{/, 'the picker keys are not .ekey');
});

test('nothing in the picker can be left invisible by an animation that never runs', () => {
  /* The failure that caught this: `animation: ... backwards` with `from { opacity: 0 }` leaves
   * the element at zero until the animation starts. Anything that stops animations running — a
   * compositor giving up, a headless render, a system setting — then leaves an invisible
   * picker, which is worse than never having animated it at all. */
  const pop = css.match(/@keyframes emotePop \{([\s\S]*?)\n\}/);
  assert.ok(pop, 'emotePop not found');
  assert.ok(!/opacity/.test(pop[1]), 'emotePop animates opacity, so a stalled clock hides the picker');
  const ring = css.slice(css.indexOf('.ring .ekey'));
  assert.ok(!/animation:[^;]*backwards/.test(ring),
    'the picker uses a backwards fill, which hides it before the animation starts');
});

test('a bubble follows the player and is drawn in screen space', () => {
  // Board space would scale the text down with the island at the zoom floor — which is exactly
  // when the board is busiest and the words matter most.
  assert.match(render, /function drawSays/, 'drawSays is gone');
  assert.match(render, /ctx\.setTransform\(view\.dpr, 0, 0, view\.dpr, 0, 0\);/,
    'the bubble is not drawn in screen space');
  assert.match(render, /say\(i, text\)/, 'the renderer no longer exposes say()');
});
