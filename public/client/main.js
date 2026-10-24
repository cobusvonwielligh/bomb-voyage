// Boot, the fixed-step loop, and the menu.
//
// No framework and no jQuery: the menu is one input and one button, and jQuery inside a frame
// loop is exactly the thing docs/ARCHITECTURE.md §9 forbids. If the UI ever grows past this,
// revisit — right now vanilla is the smaller answer.

import {
  TICK_MS, TICK_HZ, NAME_MAX_CHARS, UNITS_PER_TILE, IN_BOMB, playerColor,
  MAX_SKATES, MAX_SHIELDS, MAX_STAMINA_LEVELS, IDLE_DISCONNECT_MS, RESPAWN_DELAY_TICKS, TILE_PX,
  MAX_BOMBS_CARRIED, MAX_RADIUS, START_BOMBS, START_RADIUS,
  STAMINA_SHOW_AT, staminaMaxFor, POWDER_RADIUS, PERK, STATUS, VOLUME_MUSIC_DEFAULT,
} from '/shared/constants.js';
import { createNet } from './net.js';
import { createInput, typingSomewhere, createTap } from './input.js';
import { createWorld } from './world.js';
import { createRenderer } from './render.js';
import { createMusic } from './audio/music.js';
import { createSfx } from './audio/sfx.js';
import { createQuips, MENU_QUIPS } from './quips.js';
import { createMenuViz } from './menuviz.js';
import { bombTile } from '/shared/sim/bombs.js';

const $ = id => document.getElementById(id);

/**
 * What floats up off you when you pick something up, in the perk's own colour so the label and
 * the icon you just walked over are obviously the same thing.
 *
 * Short and loud. This is read in peripheral vision in under a second, so "+1 BOMB" beats
 * "extra bomb capacity" by a distance.
 */
/**
 * The passive upgrades that get a floating badge when you collect one.
 *
 * Only the ones that change you permanently. A bomb or a fire pickup is a number going up and
 * the pip covers it; boots, shields and stim change how you move and how much you can take,
 * and
 * those are worth a beat of celebration.
 */
const UPGRADES = {
  3:  { icon: '#i-boot',   text: 'boots',  colour: '#5fd8f0', of: () => MAX_SKATES },
  4:  { icon: '#i-shield', text: 'shield', colour: '#5ad1a0', of: () => MAX_SHIELDS },
  15: { icon: '#i-bolt',   text: 'stim',   colour: '#ffe04a', of: () => MAX_STAMINA_LEVELS },
};

const PERK_LABEL = {
  1: { text: '+1 BOMB', colour: '#7e93d6' },
  2: { text: '+1 FIRE', colour: '#ff9b4a' },
  3: { text: '+1 SPEED', colour: '#5fd8f0' },
  4: { text: 'SHIELD', colour: '#5ad1a0' },
  15: { text: '+ STIM', colour: '#ffe04a' },
  16: { text: 'RUM', colour: '#d99a55' },
  17: { text: 'GOLD!', colour: '#f6e7a9' },
};

// The mascot is an image now, ringed by the same moving gradient as the panels. The hand-drawn
// canvas it replaced ran a requestAnimationFrame loop the whole time the menu was open, which
// is a lot of machinery for a picture that does not move.
const world = createWorld();
let renderer = null;
let running = false;

// ─── music ────────────────────────────────────────────────────────────────────

const music = createMusic();

// The listener is your own player's RENDERED position, not its simulated one — panning should
// follow what you are looking at. Both audio buses share one AudioContext; see audio/engine.js.
const sfx = createSfx({
  listener: () => {
    const me = world.me();
    return me ? { tx: me.rx / UNITS_PER_TILE, ty: me.ry / UNITS_PER_TILE } : null;
  },
});

// The mascot in the corner, with something to say. He takes the name from the world rather than
// from the join form, so a name the server changed (a collision, a trim) is the one he uses.
const quips = createQuips({
  el: $('say'),
  nameOf: () => world.me()?.name ?? '',
});

/**
 * The mascot's advice, while the pointer is on PLAY.
 *
 * A fresh line per hover rather than one per page load: hovering twice and getting the same
 * sentence makes it read as static copy that happens to be hidden, which is the opposite of the
 * effect. Focus counts as hover too, so tabbing to the button gets it as well.
 */
let lastMenuQuip = '';
const menuSay = $('menuSay');

function showMenuQuip() {
  let line = MENU_QUIPS[(Math.random() * MENU_QUIPS.length) | 0];
  if (line === lastMenuQuip && MENU_QUIPS.length > 1) {
    line = MENU_QUIPS[(Math.random() * MENU_QUIPS.length) | 0];
  }
  lastMenuQuip = line;
  menuSay.textContent = line;
  menuSay.classList.add('show');
}
const hideMenuQuip = () => menuSay.classList.remove('show');

$('play').addEventListener('pointerenter', showMenuQuip);
$('play').addEventListener('focus', showMenuQuip);
$('play').addEventListener('pointerleave', hideMenuQuip);
$('play').addEventListener('blur', hideMenuQuip);

/* The three in-game beds, in rotation order. The theme is not one of them: it belongs to the
 * landing page and is excluded for the whole of a round. */
const BEDS = ['drift', 'suspend', 'undertow'];

// The landing page listening to itself. Its own rAF loop, started with the menu and stopped the
// moment a round begins — there is no point analysing audio nobody is looking at.
const menuViz = createMenuViz({ canvas: $('menuViz'), music });
menuViz.start();

/* The in-game meter: the same spectrum, three bands, in the dock.
 *
 * Deliberately almost nothing. The menu can afford to be a light show because you are reading a
 * card; in a round the only acceptable visualiser is one you never look at directly, and three
 * bars in the corner you already glance at for the track name is the whole budget.
 *
 * It drives CSS custom properties rather than touching geometry, so the browser never relayouts
 * for it — and it REPLACES the canned keyframe animation, which was a loop pretending to be a
 * level. The difference between the two is the entire point: one of them is the music.
 */
const eqBars = [...document.querySelectorAll('#nowPlaying .eq b')];
function syncMeter(dtMs) {
  const live = music.playing && music.volume > 0 && music.analyser;
  if (live) menuViz.spectrum.read(music.analyser, dtMs);
  else menuViz.spectrum.rest(dtMs);

  const s = menuViz.spectrum;
  // The sea, set to music. The renderer gets four numbers and no idea where they came from.
  renderer?.setAudio(live ? s : null);
  const v = [s.bass, s.mid, s.treble];
  for (let i = 0; i < eqBars.length; i++) {
    // 3px floor so a silent bar is still a bar. Zero-height is a missing element, not a quiet one.
    eqBars[i].style.height = `${(3 + v[i] * 8).toFixed(1)}px`;
  }
  // One number for everything that wants to breathe with the kick.
  $('dock').style.setProperty('--bass', s.bass.toFixed(3));
}

