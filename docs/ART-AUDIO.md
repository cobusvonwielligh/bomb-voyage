# Bomb Voyage — Art & Audio

Slice: **ART**. Everything here is code, not files. There are no PNGs, no WAVs, nothing to
version, nothing to download, no CORS, no cache busting.

---

## 1. The look

Not strict 8-bit pixel art. The reference is Game of Bombs itself: **chunky, readable shapes with
real shading** — closer to low-poly-flat than to NES. Big silhouettes, two-tone shading, a dark
outline on everything that moves.

Three rules that keep it coherent:

1. **Everything an entity is, you can read as a silhouette.** If it is unclear in black, redraw it.
2. **One light direction: top-left.** Highlight top-left edge, shadow bottom-right. Always.
3. **Players are the only saturated things on screen.** Terrain is muted so 16 bright tracers pop.

### How it is drawn

Sprites are **shape lists** — rectangles, rounded rectangles and arcs — executed into an
offscreen canvas once at boot, then blitted with `drawImage`. Not per-pixel strings.

Why: ~20 lines per sprite instead of 16 rows × 8 frames of characters; scales to any tile size by
changing one number; recolouring for 16 players is free; and you can tweak a shape and see it
immediately in the preview harness.

```js
// assets/art.js — the shape of the shape
export function drawPlayer(c, { dir, frame, tint, shade }) {
  rr(c, 4, 2, 8, 7, 2, tint);        // helmet
  rr(c, 5, 5, 6, 3, 1, '#1b2430');   // visor
  rr(c, 3, 9, 10, 6, 2, shade);      // body
  // ...
}
```

Helpers live at the top of `art.js`: `rr()` rounded rect, `ell()` ellipse, `outline()`,
`shade(hex, amount)`.

### Baking

At boot, for each sprite × each of the 16 player colours, draw once into an offscreen canvas and
cache it. 16 colours × 8 player frames = 128 small canvases, a few milliseconds, a few hundred
kilobytes. After that the game loop only ever calls `drawImage`.

Never tint with `globalCompositeOperation` inside the frame loop. Bake it.

---

## 2. Palette

Terrain is a fixed, muted ramp. Players get the full saturation.

| Role | Hex |
|---|---|
| Void / letterbox | `#0d1117` |
| Floor base | `#2c3442` |
| Floor accent | `#333d4d` |
| Soft wall | `#8a6b4a` |
| Reinforced | `#6f7785` |
| Monolith | `#4b5362` |
| Iron | `#262c38` |
| Column | `#59627a` |
| Shrub | `#3f6b46` |
| Outline | `#161b24` |
| Highlight | `#ffffff` at 12 % |
| Fire core | `#fff4c2` |
| Fire mid | `#ff9b3d` |
| Fire edge | `#e63f27` |
| UI gold | `#ffd21f` |
| UI text | `#e8eef7` |

### Player colours

Sixteen hues spaced **22.5° apart**, handed out in bit-reversed order so the first few joiners get
maximally separated colours, with lightness alternating between adjacent hues so the two closest
ones differ on a second axis too:

```js
const HUE_ORDER = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
export const playerColor = i => {
  const h = HUE_ORDER[i % 16];
  return `hsl(${h * 22.5} 74% ${h % 2 ? 52 : 64}%)`;
};
```

Worth knowing why it is not the usual golden-angle trick: for exactly 16 slots, the golden angle's
worst pair lands **12.4°** apart, against a guaranteed **22.5°** here. Do not hand-pick a palette
either — hand-picked sets always end up with two similar blues.

The slot function lives in `shared/constants.js`, so the simulation, the HUD and the art can never
disagree about who is what colour.

Each player's colour drives: body tint, name tag, their bombs, their fire, and their **tracer**.

---

## 3. The tracer

A core feature, not decoration. It is how you read a screen with 16 players on it, and how
spectators follow the action.

- Sample the **rendered** position (not the simulated one, so it stays smooth through
  interpolation) every **3 ticks**.
- Keep the last **8** samples.
- Draw oldest → newest as circles: radius from 2 px up to 5 px, alpha from 10 % up to 40 %, in the
  player's colour.
- Drawn **under** the player sprite, over the floor.
- Invisible players show their tracer **only to themselves**.

Acceptance: with 16 bots on screen, you can follow any one of them by tracer alone.

---

## 4. Sprite inventory

