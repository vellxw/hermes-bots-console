import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dashboard/index.js', import.meta.url), 'utf8');
test('public roster derives current profile identity instead of a hard-coded owner', () => {
  assert.doesNotMatch(source, /Perfil de Franco/);
  assert.match(source, /const headerBot = bots\.find/);
  assert.match(source, /aria-label": `Perfil \$\{headerLabel\}`/);
});
test('monitor abort and import timeouts clean listeners and timers', () => {
  assert.equal((source.match(/const clear = \(\) => \{ window\.clearTimeout\(timer\); signal\?\.removeEventListener\("abort", abort\); \};/g) || []).length, 2);
  assert.match(source, /Promise\.resolve\(\)\.then\(\(\) => rpc\.request\(method, params\)\)/);
  assert.match(source, /Promise\.resolve\(\)\.then\(loader\)/);
});
test('remote control buttons honor disabled state', () => {
  assert.match(source, /const iconButton = \(label, icon, onClick, cls, disabled\)/);
  assert.match(source, /onClick, disabled, type: "button"/);
});
