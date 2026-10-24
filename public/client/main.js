// Boot, the fixed-step loop, and the menu.
//
// No framework and no jQuery: the menu is one input and one button, and jQuery inside a frame
// loop is exactly the thing docs/ARCHITECTURE.md §9 forbids. If the UI ever grows past this,
// revisit — right now vanilla is the smaller answer.

import {
  TICK_MS, TICK_HZ, NAME_MAX_CHARS, UNITS_PER_TILE, IN_BOMB, IN_SLIDE, playerColor,
  MAX_SKATES, MAX_SHIELDS, MAX_STAMINA_LEVELS, IDLE_DISCONNECT_MS, RESPAWN_DELAY_TICKS, TILE_PX,
  MAX_BOMBS_CARRIED, MAX_RADIUS, START_BOMBS, START_RADIUS,
  POWDER_RADIUS, PERK, STATUS, VOLUME_MUSIC_DEFAULT,
  CHAT_MIN_INTERVAL_MS, STREAK_WINDOW_TICKS,
} from '/shared/constants.js';
// The one number the password box needs to quote at somebody. The rules themselves live on the
// server — see badPassword in server/accounts.js — and this is only the hint text.
import { PASSWORD_MIN } from '/shared/constants.js';
import { createNet } from './net.js';
import { createInput, typingSomewhere, createTap } from './input.js';
import { createWorld } from './world.js';
import { createRenderer } from './render.js';
import { createMusic } from './audio/music.js';
import { createSfx } from './audio/sfx.js';
import { createListener } from './audio/listen.js';
import { createQuips, MENU_QUIPS } from './quips.js';
import { createMenuViz } from './menuviz.js';
import { store } from './store.js';
import { bombTile } from '/shared/sim/bombs.js';
import { MAPS } from '/shared/maps.js';

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

/* Auto respawn, remembered across sessions.
 *
 * A preference rather than a per-round choice, so it lives in localStorage beside the volume
 * sliders. Default OFF: respawning the instant you die skips the ten seconds in which you can
 * read who killed you and where, and turning that on should be somebody's decision rather than
 * something they have to discover and switch back.
 */
const AUTO_KEY = 'bv.autoRespawn';
let autoRespawn = store.get(AUTO_KEY) === '1';

/* The three in-game beds, in rotation order. The theme is not one of them: it belongs to the
 * landing page and is excluded for the whole of a round. */
const BEDS = ['drift', 'suspend', 'undertow'];

// The landing page listening to itself. Its own rAF loop, started with the menu and stopped the
// moment a round begins — there is no point analysing audio nobody is looking at.
const menuViz = createMenuViz({ canvas: $('menuViz'), music });
menuViz.start();

/* The same visualiser again, between rounds.
 *
 * A second instance rather than moving the first: they are two canvases in two different boxes,
 * and `createMenuViz` was already written to own no global state so that exactly this would be
 * possible (see the note on `pointer`). The two are never running at once — the menu one stops
 * when a round starts, this one only runs during an intermission — so the cost is one idle
 * object for the whole session.
 *
 * Each instance keeps its own `spectrum`, which is correct precisely because only one of them is
 * ever reading the analyser at a time.
 */
const roundViz = createMenuViz({ canvas: $('roundViz'), music });

/* The pointer, fed to the menu visualiser so the motes can get out of its way.
 *
 * On `#menu` rather than on the window: the motes only exist while the menu is up, and a
 * listener on the window would keep firing all round. Coordinates are relative to the canvas,
 * which is inset:0 inside #menu, so the menu's own box is the right frame.
 */
/* The version marker under the title.
 *
 * Fetched rather than baked in: baking it would need a build step, and this project does not
 * have one. The markup carries a hard-coded fallback, so a failed fetch shows a stale number
 * rather than an empty space — and the title is the one place on the site where an empty space
 * would be more noticeable than a wrong digit.
 *
 * `title` carries the build sha, so "which version" and "which build" are both answerable from
 * the landing page without opening devtools.
 */
fetch('/version')
  .then(r => (r.ok ? r.json() : null))
  .then(v => {
    if (!v?.version) return;
    const el = $('version');
    el.textContent = `v${v.version}`;
    if (v.build) el.title = `build ${v.build}`;
  })
  .catch(() => { /* the fallback in the markup is already correct enough */ });

