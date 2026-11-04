import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const contracts = await import(new URL('../dashboard/contracts.mjs', import.meta.url).href);

const fixedNow = 1700000000000;

test('persiste el estado por perfil sin cruzar sesiones ni borradores', () => {
  const storage = contracts.createMemoryStorage();
  const store = contracts.createProfileStateStore(storage, { clock: () => fixedNow });
  const saved = store.update('researcher', {
    session: { stored_id: 'stored-researcher', runtime_id: 'runtime-researcher' },
    ui: { route: 'chat', draft: 'borrador local' },
  });
  assert.equal(saved.contract_version, contracts.CONTRACT_VERSION);
  assert.equal(saved.profile, 'researcher');
  assert.equal(store.get('researcher').session.stored_id, 'stored-researcher');
  const partial = store.update('researcher', { session: { stored_id: 'stored-researcher-2' } });
  assert.equal(partial.session.runtime_id, 'runtime-researcher');
  assert.equal(store.get('writer').session.stored_id, '');
  assert.equal(storage.getItem(contracts.profileStateKey('writer')), null);
  assert.equal(JSON.stringify(saved).includes('token'), false);
});

test('define binding profile-scoped para browser, desktop, display, socket y lease', () => {
  const binding = contracts.createIsolationBinding('researcher', {
    browser_profile: '/profiles/researcher/bot-desktop/browser-profile',
    desktop_name: 'hermes:researcher',
    display: { number: 0, socket: '/run/hermes/researcher/display.sock' },
    gateway_socket: '/run/hermes/researcher/gateway.sock',
    lease: { profile: 'researcher', holder: 'agent', viewer_id: 'viewer-researcher', status: 'held' },
  });
  assert.equal(contracts.validateIsolationBinding(binding, 'researcher').profile, 'researcher');
  assert.throws(() => contracts.validateIsolationBinding({ ...binding, gateway_socket: '/run/hermes/default/gateway.sock' }, 'researcher'), /aislamiento|profile/i);
  assert.throws(() => contracts.validateIsolationBinding({ ...binding, gateway_socket: '/run/hermes/researcher/../writer/gateway.sock' }, 'researcher'), /aislamiento|profile/i);
  assert.throws(() => contracts.validateIsolationBinding({ ...binding, lease: { ...binding.lease, profile: 'writer' } }, 'researcher'), /lease|profile/i);
});

test('mantiene un ledger de autorizaciones revocable y sin secretos', () => {
  let ledger = contracts.createAuthorizationLedger('researcher', { clock: () => fixedNow });
  ledger = contracts.grantAuthorization(ledger, {
    grant_id: 'grant-researcher-gmail', service: 'gmail', account: 'demo@example.com',
    capabilities: ['read', 'draft'], persistent: true,
  });
  assert.equal(contracts.isAuthorizationActive(ledger, 'grant-researcher-gmail', 'draft'), true);
  assert.equal(ledger.grants[0].owner.profile, 'researcher');
  assert.equal(JSON.stringify(ledger).includes('password'), false);
  assert.equal(JSON.stringify(ledger).includes('token'), false);
  assert.throws(() => contracts.grantAuthorization(ledger, {
    grant_id: 'bad', service: 'gmail', account: 'demo@example.com', capabilities: ['read'], token: 'secret',
  }), /secreto|secret/i);
  ledger = contracts.revokeAuthorization(ledger, 'grant-researcher-gmail', { clock: () => fixedNow + 1 });
  assert.equal(contracts.isAuthorizationActive(ledger, 'grant-researcher-gmail', 'read'), false);
  assert.equal(ledger.grants[0].status, 'revoked');
});

test('rejects cross-profile grants and secret values hidden in arrays', () => {
  let ledger = contracts.createAuthorizationLedger('researcher', { clock: () => fixedNow });
  ledger = contracts.grantAuthorization(ledger, { grant_id: 'grant-cross-profile', service: 'example.com', account: 'demo@example.com', capabilities: ['write'], persistent: true }, { clock: () => fixedNow });
  const forged = { ...ledger, grants: [{ ...ledger.grants[0], profile: 'writer', owner: { type: 'profile', profile: 'writer' } }] };
  assert.equal(contracts.isAuthorizationActive(forged, 'grant-cross-profile', 'write', fixedNow), false);
  assert.throws(() => contracts.normalizeProfileState('researcher', { notes: ['token=REAL_SECRET'] }), /secreto|secret/i);
  assert.throws(() => contracts.normalizeProfileState('researcher', { notes: 'arbitrary' }), /Campo de estado|estado/i);
});

test('normaliza eventos de auditoría permitidos y rechaza contenido sensible', () => {
  const event = contracts.createAuditEvent({
    event_id: 'audit-1', profile: 'researcher', type: 'authorization.granted', actor: 'user', outcome: 'accepted',
    metadata: { service: 'gmail', capabilities: ['read'], persistent: true }, at: fixedNow,
  });
  assert.equal(event.contract_version, contracts.CONTRACT_VERSION);
  assert.equal(event.profile, 'researcher');
  assert.equal(event.metadata.service, 'gmail');
  assert.throws(() => contracts.createAuditEvent({
    event_id: 'audit-2', profile: 'researcher', type: 'message.received', metadata: { token: 'secret' },
  }), /secreto|secret/i);
});

