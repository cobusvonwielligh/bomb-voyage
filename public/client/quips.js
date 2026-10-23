// The mascot says things.
//
// He is a decoration that has been sitting in the corner since the HUD was built, and a face that
// never reacts stops being looked at after about a minute. Giving him a line on death, on respawn
// and occasionally for no reason at all is the cheapest way to make the corner worth glancing at.
//
// The rule that keeps it from becoming annoying: idle lines are RARE and never interrupt. A quip
// is a garnish, and a garnish that arrives every ten seconds is a meal.

/** Idle lines. `{n}` is replaced with the player's name. */
export const QUIPS = [
  "Steady on, {n}.",
  "{n}, that barrel was load-bearing.",
  "Nothing personal, {n}. Mostly.",
  "I've seen shipwrecks with better aim.",
  "{n}, the bombs are meant to go AWAY from you.",
  "Scurvy builds character, {n}.",
  "Ten paces, {n}. Count them this time.",
  "{n}, you fight like a dairy farmer.",
  "That's my captain. Allegedly.",
  "Powder's dry, {n}. Your record isn't.",
  "{n}, the island isn't getting any bigger.",
  "Arr. That's it. That's the quip.",
  "I'd follow you anywhere, {n}. From a safe distance.",
  "{n}, blinking is optional. Moving isn't.",
  "One eye, and I still saw that coming.",
  "{n}, the crew is talking.",
  "Bold strategy. Let me know how the crater is.",
  "{n}, treasure's under the explosions. Probably.",
  "A fine day for someone else's funeral.",
  "{n}, if you survive this one I'll be amazed and so will you.",
];

/**
 * What he says when you hover PLAY on the landing page.
 *
 * Different register to the in-game lines: those are heckling, these are the last thing you read
 * before the round starts, so they are closer to advice than abuse.
 */
export const MENU_QUIPS = [
  'The trick is to be elsewhere when it goes off.',
  'Corners kill. Mostly you.',
  'Every wall is temporary. Including the one behind you.',
  'Drop it, then leave. In that order.',
  'The last pirate standing is usually the patient one.',
  'Bombs are cheap. You are not.',
  'If you can see the fuse, you are too close.',
  'Dead ends are only dead for one of you.',
  'Pick up everything. Apologise later.',
  'Nobody wins standing still.',
  'That bomb has a plan. Do you?',
  'Fortune favours the bold. Statistics do not.',
  'Blow up the walls, not the schedule.',
  'There is no honour in the middle of a crossfire.',
  'Press it. The worst that happens is everything.',
];

/**
 * The rum. Its own pool, because it is the only pickup the mascot has an opinion about — and
 * because a line that fires on one drop in ten stays funny, where the same line on every bomb
 * would be wallpaper inside a minute.
 */
export const ON_RUM = [
  'Aye, you must be tipsy now!',
  "That's the good stuff, {n}.",
  'Steady, {n}. Walls move when you drink.',
  'Rum! Now try walking in a line.',
  "Drink up. You'll not feel the next one.",
  'One for the sea, three for {n}.',
];

export const ON_DEATH = ['Oof.', 'Oof!', 'Oof… that one hurt.'];
export const ON_SPAWN = ["Let's go!", "Let's go, {n}!", 'Back at it!'];

/** How long a bubble stays up. Long enough to read a short line, short enough to not be furniture. */
export const SHOW_MS = 7000;

/** The idle line fires on average once every this many ms, and never twice inside MIN_GAP_MS. */
export const IDLE_EVERY_MS = 75_000;
export const MIN_GAP_MS = 12_000;

const fill = (line, name) => line.replaceAll('{n}', name || 'captain');

/**
 * @param el   the bubble element; its textContent is the line
 * @param now  a clock, injectable so this is testable without a browser
 */
export function createQuips({ el, nameOf, now = () => performance.now(), random = Math.random }) {
  let hideAt = 0;
  let lastAt = -Infinity;
  let last = '';

  function say(pool, { force = false } = {}) {
    const t = now();
    // A quip landing on top of a quip reads as a glitch, so the previous one has to have finished.
    // Death and spawn lines are forced: those ARE the moment, and a cooldown that swallows them
    // would make the feature look broken exactly when it is being watched.
    if (!force && t - lastAt < MIN_GAP_MS) return null;
    if (!force && t < hideAt) return null;

    // Never the same line twice running. With twenty lines the birthday problem makes a repeat
    // far more likely than it feels like it should be, and a repeat is the one thing that makes
    // a random line read as a bug.
    let line = fill(pool[(random() * pool.length) | 0], nameOf());
    if (line === last && pool.length > 1) {
      line = fill(pool[(random() * pool.length) | 0], nameOf());
    }
    last = line;
    lastAt = t;
    hideAt = t + SHOW_MS;

    if (el) {
      el.textContent = line;
      // Restart the animation even if it is already running: without the reflow a second quip
      // inside the window would simply appear, with no pop.
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }
    return line;
  }

  return Object.freeze({
    idle() {
      // A per-frame probability, not a timer: a timer would fire the moment you alt-tab back and
      // land every quip on the same instant for everyone in the room.
      if (random() < 1 / (IDLE_EVERY_MS / 16.7)) return say(QUIPS);
      return null;
    },
    died() { return say(ON_DEATH, { force: true }); },
    rum() { return say(ON_RUM, { force: true }); },
    spawned() { return say(ON_SPAWN, { force: true }); },
    tick() {
      if (el && hideAt && now() >= hideAt) { el.classList.remove('show'); hideAt = 0; }
    },
    say,
  });
}
