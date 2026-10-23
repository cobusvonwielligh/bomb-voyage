// The music cannot run in Node — it needs an AudioContext — but its note tables are plain data,
// and that is where the bugs that are expensive to find by ear live: a pattern one step short so
// the groove limps, an arpeggio index past the end of a voicing so a note silently vanishes, an
// ambient bed accidentally spelled the same as its neighbour so cycling does nothing.
//
// So: lift the literals out of the source, evaluate them, and check them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const musicSrc = read('public/client/audio/music.js');
const ambientSrc = read('public/client/audio/ambient.js');

const STEPS_PER_BAR = 16;
const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * The value of a top-level `const NAME = <array or object literal>`, bracket-balanced. `scope`
 * binds any other constant the literal refers to — BEDS names its arpeggio tables rather than
 * inlining them, which is worth keeping readable in the source.
 */
function literal(src, name, scope = {}) {
  const decl = src.indexOf(`const ${name} = `);
  assert.ok(decl >= 0, `${name} not found`);
  const from = decl + `const ${name} = `.length;
  const open = src[from];
  assert.ok(open === '[' || open === '{', `${name} is not an array or object literal`);
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) {
      const body = `return ${src.slice(from, i + 1)};`;
      return new Function(...Object.keys(scope), body)(...Object.values(scope));
    }
  }
  assert.fail(`${name} literal is unbalanced`);
}

