import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const project = new URL('../', import.meta.url);

function tarNames(buffer) {
  const names = [];
  for (let offset = 0; offset + 512 <= buffer.length; offset += 512) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    names.push(header.subarray(0, 100).toString('utf8').replace(/\0.*$/, ''));
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    offset += Math.ceil(size / 512) * 512;
  }
  return names;
}

test('pack creates a deterministic public release archive without catalog metadata or private paths', async () => {
  const run = () => execFileSync(process.execPath, ['scripts/package.mjs'], {
    cwd: new URL(project).pathname,
    encoding: 'utf8',
  });
  const firstOutput = run();
  assert.match(firstOutput, /Release archive:/);
  const archive = new URL('../dist/hermes-bots-console-0.5.0-rc.1.tar.gz', import.meta.url);
  const first = await readFile(archive);
  const secondOutput = run();
  assert.match(secondOutput, /SHA-256:/);
  const second = await readFile(archive);
  assert.deepEqual(second, first);

  const names = tarNames(gunzipSync(second));
  assert.ok(names.includes('hermes-bots-console-0.5.0-rc.1/plugin.json'));
  assert.ok(names.includes('hermes-bots-console-0.5.0-rc.1/dashboard/manifest.json'));
  assert.ok(!names.some((name) => name.includes('catalog-entry.yaml')));
  const privateMarker = ['/','home','franco'].join('');
  assert.ok(!names.some((name) => name.includes(privateMarker)));
});
