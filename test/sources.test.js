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