/**
 * The now-playing readout, bottom left.
 *
 * The FILENAME, not a pretty title. A title needs a lookup table that goes stale the next time
 * a track is swapped, and `drift.mp3` is the thing you would actually go and find in
 * `assets/audio` afterwards — which is the only reason to put a track name on screen at all.
 *
 * `(synth)` when the file could not be loaded and the synthesised fallback is playing. That
 * state is otherwise completely silent: the music still plays, it is just not the music, and
 * nobody would ever find out.
 *
 * Polled rather than pushed. The alternative is a callback out of the sequencer on every
 * crossfade, which is a second code path through the one piece of this that has already been
 * subtly wrong twice — and the thing displayed changes about once every three minutes. A string
 * compare in a function that already runs five times a second is not worth an event for.
 */
let shownTrack = null;
function syncNowPlaying() {
  const name = music.playing ? music.track : null;
  const label = !name ? 'paused' : music.trackIsFile ? `${name}.mp3` : `${name} (synth)`;
  $('dock').classList.toggle('playing', !!name && music.volume > 0);
  if (label === shownTrack) return;
  shownTrack = label;
  const el = $('nowPlaying');
  el.querySelector('.t').textContent = label;
  el.title = name ? `now playing: ${label}` : 'the music is paused';
}

/**
 * Both volume controls, kept in step with the two audio buses.
 *
 * `on` is gold and means playing; `muted` greys the level bar. The level itself rides on a CSS
 * custom property so the bar under the icon needs no second element and no layout.
 */
const syncAudio = () => {
  const m = $('musicCtl'), f = $('sfxCtl');
  $('vol').value = Math.round(music.volume * 100);
  $('sfxVol').value = Math.round(sfx.volume * 100);
  m.style.setProperty('--lvl', music.volume);
  f.style.setProperty('--lvl', sfx.volume);
  // These describe the FADER, not the transport: a paused track at 60% is still a 60% fader,
  // and greying it out would say the level had been lost when it had not.
  m.classList.toggle('on', music.volume > 0);
  m.classList.toggle('muted', music.volume === 0);
  // The glyph IS the transport state: a play triangle means "press this to hear something", two
  // bars mean "this is running". A note icon that merely dims is a thing you have to learn.
  $('musicBtn').firstElementChild.firstElementChild
    .setAttribute('href', music.playing ? '#i-pause' : '#i-play');
  $('musicBtn').classList.toggle('on', music.playing);
  f.classList.toggle('on', sfx.volume > 0);
  f.classList.toggle('muted', sfx.volume === 0);
  // The speaker glyph becomes a crossed-out one at zero, because a grey bar alone is easy to
  // miss when you are wondering why the game went quiet.
  $('sfxBtn').firstElementChild.firstElementChild
    .setAttribute('href', sfx.volume === 0 ? '#i-mute' : '#i-spk');
  syncNowPlaying();
};
// Play/pause. Nothing else: it used to carry the volume fader too, which meant the music level
// was hidden under the transport and the only fader anybody could find was the sound effects one.
$('musicBtn').onclick = async () => { await music.toggle(); syncAudio(); };
$('vol').oninput = e => { music.setVolume(e.target.value / 100); syncAudio(); };

/* Mute, as a real toggle — down to zero and back to whatever it was.
 *
 * Deliberately NOT the same thing as pause. Pause stops the track and loses your place in it;
 * mute leaves it running and silent, which is what you want when somebody walks over to your
 * desk. The same pair exists for the sound effects below, and the two faders behave
 * identically because being able to guess the second one from the first is the whole point of
 * putting them side by side.
 */
let musicBeforeMute = VOLUME_MUSIC_DEFAULT;
$('musicVolBtn').onclick = () => {
  if (music.volume > 0) { musicBeforeMute = music.volume; music.setVolume(0); }
  else music.setVolume(musicBeforeMute || VOLUME_MUSIC_DEFAULT);
  syncAudio();
};

/* Skip, in both directions.
 *
 * Debounced with the same one-shot guard as every other button: a double click on `next` would
 * otherwise fire a crossfade per click, and each one cancels the last mid-ramp — audible as a
 * stutter, and it can leave two tracks half up.
 *
 * No-ops while the music is paused rather than disabled, because a transport whose buttons grey
 * out is a transport you have to look at to use.
 */
const tapSkip = createTap(320);
$('nextTrack').onclick = tapSkip(() => { music.next(); syncAudio(); });
$('prevTrack').onclick = tapSkip(() => { music.prev(); syncAudio(); });

// Mute toggles to zero and back to whatever it was, so it is a real toggle rather than a one-way
// trip that makes you re-find your level by ear.
let sfxBeforeMute = 0.75;
$('sfxBtn').onclick = () => {
  if (sfx.volume > 0) { sfxBeforeMute = sfx.volume; sfx.setVolume(0); }
  else { sfx.setVolume(sfxBeforeMute || 0.75); sfx.play('click'); }
  syncAudio();
};
$('sfxVol').oninput = e => {
  sfx.setVolume(e.target.value / 100);
  sfx.play('click');                     // so dragging the slider demonstrates what it does
  syncAudio();
};
syncAudio();

// ─── net ──────────────────────────────────────────────────────────────────────

const toast = msg => {
  const el = $('toast');
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.style.opacity = '0'; }, 1600);
};