const number = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = (-?[\\d.]+)`));
  assert.ok(m, `${name} not found`);
  return parseFloat(m[1]);
};

const CHORDS = literal(musicSrc, 'CHORDS');
const PULSE_BASS = literal(musicSrc, 'PULSE_BASS');
const ARP_GATE = literal(musicSrc, 'ARP_GATE');
const ARP_ROLL = literal(musicSrc, 'ARP_ROLL');
const LEAD = literal(musicSrc, 'LEAD');
const LEAD_OCTAVE = literal(musicSrc, 'LEAD_OCTAVE');
const ARPS = Object.fromEntries(['DRIFT_ARP', 'SUSPEND_ARP', 'UNDERTOW_ARP']
  .map(n => [n, literal(ambientSrc, n)]));
const BEDS = literal(ambientSrc, 'BEDS', ARPS);

// ─── the main theme ──────────────────────────────────────────────────────────

test('the theme has one chord per bar and four bars per half', () => {
  assert.equal(number(musicSrc, 'BARS'), 8);
  assert.equal(CHORDS.length, 8, 'the sequencer indexes CHORDS by bar, so it needs BARS entries');
  for (const [i, c] of CHORDS.entries()) {
    assert.equal(c.notes.length, 3,
      `bar ${i}: the arpeggio reads notes[idx % 3], so a voicing must be exactly 3 notes`);
  }
});

test('the intro is two bars and the main section is six', () => {
  // An introduction that lasts as long as the thing it introduces is a second track.
  assert.equal(number(musicSrc, 'INTRO_BARS'), 2);
  assert.equal(ARP_GATE.length, 2, 'the gate has to cover exactly the intro');
  assert.match(musicSrc, /const intro = bar < INTRO_BARS;/, 'the split is hard-coded again');
  // And the hook still sits at the end, so the main section gets two bars to itself first.
  assert.match(musicSrc, /bar - \(BARS - 4\)/, 'the lead is no longer anchored to the last four bars');
});

test('both halves are the same progression, the second one voiced higher', () => {
  // The whole structure rests on this. Same four chords twice means the second pass is a
  // chorus rather than a new section, and the ear is free to follow the tune because it
  // already knows where the harmony is going.
  //
  // The bass stays put: the octave pulse lives in one register, and moving it between halves
  // would make one of them sound thin rather than making the other sound bigger. It is the
  // voicing above it that lifts.
  const low = CHORDS.slice(0, 4), high = CHORDS.slice(4);
  assert.deepEqual(low.map(c => c.bass), high.map(c => c.bass), 'the roots changed');
  // Only the two intro bars are voiced low; bars 3 and 4 are already the main section and lift
  // with it, which is what makes the arrival land a bar before the melody does.
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.max(...low[i].notes) < Math.max(...high[i].notes),
      `intro bar ${i} is not voiced under its restatement`);
  }
  for (let i = 2; i < 4; i++) {
    assert.deepEqual(low[i].notes, high[i].notes, `bar ${i} should already be the open voicing`);
  }
});

test('the progression is D minor, and stays in it', () => {
  // Dm Bb F C. The flat seventh is the whole difference between a sea shanty and a horror
  // film, so a C# anywhere in here is a bug rather than a flourish.
  const D_MINOR = new Set([2, 4, 5, 7, 9, 10, 0]);        // D E F G A Bb C
  const every = CHORDS.flatMap(c => [c.bass, ...c.notes]).concat(LEAD.filter(n => n !== null));
  const strays = [...new Set(every.filter(n => !D_MINOR.has(n % 12)))];
  assert.deepEqual(strays, [], `notes outside D natural minor: ${strays}`);
  assert.deepEqual(CHORDS.slice(4).map(c => c.bass % 12), [2, 10, 5, 0], 'not Dm Bb F C');
});

test('the octave bass pulses and never wanders', () => {
  // Relentlessness is the point. A bass line with ideas in it fights the arpeggio for the
  // same job, and the root-on-the-beat octave-off-it figure IS synthwave.
  assert.equal(PULSE_BASS.length, STEPS_PER_BAR);
  for (const [n, v] of PULSE_BASS.entries()) {
    if (n % 4 === 0) assert.equal(v, 0, `step ${n} should be the root`);
    else if (n % 2 === 0) assert.equal(v, 12, `step ${n} should be the octave`);
    else assert.equal(v, null, `step ${n} should be silent — this is eighths, not sixteenths`);
  }
});

test('the intro builds, bar by bar, into the main section', () => {
  // The listener has to hear the same figure getting denser, not a new thing arriving. If the
  // gate did not grow, bar 5 would be a change of subject instead of a chorus.
  assert.equal(ARP_GATE.length, 2, 'one gate per bar of the intro');
  const density = ARP_GATE.map(row => {
    assert.equal(row.length, STEPS_PER_BAR, 'a gate must be one bar of sixteenths');
    return row.filter(Boolean).length;
  });
  for (let i = 1; i < density.length; i++) {
    assert.ok(density[i] > density[i - 1],
      `bar ${i} is no denser than bar ${i - 1}: ${density}`);
  }
  assert.ok(density[0] <= 4, 'the first bar is already too busy to build from');
  assert.ok(density.at(-1) >= 10, 'the last intro bar does not fill in');
  for (const row of ARP_GATE) assert.equal(row[0], 1, 'every bar has to start on the downbeat');
});

test('the hook is a repeated-note cell that climbs, and it enters late', () => {
  // The figure everybody already knows from a pirate film: a pair of repeated notes stepping
  // up, answered by a leap. The repeated note is what makes it singable after one listen; the
  // step is what stops it being a drone.
  assert.equal(LEAD.length, 32, 'eight eighth-notes a bar, four bars');
  assert.equal(LEAD_OCTAVE.length, LEAD.length, 'the octave doubling must line up with the lead');
  const bar = i => LEAD.slice(i * 8, i * 8 + 8);

  // Enters after the section does, not with it.
  assert.ok(bar(0).slice(0, 2).every(n => n === null),
    'the melody starts on the downbeat — it should arrive on top of the arpeggio, not with it');
  assert.ok(bar(0)[2] !== null, 'and it should not wait longer than that either');

  // The cell: somewhere in the line, the same note twice running, at least twice over.
  const notes = LEAD.filter(n => n !== null);
  const pairs = notes.filter((n, i) => i > 0 && n === notes[i - 1]).length;
  assert.ok(pairs >= 2, `only ${pairs} repeated-note pairs; that is not the hook`);

  // High enough to be a melody rather than another moving part inside the arpeggio.
  assert.ok(Math.min(...notes) >= 72, `the hook bottoms out at ${Math.min(...notes)}, under D5`);

  // And it climbs: the high point of the third bar is above the high point of the first.
  const peak = i => Math.max(...bar(i).filter(n => n !== null));
  assert.ok(peak(2) > peak(0), 'the restatement is not higher than the statement');

  for (const i of [1, 3]) {
    assert.ok(bar(i).slice(-2).every(n => n === null), `bar ${i} never stops to breathe`);
  }
  const last = LEAD.filter(n => n !== null).at(-1);
  assert.equal(last % 12, 2, `the phrase lands on ${last}, which is not a D`);
  // And the accent is an accent, not a second melody.
  const doubled = LEAD_OCTAVE.filter(Boolean).length;
  assert.ok(doubled > 0 && doubled < LEAD.filter(n => n !== null).length / 2,
    `${doubled} doubled notes is not an accent`);
  for (const [i, on] of LEAD_OCTAVE.entries()) {
    if (on) assert.ok(LEAD[i] !== null, `slot ${i} doubles a rest`);
  }
});

test('the second-half arpeggio stays inside three octaves of its voicing', () => {
  assert.equal(ARP_ROLL.length, STEPS_PER_BAR);
  for (const idx of ARP_ROLL) {
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx <= 8,
      `arpeggio index ${idx} is outside the three octaves the voice can reach`);
  }
  // Highest note the arpeggio can produce, across every chord it plays over.
  for (const c of CHORDS.slice(4)) {
    const top = Math.max(...ARP_ROLL.map(i => c.notes[i % 3] + Math.floor(i / 3) * 12));
    assert.ok(top <= 100, `arpeggio reaches MIDI ${top}, which is a whistle, not a note`);
  }
});

test('the lead covers the second half exactly, in eighths', () => {
  // playStep reads LEAD[(bar - 4) * 8 + (n >> 1)] on even steps: 8 slots a bar, four bars.
  assert.equal(LEAD.length, 4 * 8);
  const sounding = LEAD.filter(n => n !== null);
  assert.ok(sounding.length >= 8, 'that is not a melody');
  assert.ok(sounding.length < LEAD.length * 0.8, 'a melody needs to breathe');
  for (const n of sounding) assert.ok(n >= 60 && n <= 96, `lead note ${n} is out of register`);
});

test('the dotted-eighth delay is derived from the tempo and fits the delay node', () => {
  const bpm = number(musicSrc, 'BPM');
  assert.ok(bpm >= 110 && bpm <= 122, `${bpm} BPM is not the four-on-the-floor pocket`);
  assert.match(musicSrc, /createDelayLine\(SECONDS_PER_BEAT \* 0\.75/,
    'the delay time must follow BPM, or changing the tempo desyncs the echo');
  assert.match(musicSrc, /const SECONDS_PER_BEAT = 60 \/ BPM/);
});

// ─── the ambient beds ────────────────────────────────────────────────────────

test('there are three beds and their patterns are structurally sound', () => {
  assert.equal(BEDS.length, 3);
  for (const bed of BEDS) {
    assert.ok(bed.bars >= 8 && bed.bars <= 16, `${bed.name}: ${bed.bars} bars`);
    assert.equal(bed.bars % bed.chords.length, 0,
      `${bed.name}: ${bed.bars} bars does not divide evenly into ${bed.chords.length} chords`);
    assert.equal(bed.arp.length, STEPS_PER_BAR, `${bed.name}: arp is not one bar`);
    assert.ok(bed.repeats >= 2, `${bed.name}: plays through fewer than twice before moving on`);
    for (const chord of bed.chords) {
      assert.equal(chord.voice.length, 6, `${bed.name}: voicings must all be the same length`);
      // schedule() takes voice.slice(0, 3) for the pad, so a voicing has to be sorted upward or
      // the pad silently gets the top of the chord instead of the bottom.
      for (let i = 1; i < chord.voice.length; i++) {
        assert.ok(chord.voice[i] > chord.voice[i - 1], `${bed.name}: voicing is not ascending`);
      }
      assert.ok(chord.bass >= 24 && chord.bass <= 60, `${bed.name}: drone at MIDI ${chord.bass}`);
      assert.ok(chord.bass < chord.voice[0], `${bed.name}: the drone is inside the voicing`);
    }
  }
});

test('every ambient arpeggio index reaches a real note', () => {
  for (const bed of BEDS) {
    const len = bed.chords[0].voice.length;
    const barsPerChord = bed.bars / bed.chords.length;
    for (const slot of bed.arp) {
      if (slot === null) continue;
      assert.ok(Number.isInteger(slot) && slot >= 0 && slot < len,
        `${bed.name}: arp index ${slot} is outside a ${len}-note voicing`);
      // schedule() rotates by the bar within the chord, so every rotation must land too.
      for (let bar = 0; bar < barsPerChord; bar++) {
        const i = (slot + bar) % len;
        for (const chord of bed.chords) {
          assert.equal(typeof chord.voice[i], 'number',
            `${bed.name}: rotation ${bar} of index ${slot} falls off the voicing`);
        }
      }
    }
  }
});

test('the beds are atmosphere, not music with a tune in it', () => {
  for (const bed of BEDS) {
    const notes = bed.arp.filter(s => s !== null).length;
    // Sixteen notes a bar is the main theme's arpeggio. Anything near it is too busy to sit
    // under sixteen minutes of play — the acceptance test in docs/ART-AUDIO.md.
    assert.ok(notes <= 8, `${bed.name}: ${notes} notes a bar is a sequence, not a bed`);
    assert.ok(notes >= 4, `${bed.name}: ${notes} notes a bar is not an arpeggio`);
    assert.ok(bed.release >= 1.5,
      `${bed.name}: a short release lets a line emerge out of the overlapping notes`);
    assert.ok(bed.bpm <= 80, `${bed.name}: ${bed.bpm} BPM is not an atmosphere`);
    assert.ok(bed.peak <= 0.1 && bed.padPeak <= 0.1, `${bed.name} is louder than the theme's pad`);
  }
  // No kit. The theme has the drums; a bed is allowed one soft sub pulse and nothing else.
  for (const voice of ['kick(', 'snare(', 'hat(', 'noiseSource']) {
    assert.ok(!ambientSrc.includes(voice), `ambient.js has a ${voice} — the beds have no kit`);
  }
  assert.equal(BEDS.filter(b => b.pulse).length, 1, 'at most one bed gets a pulse');
});

