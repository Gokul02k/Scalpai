/**
 * Runs the v1 JavaScript engine so the Python port can be diffed against it.
 *
 * Reads {"module": "...", "fn": "...", "args": [...]} as JSON on stdin and
 * writes the return value as JSON on stdout.
 *
 * The source files under app/lib use ESM `export` but the package has no
 * "type": "module", so Node would parse them as CommonJS and throw. Copying
 * them to .mjs in a temp dir is the least invasive fix — it avoids changing
 * v1 source purely to make it testable.
 */
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, '..', '..', 'app', 'lib');

const MODULES = ['indicators', 'signals', 'suggestion', 'signalLog'];

async function loadModules() {
  const dir = mkdtempSync(join(tmpdir(), 'scalpai-parity-'));
  const loaded = {};
  for (const name of MODULES) {
    const dest = join(dir, `${name}.mjs`);
    copyFileSync(join(LIB, `${name}.js`), dest);
  }
  for (const name of MODULES) {
    loaded[name] = await import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  }
  return { loaded, dir };
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

const { loaded, dir } = await loadModules();
try {
  const req = JSON.parse(readStdin());
  const mod = loaded[req.module];
  if (!mod) throw new Error(`unknown module ${req.module}`);
  const fn = mod[req.fn];
  if (typeof fn !== 'function') throw new Error(`unknown fn ${req.module}.${req.fn}`);

  const out = fn(...(req.args ?? []));
  process.stdout.write(JSON.stringify({ ok: true, result: out === undefined ? null : out }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.stack || e) }));
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
