// Boot, the fixed-step loop, and the menu.
//
// No framework and no jQuery: the menu is one input and one button, and jQuery inside a frame
// loop is exactly the thing docs/ARCHITECTURE.md §9 forbids. If the UI ever grows past this,
// revisit — right now vanilla is the smaller answer.

import {
  TICK_MS, TICK_HZ, NAME_MAX_CHARS, UNITS_PER_TILE, IN_BOMB, playerColor,
  MAX_BOMBS_CARRIED, MAX_RADIUS, MAX_SKATES, IDLE_DISCONNECT_MS, RESPAWN_DELAY_TICKS,
} from '/shared/constants.js';
import { createNet } from './net.js';
import { createInput, typingSomewhere } from './input.js';
import { createWorld } from './world.js';
import { createRenderer } from './render.js';
import { createMusic } from './audio/music.js';
import { createSfx } from './audio/sfx.js';

const $ = id => document.getElementById(id);

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
    renderer?.mapChanged();          // a different map size means a different scale
    if (!m.mapOnly) {
      $('menu').style.display = 'none';
      $('hud').classList.add('on');
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

        case 'perkburn':
          sfx.play('blockdie', e.x, e.y);
          break;

        case 'perkget': {
          const p = world.players[e.i];
          if (p) sfx.playAtUnits('pickup', p.rx ?? p.x, p.ry ?? p.y, { perk: perkTypes.get(e.id) });
          break;
        }

        case 'shield': {
          const p = world.players[e.i];
          if (p) sfx.playAtUnits('shield', p.rx ?? p.x, p.ry ?? p.y);
          // Being saved by a shield deserves to be as legible as dying would have been.
          if (e.i === world.you) renderer?.addFlash(0.4, '90,209,160');
          break;
        }

        case 'status': {
          const p = world.players[e.i];
          if (p) sfx.playAtUnits('status', p.rx ?? p.x, p.ry ?? p.y);
          break;
        }

        case 'spawn':
          world.markSpawn(e.i);
          // Panned and attenuated by where it happened, so the sound alone tells you which side
          // of you somebody just appeared on. Your own is centred, because you are not elsewhere.
          if (e.i === world.you) sfx.play('ownSpawn');
          else sfx.playAtUnits('spawn', e.x, e.y);
          break;

        // The death screen is driven by whether you are alive (see the HUD block below), not by
        // this event. An event can arrive on the same snapshot as the respawn that follows it, and
        // a missed one used to leave you playing behind an overlay or staring at nothing.
        case 'died': {
          const who = world.players[e.i];
          const by = world.players[e.by];
          const nameOf = i => (i === world.you ? 'you' : world.players[i]?.name ?? '?');
          killFeed(e.i === e.by
            ? `${nameOf(e.i)} blew ${e.i === world.you ? 'yourself' : 'themselves'} up`
            : `${nameOf(e.by)} bombed ${nameOf(e.i)}`,
          { youDied: e.i === world.you, youKilled: e.by === world.you && e.i !== world.you });
          if (e.i === world.you) {
            sfx.play('ownDeath');
            renderer?.addFlash(0.8, '220,60,48');     // you, specifically, just died
            renderer?.addShake(0.7);
          } else if (e.by === world.you) {
            sfx.play('kill');
            renderer?.addFlash(0.22, '255,210,31');    // a gold blink: that one was yours
          } else sfx.playAtUnits('death', e.x, e.y);
          break;
        }
      }
    }
  },
  onRoundEnd: m => {
    renderRoundTable(m);
    $('deadTitle').textContent = 'round over';
    $('dead').firstElementChild.classList.add('round');
    $('dead').style.display = 'grid';
    sfx.play('fanfare');
    $('respawn').style.display = 'none';
    roundOverUntil = performance.now() + m.startsInMs;
    setTimeout(() => {
      roundOverUntil = 0;
      $('dead').style.display = 'none';
      $('respawn').style.display = '';
      $('deadTitle').textContent = 'you died';
      $('dead').firstElementChild.classList.remove('round');
      $('roundRows').textContent = '';
      $('roundNext').textContent = '';
    }, m.startsInMs);
  },
  // Lifetime rank, once a second. See the comment on emitScores in server/room.js for why this
  // is not in the snapshot.
  onScores: m => {
    ranks.clear();
    for (const r of m.ranks || []) ranks.set(r.i, r);
    allTime = m.top || [];
    if (scoresOpen) renderScores();
  },
  /**
   * Kill streaks. The server decides what counts; this only has to make it impossible to miss.
   * Shape: { t:'streak', i, name, kind, ace }.
   */
  onStreak: m => {
    const el = $('streak');
    el.querySelector('.big').textContent = m.kind;
    el.querySelector('.who').textContent = m.i === world.you ? 'you' : m.name;
    el.classList.toggle('ace', !!m.ace);
    // Restart the animation even if one is already running — a triple kill arriving on top of a
    // double has to replace it, not be swallowed by it.
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    if (m.i === world.you) {
      sfx.play(m.ace ? 'fanfare' : 'kill');
      renderer?.addFlash(m.ace ? 0.45 : 0.3, m.ace ? '179,107,255' : '255,210,31');
    }
    killFeed(`${m.i === world.you ? 'you' : m.name}: ${m.kind}`,
      { youKilled: m.i === world.you });
  },
  onChat: m => {
    const li = document.createElement('li');
    const who = document.createElement('b');
    who.textContent = m.i === -1 ? '' : `${m.name}: `;
    if (m.i >= 0) who.style.color = playerColor(m.i);
    li.append(who, document.createTextNode(m.msg));   // textContent only: never innerHTML
    if (m.i === world.you) li.className = 'mine';
    else if (world.me() && m.msg.toLowerCase().includes(world.me().name.toLowerCase())) {
      li.className = 'mention';
    }
    pushLine(li);
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
    const mask = input.mask;
    localBombFeedback(mask);
    world.predict(tick, mask);
    const me = world.me();
    net.send({ t: 'input', tick, m: mask, x: me?.x | 0, y: me?.y | 0 });
  }
  // Fell badly behind: drop it rather than catching up — and resync, for the same reason.
  if (acc > TICK_MS * 5) { acc = 0; net.resync(); }

  fuseTicks();
  world.updateFires();
  world.interpolate(net.serverTickNow(), dt);
  renderer.frame(dt);

  if (now - hudAt > 200) { hudAt = now; drawHud(); }
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

