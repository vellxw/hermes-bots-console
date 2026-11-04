import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dashboard/index.js', import.meta.url), 'utf8');

test('group view remounts on profile and group changes in both responsive paths', () => {
  assert.match(source, /GroupRoomView, \{ key: `\$\{bot\?\.name \|\| route\.profile/);
  assert.match(source, /GroupRoomView, \{ key: `\$\{dataProfile\}:\$\{route\.group\}`/);
});

test('failed group send restores unsent text without overwriting newer draft', () => {
  assert.match(source, /groups\.send/);
  assert.match(source, /catch \(err\) \{ setDraft\(\(current\) => current\.trim\(\) \? current : text\); setError\(errText\(err\)\)/);
});
