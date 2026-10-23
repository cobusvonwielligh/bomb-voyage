// Properties of the source files themselves, rather than of what they do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['shared', 'server', 'public', 'test', 'infra'];
const SKIP = new Set(['node_modules', '.git']);
const TEXT = /\.(js|mjs|css|html|md|json|sh|ini)$/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEXT.test(e.name)) yield p;
  }
}

const sources = [...DIRS.flatMap(d => [...walk(path.join(ROOT, d))])];

/**
 * A raw control byte inside a character class makes the file BINARY as far as grep and
 * `git diff` are concerned, and they then say nothing at all about it rather than saying it is
 * binary. `server/net.js` carried `[<NUL>-<US><DEL>]` in its name sanitiser for months: the
 * regex was correct and the tests were green, but every search over the hub came back empty,
 * so the whole spectator path looked like it had never been written.
 *
 * Write the escapes. A file you cannot search is a file nobody will fix.
 */
test('no source file contains a raw control byte', () => {
  const offenders = [];
  for (const file of sources) {
    const buf = fs.readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      // Tab, LF and CR are the only ones that belong in a text file.
      if (c === 9 || c === 10 || c === 13) continue;
      if (c >= 32 && c !== 127) continue;
      const line = buf.subarray(0, i).toString('utf8').split('\n').length;
      offenders.push(`${path.relative(ROOT, file)}:${line} byte 0x${c.toString(16).padStart(2, '0')}`);
      break;                                   // one report per file is enough to find it
    }
  }
  assert.deepEqual(offenders, [], `use \\xNN escapes instead:\n  ${offenders.join('\n  ')}`);
});

// Cheap, and it caught a 1.1 MB asset that had been committed by accident once already.
test('every text source is plausibly a text source', () => {
  assert.ok(sources.length > 40, `only found ${sources.length} sources — did the walk break?`);
});

/**
 * Every `/assets/...` URL in the shipped source resolves to a file that is actually there.
 *
 * A moved or renamed asset is silent: the font falls back, the mascot is an empty box, and the
 * theme quietly plays the synthesised fallback instead. None of those throw, so nothing else in
 * this suite would notice, and the first report is somebody in the office saying it looks odd.
 */
test('every asset referenced in the source exists on disk', () => {
  const missing = [];
  for (const file of sources) {
    if (!/\.(js|css|html)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/['"(](\/assets\/[\w./-]+)/g)) {
      const onDisk = path.join(ROOT, 'public', m[1]);
      if (!fs.existsSync(onDisk)) missing.push(`${path.relative(ROOT, file)} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `broken asset references:\n  ${missing.join('\n  ')}`);
});

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Every track in the rotation has a file named after it.
 *
 * The whole fallback scheme rests on that one convention: `createFileTrack` asks for
 * `/assets/audio/<name>.mp3` and uses the synthesised version of itself when it is not there.
 * Which means a missing or misnamed file does not fail — it silently downgrades to the synth,
 * and the only symptom is that the music is not the music. Nothing else here would notice.
 */
test('every track in the rotation has an audio file named after it', () => {
  const src = read('public/client/audio/music.js') + read('public/client/audio/ambient.js');
  const names = [...src.matchAll(/name: '(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(names.sort(), ['drift', 'suspend', 'theme', 'undertow'],
    'the set of tracks changed; the files have to change with it');

  for (const name of names) {
    const mp3 = path.join(ROOT, 'public', 'assets', 'audio', `${name}.mp3`);
    assert.ok(fs.existsSync(mp3), `no file for track "${name}" — it would silently play the synth`);
    assert.ok(fs.statSync(mp3).size > 100_000, `${name}.mp3 is suspiciously small`);

    // ID3 cover art is about a megabyte a file and nobody will ever see it. An MPEG frame sync
    // as the very first bytes is what proves the tag was stripped.
    const head = Buffer.alloc(2);
    const fd = fs.openSync(mp3, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    assert.ok(head[0] === 0xff && (head[1] & 0xe0) === 0xe0,
      `${name}.mp3 still has an ID3 tag on the front — strip it, it is ~25% of the download`);
  }
});

// The audio files are the only reason server/index.js serves byte ranges at all, and the only
// reason the CSP mentions media. Those have to stay true together or Safari plays nothing.
test('the server can actually serve the audio', () => {
  const index = read('server/index.js');
  assert.match(index, /'\.mp3':\s*'audio\/mpeg'/, 'server/index.js has no mp3 content type');
  assert.match(index, /Accept-Ranges/, 'server/index.js does not advertise byte ranges');
  assert.match(index, /206,/, 'server/index.js never answers a Range request with a 206');
  assert.match(index, /media-src 'self'/, "the CSP does not allow the page to play its own media");

  const music = read('public/client/audio/music.js');
  assert.match(music, /createTheme\(\{ bus: sidechain \}\)/,
    'the synthesised theme is no longer wired as the fallback');
  assert.match(music, /createAmbient\(\{ bus: sidechain \}\)/,
    'the synthesised beds are no longer wired as the fallback');
  // The dip must never write musicGain — see the comment on applyGain. One owner each.
  assert.match(music, /sidechain\.connect\(musicGain\)/,
    'the explosion duck is not on a node of its own any more');
});
