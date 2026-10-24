// Code is never served stale.
//
// Five minutes of max-age on every module meant that after a deploy a browser could run a mix of
// old and new files, each cached on its own clock — which is how ice tiles drew as holes onto the
// sea. Code now revalidates on every load and an unchanged file costs a body-less 304.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8097;
const base = `http://127.0.0.1:${PORT}`;

test('static caching', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-cache-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), LAG: '0', DATA_DIR: dataDir, DEPLOY_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('server did not come up')), 10_000);
    server.stdout.on('data', chunk => {
      if (String(chunk).includes('listening')) { clearTimeout(bail); resolve(); }
    });
    server.once('exit', code => { clearTimeout(bail); reject(new Error(`server exited (${code})`)); });
  });
  t.after(async () => {
    server.kill();
    await once(server, 'exit');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (const url of ['/client/main.js', '/shared/constants.js', '/assets/art.js', '/style.css']) {
    await t.test(`${url} is revalidated, and a match is a 304`, async () => {
      const first = await fetch(base + url);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'no-cache', 'code is cacheable without revalidation');
      const etag = first.headers.get('etag');
      assert.ok(etag, 'no ETag, so every revalidation re-downloads the file');
      await first.arrayBuffer();

      const again = await fetch(base + url, { headers: { 'If-None-Match': etag } });
      assert.equal(again.status, 304);
      assert.equal((await again.arrayBuffer()).byteLength, 0, 'a 304 carried a body');

      const stale = await fetch(base + url, { headers: { 'If-None-Match': 'W/"nope"' } });
      assert.equal(stale.status, 200, 'a stale ETag was answered with a 304');
      await stale.arrayBuffer();
    });
  }

  await t.test('the music keeps its long cache', async () => {
    const res = await fetch(base + '/assets/audio/theme.mp3', { headers: { Range: 'bytes=0-1' } });
    assert.equal(res.status, 206);
    assert.match(res.headers.get('cache-control'), /max-age=86400/);
    await res.arrayBuffer();
  });
});

test('art draws every block type the server can send', () => {
  // No canvas in Node, so this checks the source: every BLOCK has a case, or the fallback
  // exists that draws an unknown block as a wall instead of a hole onto the sea.
  const src = fs.readFileSync(path.join(ROOT, 'public/assets/art.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function drawTile'), src.indexOf('const OUTLINED'));
  assert.match(fn, /default:\s*\n?\s*if \(type !== BLOCK\.WATER/, 'drawTile has no fallback for an unknown type');
  assert.match(fn, /case BLOCK\.ICE:/, 'ice has no drawing code');
});
