// There is no build step, so nothing checks the browser's module graph until a browser loads it.
//
// `node --check` only parses. A named import of something the target module does not export is
// perfectly valid syntax and fails at link time — in the browser, at the worst possible moment,
// with a blank screen and one line in a console nobody has open. This walks the graph the way the
// browser will, resolving the `/shared` and `/assets` mounts exactly as server/index.js does, and
// proves every specifier resolves and every named import actually exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The two static mounts from server/index.js. Keep in step with MOUNTS there.
const MOUNTS = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/assets/', dir: path.join(ROOT, 'public', 'assets') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);
  if (!spec.startsWith('/')) return null;          // bare specifier: no import map, so invalid
  for (const { prefix, dir } of MOUNTS) {
    if (spec.startsWith(prefix)) return path.join(dir, spec.slice(prefix.length));
  }
  return null;
}

const IMPORT_RE = /^\s*import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm;
const EXPORT_RE = [
  /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
];

/**
 * Every name this module exports.
 *
 * Deliberately over-generous on `export const a = 1, b = 2, c = 3` — a very common shape in
 * constants.js — by taking every `identifier =` on the statement. An extra name here can only
 * ever let a bad import through; missing one would fail a perfectly good import, and a test that
 * cries wolf gets deleted. `=>` and `==` are excluded so arrow parameters do not count.
 */
function exportsOf(file, src) {
  const names = new Set();
  for (const re of EXPORT_RE) {
    for (const m of src.matchAll(re)) names.add(m[1]);
  }
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+([\s\S]*?);\s*$/gm)) {
    for (const d of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) names.add(d[1]);
  }
  // `export { a, b as c }`
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const as = part.split(/\sas\s/);
      const n = (as[1] ?? as[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  if (/^\s*export\s+default\b/m.test(src)) names.add('default');
  return names;
}

/** The named bindings an import clause asks for. Namespace and default imports are not checked. */
function importedNames(clause) {
  const braces = clause.match(/\{([^}]*)\}/);
  if (!braces) return [];
  return braces[1]
    .split(',')
    .map(part => part.split(/\sas\s/)[0].trim())
    .filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
}

function walk(entry) {
  const seen = new Map();          // absolute path -> source
  const problems = [];
  const queue = [entry];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) { problems.push(`missing module: ${path.relative(ROOT, file)}`); continue; }
    const src = fs.readFileSync(file, 'utf8');
    seen.set(file, src);
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = resolveSpecifier(m[2], file);
      if (!target) {
        problems.push(`${path.relative(ROOT, file)}: "${m[2]}" is not resolvable in a browser`);
        continue;
      }
      queue.push(target);
    }
  }

  // Second pass, now that every module's exports are known.
  for (const [file, src] of seen) {
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = resolveSpecifier(m[2], file);
      if (!target || !seen.has(target)) continue;
      const have = exportsOf(target, seen.get(target));
      for (const name of importedNames(m[1])) {
        if (!have.has(name)) {
          problems.push(
            `${path.relative(ROOT, file)} imports { ${name} } from "${m[2]}", ` +
            `which does not export it`);
        }
      }
    }
  }
  return { modules: [...seen.keys()], problems };
}

test('the browser module graph resolves and every named import exists', () => {
  const { modules, problems } = walk(path.join(ROOT, 'public', 'client', 'main.js'));
  assert.ok(modules.length >= 8, `only walked ${modules.length} modules — the walker is broken`);
  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}\n`);
});

test('index.html only references files that exist', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const missing = [];
  for (const m of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
    const target = resolveSpecifier(m[1], ROOT);
    if (!target || !fs.existsSync(target)) missing.push(m[1]);
  }
  assert.deepEqual(missing, []);
});

test('every element main.js looks up exists in index.html', () => {
  // `$('id')` with a literal is the only form used, and a typo here is a silent null dereference
  // on a code path nobody exercises until someone dies or a round ends.
  const main = fs.readFileSync(path.join(ROOT, 'public', 'client', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([A-Za-z][\w-]*)"/g)].map(m => m[1]));
  const wanted = new Set([...main.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map(m => m[1]));
  const missing = [...wanted].filter(id => !ids.has(id));
  assert.ok(wanted.size > 10, 'the extractor found almost nothing; it is broken');
  assert.deepEqual(missing, [], `main.js looks up ids that are not in the page: ${missing}`);
});
