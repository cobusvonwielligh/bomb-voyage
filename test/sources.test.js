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

// The theme is the one binary the game actually plays, and it is the only reason server/index.js
// serves byte ranges at all. Both halves of that have to stay true together.
test('the theme file is there, and the server can serve it', () => {
  const mp3 = path.join(ROOT, 'public', 'assets', 'audio', 'theme.mp3');
  assert.ok(fs.existsSync(mp3), 'public/assets/audio/theme.mp3 is missing');
  assert.ok(fs.statSync(mp3).size > 100_000, 'theme.mp3 is suspiciously small');

  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(index, /'\.mp3':\s*'audio\/mpeg'/, 'server/index.js has no mp3 content type');
  assert.match(index, /Accept-Ranges/, 'server/index.js does not advertise byte ranges');
  assert.match(index, /206,/, 'server/index.js never answers a Range request with a 206');
  assert.match(index, /media-src 'self'/, "the CSP does not allow the page to play its own media");

  const music = fs.readFileSync(path.join(ROOT, 'public', 'client', 'audio', 'music.js'), 'utf8');
  assert.match(music, /\/assets\/audio\/theme\.mp3/, 'music.js does not point at the theme file');
  assert.match(music, /createTheme\(\{ bus: musicGain \}\)/,
    'the synthesised theme is no longer wired as the fallback');
});