test('the three beds are audibly different, not three spellings of one bed', () => {
  const distinct = key => new Set(BEDS.map(b => b[key])).size;
  assert.equal(distinct('name'), 3, 'two beds share a name');
  assert.equal(distinct('bpm'), 3, 'all three beds run at the same tempo');
  assert.equal(distinct('wave'), 3, 'all three beds use the same oscillator');
  assert.equal(distinct('cutoff'), 3, 'all three beds sit in the same part of the spectrum');
  assert.equal(new Set(BEDS.map(b => b.arp.join())).size, 3, 'two beds share an arpeggio');

  // Different harmony, not just transposed: compare the pitch classes each bed actually uses.
  const classes = BEDS.map(b => [...new Set(
    b.chords.flatMap(c => [c.bass, ...c.voice]).map(n => n % 12))].sort().join());
  assert.equal(new Set(classes).size, 3, 'two beds are built from the same notes');

  // One bed must have no thirds at all, which is what lets it hang without resolving.
  const thirdless = BEDS.filter(b => b.chords.every(c => {
    const iv = c.voice.map(n => (n - c.bass) % 12);
    return !iv.includes(3) && !iv.includes(4);
  }));
  assert.equal(thirdless.length, 1, 'exactly one bed should be the unresolved, thirdless one');
});

