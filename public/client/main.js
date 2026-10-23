// Boot, the fixed-step loop, and the menu.
//
// No framework and no jQuery: the menu is one input and one button, and jQuery inside a frame
// loop is exactly the thing docs/ARCHITECTURE.md §9 forbids. If the UI ever grows past this,
// revisit — right now vanilla is the smaller answer.

import {
  TICK_MS, TICK_HZ, NAME_MAX_CHARS, UNITS_PER_TILE, IN_BOMB, playerColor,
} from '/shared/constants.js';
import { createNet } from './net.js';
import { createInput, typingSomewhere } from './input.js';
import { createWorld } from './world.js';
import { createRenderer } from './render.js';
import { createMusic } from './audio/music.js';
import { createSfx } from './audio/sfx.js';
import { drawMascot } from '/assets/art.js';

const $ = id => document.getElementById(id);

// ─── landing mascot ───────────────────────────────────────────────────────────

(function mascot() {
  const c = $('mascot').getContext('2d');
  c.imageSmoothingEnabled = false;
  c.scale(2, 2);                                   // 96px of art, drawn at 192
  const t0 = performance.now();
  (function paint() {
    if ($('menu').style.display !== 'none') {
      c.clearRect(0, 0, 96, 96);
      drawMascot(c, (performance.now() - t0) / 1000);
    }
    requestAnimationFrame(paint);
  })();
})();
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

const syncAudio = () => {
  $('musicBtn').textContent = music.playing ? '♪ on' : '♪ off';
  $('vol').value = Math.round(music.volume * 100);
  $('sfxVol').value = Math.round(sfx.volume * 100);
};
$('musicBtn').onclick = async () => { await music.toggle(); syncAudio(); };
$('vol').oninput = e => music.setVolume(e.target.value / 100);
$('sfxVol').oninput = e => {
  sfx.setVolume(e.target.value / 100);
  sfx.play('click');                     // so dragging the slider demonstrates what it does
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
    if (!m.mapOnly) {
      $('menu').style.display = 'none';
      $('hud').style.display = 'flex';
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
          if (e.o !== world.you) sfx.play('place', e.x, e.y);
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
          if (p) sfx.playAtUnits('pickup', p.rx ?? p.x, p.ry ?? p.y, { perk: perkTypes.get(e.id) });
          break;
        }

        case 'shield': {
          const p = world.players[e.i];
          if (p) sfx.playAtUnits('shield', p.rx ?? p.x, p.ry ?? p.y);
          break;
        }

        case 'status': {
          const p = world.players[e.i];
          if (p) sfx.playAtUnits('status', p.rx ?? p.x, p.ry ?? p.y);
          break;
        }

        case 'spawn':
          if (e.i === world.you) sfx.play('ownSpawn');
          else sfx.playAtUnits('spawn', e.x, e.y);
          break;

        // The death screen is driven by whether you are alive (see the HUD block below), not by
        // this event. An event can arrive on the same snapshot as the respawn that follows it, and
        // a missed one used to leave you playing behind an overlay or staring at nothing.
        case 'died': {
          const who = world.players[e.i];
          const by = world.players[e.by];
          killFeed(e.i === e.by
            ? `${who?.name ?? '?'} blew themselves up`
            : `${by?.name ?? '?'} bombed ${who?.name ?? '?'}`);
          if (e.i === world.you) sfx.play('ownDeath');
          else if (e.by === world.you) sfx.play('kill');
          else sfx.playAtUnits('death', e.x, e.y);
          break;
        }
      }
    }
  },
  onRoundEnd: m => {
    const list = m.standings.map((p, n) =>
      `${n + 1}. ${p.name}  ${p.s} pts  ${p.k}/${p.d}`).join('\n');
    $('deadTitle').textContent = 'round over';
    $('deadText').textContent = `${list}\n\nnext: ${m.nextMap}`;
    $('dead').style.display = 'grid';
    sfx.play('fanfare');
    $('respawn').style.display = 'none';
    roundOverUntil = performance.now() + m.startsInMs;
    setTimeout(() => {
      roundOverUntil = 0;
      $('dead').style.display = 'none';
      $('respawn').style.display = '';
      $('deadTitle').textContent = 'you died';
      $('deadText').textContent = 'space to respawn · esc to leave';
    }, m.startsInMs);
  },
  onChat: m => {
    const li = document.createElement('li');
    const who = document.createElement('b');
    who.textContent = m.i === -1 ? '' : `${m.name}: `;
    if (m.i >= 0) who.style.color = playerColor(m.i);
    li.append(who, document.createTextNode(m.msg));   // textContent only: never innerHTML
    const list = $('chatList');
    list.append(li);
    while (list.children.length > 50) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
  },
  // The connection readout lives in the HUD, which is hidden until you are in a game. Before
  // that, a full server or an unreachable one has to say so somewhere you can actually see it.
  onStatus: s => {
    $('conn').textContent = s;
    $('conn').dataset.state = s;
    if (running) return;
    toast(s);
    $('play').disabled = s === 'connecting' || s === 'open';
    if (s.startsWith('rejected')) $('play').disabled = false;
  },
});

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
  const tx = me.x >> 8, ty = me.y >> 8;
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