const net = createNet({
  onWelcome: m => {
    world.applyWelcome(m);
    renderer?.invalidateAll();
    renderer?.mapChanged();          // a different map size means a different scale
    if (!m.mapOnly) {
      $('menu').style.display = 'none';
      $('hud').classList.add('on');
      menuViz.stop();                 // the menu is gone; stop drawing to a hidden canvas
      if (!running) {
        running = true;
        last = performance.now();
        acc = 0;                      // a stale accumulator would replay however long the menu was up
        requestAnimationFrame(loop);
      }
      renderer?.resize();             // the canvas was behind the menu; make sure it measured right
    }
  },
  onSnap: snap => {
    // `perkget` only carries an id, and applySnap is about to replace the perk list with one that
    // no longer contains it — so remember the types first. That is what lets a Fire sound
    // different from a Skate.
    const perkTypes = new Map(world.perks.map(k => [k.id, k.type]));
    world.applySnap(snap);

    for (const e of snap.ev || []) {
      switch (e.e) {
        case 'blockhit': case 'blockdie': case 'blocknew':
          world.applyBlockEvent(e);
          renderer?.invalidateTile(e.x, e.y);
          if (e.e !== 'blockhit') sfx.play(e.e, e.x, e.y);
          break;

        case 'bomb':
          // Your own bomb already made a noise the instant you pressed the key, two ticks ago.
          if (e.o !== world.you) sfx.play('place', e.x, e.y, { theirs: true });
          break;

        case 'boom': {
          // Authoritative detonation. Usually we already burst it locally off its own fuse; this
          // is what covers chain reactions, which go off early and without warning. `at` is
          // carried across from the bomb we already knew about so the sound can tell the two
          // apart — a blast before its own fuse ran out is a chain.
          const known = world.bombs.find(b => b.id === e.id);
          world.burstBomb({ id: e.id, tx: e.x, ty: e.y, o: e.o, r: e.r, at: known?.at });
          break;
        }

        case 'perkget': {
          const p = world.players[e.i];
          if (!p) break;
          const type = perkTypes.get(e.id);
          // Rum is the one pickup that might be bad news, so it is the one that does not go up.
          sfx.playAtUnits(type === PERK.RUM ? 'glug' : 'pickup',
            p.rx ?? p.x, p.ry ?? p.y, { perk: type, theirs: e.i !== world.you });
          if (e.i === world.you) {
            showUpgrade(type);
            if (type === PERK.RUM) quips.rum();
          }
          // Say what it was. Four of the five perks are a number going up somewhere in the top
          // bar, which is the last place you are looking while somebody is chasing you.
          const label = PERK_LABEL[type];
          if (label) {
            renderer?.addFloater(
              ((p.rx ?? p.x) / UNITS_PER_TILE) * TILE_PX,
              ((p.ry ?? p.y) / UNITS_PER_TILE) * TILE_PX - TILE_PX * 0.5,
              label.text, label.colour);
          }
          break;
        }

        case 'shield': {
          const p = world.players[e.i];
          if (p) sfx.playAtUnits('shield', p.rx ?? p.x, p.ry ?? p.y, { theirs: e.i !== world.you });
          // Being saved by a shield deserves to be as legible as dying would have been.
          if (e.i === world.you) renderer?.addFlash(0.4, '90,209,160');
          break;
        }

        case 'status': {
          const p = world.players[e.i];
          if (p) sfx.playAtUnits('status', p.rx ?? p.x, p.ry ?? p.y, { theirs: e.i !== world.you });
          break;
        }

        case 'spawn':
          // Only your own. Sixteen players respawning at ten seconds apiece meant something was
          // ballooning across the board every few seconds, which buried the thing the effect is
          // for — finding YOURSELF. Everyone else still gets the panned arrival sound.
          if (e.i === world.you) world.markSpawn(e.i);
          // Panned and attenuated by where it happened, so the sound alone tells you which side
          // of you somebody just appeared on. Your own is centred, because you are not elsewhere.
          if (e.i === world.you) { sfx.play('ownSpawn'); quips.spawned(); }
          else sfx.playAtUnits('spawn', e.x, e.y, { theirs: true });
          break;

        // The death screen is driven by whether you are alive (see the HUD block below), not by
        // this event. An event can arrive on the same snapshot as the respawn that follows it, and
        // a missed one used to leave you playing behind an overlay or staring at nothing.
        case 'died': {
          const who = world.players[e.i];
          const by = world.players[e.by];
          killFeed(e.i === e.by
            ? `${nameOf(e.i)} blew ${e.i === world.you ? 'yourself' : 'themselves'} up`
            : `${nameOf(e.by)} bombed ${nameOf(e.i)}`,
          { youDied: e.i === world.you, youKilled: e.by === world.you && e.i !== world.you });
          if (e.i === world.you) {
            sfx.play('ownDeath');
            // Deeper and slower than a blast: this is the one moment the music should get out
            // of the way completely and come back as you read the card.
            music.dip(0.75, 1.1);
            renderer?.addFlash(0.8, '220,60,48');     // you, specifically, just died
            renderer?.addShake(0.7);
            showDeadBanner(e.by === e.i ? 'you blew yourself up' : `${nameOf(e.by)} got you`);
            quips.died();
          } else if (e.by === world.you) {
            sfx.play('kill');
            renderer?.addFlash(0.22, '134,217,255');   // an accent blink: that one was yours
          } else sfx.playAtUnits('death', e.x, e.y, { theirs: true });
          break;
        }
      }
    }
  },
  onRoundEnd: m => {
    renderRoundTable(m);
    /* Two different endings, and the difference between them is length.
     *
     * Winning gets four and a half seconds of actual fanfare; everybody else gets a second of
     * something catchier. That asymmetry IS the reward — there is nothing else the game can
     * give you at this moment, and a win that sounds the same as fifteenth place is not a win.
     *
     * The consolation is deliberately not sad. Most rounds are losing rounds for fifteen out of
     * sixteen people, and a sound you hear that often had better not be one you learn to dread.
     */
    const won = (m.standings || [])[0]?.i === world.you;
    $('deadTitle').textContent = won ? 'you won the round' : 'round over';
    $('dead').firstElementChild.classList.toggle('won', won);
    $('dead').firstElementChild.classList.add('round');
    $('dead').style.display = 'grid';
    sfx.play(won ? 'fanfare' : 'playoff');
    // Get the music out of the way of it, for as long as it runs.
    music.dip(won ? 0.7 : 0.4, won ? 3.6 : 1.1);
    $('respawn').style.display = 'none';
    roundOverUntil = performance.now() + m.startsInMs;
    setTimeout(() => {
      roundOverUntil = 0;
      $('dead').style.display = 'none';
      $('respawn').style.display = '';
      $('deadTitle').textContent = 'you died';
      $('dead').firstElementChild.classList.remove('round', 'won');
      $('roundRows').textContent = '';
      $('roundNext').textContent = '';
    }, m.startsInMs);
  },
  // Lifetime rank, once a second. See the comment on emitScores in server/room.js for why this
  // is not in the snapshot.
  onScores: m => {
    ranks.clear();
    for (const r of m.ranks || []) {
      ranks.set(r.i, r);
      // Authoritative names, once a second. See emitScores in server/room.js.
      const p = world.players[r.i];
      if (p && r.name && p.name !== r.name) p.name = r.name;
    }
    allTime = m.top || [];
    hostSeat = m.host ?? -1;
    if (scoresOpen) renderScores();
  },
  /**
   * Kill streaks. The server decides what counts; this only has to make it impossible to miss.
   * Shape: { t:'streak', i, name, kind, ace }.
   */
  // The host moved the finish line. One field, and the HUD clock follows it from the next frame.
  onRoundTime: m => { world.roundEndsAtTick = m.endsAtTick; },

  onStreak: m => {
    const el = $('streak');
    // How far up the ladder, from the name the server sent. Everything scales off it: the type
    // gets bigger, the chord gets wider, the sweep gets longer.
    const step = m.ace ? 1
      : m.kind.startsWith('RAMPAGE') ? 0.85
      : m.kind.startsWith('ULTRA') ? 0.65
      : m.kind.startsWith('TRIPLE') ? 0.35 : 0;
    const tier = m.ace ? 'ace' : step >= 0.85 ? 's4' : step >= 0.65 ? 's4' : step >= 0.35 ? 's3' : 's2';

    el.querySelector('.big').textContent = `${m.kind}!!`;
    el.querySelector('.who').textContent = m.i === world.you ? 'you' : m.name;
    el.className = tier;
    // Restart the animation even if one is already running — a triple arriving on top of a
    // double has to replace it, not be swallowed by it.
    void el.offsetWidth;
    el.classList.add('show');

    sfx.play('streak', undefined, undefined, { step });
    // Duck the music under the announcement, scaled by the rung. The top of the ladder takes a
    // big bite and comes back over a second — the same trick a film uses when something lands.
    music.dip(0.35 + step * 0.4, 0.8 + step * 0.7);
    if (m.i === world.you) {
      // The accent golds, so the flash is the same light the banner is cast in.
      renderer?.addFlash(0.26 + step * 0.34, m.ace ? '246,231,169' : '237,194,78');
      renderer?.addShake(0.26 + step * 0.5);
    } else {
      // Somebody ELSE is on a run. A small shake, because the thing worth knowing is that it is
      // happening at all — and no flash, which would read as something having hit you.
      renderer?.addShake(0.08 + step * 0.16);
    }
    killFeed(`${m.i === world.you ? 'you' : m.name}: ${m.kind}!!`,
      { youKilled: m.i === world.you });
  },
  onChat: m => {
    const li = document.createElement('li');
    const who = document.createElement('b');
    who.textContent = m.i === -1 ? '' : `${m.name}: `;
    if (m.i >= 0) who.style.color = playerColor(m.i);
    li.append(who, document.createTextNode(m.msg));   // textContent only: never innerHTML
    const mentioned = world.me() && m.msg.toLowerCase().includes(world.me().name.toLowerCase());
    if (m.i === world.you) li.className = 'mine';
    else if (mentioned) li.className = 'mention';
    pushLine(li);
    /* Your own line makes no noise — you just typed it, you know.
     *
     * Two different sounds, because they are two different events: a message is ambient and a
     * message with your name in it is addressed to you. The second is louder, three notes rather
     * than two, and is the only chat sound that will pull your eyes off the board. */
    if (m.i !== world.you) sfx.play(mentioned ? 'mention' : 'chat');
  },
  /**
   * Turned away. The usual reason is that this browser's identity is already in a game, which is
   * a state somebody can be stuck in forever if the only feedback is the word "rejected" — so
   * when the server says the identity is the problem, offer the way out next to the message.
   */
  onRejected: m => {
    running = false;
    $('menu').style.display = 'grid';
    $('hud').classList.remove('on');
    $('play').disabled = false;
    toast(m.why);
    if (m.forget) {
      // net.js has already dropped the stored id, so pressing play again simply works.
      $('signedOut').textContent = `${m.why}. press play to start a new session.`;
      $('signedOut').style.display = '';
    }
  },
  // The connection readout lives in the HUD, which is hidden until you are in a game. Before
  // that, a full server or an unreachable one has to say so somewhere you can actually see it.
  onStatus: s => {
    // A dot, not a word. "open" is the state nine hundred and ninety-nine seconds out of a
    // thousand, and a label that almost never changes is a label nobody reads. The state still
    // goes on the title, so hovering says exactly what it is.
    $('conn').dataset.state = s;
    // The transport rides along in the tooltip: "open · webtransport". Worth having somewhere
    // visible, because a silent fallback to WebSocket is invisible by design.
    $('conn').title = s === 'open' && net.transport ? `${s} \u00b7 ${net.transport}` : s;
    if (running) return;
    toast(s);
    $('play').disabled = s === 'connecting' || s === 'open';
    if (s.startsWith('rejected')) $('play').disabled = false;
  },
});