| Sprite | Frames | Notes |
|---|---|---|
| Player | 4 directions × 2 walk frames + 1 death | Tinted per player. Changeling draws it flipped vertically. Reduction draws it at 50 % scale. |
| Bomb | 3 pulse frames | Pulses faster as the fuse runs out. Tinted to the owner. |
| Fire | centre, arm, tip × 4 rotations | Three-colour ramp from §2. |
| Floor | 3 variants | Chosen by a hash of the cell coordinates, so it never looks tiled. |
| Soft wall | 1 + 1 damaged | |
| Reinforced | 1 + 3 damage states | Damage must read at a glance — it takes six hits. |
| Monolith | 1 + 4 damage states | |
| Iron | 2 variants | |
| Column | 1 | |
| Shrub | 2 (walk-through / solid) | Walk-through is visibly lighter. |
| Perks | 5 live + 9 reserved | 16 × 16 icons inside a rounded tile. |
| Status icons | 7 | Shown above the player's head, small. |

Status visual effects (on the player, not just icons):

| Status | Effect |
|---|---|
| Invulnerability | Flashing white outline, 4 Hz |
| Pacifism | Grey desaturated body |
| Slowdown | Blue drips under the sprite |
| Invisibility | Alpha 0 to others; alpha 35 % to yourself |
| Changeling | Sprite flipped vertically |
| Reduction | 50 % scale |
| Fast Detonation | Red spark particles |

---

## 5. UI style

Dark panels, gold headings, white body text — close to Game of Bombs' own menu so it reads as
familiar.

- Panel: `#1a2029`, 2 px border `#ffd21f` at 40 %, 4 px corner radius.
- Headings: UI gold, uppercase, letter-spaced.
- Body: `#e8eef7`.
- Buttons: gold border, transparent fill, filled gold on hover.
- Font: a system monospace stack. **No web fonts** — they are an external request and IT may
  block them, and `default-src 'self'` will refuse them anyway.

Screens: **Menu** (name + colour preview + three map cards + PLAY), **HUD** (stat icons, round
timer, connection dot), **TAB scoreboard**, **Q map overview**, **round-end scoreboard**.

---

## 6. Audio

Synthesised with WebAudio, with **one** exception: the theme is a file,
`/assets/audio/theme.mp3`. Every sound effect and all three ambient beds are still generated.

The file is wrapped to look exactly like a synthesised track to the sequencer — one step whose
duration is the length of the mix, minus the crossfade so the next track overlaps the outro
rather than following a gap. Nothing above `createFileTheme` in `music.js` knows the difference,
which is why crossfading, `exclude`, `playFrom`, muting and ducking all work on it unchanged.
The synthesised theme is the fallback when the file cannot be loaded.

Serving it needs an `audio/mpeg` content type **and byte ranges** — Safari will not play an
`<audio>` source from a server that answers `Range` with a 200. `server/index.js` does both.

**Defaults: music `0.10`, SFX `0.75`.** Persist both to `localStorage` (`bv.music`, `bv.sfx`).
**One** `AudioContext` for the whole page, created lazily and unlocked on the PLAY click — see
`public/client/audio/engine.js`. Two contexts means the second never unlocks, and hanging the
effects off the music's context means muting the music mutes the game.

**`VOLUME_MASTER` (`0.5`) is a trim node, not a default.** It is applied in `engine.js`, in both
`createBus` and `createMusicBus`, on a gain node of its own *after* the limiter and *downstream of
the slider*. Three reasons it has to be there and nowhere else:

- A **default** only ever reaches somebody with no stored slider value. Everybody who has already
  played has one in `localStorage`, so halving the defaults would do nothing for them.
- Downstream of the volume node means **no slider can scale back past it**.
- After the limiter, because trimming *before* it lets peaks that used to be squashed through
  untouched — the mix then gets quieter by rather less than the trim claims.

### SFX

Implemented in `public/client/audio/sfx.js`. Each voice is a function that schedules itself; the
caller has already decided when, where and how loud.

