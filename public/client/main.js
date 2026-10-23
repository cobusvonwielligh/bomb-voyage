// Boot, the fixed-step loop, and the menu.
//
// No framework and no jQuery: the menu is one input and one button, and jQuery inside a frame
// loop is exactly the thing docs/ARCHITECTURE.md §9 forbids. If the UI ever grows past this,
// revisit — right now vanilla is the smaller answer.

import { TICK_MS, NAME_MAX_CHARS, playerColor } from '/shared/constants.js';
import { createNet } from './net.js';
import { createInput } from './input.js';
import { createWorld } from './world.js';
import { createRenderer } from './render.js';
import { createMusic } from './audio/music.js';

const $ = id => document.getElementById(id);
const world = createWorld();
let renderer = null;
let running = false;

// ─── music ────────────────────────────────────────────────────────────────────

const music = createMusic();
const syncMusic = () => {
  $('musicBtn').textContent = music.playing ? '♪ on' : '♪ off';
  $('vol').value = Math.round(music.volume * 100);
};
$('musicBtn').onclick = async () => { await music.toggle(); syncMusic(); };
$('vol').oninput = e => music.setVolume(e.target.value / 100);
syncMusic();

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
      if (!running) { running = true; requestAnimationFrame(loop); }
    }
  },
  onSnap: snap => {
    world.applySnap(snap);
    for (const e of snap.ev || []) {
      if (e.e === 'blockhit' || e.e === 'blockdie' || e.e === 'blocknew') renderer?.invalidateTile(e.x, e.y);
    }
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
  onStatus: s => { $('conn').textContent = s; $('conn').dataset.state = s; },
});

const chatHasFocus = () => document.activeElement === $('chatInput');
const input = createInput({
  isTyping: chatHasFocus,
  onReserved: what => toast(`${what} is not in this build yet`),
});

// ─── loop ─────────────────────────────────────────────────────────────────────

let acc = 0, last = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(250, now - last);     // a backgrounded tab must not replay two minutes
  last = now;
  acc += dt;

  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    const tick = net.advanceTick();
    const mask = input.mask;
    world.predict(tick, mask);
    const me = world.me();
    net.send({ t: 'input', tick, m: mask, x: me?.x | 0, y: me?.y | 0 });
  }

  world.interpolate(net.serverTickNow());
  renderer.frame();

  if ((now | 0) % 8 === 0) {
    const me = world.me();
    $('stat').textContent =
      `${net.rtt}ms  ·  ${world.players.filter(Boolean).length} online  ·  ${world.map?.id ?? ''}`;
    if (me) $('you').textContent = `${me.name}  ${me.kills}/${me.deaths}`;
  }
}

// ─── menu ─────────────────────────────────────────────────────────────────────

const nameInput = $('name');
nameInput.maxLength = NAME_MAX_CHARS;
nameInput.value = localStorage.getItem('bv.name') || '';

function play() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  localStorage.setItem('bv.name', name);
  renderer = createRenderer($('game'), world);
  music.start().then(syncMusic);        // the click that got us here is the gesture
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
  } else if (e.key === 'Escape' && chatHasFocus()) {
    $('chatInput').blur();
    music.duck(false);
  }
});

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