const nameOf = i => (i === world.you ? 'you' : world.players[i]?.name ?? '?');
const chatHasFocus = () => document.activeElement === $('chatInput');
// Note: no isTyping override. It defaults to typingSomewhere(), which asks whether focus is in
// ANY text field — passing chatHasFocus here is what made WASD unusable in the name box.
const input = createInput({
  onReserved: what => toast(`${what} is not in this build yet`),
});

// ─── loop ─────────────────────────────────────────────────────────────────────

let acc = 0, last = performance.now(), hudAt = 0, roundOverUntil = 0;
let lastMask = 0;
const fuseStage = new Map();     // bomb id -> how urgent it sounded last time
let warnedAt = -1;
let tickedAt = -1;
// Wall clock, not ticks: a hiccup is presentation, and the sim must never be asked to be
// irregular about anything.
let nextHiccupAt = 0;

/**
 * Your own bomb, the instant you press the key.
 *
 * The server's `bomb` event is two ticks behind, and 66 ms of lag on the one sound you trigger
 * yourself is the difference between responsive and mushy. The client knows every reason a
 * placement would be refused — dead, pacifist, out of bombs, already a bomb on this tile — so it
 * can be honest about it rather than clicking optimistically and being wrong.
 */
function localBombFeedback(mask) {
  const pressed = (mask & IN_BOMB) && !(lastMask & IN_BOMB);
  lastMask = mask;
  if (!pressed) return;
  const me = world.me();
  if (!me || !me.alive) return;
  // The same tile the sim will choose, from the same function — the sound has to come from
  // where the bomb actually lands, which with facing-placement is rarely where you stand.
  const { tx, ty } = bombTile(world, me);
  if (world.bombs.some(b => b.tx === tx && b.ty === ty)) return;
  if (world.bombs.reduce((n, b) => n + ((b.o ?? b.owner) === world.you ? 1 : 0), 0) >= me.bombs) return;
  sfx.play('place', tx, ty);
}

/**
 * A fuse you can hear. Pure gameplay information: a bomb round a corner is invisible, and in a
 * game where the whole skill is knowing where not to stand, that is worth a quiet tick.
 * Four stages, accelerating, so urgency is audible without counting.
 */
function fuseTicks() {
  for (const b of world.bombs) {
    const rem = b.at - world.tick;
    const stage = rem > 30 ? -1 : rem > 20 ? 0 : rem > 12 ? 1 : rem > 6 ? 2 : rem > 0 ? 3 : 4;
    if (stage < 0 || stage > 3) continue;
    if (fuseStage.get(b.id) === stage) continue;
    fuseStage.set(b.id, stage);
    sfx.play('fuse', b.tx, b.ty, { urgency: stage / 3 });
  }
  // Bomb ids only ever grow, so this would too.
  if (fuseStage.size > 64) {
    const live = new Set(world.bombs.map(b => b.id));
    for (const id of fuseStage.keys()) if (!live.has(id)) fuseStage.delete(id);
  }
}

/**
 * Lost yourself? Say where you are again.
 *
 * Fifteen seconds of no input, alive, and the arrival animation replays: the sprite blows up to
 * full size and collapses with its shockwave. This is the same cue as spawning because it is the
 * same question — on a thirty-nine tile board with sixteen pirates on it, "which one am I" is
 * genuinely hard after you look away, and hunting for your own colour is worse than being told.
 *
 * Keyed off input rather than off movement: standing still behind a wall on purpose is being
 * idle in exactly the sense that matters, and a player held in place by a bomb is not.
 */
const IDLE_MARK_MS = 15_000;
let lastActivityAt = 0;

function idlePing(now) {
  const me = world.me();
  if (!me || !me.alive) { lastActivityAt = now; return; }
  if (input.mask !== 0) { lastActivityAt = now; return; }
  if (!lastActivityAt) { lastActivityAt = now; return; }
  if (now - lastActivityAt < IDLE_MARK_MS) return;
  lastActivityAt = now;
  world.markSpawn(world.you);
  sfx.play('ownSpawn');
}