function loop(now) {
  // Bail before re-arming, so leaving genuinely stops the loop. Returning to the menu and
  // pressing play used to start a second one on top of the first: two simulation steps and two
  // input packets per tick, which is indistinguishable from the server lagging.
  if (!running) return;
  requestAnimationFrame(loop);
  const dt = Math.min(250, now - last);     // a backgrounded tab must not replay two minutes
  last = now;
  acc += dt;

  sfx.frame();                              // resets the per-frame sound budget

  // Exactly one simulation step per TICK_MS of real time, never more than a handful at once.
  let steps = 0;
  while (acc >= TICK_MS && steps++ < 5) {
    acc -= TICK_MS;
    const tick = net.advanceTick();
    const mask = input.mask;
    localBombFeedback(mask);
    world.predict(tick, mask);
    const me = world.me();
    net.send({ t: 'input', tick, m: mask, x: me?.x | 0, y: me?.y | 0 });
  }
  if (acc > TICK_MS * 5) acc = 0;           // fell badly behind: drop it rather than catching up

  fuseTicks();
  world.updateFires();
  world.interpolate(net.serverTickNow(), dt);
  renderer.frame(dt);

  if (now - hudAt > 200) {
    hudAt = now;
    const me = world.me();
    const left = Math.max(0, (world.roundEndsAtTick || 0) - world.tick);
    const mm = String(Math.floor(left / 30 / 60)).padStart(2, '0');
    const ss = String(Math.floor((left / 30) % 60)).padStart(2, '0');

    // One minute left, then ten seconds. Nobody watches the clock while being chased.
    const secs = Math.floor(left / TICK_HZ);
    for (const mark of [60, 10]) {
      if (secs <= mark && warnedAt !== mark && secs > mark - 3) { warnedAt = mark; sfx.play('warn'); }
    }
    if (secs > 61) warnedAt = -1;           // a new round re-arms both
    $('stat').textContent =
      `${mm}:${ss} · ${net.rtt}ms · ${world.players.filter(Boolean).length} online · ${world.map?.id ?? ''}`;
    if (me) {
      $('you').textContent = `${me.name}  ${me.kills}/${me.deaths}`;
      $('gear').textContent = `◼${me.bombs}  ✸${me.radius}  »${me.speed}${me.shields ? '  ◊' : ''}`;
      if (!roundOverUntil) showDead(!me.alive);
    }
    if (scoresOpen) renderScores();
  }
}

// ─── death, scoreboard, leaving ───────────────────────────────────────────────

function showDead(dead) {
  $('dead').style.display = dead ? 'grid' : 'none';
}

function killFeed(text) {
  const li = document.createElement('li');
  li.style.color = '#8b97a8';
  li.textContent = text;
  const list = $('chatList');
  list.append(li);
  while (list.children.length > 50) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

let scoresOpen = false;
function renderScores() {
  const rows = world.players.filter(Boolean).sort((a, b) => b.score - a.score || b.kills - a.kills);
  const body = $('scoreRows');
  body.textContent = '';
  for (const [n, p] of rows.entries()) {
    const tr = document.createElement('tr');
    for (const [v, colour] of [[n + 1], [p.name, playerColor(p.i)], [p.kills], [p.deaths], [p.score]]) {
      const td = document.createElement('td');
      td.textContent = v;
      if (colour) td.style.color = colour;
      tr.append(td);
    }
    if (p.i === world.you) tr.style.fontWeight = 'bold';
    body.append(tr);
  }
}

function leave() {
  net.close();
  world.ready = false;
  running = false;
  $('menu').style.display = 'grid';
  $('hud').style.display = 'none';
  $('dead').style.display = 'none';
  $('scores').style.display = 'none';
  scoresOpen = false;
  roundOverUntil = 0;
  input.clear();
  $('play').disabled = false;
  $('name').focus();
}

// ─── menu ─────────────────────────────────────────────────────────────────────

const nameInput = $('name');
nameInput.maxLength = NAME_MAX_CHARS;
nameInput.value = localStorage.getItem('bv.name') || '';

function play() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  if ($('play').disabled) return;          // double-click would otherwise open a second socket
  $('play').disabled = true;
  localStorage.setItem('bv.name', name);
  renderer = createRenderer($('game'), world);
  // The click that got us here is the gesture that unlocks audio. Both buses share one context,
  // so sfx must be started too — and started first, so the join sounds are audible.
  sfx.start().then(() => sfx.play('click'));
  music.start().then(syncAudio);
  world.onBoom = bomb => {
    // A blast before its own fuse ran out was set off by something else. A bomb we never even
    // saw placed counts too — that only happens when a chain reaches it inside one snapshot.
    sfx.play('boom', bomb.tx, bomb.ty, { chain: bomb.at === undefined || world.tick < bomb.at });
  };
  net.connect(name);
}

$('play').onclick = play;
nameInput.onkeydown = e => { if (e.key === 'Enter') play(); };

// ─── chat ─────────────────────────────────────────────────────────────────────

addEventListener('keydown', e => {
  if (e.key === 'Enter' && !chatHasFocus() && running) {
    e.preventDefault();
    $('chatInput').focus();
    music.duck(true);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (chatHasFocus()) { $('chatInput').blur(); music.duck(false); }
    else if (scoresOpen) { scoresOpen = false; $('scores').style.display = 'none'; }
    else if (running) leave();                 // there has to be a way out of the game
    return;
  }
  if (e.code === 'Tab' && running && !typingSomewhere()) {
    e.preventDefault();
    scoresOpen = !scoresOpen;
    $('scores').style.display = scoresOpen ? 'block' : 'none';
    if (scoresOpen) renderScores();
  }
});

$('leave').onclick = leave;
$('respawn').onclick = () => net.send({ t: 'respawn' });

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