test('every note in every table maps to a frequency a person can hear', () => {
  const all = [
    ...CHORDS.flatMap(c => [c.bass, ...c.notes]),
    ...CHORDS.flatMap(c => PULSE_BASS.filter(v => v !== null).map(v => c.bass + v)),
    ...CHORDS.slice(4).flatMap(c => ARP_ROLL.map(i => c.notes[i % 3] + Math.floor(i / 3) * 12)),
    ...LEAD.filter(n => n !== null),
    ...BEDS.flatMap(b => b.chords.flatMap(c => [c.bass, ...c.voice])),
  ];
  assert.ok(all.length > 150, `only checked ${all.length} notes`);
  for (const n of all) {
    assert.ok(Number.isInteger(n), `${n} is not a MIDI note number`);
    const f = hz(n);
    assert.ok(Number.isFinite(f) && f >= 40 && f <= 4200,
      `MIDI ${n} is ${f.toFixed(1)} Hz, outside the range this soundtrack should ever reach`);
  }
});

// ─── the public surface ──────────────────────────────────────────────────────

test('music.js still exposes exactly what main.js calls, and nothing less', () => {
  const mainSrc = read('public/client/main.js');
  // The lookbehind keeps `./audio/music.js` in the import out of the member list.
  const used = new Set([...mainSrc.matchAll(/(?<![/\w])music\.(\w+)/g)].map(m => m[1]));
  assert.ok(used.size >= 5, `main.js barely uses the music module; found ${[...used]}`);
  for (const name of used) {
    assert.ok(new RegExp(`(^|\\s)(get )?${name}\\s*\\(`, 'm').test(musicSrc),
      `main.js calls music.${name}, which createMusic does not return`);
  }
  // main.js names a track to start on — the theme belongs to the landing page and a bed belongs
  // to a round — but that is the whole extent of what it knows. Everything about how tracks are
  // built, scheduled and cycled stays behind the music module.
  assert.match(musicSrc, /createAmbient/, 'the ambient beds are not wired into the music module');
  assert.ok(!/from ['"].*ambient/.test(mainSrc), 'main.js imports the ambient module directly');
  assert.ok(!mainSrc.includes('createAmbient'), 'main.js builds beds itself');

  // Every track name main.js asks for has to be a track that exists, or the call silently does
  // nothing and the landing page plays whatever happened to be first.
  const asked = new Set([...mainSrc.matchAll(/music\.(?:start|playFrom)\('(\w+)'\)/g)].map(m => m[1]));
  // Names reached through a list rather than written at the call site. `music.start(BEDS[i])` is
  // still main.js asking for a track, and a typo in that list is just as silent as one inline.
  const beds = /const BEDS = \[([^\]]*)\]/.exec(mainSrc);
  assert.ok(beds, 'main.js no longer declares BEDS; the rotation is named somewhere else now');
  for (const m of beds[1].matchAll(/'(\w+)'/g)) asked.add(m[1]);
  assert.ok(!/'theme'/.test(beds[1]), 'the theme is in BEDS — it would play during a round');
  assert.ok(asked.size >= 2, `expected main.js to name tracks; found ${[...asked]}`);
  const ambientSrc = read('public/client/audio/ambient.js');
  for (const name of asked) {
    const known = new RegExp(`name: ['"]${name}['"]`).test(musicSrc + ambientSrc);
    assert.ok(known, `main.js asks for track "${name}", which no module defines`);
  }
});

test('the bus gain has exactly one writer, so start() cannot leave it ramping to zero', () => {
  // The bug this guards: stop() ramped musicGain to 0 and start() never put it back, and because
  // a setTargetAtTime whose startTime is in the past keeps decaying, the music was gone for the
  // rest of the session while the button still said "on".
  const writes = [...musicSrc.matchAll(/musicGain\.gain\.\w+/g)].map(m => m[0]);
  assert.deepEqual(writes, ['musicGain.gain.setTargetAtTime'],
    `musicGain.gain is written in more than one place: ${writes.join(', ')}`);
  assert.match(musicSrc, /function applyGain/, 'there is no single gain writer');
  // Duck state has to be remembered, or a restart while chat is focused comes back at full.
  assert.match(musicSrc, /playing \? volume \* \(ducked \? 0\.4 : 1\) : 0/);
});

test('the master trim lives in engine.js, where a stored slider value cannot beat it', () => {
  const engineSrc = read('public/client/audio/engine.js');
  assert.match(engineSrc, /VOLUME_MASTER/,
    'halving the defaults does nothing for anyone who already has a slider in localStorage');
  // sfx.js is not allowed to know about this; it gets the trim because createBus applies it.
  const sfxSrc = read('public/client/audio/sfx.js');
  assert.ok(!sfxSrc.includes('VOLUME_MASTER'), 'sfx.js should get the trim from createBus');
  assert.match(sfxSrc, /createBus\(volume\)/);
  for (const factory of ['createBus', 'createMusicBus']) {
    const from = engineSrc.indexOf(`export function ${factory}`);
    assert.ok(from > 0, `${factory} not found`);
    const body = engineSrc.slice(from, engineSrc.indexOf('\n}', from));
    assert.match(body, /trimmedOutput\(c, \w+\)/, `${factory} does not apply the master trim`);
  }
});