function loop(now) {
  // Bail before re-arming, so leaving genuinely stops the loop. Returning to the menu and
  // pressing play used to start a second one on top of the first: two simulation steps and two
  // input packets per tick, which is indistinguishable from the server lagging.
  if (!running) return;
  requestAnimationFrame(loop);
  const raw = now - last;
  const dt = Math.min(250, raw);            // a backgrounded tab must not replay two minutes
  last = now;
  acc += dt;
  // The clamp above just skipped (raw - 250) ms of simulation. Re-tie the clock to real time, or
  // every input from here lands in the server's past until a 1-tick-per-second crawl catches up.
  if (raw > 250) net.resync();

  // A hidden tab is not playing. Keep the loop alive so the clock and the socket survive, but
  // stop simulating and stop sending: a throttled tab stepping five ticks per second produces
  // nothing but corrections.
  if (document.hidden) { acc = 0; return; }

  sfx.frame();                              // resets the per-frame sound budget

  // Exactly one simulation step per TICK_MS of real time, never more than a handful at once.
  let steps = 0;
  while (acc >= TICK_MS && steps++ < 5) {
    acc -= TICK_MS;
    const tick = net.advanceTick();
    // A spectator still advances the clock — the interpolator is driven from it — but has
    // nothing to predict and nothing to send. The server ignores input from a watcher anyway;
    // not sending it is the difference between ignored and never asked.
    if (observing) continue;
    const mask = input.mask;
    localBombFeedback(mask);
    world.predict(tick, mask);
    const me = world.me();
    net.send({ t: 'input', tick, m: mask, x: me?.x | 0, y: me?.y | 0 });
  }
  // Fell badly behind: drop it rather than catching up — and resync, for the same reason.
  if (acc > TICK_MS * 5) { acc = 0; net.resync(); }

  idlePing(now);
  fuseTicks();
  world.updateFires();
  world.interpolate(net.serverTickNow(), dt);
  // BEFORE the renderer, not after: it reads the analyser and hands the result to the sea, and
  // doing it afterwards would draw this frame's water with last frame's music.
  syncMeter(dt);
  renderer.frame(dt);

  // Five times a second is plenty for a clock, a loadout and a track name, and it keeps a
  // pile of DOM writes out of the frame that has to draw sixteen players.
  if (now - hudAt > 200) { hudAt = now; drawHud(); syncNowPlaying(); }
  quips.tick();
  quips.idle();
}

// ─── HUD ──────────────────────────────────────────────────────────────────────

/**
 * Write a value, and flash it if it changed.
 *
 * The flash is the point. A number in the corner that silently becomes a different number is
 * invisible while you are being chased — picking up a Fire has to announce itself. Colour alone
 * is not enough either: peripheral vision notices movement far more reliably than hue, which is
 * why the keyframe scales as well as recolours.
 *
 * Restarting the animation needs the class off, a forced reflow, and the class back on. Without
 * the reflow the browser coalesces both changes into no change at all, and two pickups in quick
 * succession only flash once.
 */
function setValue(el, text, { worse = false, calm = false } = {}) {
  if (!el || el.textContent === String(text)) return;
  const first = el.textContent === '' || el.textContent === '--';
  el.textContent = text;
  if (first) return;                        // joining is not an event worth flashing
  const cls = calm ? 'bump-calm' : worse ? 'bump-bad' : 'bump';
  el.classList.remove('bump', 'bump-bad', 'bump-calm');
  void el.offsetWidth;
  el.classList.add(cls);
}

/**
 * One loadout pip.
 *
 * `base` is what you start the round with, so a pip lights only once you have picked something
 * up: every player has one bomb from the first tick, and a bar that is lit from the start tells
 * you nothing. Speed, shields and stim all start at zero, so for those the default is right.
 */
/**
 * Float a badge for a passive upgrade, then throw it away.
 *
 * The element removes itself on animationend rather than on a timer: a tab that was hidden for
 * the duration never ran the animation, and a timer would delete a badge that had not yet been
 * seen. Capped at three on screen, because collecting a cluster should not build a tower.
 */
function showUpgrade(type) {
  const up = UPGRADES[type];
  if (!up) return;
  const me = world.me();
  const have = type === 3 ? me?.speed : type === 4 ? me?.shields : me?.staminaLevel;

  const box = $('ups');
  while (box.children.length >= 3) box.firstChild.remove();
  // Stack, so a second pickup does not land exactly on top of the first.
  const el = document.createElement('div');
  el.className = 'up';
  el.style.color = up.colour;
  el.style.top = `${2 + box.children.length * 30}px`;
  el.innerHTML = `<svg><use href="${up.icon}"/></svg><span>${up.text}</span>`
    + `<span class="lvl">${(have ?? 0)}/${up.of()}</span>`;
  el.addEventListener('animationend', () => el.remove());
  box.append(el);
}

const gearPip = (id, value, cap, base = 0) => {
  const el = $(id);
  setValue(el.querySelector('.n'), value);
  el.querySelector('.cap').textContent = `/${cap}`;
  el.classList.toggle('max', value >= cap);
  // The glow is what reads mid-round, because it is visible without being focused on. The
  // number is there for when you actually look.
  el.classList.toggle('on', value > base);
};

let diedAtTick = -1;
let lastLevel = -1;

/**
 * The experience bar.
 *
 * `into / need` rather than `total / target`, because 3 093 of 26 957 is a distance you can feel
 * and 60 000 of 83 864 is arithmetic. The level number flashes when it changes, which is the one
 * moment here worth interrupting anybody for.
 */
function drawXp(p) {
  if (!p) return;
  const box = $('xp');
  const fill = $('xpFill');
  const levelled = lastLevel >= 0 && p.level > lastLevel;

  $('xpLevel').textContent = `lvl ${p.level}`;
  $('xpNums').textContent = `${p.into.toLocaleString()} / ${p.need.toLocaleString()}`;
  box.classList.toggle('maxed', p.tier === 'Veteran');
  box.title = `${p.xp.toLocaleString()} XP total \u00b7 next level at ${p.nextAt.toLocaleString()}`;

  if (!levelled) { fill.style.width = `${(p.fraction * 100).toFixed(1)}%`; lastLevel = p.level; return; }

  // Levelled. Run the bar to full first, then drop it to where the new level actually starts —
  // animating straight down to a sliver reads as losing progress, which is the opposite of what
  // just happened. The drop is made instant for one frame so only the climb is ever seen.
  lastLevel = p.level;
  fill.style.width = '100%';
  box.classList.remove('levelup');
  void box.offsetWidth;
  box.classList.add('levelup');
  // Its own sound, not the win fanfare: that is four and a half seconds of brass, which is
  // right for a round ending and absurd over a firefight.
  sfx.play('levelup');
  killFeed(`level ${p.level} \u00b7 ${p.tier}`, { youKilled: true });

  setTimeout(() => {
    box.classList.add('resetting');
    fill.style.width = `${(p.fraction * 100).toFixed(1)}%`;
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove('resetting')));
  }, 620);
  setTimeout(() => box.classList.remove('levelup'), 950);
}

/**
 * The respawn countdown, live, on the button itself.
 *
 * Timed from the tick your own `alive` flag went false rather than from anything on the wire:
 * the server owns `respawnAt` but never sends it, and re-deriving it here is accurate to the two
 * ticks of snapshot granularity — which nobody can see in a number that counts whole seconds.
 *
 * The button is genuinely disabled while it counts. A button that looks pressable and does
 * nothing is worse than one that tells you to wait.
 */