| Sound | When | Recipe |
|---|---|---|
| `place` | a bomb is placed | square blip 220 → 180 Hz, 60 ms |
| `fuse` | a bomb within earshot has < 1 s left | dry triangle tick, 1.2–1.9 kHz, four accelerating stages |
| `boom` | explosion | noise burst low-passed 2 kHz → 200 Hz + sine thump 100 → 38 Hz + a 2.6 kHz crack |
| `boom {chain}` | a bomb set off by another | same, pitched up 15 %, capped at 3 per frame |
| `blockdie` | a wall is destroyed | band-passed noise 900 → 420 Hz, quiet — several fire per blast |
| `blocknew` | a wall grows back | low sine thud 150 → 70 Hz. Your escape route just changed |
| `pickup` | a perk is collected | two-note triangle; **the interval says which perk** (Gift goes *down*) |
| `shield` | a shield eats a blast | glassy sine pair, a fifth apart |
| `status` | a disease is caught | detuned triangle pair with a 7 Hz wobble |
| `death` | someone else dies | descending saw 330 → 70 Hz, positional |
| `ownDeath` | **you** die | two detuned saws 300 → 52 Hz, 750 ms, close up |
| `kill` | **you** killed someone | bright two-note stab up a fourth, with a click on front |
| `spawn` / `ownSpawn` | a respawn | rising triangle; yours gets a fifth under it |
| `warn` | 60 s and 10 s left in the round | two dry 880 Hz ticks |
| `fanfare` | round end | C–E–G–C across three waveforms |
| `click` | UI | one 1.4 kHz tick |

Four rules do more for how this feels than any individual recipe:

1. **Positional.** Panned and attenuated by distance from your own *rendered* position, with the
   top end rolled off with distance too — that is what actually reads as far away. Past
   `SFX_MAX_DISTANCE_TILES` the sound is not played at all. Rolloff is **linear, not
   inverse-square**: physically wrong, and correct here, because a bomb four tiles away matters
   nearly as much as one at your feet.
2. **Budgeted.** `MAX_PER_FRAME` per voice. A chain can set off a dozen bombs on one tick; past
   the third, the sound stops being information.
3. **Jittered.** Every instance is a few percent off in pitch and length. Identical repeats are
   the loudest tell that a game's audio was made by a programmer.
4. **About you.** Anything that happened *to* you is non-positional, longer and louder than the
   same thing happening to someone else, and `kill` is its own sound. That confirmation is the
   most important noise in a deathmatch.

Explosions, the fanfare and both death sounds feed a shared send — one low-passed feedback delay,
not a real reverb — so a blast sounds like it happened in a stone corridor.

**Your own bomb is triggered locally, not from the server event.** The `bomb` event is two ticks
behind, and 66 ms of lag on the one sound you trigger yourself is the difference between
responsive and mushy. `localBombFeedback` in `main.js` re-checks every reason a placement would be
refused — dead, pacifist, out of bombs, tile occupied — so it is honest rather than optimistic.

### Music

**Four tracks, one module, one public surface.** `createMusic()` in
`public/client/audio/music.js` owns the main theme, the three ambient beds in
`public/client/audio/ambient.js`, and the cycling between them. `main.js` only ever says
`start` / `stop` / `toggle` / `setVolume` / `duck` and never learns that more than one track
exists — adding a fifth track must not touch anything outside `audio/`.

Every track is the same shape — `{ name, steps, stepDur, repeats, gain, schedule(step, time) }` —
so one sequencer drives all four. Scheduling is the standard look-ahead pattern: a 25 ms timer
that only ever queues notes ~120 ms into the future, with the AudioContext clock doing the real
timing. **Never `setTimeout` per note** — it drifts audibly within seconds.

#### The main theme — 8 bars, 116 BPM, two halves that do not sound alike

| | Bars 1–4 | Bars 5–8 |
|---|---|---|
| Feel | relaxed four-on-the-floor funk | synthwave |
| Harmony | Am7 Cmaj7 Em7 D9 (vi–I–iii–II) | C G F G |
| Bass | walks down A–G–E–D, syncopated, root only on the downbeat | eighths, octave up on the "and" |
| Top | muted guitar chank on the offbeats | three-octave arpeggio |
| Hats | closed on the eighths, open on the "and" of 4 | offbeat sixteenths |
| Lead | none | the only singable line in the project |

The **major II** at the end of bar 4 wants to resolve and the loop goes back to the Am7 instead.
That is what lets four bars repeat without ever sounding finished. The arpeggio *and* the lead are
both held back until bar 5, so the melody arriving is an event rather than something that was
always there.

The **chank** is the one voice worth being careful with: a band-passed sawtooth cluster, 40 ms
gate, Q of 5 around 1.9 kHz, no body underneath, and no send to the delay. Lengthen the envelope
and it becomes a pad; drop the Q and it becomes a synth stab; keep the low end and it fights the
bass.