const gearPip = (id, value, cap) => {
  const el = $(id);
  setValue(el.querySelector('.n'), value);
  el.querySelector('.cap').textContent = `/${cap}`;
  el.classList.toggle('max', value >= cap);
};

let lastShields = 0;
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
  setValue($('xpLevel'), `lvl ${p.level}`, { calm: p.level === lastLevel });
  if (p.level !== lastLevel && lastLevel >= 0) sfx.play('pickup', undefined, undefined, { perk: 4 });
  lastLevel = p.level;
  $('xpNums').textContent = `${p.into.toLocaleString()} / ${p.need.toLocaleString()}`;
  $('xpFill').style.width = `${(p.fraction * 100).toFixed(1)}%`;
  box.classList.toggle('maxed', p.tier === 'Veteran');
  box.title = `${p.xp.toLocaleString()} XP total \u00b7 next level at ${p.nextAt.toLocaleString()}`;
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
  btn.disabled = left > 0;
  // Calm: this ticks once a second right in front of you, and the full bump is a strobe.
  setValue(btn, left > 0 ? `respawn in ${secs}\u2026` : 'respawn', { calm: true });
  $('deadText').textContent = left > 0
    ? 'hold space to go again\u2026'
    : 'space to respawn \u00b7 esc to leave';
}