function drawRespawn(me) {
  const btn = $('respawn');
  if (me.alive) { diedAtTick = -1; return; }
  if (diedAtTick < 0) diedAtTick = world.tick;
  const left = Math.max(0, RESPAWN_DELAY_TICKS - (world.tick - diedAtTick));
  const secs = Math.ceil(left / TICK_HZ);
  // The moment it becomes pressable, once. You have been watching a number for ten seconds;
  // this is what lets you stop watching it.
  if (btn.disabled && left === 0) sfx.play('ready');
  btn.disabled = left > 0;
  // Calm: this ticks once a second right in front of you, and the full bump is a strobe.
  setValue(btn, left > 0 ? `respawn in ${secs}\u2026` : 'respawn', { calm: true });
}

function drawHud() {
  const me = world.me();
  const left = Math.max(0, (world.roundEndsAtTick || 0) - world.tick);
  const secs = Math.floor(left / TICK_HZ);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');

  // A minute out, one warning. Then the last twenty seconds get a tick each.
  //
  // Urgency is the cube of how far through the twenty you are, not a straight line. A linear
  // ramp spends its first half audibly building, which makes twenty seconds of it exhausting;
  // cubed, it stays a quiet metronome until about eight seconds out and then climbs hard. The
  // shape is the point: the first half says "time is running out", the last few say "NOW".
  const COUNTDOWN_FROM = 20;
  /* Drunk, audibly.
   *
   * The bubbles and the camera roll say it to whoever is looking at the screen; this says it to
   * whoever is looking at the board. Irregular on purpose — a hiccup on a timer is a metronome,
   * and the one thing a hiccup must not be is predictable, so the gap is re-rolled every time
   * between about one and three seconds.
   */
  if (me && (me.status & STATUS.DRUNK)) {
    if (performance.now() >= nextHiccupAt) {
      sfx.play('hiccup');
      nextHiccupAt = performance.now() + 1000 + Math.random() * 2000;
    }
  } else {
    // Sober: the first hiccup of the next bottle comes soon, not after a leftover wait.
    nextHiccupAt = 0;
  }

  if (secs <= 60 && secs > 57 && warnedAt !== 60) { warnedAt = 60; sfx.play('warn'); }
  if (secs > 61) warnedAt = -1;             // a new round re-arms it
  if (secs <= COUNTDOWN_FROM && secs > 0 && secs !== tickedAt) {
    tickedAt = secs;
    const through = (COUNTDOWN_FROM - secs) / (COUNTDOWN_FROM - 1);
    sfx.play('tick', undefined, undefined, { urgency: through * through * through });
  }
  if (secs > COUNTDOWN_FROM) tickedAt = -1;

  $('vClock').textContent = `${mm}:${ss}`;
  $('clock').classList.toggle('low', secs <= 60);
  $('vPing').textContent = `${net.rtt}ms`;
  $('vOnline').textContent = world.players.filter(Boolean).length;
  $('vMap').textContent = world.map?.id ?? '';

  if (!me) {
    // Watching. Everything that is about YOU is meaningless, so it is emptied rather than left
    // showing the last player who happened to be in the slot.
    if (observing) {
      $('who').textContent = 'spectating';
      setValue($('rank'), '');
      $('dead').style.display = 'none';
      renderLive();
    }
    return;
  }

  const mine = ranks.get(world.you);
  $('who').textContent = me.name;
  setValue($('rank'), mine ? mine.tier : '');
  drawXp(mine);
  setValue($('vKills'), me.kills);
  setValue($('vDeaths'), me.deaths, { worse: true });
  // Gold. Lifetime, not this round — it is the one stat here that accumulates, which is the
  // whole point of it, and it is going to be a currency.
  setValue($('vGold'), me.gold || 0);
  renderLive();

  // Every live perk as a pip, lit when you are carrying more than you started with. Shields used
  // to be a separate row of green dots off to the right of the bar; they are a perk like the
  // rest and belong in the same row, counted the same way.
  gearPip('pBombs', me.bombs, MAX_BOMBS_CARRIED, START_BOMBS);
  gearPip('pFire', me.radius, MAX_RADIUS, START_RADIUS);
  gearPip('pSpeed', me.speed, MAX_SKATES);
  gearPip('pShield', me.shields, MAX_SHIELDS);
  gearPip('pStim', me.staminaLevel ?? 0, MAX_STAMINA_LEVELS);

  // drawRespawn first: it is what stamps diedAtTick, and showDead reads it to hold the dialog
  // back. The other order shows the dialog a frame early on the tick you die.
  if (!roundOverUntil) { drawRespawn(me); showDead(!me.alive); }
  if (scoresOpen) renderScores();
}

// ─── backgrounded tabs ────────────────────────────────────────────────────────
//
// Only the tab you are looking at plays. Open the game twice and the one behind freezes: browsers
// throttle requestAnimationFrame in a hidden tab to roughly once a second, so it cannot play
// anyway — all it can do is hold a seat somebody else wants and let its clock drift far enough
// that every input it sends on return lands in the server's past.
//
// So hiding cuts the keys immediately, and staying hidden gives the seat back. Coming back to a
// live tab resyncs the clock, because a throttled tab has been accumulating drift the whole time.

let hiddenSince = 0;
let idleTimer = null;

function onVisibility() {
  if (!running) return;
  if (document.hidden) {
    hiddenSince = performance.now();
    input.clear();                    // never leave a key stranded down in a frozen tab
    music.duck(true);
    net.send({ t: 'input', tick: net.clientTick, m: 0 });
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!document.hidden || !running) return;
      leave();
      toast('left for being idle in a background tab');
    }, IDLE_DISCONNECT_MS);
  } else {
    clearTimeout(idleTimer);
    music.duck(chatHasFocus());
    // However long it was away, the frame loop discarded that time. Re-tie the clock, or every
    // input lands in the server's past until a one-tick-per-second crawl catches up.
    if (hiddenSince) { net.resync(); last = performance.now(); acc = 0; }
    hiddenSince = 0;
  }
}
document.addEventListener('visibilitychange', onVisibility);

// ─── death, scoreboard, leaving ───────────────────────────────────────────────

/**
 * The end-of-round standings, as a table.
 *
 * It was a block of pre-formatted text, which meant the columns only lined up by luck and your
 * own row was indistinguishable from the other fifteen. The one thing anyone wants from this
 * screen is "where did I come", so that row is marked, coloured and scrolled to.
 */
function renderRoundTable(m) {
  const body = $('roundRows');
  body.textContent = '';
  let mine = null;
  for (const [n, p] of (m.standings || []).entries()) {
    const tr = document.createElement('tr');
    const you = p.i === world.you;
    cell(tr, n === 0 ? '1st' : `${n + 1}`, n === 0 ? 'var(--gold)' : null, n !== 0);
    cell(tr, you ? `${p.name} (you)` : p.name, playerColor(p.i));
    num(cell(tr, p.k));
    num(cell(tr, p.d));
    num(cell(tr, p.s));
    if (you) { tr.className = 'me'; mine = tr; }
    body.append(tr);
  }
  $('roundNext').textContent = `next map: ${m.nextMap}`;
  $('roundEmpty').style.display = body.children.length ? 'none' : '';
  // Sixteen rows can overflow the card on a short window; make sure yours is the one on screen.
  mine?.scrollIntoView({ block: 'nearest' });
}