const menuBox = $('menu');
menuBox.addEventListener('pointermove', e => {
  const r = menuBox.getBoundingClientRect();
  menuViz.pointer(e.clientX - r.left, e.clientY - r.top);
});
menuBox.addEventListener('pointerleave', () => menuViz.pointerOut());

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
// Looked up once: syncMeter runs every frame.
const dockEl = $('dock'), avatarEl = $('avatar');
function syncMeter(dtMs) {
  const live = music.playing && music.volume > 0 && music.analyser;
  if (live) menuViz.spectrum.read(music.analyser, dtMs);
  else menuViz.spectrum.rest(dtMs);

  const s = menuViz.spectrum;
  // The sea is NOT driven from here: it has its own ear (audio/listen.js, via renderer.setSound),
  // because it wants beats and tempo, which these smoothed bars blur away.
  const v = [s.bass, s.mid, s.treble];
  for (let i = 0; i < eqBars.length; i++) {
    // 3px floor so a silent bar is still a bar. Zero-height is a missing element, not a quiet one.
    // A scale of a full-height bar, not a height: see `.eq b` in style.css.
    eqBars[i].style.transform = `scaleY(${((3 + v[i] * 8) / 11).toFixed(3)})`;
  }
  // One number for everything that wants to breathe with the kick.
  dockEl.style.setProperty('--bass', s.bass.toFixed(3));

  /* The mascot, which is where the sea's old reactivity went.
   *
   * `--bob` lifts him on the bass and `--kick` squashes and lights him on the transient. Both
   * ride on top of the CSS float rather than replacing it, so he carries on bobbing in silence.
   * Written as custom properties because `translate` and `scale` are composited — no layout, no
   * paint, and a style write per frame on one element is nothing. */
  const av = avatarEl;
  av.style.setProperty('--bob', s.bass.toFixed(3));
  // The kick is the RISE in the bass, not its level: a sustained bass note should hold him up,
  // not keep punching him. Falls away fast, so it is a hit rather than a state.
  kick = Math.max(kick * Math.pow(0.86, dtMs / 16.7), Math.max(0, s.bass - lastBass) * 3.2);
  lastBass = s.bass;
  av.style.setProperty('--kick', Math.min(1, kick).toFixed(3));
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
/* One tab makes the noise. Whichever one you are looking at.
 *
 * Three tabs of this game open — which happens constantly, because the link gets reopened rather
 * than switched to — meant three copies of the same soundtrack a few hundred milliseconds apart.
 * That is not three times the music, it is a phaser, and it is the single most obvious way the
 * site can sound broken.
 *
 * A `BroadcastChannel` is the whole mechanism: the tab that becomes visible shouts, every other
 * tab hears it and cedes, and the one that shouted takes the speakers. Last claim wins, which is
 * right — the most recent thing you looked at is the thing you meant.
 *
 * Ceding is NOT muting: the music keeps running silently (`music.cede`), so coming back finds the
 * track where it would have been rather than restarting it mid-phrase, and the volume slider still
 * shows what the person chose rather than a zero they did not ask for.
 *
 * A browser without BroadcastChannel keeps the old behaviour, which is "every tab plays". That is
 * the correct fallback: the alternative would be a tab that has no way to claim the audio back and
 * is therefore silent forever.
 */
const audioBus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('bv.audio') : null;

function claimAudio() {
  music.cede(false);
  sfx.cede(false);
  audioBus?.postMessage({ claim: Date.now() });
}

if (audioBus) {
  audioBus.onmessage = e => {
    if (!e.data?.claim) return;
    music.cede(true);
    sfx.cede(true);
    syncAudio();
  };
  // Visibility rather than focus alone: switching tabs fires this, and so does coming back to a
  // minimised window. `focus` is kept as well for the case of two windows side by side, where
  // both are visible and the click decides.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) claimAudio(); });
  addEventListener('focus', claimAudio);
  // And on the way in, so the tab you just opened is the one you hear.
  if (!document.hidden) claimAudio();
}

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
    // A full welcome outside an intermission IS the next round — on time, or early because the
    // host typed /restart or /map — so the standings go the moment it lands, not on a timer.
    if (roundOverUntil && !m.mapOnly && !m.between) endIntermission();
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

        // Ice breaking. The tile itself already changed with the `blockdie` just before this; the
        // water arrives in the snapshot's puddle list. This is only the moment of it.
        case 'melt':
          renderer?.addMelt(e.x, e.y);
          sfx.play('melt', e.x, e.y);
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

        // A gull caught in a blast. The tumble, the feathers and the sound are the renderer's;
        // the line in the feed is ours, and it names whoever's fire it was.
        case 'gullhit': {
          renderer?.gullHit(e);
          if (e.by >= 0 && world.players[e.by]) {
            const spoils = e.coins ? ` · ${e.coins} gold` : e.cx !== undefined ? ' · it dropped gold' : '';
            killFeed(`${nameOf(e.by)} downed a gull${spoils}`, { youKilled: e.by === world.you });
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

        /* Somebody slid. The dust and the streaks are drawn straight off `slideV` in the
         * renderer — they have to be, so your own slide starts on the frame you asked for it
         * rather than a round trip later — so this event exists for the NOISE alone, which is
         * the one part that cannot be derived from a snapshot without firing again on every
         * replay of the same tick. */
        case 'slide':
          sfx.playAtUnits('slide', e.x, e.y, { theirs: e.i !== world.you });
          break;

        // Barged by one. The question mark is drawn from the status bit; this is the thump.
        case 'dazed':
          sfx.playAtUnits('dazed', e.x, e.y, { theirs: e.i !== world.you });
          if (e.i === world.you) {
            renderer?.addShake(0.3);
            renderer?.addFlash(0.18, '255,224,74');
          }
          break;

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
          // The body comes apart where the server says it fell, not where the sprite was being
          // drawn: a death two tiles from the rendered position is a death in the wrong place.
          renderer?.addDeathDust(e.i, e.x, e.y);
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
    startIntermission(m.startsInMs);
    clearTimeout(roundOverTimer);
    roundOverTimer = setTimeout(endIntermission, m.startsInMs);
  },
  // Lifetime rank, once a second. See the comment on emitScores in server/room.js for why this
  // is not in the snapshot.
  onScores: m => {
    ranks.clear();
    botNames.clear();
    for (const r of m.ranks || []) {
      if (r.bot && r.name) botNames.add(r.name.toLowerCase());
      ranks.set(r.i, r);
      // Authoritative names, once a second. See emitScores in server/room.js.
      const p = world.players[r.i];
      if (p && r.name && p.name !== r.name) p.name = r.name;
      // The renderer puts a robot before a bot's name on the field, same as the scoreboard.
      if (p) p.isBot = !!r.bot;
    }
    allTime = m.top || [];
    hostSeat = m.host ?? -1;
    // The renderer draws a crown over the host's head, so it needs the same fact. On the world
    // rather than passed in: `drawOne` runs sixteen times a frame and the renderer has no other
    // channel for per-round facts that arrive once a second.
    world.host = hostSeat;
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
    /* How far up the ladder. `n` is the rung — 2 for a double through 5 for a rampage, 6 for an
     * ace — and the prefix matching is the fallback for a server that predates the field.
     * Everything scales off `step`: the type gets bigger, the chord gets wider, and the rainbow
     * pours faster. */
    const step = m.n !== undefined
      ? Math.min(1, Math.max(0, (m.n - 2) / 4))
      : m.ace ? 1
        : m.kind.startsWith('RAMPAGE') ? 0.85
          : m.kind.startsWith('ULTRA') ? 0.65
            : m.kind.startsWith('TRIPLE') ? 0.35 : 0;
    const tier = m.ace ? 'ace' : step >= 0.65 ? 's4' : step >= 0.35 ? 's3' : 's2';

    /* One period of the rainbow, in seconds, per rung: 2.2 for a double, then 1.6, 1.1, 0.75,
     * and 0.5 for an ace. The colours never change, so the SPEED is the whole escalation — and
     * because the same value drives the banner, the chat line and the name in the corner, the
     * three read as one event moving at one pace. */
    const flow = `${(2.2 - step * 1.7).toFixed(2)}s`;
    const big = el.querySelector('.big');
    const who = el.querySelector('.who');
    big.textContent = `${m.kind}!!`;
    withBotIcons(who, m.i === world.you ? 'you' : m.name);
    el.className = tier;
    for (const part of [big, who]) {
      part.classList.add('rainbow');
      part.style.setProperty('--flow', flow);
    }
    // Your own name in the corner, for as long as the run could still continue. See streakGlow.
    if (m.i === world.you) streakGlow(flow);

    /* Not while you are dead.
     *
     * The death card is centred on the same board this lands on, and a kill streak over the top
     * of your own respawn countdown is noise at the one moment you are not playing. The sound
     * still plays — somebody is on a run and that is worth hearing — but the banner waits for
     * a round where you are in it.
     */
    const dead = document.body.classList.contains('dead');
    if (!dead) {
      // Restart the animation even if one is already running — a triple arriving on top of a
      // double has to replace it, not be swallowed by it.
      void el.offsetWidth;
      el.classList.add('show');
    }

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
    /* The same announcement, in the feed, in the same rainbow at the same speed.
     *
     * The banner is gone in two and a half seconds and it only ever shows the LAST thing that
     * happened; the feed is the record, and a run of four lines pouring colour at four different
     * speeds is the clearest picture of a round anybody gets. Built by hand rather than through
     * `killFeed` because this is the one feed line with structure in it: the name and the
     * announcement are separate spans so each can carry the gradient on its own.
     */
    const li = document.createElement('li');
    li.className = `feed streakLine${m.i === world.you ? ' kill' : ''}`;
    const nameEl = document.createElement('span');
    nameEl.className = 'rainbow';
    nameEl.style.setProperty('--flow', flow);
    withBotIcons(nameEl, m.i === world.you ? 'you' : m.name);
    const kindEl = document.createElement('span');
    kindEl.className = 'rainbow';
    kindEl.style.setProperty('--flow', flow);
    kindEl.textContent = `${m.kind}!!`;
    li.append(nameEl, document.createTextNode(' · '), kindEl);
    pushLine(li);
  },
  onChat: m => {
    const li = document.createElement('li');
    const who = document.createElement('b');
    withBotIcons(who, m.i === -1 ? '' : `${m.name}: `);
    if (m.i >= 0) who.style.color = playerColor(m.i);
    li.append(who, withBotIcons(document.createElement('span'), m.msg));   // textContent only: never innerHTML
    /* Short lines also appear over the speaker's head.
     *
     * This is what makes emotes and chat one feature rather than two: an emote is just a very
     * short message, so anything that makes a bubble for short chat makes one for emotes too,
     * with no second path to keep in step.
     *
     * NOT commands. `/kick bob` is addressed to the server, the reply comes back as a SERVER
     * line, and putting the command itself over somebody's head would broadcast a thing they
     * typed privately to the room. Not the server's own lines either (`i === -1`) — nobody is
     * standing there to say them.
     */
    const SAY_MAX = 24;
    if (m.i >= 0 && m.msg.length <= SAY_MAX && !m.msg.startsWith('/')) {
      renderer?.say(m.i, m.msg);
    }

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
    /* Turned away because of a password, which is not an error — it is the next step.
     *
     * So it gets the box and a sentence, and NOT a toast: a toast says "something went wrong",
     * and the right reading of "pick a password for yourself" is "the sign-up is one field
     * long". `auth` tells us which of the three it is; see askPassword.
     */
    if (m.auth) {
      askPassword(m.auth, m.why);
      nameInput.blur();
      return;
    }
    closePassword();
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

/* Bots carry the robot everywhere their name appears — the feed, chat, the banners, the boards —
 * not only on the live scoreboard. Names of the bots seated right now, lowercased, refreshed by
 * the scores broadcast, which is the only place the server says who is a bot. */
const botNames = new Set();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Write `text` into `el`, with a robot in front of every seated bot's name in it. */
function withBotIcons(el, text) {
  const s = String(text);
  el.textContent = '';
  if (!botNames.size) { el.textContent = s; return el; }
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${[...botNames].map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  let at = 0;
  for (const m of s.matchAll(re)) {
    const start = m.index + m[1].length;
    if (start > at) el.append(s.slice(at, start));
    const icon = document.createElement('span');
    icon.className = 'botIcon';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', 'bot');
    el.append(icon, m[2]);
    at = start + m[2].length;
  }
  if (at < s.length) el.append(s.slice(at));
  return el;
}
const chatHasFocus = () => document.activeElement === $('chatInput');
// Note: no isTyping override. It defaults to typingSomewhere(), which asks whether focus is in
// ANY text field — passing chatHasFocus here is what made WASD unusable in the name box.
/* The four emotes, in compass order: up, left, down, right.
 *
 * Four and not eight. Eight needs diagonals, diagonals need two keys, and the whole value of
 * this is that it is one key and over before you have thought about it. These four cover what
 * anybody actually says mid-round: nice one, no, that was funny, and love it.
 */
const EMOTES = ['\u{1F44D}', '\u{1F44E}', '\u{1F602}', '❤️'];

/* An emote IS a chat message.
 *
 * Not a new message type, and that is the whole design. It goes down the existing chat path, so
 * the server sanitises it, rate-limits it and broadcasts it with no new code; it lands in the
 * log like anything else; and the bubble above the player comes free, because short chat
 * messages already get one. One mechanism, two features, nothing to keep in step.
 *
 * The cooldown is longer than the server's own chat interval on purpose: the server simply
 * drops anything faster, so a client that allowed faster would be firing emotes that silently
 * never happened.
 */
const EMOTE_COOLDOWN_MS = CHAT_MIN_INTERVAL_MS + 200;
let emoteAt = 0;
function sendEmote(slot) {
  const e = EMOTES[slot];
  const now = performance.now();
  if (!e || !world.ready || now - emoteAt < EMOTE_COOLDOWN_MS) return;
  emoteAt = now;
  net.send({ t: 'chat', msg: e });
}

/* One emote per Shift.
 *
 * The wheel goes the moment you pick, even with Shift still down, and does not come back until
 * you have let go and held again. Holding Shift is the question; picking is the answer; leaving
 * the question on screen after it has been answered is a legend sitting over the board while
 * you are trying to see what you walked into. */
let pickerSpent = false;
const showPicker = on => $('emotePick').classList.toggle('on', on && !pickerSpent);

// The picker's glyphs come from the same array, so the legend and what it sends cannot drift
// apart. Here rather than at the top of the file: `EMOTES` is a const, and reading it before
// its declaration is executed is a temporal dead zone error, not an undefined.
for (const [i, el] of [...document.querySelectorAll('#emotePick .ekey b')].entries()) {
  el.textContent = EMOTES[i] ?? '';
}

const input = createInput({
  onEmote: slot => {
    sendEmote(slot);
    pickerSpent = true;
    showPicker(false);
  },
  onEmoteMenu: on => {
    if (!on) pickerSpent = false;      // Shift released: the next hold gets a wheel again
    showPicker(on);
  },
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
// The mascot's reaction to the music: see syncMeter. `kick` decays, `lastBass` is what the
// rise is measured against.
let kick = 0, lastBass = 0;

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

  // Exactly one simulation step per tick of real time, never more than a handful at once. The
  // tick's length is the SERVER's, which /gamespeed changes — stepping on a fixed TICK_MS here
  // while the server ran at 200% is what pinned players in place. See `tickMs` in net.js.
  const step = net.tickMs;
  world.tickMs = step;
  let steps = 0;
  while (acc >= step && steps++ < 5) {
    acc -= step;
    const tick = net.advanceTick();
    // A spectator still advances the clock — the interpolator is driven from it — but has
    // nothing to predict and nothing to send. The server ignores input from a watcher anyway;
    // not sending it is the difference between ignored and never asked.
    // Between rounds the server simulates nothing, so predicting would walk you off on your own.
    if (observing || roundOverUntil) continue;
    // The slide bit rides on this tick's mask only. `takeSlide` clears as it reads, so the five
    // steps a stalled frame can run cannot turn one double-tap into five launches.
    const mask = input.mask | (input.takeSlide() ? IN_SLIDE : 0);
    localBombFeedback(mask);
    world.predict(tick, mask);
    const me = world.me();
    net.send({ t: 'input', tick, m: mask, x: me?.x | 0, y: me?.y | 0 });
  }
  // Fell badly behind: drop it rather than catching up — and resync, for the same reason.
  if (acc > step * 5) { acc = 0; net.resync(); }

  // BEFORE the renderer, not after: it reads the analyser and hands the result to the sea, and
  // doing it afterwards would draw this frame's water with last frame's music.
  syncMeter(dt);
  if (roundOverUntil) {
    // The board is hidden and frozen; draw nothing on it until the next round's welcome.
    syncCountdown(now);
  } else {
    idlePing(now);
    syncCountIn();
    fuseTicks();
    world.updateFires();
    world.interpolate(net.serverTickNow(), dt);
    renderer.frame(dt);
  }

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
/**
 * Write text into a cast-gold element.
 *
 * Cast text has a transparent fill with a gradient clipped through it, which means it can carry
 * neither a text-shadow (it would show through the inside of every glyph) nor a filter (that
 * forces a compositing layer, and a text-clip composited is what turned the name into a black
 * smudge). So the drop shadow is a SECOND COPY of the same text, in a pseudo-element behind it
 * — plain opaque text, which can take any shadow you like.
 *
 * CSS cannot read an element's text content, only its attributes. `data-text` is the copy the
 * pseudo-element reads, and this is the one place that keeps the two in step.
 */
function castText(el, text) {
  const s = String(text);
  if (el.dataset.text === s) return;
  el.textContent = s;
  el.dataset.text = s;
}

/* Your own name, in the corner, while your run is live.
 *
 * The banner is about the kill; this is about the player, so it stays up for as long as the run
 * could still continue — STREAK_WINDOW_TICKS, the same window the server uses to decide whether
 * the next kill counts. When it lapses the name goes back to its cast gold, which is itself
 * information: the run is over.
 *
 * A fresh kill inside the window simply replaces the timer and the speed, so a streak that keeps
 * climbing never drops back to gold in between.
 */
let streakGlowTimer = 0;

function streakGlow(flow) {
  const el = $('who');
  el.style.setProperty('--flow', flow);
  el.classList.add('rainbow');
  clearTimeout(streakGlowTimer);
  streakGlowTimer = setTimeout(() => el.classList.remove('rainbow'),
    (STREAK_WINDOW_TICKS / TICK_HZ) * 1000);
}

function setValue(el, text, { worse = false, calm = false } = {}) {
  if (!el || el.textContent === String(text)) return;
  // An em dash is the placeholder these start at; see the top bar in index.html. Arriving at a
  // real value from one is a join, not an event, so it does not flash.
  const first = el.textContent === '' || el.textContent === '\u2014';
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
  const justUnlocked = btn.disabled && left === 0;
  if (justUnlocked) sfx.play('ready');
  btn.disabled = left > 0;
  /* Auto respawn fires on that same edge, and only on it.
   *
   * On the EDGE rather than on `left === 0`, because this function runs five times a second for
   * as long as you are dead: without the edge it would send a respawn request every 200 ms
   * until the server got round to honouring one. The request is debounced downstream as well,
   * but a guard that relies on the debounce is a guard that breaks when somebody retunes it. */
  if (justUnlocked && autoRespawn) askRespawn();
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

  castText($('vClock'), `${mm}:${ss}`);
  $('clock').classList.toggle('low', secs <= 60);
  $('vPing').textContent = `${net.rtt}ms`;
  $('vOnline').textContent = world.players.filter(Boolean).length;
  $('vMap').textContent = world.map?.id ?? '';

  if (!me) {
    // Watching. Everything that is about YOU is meaningless, so it is emptied rather than left
    // showing the last player who happened to be in the slot.
    if (observing) {
      castText($('who'), 'spectating');
      setValue($('rank'), '');
      $('dead').style.display = 'none';
      renderLive();
    }
    return;
  }

  const mine = ranks.get(world.you);
  castText($('who'), me.name);
  setValue($('rank'), mine ? mine.tier : '');
  drawXp(mine);
  drawCabinet(mine?.medals);
  setValue($('vKills'), me.kills);
  setValue($('vDeaths'), me.deaths, { worse: true });
  // Gold. Lifetime, not this round — it is the one stat here that accumulates, which is the
  // whole point of it, and it is going to be a currency.
  setValue($('vCoins'), me.coins || 0);
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
    placeCell(tr, n);
    cell(tr, you ? `${p.name} (you)` : p.name, playerColor(p.i));
    num(cell(tr, p.k));
    num(cell(tr, p.d));
    num(cell(tr, p.s)).classList.add('score');
    if (you) { tr.classList.add('me'); mine = tr; }
    body.append(tr);
  }
  $('nextMapName').textContent = MAPS.find(x => x.id === m.nextMap)?.name ?? m.nextMap ?? '';
  $('roundEmpty').style.display = body.children.length ? 'none' : '';
  // Sixteen rows can overflow the card on a short window; make sure yours is the one on screen.
  mine?.scrollIntoView({ block: 'nearest' });
}

/**
 * Between rounds: the board goes, the standings stay, and a bar fills until the next round.
 *
 * The simulation is paused on the server for the whole intermission, but the board used to keep
 * drawing — players frozen mid-stride or still walking on their own prediction, the sea rolling,
 * banners firing — behind a translucent card. Now `body.intermission` hides the field outright
 * and `loop` stops predicting and drawing until the round is back.
 */
let roundOverTimer = 0;

function startIntermission(ms) {
  document.body.classList.add('intermission');
  input.clear();
  // The board is hidden for the next twenty seconds and the music keeps playing, so the thing
  // that was listening to it on the landing page comes back for exactly that long.
  roundViz.start();
  // A round that ended inside its own count-in would otherwise leave the digit hanging over the
  // scoreboard. Cleared here rather than hidden by CSS, so the next round starts it cleanly.
  $('countIn').classList.remove('on', 'hot');
  countInShown = -1;
  const fill = $('roundBar').firstElementChild;
  fill.style.animation = 'none';
  void fill.offsetWidth;                 // restart, or a second intermission starts full
  fill.style.animation = `roundFill ${ms}ms linear forwards`;
  syncCountdown(performance.now());
}

function endIntermission() {
  clearTimeout(roundOverTimer);
  roundOverUntil = 0;
  // Back to the board. Nothing analyses audio nobody is looking at — the same rule the menu one
  // follows when a round starts.
  roundViz.stop();
  document.body.classList.remove('intermission');
  $('dead').style.display = 'none';
  $('respawn').style.display = '';
  $('deadTitle').textContent = 'you died';
  $('dead').firstElementChild.classList.remove('round', 'won');
  $('roundRows').textContent = '';
  $('nextMapName').textContent = '';
  $('roundCountdown').textContent = '';
}

function syncCountdown(now) {
  const s = Math.max(0, Math.ceil((roundOverUntil - now) / 1000));
  const text = s > 0 ? `next round in ${s}s` : 'here we go';
  const el = $('roundCountdown');
  if (el.textContent !== text) el.textContent = text;     // called every frame; write once a second
}

/* ─── the count-in ──────────────────────────────────────────────────────────────
 *
 * Five seconds at the top of every round, under the clock, ticking like one.
 *
 * Driven from the ROUND'S OWN TICK rather than from a local timer, which is the only detail here
 * that matters: `world.tick` restarts at zero with every fresh state the server installs, so the
 * digit everybody is looking at is the same digit at the same instant, with no message to send
 * and nothing to keep in step. It also means somebody who joins four seconds into a round sees
 * "1" and then GO — the truth — rather than a fresh five seconds of their own.
 *
 * Presentation only. The simulation is live underneath it: the round clock is already running and
 * a bomb placed on the first tick goes off on schedule. This is the beat that tells a room full of
 * people the map has loaded and the fight is on, not a gate on the fight — gating movement is a
 * server rule and would want its own state on the wire. Easy to add if it is wanted.
 */
const COUNT_IN_SECONDS = 5;
const COUNT_IN_TICKS = COUNT_IN_SECONDS * TICK_HZ;
let countInShown = -1;             // the digit on screen, so each second is written once

function syncCountIn() {
  const el = $('countIn');
  const left = COUNT_IN_TICKS - world.tick;
  // Over, or not this round: the GO frame is left to finish its own animation.
  if (left < -TICK_HZ || !world.ready) {
    if (countInShown !== -1) { el.classList.remove('on', 'hot'); countInShown = -1; }
    return;
  }
  // 5..1 while there is time left, then 0 for the GO beat.
  const n = Math.max(0, Math.ceil(left / TICK_HZ));
  if (n === countInShown) return;
  countInShown = n;

  const num = $('countInN');
  el.classList.add('on');
  el.classList.toggle('hot', n > 0 && n <= 2);
  num.classList.toggle('go', n === 0);
  num.textContent = n > 0 ? String(n) : 'GO';
  // Restart the tick animation on every digit: without this the class is already applied and
  // the second one simply replaces the text inside a finished animation.
  num.style.animation = 'none';
  void num.offsetWidth;
  num.style.animation = '';

  if (n > 0) {
    // The same voice the round clock's last seconds use, climbing the same way — so the end of
    // the count-in and the end of the round sound like the same clock.
    sfx.play('tick', undefined, undefined, { urgency: (COUNT_IN_SECONDS - n) / COUNT_IN_SECONDS });
  } else {
    sfx.play('go');
    renderer?.addFlash(0.2, '237,194,78');
  }
}

/** YOU DIED, across the middle of the board. Separate from the card, which is the controls. */
function showDeadBanner(by) {
  const el = $('deadBanner');
  withBotIcons(el.querySelector('.who'), by);
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');

  /* A streak announcement cannot share the screen with this one.
   *
   * They occupy the same spot, they are the same size, and only one of them is about you. A
   * RAMPAGE landing on top of YOU DIED is somebody else's good news written over your bad news
   * — and because the streak banner runs on its own timer it would simply erase this one
   * mid-sentence. Killed outright rather than queued: by the time it could be shown again the
   * run it was announcing is three kills further on. */
  $('streak').classList.remove('show');

  // Everything that has to look dead, in one place — see `body.dead` in style.css. The name in
  // the corner goes the colour of the banner and the mascot's face loses its colour.
  document.body.classList.add('dead');
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
  // Alive again: the corner goes back to gold and the mascot gets his colour back.
  if (!dead) document.body.classList.remove('dead');
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
  withBotIcons(li, text);
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
    // Only rebuilt when the place in this slot changes — this runs five times a second, and the
    // slot's place never changes at all once the list exists. Cheap either way.
    if (pos.dataset.n !== String(n)) { pos.dataset.n = n; pos.replaceChildren(placeMark(n)); }
    for (const k of [1, 2, 3]) li.classList.toggle(`p${k}`, n === k - 1);
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
  withBotIcons(td, text);
  if (colour) td.style.color = colour;
  if (dim) td.className = 'dimcell';
  tr.append(td);
  return td;
}

/** Tabular figures, so a column of scores lines up instead of shimmering. */
const num = td => { td.classList.add('num'); return td; };

const PLACES = ['1st', '2nd', '3rd'];

/**
 * A medal for the podium, a plain number for everyone else.
 *
 * Drawn by CSS (`.medal.m1`–`m3` in style.css) so all four boards share one set of medals. It
 * keeps an accessible name, because a picture of a "1" is not a "1" to a screen reader.
 */
function placeMark(n) {
  if (n > 2) return document.createTextNode(String(n + 1));
  const m = document.createElement('span');
  m.className = `medal m${n + 1}`;
  m.setAttribute('role', 'img');
  m.setAttribute('aria-label', `${PLACES[n]} place`);
  m.title = PLACES[n];
  return m;
}

/**
 * A player's lifetime medals: gold, silver and bronze, each a small medal and a count.
 *
 * All three are always there, in place order, with an empty one dimmed rather than left out —
 * a column whose entries change shape row to row cannot be read down, and "no silver yet" is
 * worth seeing. `counts` is [gold, silver, bronze]; missing means nobody has told us yet.
 */
function medalTally(counts) {
  const wrap = document.createElement('span');
  wrap.className = 'tally';
  if (!counts) { wrap.textContent = '—'; wrap.classList.add('none'); return wrap; }
  const total = counts.reduce((a, b) => a + (b || 0), 0);
  wrap.setAttribute('aria-label', `${counts[0] || 0} gold, ${counts[1] || 0} silver, ${counts[2] || 0} bronze`);
  wrap.title = total ? `${counts[0] || 0} gold · ${counts[1] || 0} silver · ${counts[2] || 0} bronze`
    : 'no podium finishes yet';
  for (let k = 0; k < 3; k++) {
    const n = counts[k] || 0;
    const t = document.createElement('span');
    t.className = 't' + (n ? '' : ' zero');
    const m = document.createElement('span');
    m.className = `medal mini m${k + 1}`;
    m.setAttribute('aria-hidden', 'true');
    t.append(m, String(n));
    wrap.append(t);
  }
  return wrap;
}

/**
 * Your own medals, on your stats card. Rebuilt only when a count changes: the HUD redraws every
 * frame, and these change at most once a round.
 */
let cabinetKey = '';
function drawCabinet(counts) {
  const key = counts ? counts.join(',') : '';
  if (key === cabinetKey) return;
  cabinetKey = key;
  const el = $('cardMedals');
  el.replaceChildren();
  if (!counts) return;
  const label = document.createElement('span');
  label.className = 'k';
  label.textContent = 'medals';
  el.append(label, medalTally(counts));
}

/** The place column of a table row, and the podium tint on the row itself. */
function placeCell(tr, n) {
  const td = document.createElement('td');
  td.className = 'place';
  td.append(placeMark(n));
  if (n < 3) tr.classList.add(`p${n + 1}`);
  tr.append(td);
  return td;
}

function renderScores() {
  const rows = world.players.filter(Boolean).sort((a, b) => b.score - a.score || b.kills - a.kills);
  const body = $('scoreRows');
  body.textContent = '';
  for (const [n, p] of rows.entries()) {
    const tr = document.createElement('tr');
    const r = ranks.get(p.i);
    placeCell(tr, n);
    // The crown rides with the name here exactly as it does on the live list: same mark, same
    // size, same meaning. See `td.host` in style.css — it is one mask, so there is one crown in
    // the project and three places that show it.
    const nameCell = cell(tr, p.name, playerColor(p.i));
    if (p.i === hostSeat) nameCell.classList.add('host');
    // The rank ladder is the thing returning Game of Bombs players recognise first, so it gets a
    // column of its own rather than a tooltip.
    cell(tr, r ? `${r.level} \u00b7 ${r.tier}` : '\u2014', null, true);
    cell(tr, '').append(medalTally(r?.medals));
    num(cell(tr, p.kills));
    num(cell(tr, p.deaths));
    // Coins this life, then the round score. Both, because they answer different questions:
    // the score is who is winning right now, the coins are what you are taking away from it.
    num(cell(tr, p.coins || 0, (p.coins || 0) > 0 ? 'var(--gold)' : null));
    num(cell(tr, p.score)).classList.add('score');
    num(cell(tr, r ? r.xp.toLocaleString() : '\u2014', null, true));
    if (p.i === world.you) tr.classList.add('me');
    body.append(tr);
  }

  const best = $('allTimeRows');
  best.textContent = '';
  for (const [n, e] of allTime.entries()) {
    const tr = document.createElement('tr');
    placeCell(tr, n);
    cell(tr, e.name);
    cell(tr, `${e.level} \u00b7 ${e.tier}`, null, true);
    cell(tr, '').append(medalTally([e.gold, e.silver, e.bronze]));
    num(cell(tr, e.coins || 0, (e.coins || 0) > 0 ? 'var(--gold)' : null));
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
  endIntermission();
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
nameInput.value = store.get('bv.name') || '';

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
  /* The password, if the box is open, and the box is only open because the server asked.
   *
   * Read here and passed straight down to `connect`: it is never stored, never kept in a module
   * variable, and the field is cleared the moment it has been sent. The only thing that persists
   * is the token the server sends back, which is what stops the box ever opening again on this
   * machine. See trustFor in client/net.js.
   */
  const pw = pwOpen && !observe ? $('pw').value : '';
  if (pwOpen && !observe && !pw) { $('pw').focus(); return; }
  $('play').disabled = true;
  observing = observe;
  document.body.classList.toggle('observing', observe);
  store.set('bv.name', name);
  renderer = createRenderer($('game'), world);
  // Gulls. The renderer decides when one calls and when one comes down, because it is the
  // only thing that knows where they are drawn; the sounds belong here with the rest.
  renderer.onGullCry = (tx, ty) => sfx.play('gull', tx, ty);
  renderer.onGullDown = (tx, ty) => sfx.play('gullhit', tx, ty);
  // The sea dances to the music. The renderer asks once a frame; see audio/listen.js.
  const listen = createListener();
  renderer.setSound(dtMs => {
    // How far the speakers are behind the analyser. The listener delays everything by this, so
    // a swell lands when the kick is heard rather than a few frames before it.
    const c = music.seaAnalyser?.context;
    const latencyS = c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
    const s = listen(music.seaAnalyser, music.audible, dtMs, latencyS);
    /* How loud it is SET, which the listener cannot know.
     *
     * The sea's analyser is tapped before the volume fader — deliberately, so the water reads the
     * music's content rather than the slider — which means nothing downstream can tell a muted
     * track from a silent one. The coast needs that difference to decide whether to light at all,
     * so it is added here, where both facts are in scope.
     */
    s.vol = music.audible ? music.volume : 0;
    return s;
  });
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
  world.onBoom = (bomb, cells) => {
    // Smoke off every tile the blast reached, before anything below can return early.
    renderer?.addSmoke(cells || [], (bomb.r ?? bomb.radius ?? 1) >= POWDER_RADIUS);
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
  net.connect(name || 'watcher', observe, pw || null);
  // Out of the DOM as soon as it has gone down the socket. There is no reason for it to still be
  // in a form field behind the game, and a cleared field is also the signal that a retry needs
  // it typed again rather than silently re-sending the one that was just refused.
  $('pw').value = '';
}

/* The password box: shut until the server asks for it, and it says WHY it is asking.
 *
 * Three states and they are genuinely different situations:
 *
 *   signup  this name has never been claimed. Whatever is typed here becomes its password, so the
 *           field is `new-password` and a manager will offer to generate and save one.
 *   need    the name is claimed and this browser is not trusted. `current-password`.
 *   bad     the last attempt was wrong, or there have been too many. Same field, red note, and
 *           the value cleared — never left in place to be re-sent by a reconnect.
 */
let pwOpen = false;

function askPassword(mode, why) {
  pwOpen = true;
  const group = $('pwGroup');
  const note = $('pwNote');
  const input = $('pw');
  group.hidden = false;
  input.type = 'password';
  input.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  input.placeholder = mode === 'signup' ? `at least ${PASSWORD_MIN} characters` : 'your password';
  $('pwLabel').textContent = mode === 'signup' ? 'SET PASSWORD:' : 'PASSWORD:';
  note.hidden = false;
  note.className = mode === 'bad' || mode === 'wait' ? 'bad' : '';
  note.textContent = mode === 'signup'
    ? `"${nameInput.value.trim()}" is yours to claim. Pick a password — you will only be asked for it again on a new browser.`
    : why;
  input.value = '';
  input.focus();
}

function closePassword() {
  pwOpen = false;
  $('pwGroup').hidden = true;
  $('pwNote').hidden = true;
  $('pw').value = '';
}

/** True while this tab is watching rather than playing. Read by the HUD and the input loop. */
let observing = false;

$('play').onclick = () => play(false);
$('watch').onclick = () => play(true);
nameInput.onkeydown = e => { if (e.key === 'Enter') play(false); };
// Enter in the password box plays, so a sign-in is name, tab, password, enter and nothing else.
$('pw').onkeydown = e => { if (e.key === 'Enter') play(false); };
// A different name is a different account, so whatever was typed for the last one is wrong by
// definition — and leaving it there is how somebody sends one person's password to another's
// sign-in. Closed rather than cleared: the server will ask again if it needs to.
nameInput.oninput = () => { if (pwOpen) closePassword(); };

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

/* The scoreboard's two panes. Clicks only: it is a thing you read, not a thing you do mid-fight,
 * and a second key to remember would cost more than it is worth. The pane is NOT reset when the
 * panel closes, so somebody reading the rules between rounds still has them on the next Tab. */
for (const b of document.querySelectorAll('#boardTabs .bt')) {
  b.onclick = () => {
    $('scoresCard').classList.toggle('rules', b.dataset.pane === 'rules');
    for (const o of document.querySelectorAll('#boardTabs .bt')) o.classList.toggle('on', o === b);
  };
}

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

/* The checkbox, and the stored value, kept in step in one place.
 *
 * `checked` is set from storage at boot rather than from the markup, so the box always shows
 * what will actually happen — a checkbox whose state is a guess is worse than no checkbox.
 */
$('autoRespawn').checked = autoRespawn;
$('autoRespawn').onchange = e => {
  autoRespawn = e.target.checked;
  store.set(AUTO_KEY, autoRespawn ? '1' : '0');
  sfx.play('click');
  // Turned on while already waiting out a countdown that has finished: honour it now rather
  // than on the next death, which would be a setting that appears not to work.
  if (autoRespawn && !$('respawn').disabled && $('dead').style.display !== 'none') askRespawn();
};

// Ducking hangs off focus, not off the keys that usually cause it — clicking into the chat box
// with the mouse is the same thing to the person doing it.
$('chatInput').onfocus = () => music.duck(true);
$('chatInput').onblur = () => { music.duck(false); input.clear(); };

$('chatInput').onkeydown = e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  /* And stop it here.
   *
   * This Enter bubbles up to the window handler that OPENS the chat, and by the time it gets
   * there the blur below has already run — so `chatHasFocus()` is false, the handler does what
   * it is for, and the box you just left takes focus straight back. Two correct handlers, one
   * event, and the second undoes the first. */
  e.stopPropagation();
  const msg = $('chatInput').value.trim();
  if (msg) net.send({ t: 'chat', msg });
  $('chatInput').value = '';
  /* Something to say is one thing; a command is a conversation.
   *
   * An ordinary message is finished the moment you press Enter, so the keyboard goes straight
   * back to the board — WASD should move you, not sit in an empty text box while something
   * walks into you. A command is not finished: the answer comes back as a SERVER line a moment
   * later, and half of them are "no such map" or "you need to be host", which you then retype.
   * Staying in the box is right there and wrong on the board. */
  if (!msg.startsWith('/')) {
    $('chatInput').blur();
    // Focus the canvas rather than merely leaving it on <body>: a click on the board then goes
    // where you expect, and nothing else can quietly claim the keyboard in between.
    $('game').focus({ preventScroll: true });
    music.duck(false);
    input.clear();
  }
};