function drawHud() {
  const me = world.me();
  const left = Math.max(0, (world.roundEndsAtTick || 0) - world.tick);
  const secs = Math.floor(left / TICK_HZ);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');

  // One minute left, then ten seconds. Nobody watches the clock while being chased.
  for (const mark of [60, 10]) {
    if (secs <= mark && warnedAt !== mark && secs > mark - 3) { warnedAt = mark; sfx.play('warn'); }
  }
  if (secs > 61) warnedAt = -1;             // a new round re-arms both

  $('vClock').textContent = `${mm}:${ss}`;
  $('clock').classList.toggle('low', secs <= 60);
  $('vPing').textContent = `${net.rtt}ms`;
  $('vOnline').textContent = world.players.filter(Boolean).length;
  $('vMap').textContent = world.map?.id ?? '';

  if (!me) return;

  const mine = ranks.get(world.you);
  $('who').textContent = me.name;
  setValue($('rank'), mine ? mine.tier : '');
  drawXp(mine);
  setValue($('vKills'), me.kills);
  setValue($('vDeaths'), me.deaths, { worse: true });
  setValue($('vScore'), me.score);
  renderLive();

  gearPip('pBombs', me.bombs, MAX_BOMBS_CARRIED);
  gearPip('pFire', me.radius, MAX_RADIUS);
  gearPip('pSpeed', me.speed, MAX_SKATES);

  // Shields are the closest thing this game has to health: one hit each, and nothing refills
  // them except picking up another. Drawn as pips rather than a bar, because a bar implies a
  // continuous quantity and these are discrete lives.
  if (me.shields !== lastShields) {
    const box = $('shields');
    box.textContent = '';
    for (let n = 0; n < me.shields; n++) box.append(document.createElement('i'));
    if (me.shields > lastShields) { box.classList.remove('bump'); void box.offsetWidth; box.classList.add('bump'); }
    lastShields = me.shields;
  }

  if (!roundOverUntil) { showDead(!me.alive); drawRespawn(me); }
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

function showDead(dead) {
  $('dead').style.display = dead ? 'grid' : 'none';
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
    kd.textContent = `${p.kills}/${p.deaths}`;
    sc.textContent = p.score;
    li.classList.toggle('me', p.i === world.you);
    li.classList.toggle('out', !p.alive);
  }
}

let scoresOpen = false;
const ranks = new Map();        // seat -> {lifetime, rank, rankName, nextAt}
let allTime = [];

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
    num(cell(tr, p.score));
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
  $('scores').style.display = 'none';
  scoresOpen = false;
  roundOverUntil = 0;
  clearTimeout(idleTimer);
  hiddenSince = 0;
  input.clear();
  music.playFrom('theme');          // back to the landing page, back to the theme
  $('play').disabled = false;
  $('name').focus();
}

// ─── menu ─────────────────────────────────────────────────────────────────────

// The theme plays on the landing page, from the first gesture the browser will accept — a click
// anywhere on the card, or the first keystroke in the name box. Audio cannot start before one.
let menuAudioTried = false;
function startMenuAudio() {
  if (menuAudioTried || running) return;
  menuAudioTried = true;
  music.start('theme').then(syncAudio);
}
for (const ev of ['pointerdown', 'keydown']) {
  $('menu').addEventListener(ev, startMenuAudio, { once: true });
}

const nameInput = $('name');
nameInput.maxLength = NAME_MAX_CHARS;
nameInput.value = localStorage.getItem('bv.name') || '';

function play() {
  $('signedOut').style.display = 'none';
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  if ($('play').disabled) return;          // double-click would otherwise open a second socket
  $('play').disabled = true;
  localStorage.setItem('bv.name', name);
  renderer = createRenderer($('game'), world);
  sfx.start().then(() => sfx.play('click'));
  // Straight to an ambient bed. The theme has a tune and a backbeat, which is right for reading
  // a menu and wrong for ten minutes of being hunted.
  music.start('drift').then(syncAudio);
  world.onBoom = bomb => {
    // A blast before its own fuse ran out was set off by something else. A bomb we never even
    // saw placed counts too — that only happens when a chain reaches it inside one snapshot.
    sfx.play('boom', bomb.tx, bomb.ty, { chain: bomb.at === undefined || world.tick < bomb.at });

    // Shake falls off with distance and is saturating, so a chain reaction across the map rattles
    // once rather than sixteen times. Nothing past eight tiles moves the camera at all.
    const me = world.me();
    if (!me) return;
    const d = Math.hypot(bomb.tx - me.rx / UNITS_PER_TILE, bomb.ty - me.ry / UNITS_PER_TILE);
    if (d >= 8) return;
    // Yours kicks harder than someone else's at the same distance. You pressed the button; the
    // screen agreeing with you is most of what makes a bomb feel like it went off.
    const mine = (bomb.o ?? bomb.owner) === world.you;
    renderer?.addShake((mine ? 0.75 : 0.5) * (1 - d / 8));
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
