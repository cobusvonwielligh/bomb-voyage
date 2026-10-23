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

All synthesised with WebAudio. No files.

**Defaults: music `0.10`, SFX `0.75`.** Persist both to `localStorage` (`bv.music`, `bv.sfx`).
**One** `AudioContext` for the whole page, created lazily and unlocked on the PLAY click — see
`public/client/audio/engine.js`. Two contexts means the second never unlocks, and hanging the
effects off the music's context means muting the music mutes the game.

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

Three loops, one per map, 8–16 bars, ~100 BPM, four voices max: bass pulse, arpeggio, lead,
noise percussion. Build them as a note array plus a scheduler that queues ~200 ms ahead — never
`setTimeout` per note.

Keep them *soft and repetitive by design*. The real acceptance test is listening to one for a
full 16-minute round without wanting to mute it. If you would mute it, it is too busy.

Duck music to 40 % while chat is focused.

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