test('normaliza respuesta multimodal con descriptores de adjuntos, Markdown y voz', () => {
  const response = contracts.normalizeMultimodalResponse({
    response_id: 'response-1', profile: 'researcher', role: 'assistant',
    text: '# Resultado\n\n**Listo** [documentación](https://example.com)',
    attachments: [{ id: 'a-1', name: 'resultado.pdf', type: 'application/pdf', size: 128, kind: 'document', source: 'file', storage_key: 'hermes-bots-console://researcher/a-1' }],
    voice: { voice_id: 'voice-1', mime_type: 'audio/webm', duration_ms: 900, source: 'microphone', transcript: 'Resultado listo' },
    created_at: fixedNow,
  });
  assert.equal(response.profile, 'researcher');
  assert.equal(response.markdown.blocks[0].type, 'heading');
  assert.equal(response.attachments[0].storage_key, 'hermes-bots-console://researcher/a-1');
  assert.equal(response.voice.mime_type, 'audio/webm');
  assert.equal(JSON.stringify(response).includes('base64'), false);
  assert.throws(() => contracts.normalizeAttachmentDescriptor({ name: 'x.md', type: 'text/markdown', size: 2, storage_key: 'hermes-bots-console://researcherish/a1' }, 'researcher'), /contrato|profile/i);
  assert.throws(() => contracts.normalizeAttachmentDescriptor({ name: 'x.md', type: 'text/markdown', size: 2, storage_key: 'https://researcher/a1' }, 'researcher'), /contrato|profile/i);
  assert.throws(() => contracts.normalizeMultimodalResponse({ profile: 'researcher', text: 'x', data_url: 'data:audio/webm;base64,secret' }), /secreto|contenido|data_url/i);
});

test('Markdown queda en AST seguro y no permite HTML ejecutable ni URLs javascript', () => {
  const markdown = contracts.normalizeMarkdownDocument('# Título\n\n<script>alert(1)</script>\n\n[malicioso](javascript:alert(2))');
  assert.equal(markdown.format, 'gfm-safe');
  assert.equal(markdown.blocks[0].type, 'heading');
  assert.equal(JSON.stringify(markdown.blocks).includes('<script>'), false);
  assert.equal(markdown.blocks.some(block => JSON.stringify(block).includes('javascript:')), false);
});

test('voz usa descriptor profile-scoped sin audio inline y solo MIME permitido', () => {
  const voice = contracts.normalizeVoiceDescriptor({
    voice_id: 'voice-1', profile: 'researcher', mime_type: 'audio/ogg', duration_ms: 1200,
    source: 'remote', transcript: 'hola', storage_key: 'hermes-bots-console://researcher/voice-1',
  });
  assert.equal(voice.profile, 'researcher');
  assert.equal(voice.status, 'ready');
  assert.throws(() => contracts.normalizeVoiceDescriptor({ profile: 'researcher', mime_type: 'text/plain', duration_ms: 1 }), /MIME|voz/i);
  assert.throws(() => contracts.normalizeVoiceDescriptor({ profile: 'researcher', mime_type: 'audio/ogg', duration_ms: 1, data_url: 'data:audio/ogg;base64,x' }), /secreto|inline|data_url/i);
  assert.throws(() => contracts.normalizeVoiceDescriptor({ profile: 'researcher', mime_type: 'audio/ogg', duration_ms: 1.5 }), /Duración|voz/i);
});

test('fixture dry-run expone interfaces mock reproducibles sin side effects', async () => {
  const fixture = contracts.createDryRunFixture('researcher', { now: fixedNow });
  assert.equal(fixture.profile, 'researcher');
  assert.equal(fixture.isolation.desktop_name, 'hermes:researcher');
  assert.equal(fixture.authorization.grants[0].owner.profile, 'researcher');
  assert.equal(fixture.screen.rfb.protocol, '003.008');
  assert.equal(fixture.screen.rfb.desktop_name, 'hermes:researcher');
  assert.equal(fixture.group.room.members.length, 2);
  assert.equal(fixture.group.events[0].thread_id, fixture.group.thread_id);
  assert.ok(fixture.rpc_responses['groups.capabilities'].methods.includes('groups.send'));
  assert.equal(fixture.response.markdown.format, 'gfm-safe');
  const rpc = contracts.createDryRunRpc({ 'display.status': { running: false }, 'display.start': { running: true } });
  assert.deepEqual(await rpc.request('display.status', { profile: 'researcher' }), { running: false });
  assert.deepEqual(await rpc.request('display.start', { profile: 'researcher' }), { running: true });
  assert.equal(rpc.calls.length, 2);
});

test('contrato JSON documenta las mismas superficies que consumen los módulos', async () => {
  const spec = JSON.parse(await readFile(new URL('../contracts/bot-console-contracts.json', import.meta.url), 'utf8'));
  const versioned = await import(new URL('../dashboard/contracts-v001.mjs', import.meta.url).href);
  assert.equal(spec.contract_version, contracts.CONTRACT_VERSION);
  assert.equal(versioned.CONTRACT_VERSION, contracts.CONTRACT_VERSION);
  for (const key of ['profile_state', 'isolation_binding', 'authorization_grant', 'audit_event', 'multimodal_response', 'markdown_document', 'voice_descriptor', 'screen_dry_run', 'group_dry_run']) {
    assert.ok(spec.schemas[key], `falta schema ${key}`);
  }
  assert.ok(spec.fixtures.dry_run);
});