/** YOU DIED, across the middle of the board. Separate from the card, which is the controls. */
function showDeadBanner(by) {
  const el = $('deadBanner');
  el.querySelector('.who').textContent = by;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

/**
 * The death dialog, held back for a beat.
 *
 * Dying is a thing that happens to your player on the board, and covering the board with a panel
 * the same instant takes the moment away — you never see what killed you. The banner and the
 * flash land immediately; the dialog waits for the banner to finish saying who got you, and
 * then another half second on top so the two do not cross-fade into each other.
 */
// The banner runs for 4.4s (see #deadBanner in style.css) and the dialog takes over the instant
// it clears, so the screen is never empty and the two never overlap.
const DEAD_DIALOG_DELAY_TICKS = Math.round(4.4 * TICK_HZ);

function showDead(dead) {
  const held = dead && diedAtTick >= 0 && world.tick - diedAtTick < DEAD_DIALOG_DELAY_TICKS;
  $('dead').style.display = dead && !held ? 'grid' : 'none';
}

/** One place that appends to the log, so trimming and scrolling cannot drift apart. */
function pushLine(li) {
  const list = $('chatList');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  list.append(li);
  while (list.children.length > 60) list.firstChild.remove();
  // Only follow if they were already at the bottom — yanking the view while someone is reading
  // back through a fight is worse than missing the newest line.
  if (atBottom) list.scrollTop = list.scrollHeight;
}

/**
 * The kill feed, with you picked out of it.
 *
 * In a sixteen-player free-for-all the log scrolls constantly, and the only lines that matter to
 * you are the ones you are in. Those get your colour and a marker; everything else stays grey.
 */
function killFeed(text, { youDied = false, youKilled = false } = {}) {
  const li = document.createElement('li');
  li.className = 'feed' + (youKilled ? ' kill' : youDied ? ' death' : '');
  li.textContent = text;
  pushLine(li);
}

/**
 * The standings in the side panel. Always up, because a scoreboard you have to hold a key for is
 * a scoreboard nobody reads in a game where letting go of the keys gets you killed.
 *
 * Rebuilt in place rather than cleared and re-created: this runs five times a second, and
 * replacing sixteen list items that often is both wasteful and makes text unselectable.
 */
function renderLive() {
  const rows = world.players.filter(Boolean)
    .sort((a, b) => b.score - a.score || b.kills - a.kills)
    .slice(0, 12);
  const list = $('liveRows');
  while (list.children.length > rows.length) list.lastChild.remove();
  while (list.children.length < rows.length) {
    const li = document.createElement('li');
    for (const cls of ['pos', 'nm', 'kd', 'sc']) {
      const sp = document.createElement('span');
      sp.className = cls;
      li.append(sp);
    }
    list.append(li);
  }
  for (const [n, p] of rows.entries()) {
    const li = list.children[n];
    const [pos, nm, kd, sc] = li.children;
    pos.textContent = n + 1;
    nm.textContent = p.name;
    nm.style.color = playerColor(p.i);
    // A robot beside anything that is not a person. `bot` comes from the scores broadcast, which
    // is the only place the server says so — the snapshot has no idea what a bot is, and it
    // should not: the simulation treats them identically on purpose.
    li.classList.toggle('bot', !!ranks.get(p.i)?.bot);
    // A crown on whoever can restart the round, change the map or set the speed. It passes down
    // the moment they leave, so the room is never left without somebody who can run it.
    li.classList.toggle('host', p.i === hostSeat);
    kd.textContent = `${p.kills}/${p.deaths}`;
    sc.textContent = p.score;
    li.classList.toggle('me', p.i === world.you);
    li.classList.toggle('out', !p.alive);
  }
}

let scoresOpen = false;
const ranks = new Map();        // seat -> {lifetime, rank, rankName, nextAt}
let allTime = [];
let hostSeat = -1;

function cell(tr, text, colour, dim) {
  const td = document.createElement('td');
  td.textContent = text;
  if (colour) td.style.color = colour;
  if (dim) td.className = 'dimcell';
  tr.append(td);
  return td;
}

/** Tabular figures, so a column of scores lines up instead of shimmering. */
const num = td => { td.classList.add('num'); return td; };

function renderScores() {
  const rows = world.players.filter(Boolean).sort((a, b) => b.score - a.score || b.kills - a.kills);
  const body = $('scoreRows');
  body.textContent = '';
  for (const [n, p] of rows.entries()) {
    const tr = document.createElement('tr');
    const r = ranks.get(p.i);
    cell(tr, n + 1, null, true);
    cell(tr, p.name, playerColor(p.i));
    // The rank ladder is the thing returning Game of Bombs players recognise first, so it gets a
    // column of its own rather than a tooltip.
    cell(tr, r ? `${r.level} \u00b7 ${r.tier}` : '\u2014', null, true);
    num(cell(tr, p.kills));
    num(cell(tr, p.deaths));
    num(cell(tr, p.gold || 0, (p.gold || 0) > 0 ? 'var(--gold)' : null));
    num(cell(tr, r ? r.xp.toLocaleString() : '\u2014', null, true));
    if (p.i === world.you) tr.style.fontWeight = 'bold';
    body.append(tr);
  }

  const best = $('allTimeRows');
  best.textContent = '';
  for (const [n, e] of allTime.entries()) {
    const tr = document.createElement('tr');
    cell(tr, n + 1, null, true);
    cell(tr, e.name);
    cell(tr, `${e.level} \u00b7 ${e.tier}`, null, true);
    num(cell(tr, e.gold || 0, (e.gold || 0) > 0 ? 'var(--gold)' : null));
    num(cell(tr, e.score));
    best.append(tr);
  }
  $('allTime').style.display = allTime.length ? '' : 'none';
}

function leave() {
  net.close();
  world.ready = false;
  running = false;
  $('menu').style.display = 'grid';
  $('hud').classList.remove('on');
  $('dead').style.display = 'none';
  $('scores').classList.remove('on');
  scoresOpen = false;
  roundOverUntil = 0;
  clearTimeout(idleTimer);
  hiddenSince = 0;
  input.clear();
  music.exclude('theme', false);    // back on the landing page, so the theme is allowed again
  music.playFrom('theme');
  $('play').disabled = false;
  $('name').focus();
}

// ─── menu ─────────────────────────────────────────────────────────────────────

/* Music is ON by default, from the first gesture the browser will accept.
 *
 * No browser lets audio start before a user gesture, so "plays by default" can only ever mean
 * "starts at the first click or keypress". Three things make that reliable:
 *
 *   1. **The listener is on the document, not the menu card.** It used to be on `#menu`, which
 *      covers the common path and misses every other one — landing straight into a game from a
 *      reconnect, or a first click that happens to be outside the card.
 *   2. **`music.wanted` is consulted.** It is true unless this browser has explicitly paused
 *      before, so somebody who turned the music off does not get it back every time they open
 *      the page. A default is not the same thing as a decision overridden.
 *   3. **`once: true` plus the guard.** Capture phase so nothing can swallow the gesture first.
 */
let menuAudioTried = false;
function startMenuAudio() {
  if (menuAudioTried) return;
  menuAudioTried = true;
  if (!music.wanted) { syncAudio(); return; }
  // Only put the theme back when we are still on the menu; starting audio mid-round must not
  // drag the landing-page tune into a firefight.
  if (!running) music.exclude('theme', false);
  music.start(running ? BEDS[(Math.random() * BEDS.length) | 0] : 'theme').then(syncAudio);
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(ev, startMenuAudio, { once: true, capture: true });
}

const nameInput = $('name');
nameInput.maxLength = NAME_MAX_CHARS;
nameInput.value = localStorage.getItem('bv.name') || '';

/**
 * @param observe watch instead of play. A spectator takes no seat, so this is also the way in
 *   when the server is full — which is the whole reason the feature exists.
 */
function play(observe = false) {
  $('signedOut').style.display = 'none';
  const name = nameInput.value.trim();
  // A spectator still needs a name for the chat, but not a chosen one.
  if (!name && !observe) { nameInput.focus(); return; }
  if ($('play').disabled) return;          // double-click would otherwise open a second socket
  $('play').disabled = true;
  observing = observe;
  document.body.classList.toggle('observing', observe);
  localStorage.setItem('bv.name', name);
  renderer = createRenderer($('game'), world);
  sfx.start().then(() => sfx.play('click'));
  /* Out of the theme and into a bed, immediately and at random.
   *
   * The theme has a tune and a backbeat: right for twenty seconds of reading a menu, wrong for
   * ten minutes of being hunted. `exclude` keeps it out of the rotation for the whole round, so
   * it cannot come back round mid-firefight; it is let back in when you return to the menu.
   *
   * Random rather than always `drift`, because the first thing you hear should not be the same
   * thing every single time you press PLAY — three rounds in and a fixed opener is the sound of
   * the menu, not the sound of the game. The rotation carries on from whichever one it picked.
   */
  music.exclude('theme');
  music.start(BEDS[(Math.random() * BEDS.length) | 0]).then(syncAudio);
  world.onBoom = bomb => {
    /* How big did that sound?
     *
     * Radius is the only size information a blast carries, and it is enough. A keg is radius 7
     * against a bomb's cap of 6, so it needs no new field on the wire and no flag to go stale:
     * anything over the cap can only be a keg.
     */
    const r = bomb.r ?? bomb.radius ?? 1;
    const keg = r >= POWDER_RADIUS;
    // Somebody else's blast. A keg is nobody's for this purpose — it was not placed, and the
    // one thing everybody needs to hear at full volume is seven tiles of fire going off.
    const theirs = !keg && (bomb.o ?? bomb.owner) !== world.you;
    // A blast before its own fuse ran out was set off by something else. A bomb we never even
    // saw placed counts too — that only happens when a chain reaches it inside one snapshot.
    const chain = bomb.at === undefined || world.tick < bomb.at;
    if (keg) sfx.play('kegboom', bomb.tx, bomb.ty);
    else sfx.play('boom', bomb.tx, bomb.ty, { chain, size: (r - 1) / (MAX_RADIUS - 1), theirs });

    // Shake falls off with distance and is saturating, so a chain reaction across the map rattles
    // once rather than sixteen times. Nothing past eight tiles moves the camera at all.
    const me = world.me();
    if (!me) return;
    const d = Math.hypot(bomb.tx - me.rx / UNITS_PER_TILE, bomb.ty - me.ry / UNITS_PER_TILE);
    if (d >= 8) return;

    /* Pull the music down under anything that went off near you.
     *
     * Same falloff as the shake and for the same reason: this is about blasts you are IN, not
     * blasts you can hear. Scaled by distance and by size, so a keg at your feet takes a big
     * bite and a small bomb five tiles away barely moves it. dip() itself refuses to undo an
     * earlier dip that is still recovering, so a chain reaction ducks once and deeply rather
     * than stuttering.
     */
    music.dip((keg ? 0.62 : 0.38) * (1 - d / 8));
    // Yours kicks harder than someone else's at the same distance. You pressed the button; the
    // screen agreeing with you is most of what makes a bomb feel like it went off.
    const mine = (bomb.o ?? bomb.owner) === world.you;
    renderer?.addShake((mine ? 0.75 : 0.5) * (1 - d / 8));
  };
  net.connect(name || 'watcher', observe);
}

/** True while this tab is watching rather than playing. Read by the HUD and the input loop. */
let observing = false;

$('play').onclick = () => play(false);
$('watch').onclick = () => play(true);
nameInput.onkeydown = e => { if (e.key === 'Enter') play(false); };

// Switching to spectating from the death screen. A fresh connection rather than a mode flag on
// the open one: the server frees the seat on disconnect, which is the point — somebody waiting
// gets it, and that is a better outcome than a seat held by a person who has stopped playing.
$('spectate').onclick = createTap()(() => {
  $('dead').style.display = 'none';
  net.close();
  $('play').disabled = false;
  play(true);
});
$('deadLeave').onclick = createTap()(leave);

// ─── chat ─────────────────────────────────────────────────────────────────────

/* Every one-shot gets its own cooldown.
 *
 * Its OWN, not a shared one: a single guard across all of them would mean opening the
 * scoreboard swallowed the Escape that closes it. Each action only has to be protected from
 * itself.
 */
const tapChat = createTap();
const tapEscape = createTap();
const tapScores = createTap();
const tapRespawn = createTap();

const toggleScores = tapScores(() => {
  scoresOpen = !scoresOpen;
  $('scores').classList.toggle('on', scoresOpen);
  if (scoresOpen) renderScores();
});

const openChat = tapChat(() => { $('chatInput').focus(); music.duck(true); });

const onEscape = tapEscape(() => {
  if (chatHasFocus()) { $('chatInput').blur(); music.duck(false); }
  else if (scoresOpen) { scoresOpen = false; $('scores').classList.remove('on'); }
  else if (running) leave();                 // there has to be a way out of the game
});

// The one place a respawn is actually asked for. Both the button and the spacebar come through
// here, because they are the same action and a held Space is otherwise both at once — thirty
// synthetic button clicks a second on top of thirty keypresses.
const askRespawn = tapRespawn(() => net.send({ t: 'respawn' }));

addEventListener('keydown', e => {
  // Auto-repeat is never a second press. Holding Tab used to toggle the scoreboard thirty times
  // a second, and holding Escape left the game.
  if (e.repeat) return;

  if (e.key === 'Enter' && !chatHasFocus() && running) { e.preventDefault(); openChat(); return; }
  if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
  if (e.code === 'Tab' && running && !typingSomewhere()) { e.preventDefault(); toggleScores(); return; }

  // Space is respawn while you are dead, and nothing else: the browser would otherwise fire it
  // at whatever button happens to hold focus.
  if ((e.code === 'Space' || e.code === 'KeyK') && running && !typingSomewhere()) {
    const me = world.me();
    if (me && !me.alive) { e.preventDefault(); askRespawn(); }
  }
});

$('leave').onclick = createTap()(leave);
$('respawn').onclick = askRespawn;

// Ducking hangs off focus, not off the keys that usually cause it — clicking into the chat box
// with the mouse is the same thing to the person doing it.
$('chatInput').onfocus = () => music.duck(true);
$('chatInput').onblur = () => { music.duck(false); input.clear(); };

$('chatInput').onkeydown = e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const msg = $('chatInput').value.trim();
  if (msg) net.send({ t: 'chat', msg });
  $('chatInput').value = '';
  $('chatInput').blur();
  music.duck(false);
  input.clear();
};
