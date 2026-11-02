import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { attachmentPayload, normalizeAttachment, inlineTokens } from '../dashboard/interaction-core.mjs';

const source = await readFile(new URL('../dashboard/index.js', import.meta.url), 'utf8');

test('attachment descriptors retain profile and storage key but no file content', () => {
  const result = attachmentPayload([{ id: 'a1', profile: 'researcher', name: 'notes.md', type: 'text/markdown', size: 6, kind: 'document', source: 'file', storage_key: 'hermes-bots-console://researcher/a1', file: new Blob(['secret']) }]);
  assert.equal(result[0].profile, 'researcher');
  assert.equal(result[0].storage_key, 'hermes-bots-console://researcher/a1');
  assert.equal(Object.hasOwn(result[0], 'file'), false);
});

test('image and file fixtures preserve kind and MIME validation', () => {
  assert.equal(normalizeAttachment({ name: 'capture.png', type: 'image/png', size: 8 }).kind, 'image');
  assert.equal(normalizeAttachment({ name: 'notes.md', type: 'text/markdown', size: 16 }).kind, 'document');
  assert.throws(() => normalizeAttachment({ name: 'photo.png', type: 'text/plain', size: 2 }), /MIME/);
});

test('Markdown consumes inline emphasis after prose and neutralizes executable URLs', () => {
  const tokens = inlineTokens('Hola **mundo**');
  assert.equal(tokens.some(token => token.type === 'strong'), true);
  const malicious = inlineTokens('[x](javascript:alert(1)) <img src=x onerror=alert(1)>');
  assert.equal(malicious.some(token => token.type === 'link'), false);
  assert.equal(JSON.stringify(malicious).includes('<img'), false);
});

test('ChatView uses multipart voice adapter and surfaces accessible progress/errors', () => {
  assert.match(source, /transcribeAudioBlob/);
  assert.match(source, /\/audio\/transcribe\?profile/);
  assert.match(source, /new FormData/);
  const voiceAdapter = source.slice(source.indexOf('async function transcribeAudioBlob'), source.indexOf('function blobAsDataUrl'));
  assert.doesNotMatch(voiceAdapter, /data_url:/);
  assert.match(source, /Progreso de/);
  assert.match(source, /Reproducir respuesta de voz/);
});

test('generic file attachments use the Gateway data_url contract', () => {
  const attach = source.slice(source.indexOf('async function attachBlobToGateway'), source.indexOf('function safeMessageText'));
  assert.match(attach, /rpc\.request\("file\.attach",\s*\{[\s\S]*data_url:\s*dataUrl/);
  assert.doesNotMatch(attach, /rpc\.request\("file\.attach",\s*\{[\s\S]*content_base64:/);
});