116 BPM, not the 77 this started at, because the pocket only exists around there — a
four-on-the-floor at 77 is a funeral march, and putting the kick on the eighths instead makes it
154, which is drum and bass. The **dotted-eighth delay time is derived from `BPM`**; if you change
the tempo it has to follow or the echo desyncs.

#### The three ambient beds — in-game atmosphere

Each is 12–16 bars, 50–64 BPM, and audibly its own thing:

| Bed | Key / character | Why it is different |
|---|---|---|
| `drift` | C major, airy — Cmaj9 Fmaj7 Am9 G6 | triangle waves, 3.2 kHz cutoff, sits well above the gameplay |
| `suspend` | A/D/E **sus**, unresolved — not one third in it | sine, 12 bars so it is off the others' grid, 2.4 s release |
| `undertow` | D minor with a flat second, modal and dark | lowpassed sawtooth an octave down, the only bed with a pulse |

**No kit.** The theme has the drums; `undertow` gets one soft sub thump on the bar and that is the
whole percussion budget. Six or seven arpeggio notes a bar, not sixteen.

What makes a bed atmosphere rather than music is the **overlap**: every note has a 1.5–2.5 s
release and feeds a dotted-eighth delay at its own tempo, so by the third note you are hearing a
chord instead of a line and there is nothing to follow. The arpeggio index is also **rotated by
the bar within the chord**, so four bars on one chord are four different contours — and because
every note in a voicing is a chord tone, no rotation can turn into a tune.

#### Cycling

`theme` ×4 → `drift` ×2 → `suspend` ×2 → `undertow` ×2 → repeat. That is roughly a 7-minute
cycle, so a 16-minute round hears the theme two or three times and never the same eight bars sixty
times over. Each track has its own fader into the music bus and track changes **crossfade over
2.5 s** at the loop boundary: the outgoing track stops scheduling but its pad releases and delay
tail keep sounding through its own fader, which is the overlap. `start()` always comes back to the
theme — the track somebody turned off is the one they expect back.

The theme leads because `main.js` starts the music on the PLAY click, so there is no menu to play
it over; joining the game is the moment it gets.

#### Volume, ducking, and the one bug that cost a session of silence

Keep it all *soft and repetitive by design*. The real acceptance test is listening for a full
16-minute round without wanting to mute it. **If you would mute it, it is too busy.**

Duck to 40 % while chat is focused.

`applyGain()` is the **only** writer of the music bus gain, and it must stay that way. It used to
be three writers that did not agree: `stop()` ramped to zero, `start()` never put it back, and
`setVolume` and `duck` were both gated on `playing` so neither rescued it. Toggling the music off
and on gave you a button saying "♪ on" and silence for the rest of the session, because a
`setTargetAtTime` whose `startTime` is already in the past keeps decaying until some later
automation event replaces it — and `cancelScheduledValues(currentTime)` does *not* remove it.
Routing every writer through one place also means the ducked flag survives a restart, instead of
coming back at full volume while the chat box still has focus.

Silence while stopped is deliberate, not a fallthrough: the delay lines ring for about two seconds
after the last note, and moving the slider must not un-mute that tail once the music is off.

---

## 7. Performance rules

1. Bake every sprite at boot. Never generate a canvas inside the frame loop.
2. The static map lives in cached 8×8-tile chunk canvases (see
   [ARCHITECTURE.md](ARCHITECTURE.md) §6). Only dirty chunks redraw.
3. No `shadowBlur`, no filters, no per-pixel `getImageData` in the loop.
4. Allocate zero objects per frame in the hot path. Reuse arrays.
5. Budget: 16 ms per frame total, under 6 ms in rendering, on a mid-range office laptop.

---

## 8. Preview harness

`public/art-preview.html` draws every sprite at 1×, 2× and 4×, in all 16 player colours, over
both the floor and the void background, with a live damage-state slider and a 16-tracer
readability check.

```bash
npm start   # then open http://localhost:8080/art-preview.html
```

It lives under `public/` rather than `tools/` for one boring reason: browsers refuse ES module
imports over `file://`, and `npm start` is a static server we already have. No build step, no
second server, no game required.

Build art against this first. It means the art can be finished before the game exists, and it is
how you check that damage states read and that no two player colours are confusable.
