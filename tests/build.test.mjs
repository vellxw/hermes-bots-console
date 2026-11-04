import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

 test('build regenerates cache-busted assets and manifest integrity from source', async () => {
  const output = execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
  });
  assert.match(output, /assets verified/);

  const manifest = JSON.parse(await readFile(new URL('../dashboard/manifest.json', import.meta.url), 'utf8'));
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const [sourceEntry, bundledEntry, sourceCss, bundledCss] = await Promise.all([
    readFile(new URL(`../dashboard/index.js`, import.meta.url)),
    readFile(new URL(`../dashboard/${manifest.entry}`, import.meta.url)),
    readFile(new URL('../dashboard/style.css', import.meta.url)),
    readFile(new URL(`../dashboard/${manifest.css}`, import.meta.url)),
  ]);
  assert.equal(manifest.version, packageJson.version);
  assert.deepEqual(bundledEntry, sourceEntry);
  assert.deepEqual(bundledCss, sourceCss);
  assert.match(manifest.integrity, /^sha384-[A-Za-z0-9+/]+=*$/);
});
