import { parseMarkdown } from './interaction-core.mjs';

export const CONTRACT_VERSION = '1';
export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const STORAGE_KEY_PREFIX = 'hermes-bots-console.profile-state';
export const ATTACHMENT_STORAGE_KEY_RE = /^hermes-bots-console:\/\/([a-z0-9][a-z0-9_-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,159})$/;
export const AUDIT_TYPES = Object.freeze([
  'profile.state.loaded', 'profile.state.saved', 'screen.binding.created',
  'screen.lease.acquired', 'screen.lease.released', 'authorization.granted',
  'authorization.revoked', 'authorization.pending', 'authorization.cancelled',
  'turbo.mode.changed', 'turbo.operation.blocked', 'message.received', 'message.sent',
  'response.normalized', 'voice.transcribed',
]);

const SECRET_KEY_RE = /(?:password|passwd|passphrase|token|secret|cookie|credential|authorization|api[_-]?key|private[_-]?key|connection[_-]?string|client[_-]?secret|verification[_-]?code|mfa|otp|cvc|data[_-]?url|base64|audio[_-]?bytes|file[_-]?bytes)/i;
const INLINE_PAYLOAD_KEY_RE = /^(?:data[_-]?url|base64|audio[_-]?bytes|file[_-]?bytes|blob|file)$/i;
const SECRET_VALUE_RE = /(?:data:[^,;\s]+;base64,|(?:password|passwd|passphrase|token|secret|cookie|api[_-]?key|connection[_-]?string|verification[_-]?code|mfa|otp|cvc)\s*[:=])/i;
const SAFE_VOICE_MIME = new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm']);
const SAFE_HOLDERS = new Set(['agent', 'human', 'none']);
const SAFE_LEASE_STATUS = new Set(['held', 'released']);
const SAFE_AUDIT_METADATA_KEY_RE = /(?:text|content|markdown|transcript|audio|payload|data|body|html)/i;
const PATH_TRAVERSAL_RE = /(?:^|[\\/])\.{1,2}(?:$|[\\/])/;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

export function assertProfile(profile) {
  const value = String(profile ?? '');
  if (!PROFILE_RE.test(value)) throw new Error('Perfil inválido');
  return value;
}

function assertNoSecretKeys(value, path = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string' && SECRET_VALUE_RE.test(item)) throw new Error(`Valor secreto no permitido: ${path}[${index}]`);
      assertNoSecretKeys(item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) throw new Error(`Valor secreto no permitido: ${path}`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) throw new Error(`Campo secreto no permitido: ${path}${key}`);
    if (typeof child === 'string' && SECRET_VALUE_RE.test(child)) throw new Error(`Valor secreto no permitido: ${path}${key}`);
    assertNoSecretKeys(child, `${path}${key}.`);
  }
}

function assertNoInlinePayload(value, path = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlinePayload(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (INLINE_PAYLOAD_KEY_RE.test(key)) throw new Error(`Contenido inline no permitido: ${path}${key}`);
    if (typeof child === 'string' && SECRET_VALUE_RE.test(child)) throw new Error(`Contenido secreto no permitido: ${path}${key}`);
    assertNoInlinePayload(child, `${path}${key}.`);
  }
}

function normalizeStorageKey(value, profile, field = 'storage_key') {
  const key = String(value || '');
  const match = key.match(ATTACHMENT_STORAGE_KEY_RE);
  if (!match || match[1] !== profile) throw new Error(`${field} sin contrato profile-scoped`);
  return key;
}

export function profileStateKey(profile) {
  return `${STORAGE_KEY_PREFIX}.${assertProfile(profile)}`;
}

function defaultProfileState(profile, now) {
  return {
    contract_version: CONTRACT_VERSION,
    profile,
    updated_at: now,
    session: { stored_id: '', runtime_id: '' },
    turbo: { mode: 'planning', grants: [] },
    audit: [],
    ui: { route: 'roster', draft: '' },
  };
}

function normalizeStateGrants(profile, grants, now) {
  if (!Array.isArray(grants)) throw new Error('Ledger de grants inválido');
  return grants.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Grant inválido');
    assertNoSecretKeys(raw);
    const service = String(raw.service || '').trim().slice(0, 80);
    const account = String(raw.account || '').trim().slice(0, 160);
    const capabilities = [...new Set((Array.isArray(raw.capabilities) ? raw.capabilities : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 32);
    const status = String(raw.status || 'active');
    if (!service || !account || (!capabilities.length && status !== 'revoked') || !['active', 'revoked', 'pending'].includes(status)) throw new Error('Grant inválido');
    const persistent = Boolean(raw.persistent);
    return { grant_id: String(raw.grant_id || `${profile}-${service}-${account}`).slice(0, 160), contract_version: CONTRACT_VERSION, profile, service, account, capabilities, persistent, scope: persistent ? 'profile' : 'once', owner: { type: 'profile', profile }, status, granted_at: Number.isFinite(Number(raw.granted_at)) ? Number(raw.granted_at) : now, expires_at: raw.expires_at == null ? null : Number(raw.expires_at), ...(raw.revoked_at == null ? {} : { revoked_at: Number(raw.revoked_at) }) };
  });
}

function normalizeAuditTrail(profile, audit) {
  if (!Array.isArray(audit)) throw new Error('Auditoría inválida');
  return audit.slice(-200).map((event) => createAuditEvent({ ...event, profile }));
}

export function normalizeProfileState(profile, patch = {}, { now = Date.now() } = {}) {
  profile = assertProfile(profile);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Estado de perfil inválido');
  assertNoSecretKeys(patch);
  const allowed = { session: new Set(['stored_id', 'runtime_id']), turbo: new Set(['mode', 'grants']), ui: new Set(['route', 'draft']) };
  const topLevel = new Set(['contract_version', 'profile', 'updated_at', 'session', 'turbo', 'audit', 'ui']);
  for (const key of Object.keys(patch)) if (!topLevel.has(key)) throw new Error(`Campo de estado no permitido: ${key}`);
  for (const [section, keys] of Object.entries(allowed)) {
    if (patch[section] == null) continue;
    if (!patch[section] || typeof patch[section] !== 'object' || Array.isArray(patch[section])) throw new Error(`Sección de estado inválida: ${section}`);
    for (const key of Object.keys(patch[section])) if (!keys.has(key)) throw new Error(`Campo de estado no permitido: ${section}.${key}`);
  }
  if (patch.profile && assertProfile(patch.profile) !== profile) throw new Error('El estado pertenece a otro perfil');
  const base = defaultProfileState(profile, now);
  const state = { ...base, ...clone(patch), contract_version: CONTRACT_VERSION, profile, updated_at: Number.isFinite(Number(patch.updated_at)) ? Number(patch.updated_at) : now, session: { ...base.session, ...(patch.session || {}) }, turbo: { ...base.turbo, ...(patch.turbo || {}) }, audit: Array.isArray(patch.audit) ? clone(patch.audit) : base.audit, ui: { ...base.ui, ...(patch.ui || {}) } };
  if (!['planning', 'simulation', 'autonomous'].includes(state.turbo.mode)) throw new Error('Modo Turbo inválido');
  state.turbo.grants = normalizeStateGrants(profile, state.turbo.grants || [], now);
  state.audit = normalizeAuditTrail(profile, state.audit);
  if (typeof state.ui.route !== 'string' || !['roster', 'chat', 'groups', 'group'].includes(state.ui.route)) throw new Error('Ruta de UI inválida');
  assertNoSecretKeys(state);
  return state;
}

export function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    dump() { return Object.fromEntries(values); },
  };
}

export function createProfileStateStore(storage, { clock = Date.now } = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new Error('Storage inválido');
  return {
    get(profile) {
      profile = assertProfile(profile);
      let parsed = {};
      try { parsed = JSON.parse(storage.getItem(profileStateKey(profile)) || '{}'); } catch (_) { parsed = {}; }
      return normalizeProfileState(profile, parsed, { now: clock() });
    },
    update(profile, patch) {
      profile = assertProfile(profile);
      const current = this.get(profile);
      const requested = clone(patch || {});
      const next = normalizeProfileState(profile, {
        ...current,
        ...requested,
        session: { ...current.session, ...(requested.session || {}) },
        turbo: { ...current.turbo, ...(requested.turbo || {}) },
        ui: { ...current.ui, ...(requested.ui || {}) },
        profile,
      }, { now: clock() });
      storage.setItem(profileStateKey(profile), JSON.stringify(next));
      return next;
    },
    remove(profile) {
      storage.removeItem(profileStateKey(profile));
      return normalizeProfileState(profile, {}, { now: clock() });
    },
    appendAudit(profile, details) {
      profile = assertProfile(profile);
      const current = this.get(profile);
      const event = createAuditEvent({ ...details, profile, event_id: details?.event_id || `audit-${profile}-${clock()}` });
      return this.update(profile, { audit: [...current.audit, event] });
    },
    getAudit(profile) {
      return this.get(profile).audit;
    },
  };
}

function requireScopedString(value, field, profile) {
  const text = String(value ?? '').trim();
  const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = new RegExp(`(?:^|[\\/:])${escaped}(?:$|[\\/])`, 'i');
  if (!text || PATH_TRAVERSAL_RE.test(text) || !marker.test(text)) throw new Error(`Recurso sin aislamiento por perfil: ${field}`);
  return text;
}

export function createIsolationBinding(profile, input = {}) {
  profile = assertProfile(profile);
  const display = input.display || {};
  const lease = input.lease || {};
  const binding = {
    contract_version: CONTRACT_VERSION,
    profile,
    browser_profile: requireScopedString(input.browser_profile || `/profiles/${profile}/bot-desktop/browser-profile`, 'browser_profile', profile),
    desktop_name: String(input.desktop_name || `hermes:${profile}`),
    display: {
      number: Number.isInteger(display.number) ? display.number : 0,
      socket: requireScopedString(display.socket || `/run/hermes/${profile}/display.sock`, 'display.socket', profile),
    },
    gateway_socket: requireScopedString(input.gateway_socket || `/run/hermes/${profile}/gateway.sock`, 'gateway_socket', profile),
    lease: {
      profile: assertProfile(lease.profile || profile),
      holder: lease.holder || 'agent',
      viewer_id: String(lease.viewer_id || `dry-run-${profile}`),
      status: lease.status || 'held',
      expires_at: lease.expires_at == null ? null : Number(lease.expires_at),
    },
  };
  return validateIsolationBinding(binding, profile);
}

export function validateIsolationBinding(binding, expectedProfile = binding?.profile) {
  if (!binding || typeof binding !== 'object') throw new Error('Binding de aislamiento inválido');
  const profile = assertProfile(expectedProfile);
  if (assertProfile(binding.profile) !== profile) throw new Error('Binding de otro perfil');
  if (binding.desktop_name !== `hermes:${profile}`) throw new Error('desktop_name no coincide con el perfil');
  requireScopedString(binding.browser_profile, 'browser_profile', profile);
  requireScopedString(binding.gateway_socket, 'gateway_socket', profile);
  if (!binding.display || !Number.isInteger(binding.display.number) || binding.display.number < 0) throw new Error('display inválido');
  requireScopedString(binding.display.socket, 'display.socket', profile);
  if (!binding.lease || assertProfile(binding.lease.profile) !== profile) throw new Error('lease sin aislamiento por perfil');
  if (!SAFE_HOLDERS.has(binding.lease.holder) || !SAFE_LEASE_STATUS.has(binding.lease.status)) throw new Error('lease inválido');
  if (!String(binding.lease.viewer_id || '').trim()) throw new Error('viewer_id inválido');
  return clone({ ...binding, contract_version: CONTRACT_VERSION, profile });
}

export function createAuthorizationLedger(profile, { clock = Date.now } = {}) {
  return { contract_version: CONTRACT_VERSION, profile: assertProfile(profile), grants: [], updated_at: clock() };
}

function normalizeGrant(ledger, input, now) {
  assertNoSecretKeys(input);
  const profile = assertProfile(ledger.profile);
  if (!input || typeof input !== 'object') throw new Error('Grant inválido');
  const service = String(input.service || '').trim().slice(0, 80);
  const account = String(input.account || '').trim().slice(0, 160);
  const capabilities = [...new Set((Array.isArray(input.capabilities) ? input.capabilities : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 32);
  if (!service || !account || (!capabilities.length && input.status !== 'revoked')) throw new Error('Grant incompleto');
  if (SECRET_VALUE_RE.test(service) || SECRET_VALUE_RE.test(account) || capabilities.some((item) => SECRET_VALUE_RE.test(item))) throw new Error('Secreto no permitido en grant');
  const persistent = Boolean(input.persistent);
  const grantId = String(input.grant_id || `${profile}-${service}-${account}`).slice(0, 160);
  const status = String(input.status || 'active');
  if (!['active', 'revoked', 'pending'].includes(status)) throw new Error('Estado de grant inválido');
  return {
    grant_id: grantId,
    contract_version: CONTRACT_VERSION,
    profile,
    service,
    account,
    capabilities,
    persistent,
    scope: persistent ? 'profile' : 'once',
    owner: { type: 'profile', profile },
    status,
    granted_at: Number.isFinite(Number(input.granted_at)) ? Number(input.granted_at) : now,
    expires_at: input.expires_at == null ? null : Number(input.expires_at),
    ...(input.revoked_at == null ? {} : { revoked_at: Number(input.revoked_at) }),
  };
}

export function grantAuthorization(ledger, input, { clock = Date.now } = {}) {
  if (!ledger || !Array.isArray(ledger.grants)) throw new Error('Ledger inválido');
  const next = normalizeGrant(ledger, input, clock());
  const grants = ledger.grants.filter((item) => item.grant_id !== next.grant_id && !(item.service === next.service && item.account === next.account));
  return { ...clone(ledger), contract_version: CONTRACT_VERSION, grants: [...grants, next], updated_at: clock() };
}

export function revokeAuthorization(ledger, grantId, { clock = Date.now } = {}) {
  if (!ledger || !Array.isArray(ledger.grants)) throw new Error('Ledger inválido');
  const id = String(grantId || '');
  return { ...clone(ledger), grants: ledger.grants.map((grant) => grant.grant_id === id ? { ...grant, status: 'revoked', capabilities: [], revoked_at: clock() } : grant), updated_at: clock() };
}

export function isAuthorizationActive(ledger, grantId, capability, now = Date.now()) {
  return Boolean(ledger?.grants?.some((grant) => grant.grant_id === grantId && grant.profile === ledger.profile && grant.owner?.profile === ledger.profile && grant.status === 'active' && grant.capabilities.includes(capability) && (grant.expires_at == null || Number(grant.expires_at) > now)));
}

export function createAuditEvent({ event_id, profile, type, actor = 'system', outcome = 'ok', metadata = {}, account, tool, evidence, expected_result, result, at = Date.now() }) {
  profile = assertProfile(profile);
  if (!AUDIT_TYPES.includes(type)) throw new Error(`Evento de auditoría no permitido: ${type}`);
  if (!event_id || !String(event_id).trim()) throw new Error('event_id requerido');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('metadata inválida');
  const operational = { ...metadata };
  for (const [key, value] of Object.entries({ account, tool, evidence, expected_result, result })) if (value != null) operational[key] = String(value).slice(0, 240);
  assertNoSecretKeys(operational);
  for (const key of Object.keys(operational)) if (SAFE_AUDIT_METADATA_KEY_RE.test(key)) throw new Error(`Contenido no permitido en auditoría: ${key}`);
  return { contract_version: CONTRACT_VERSION, event_id: String(event_id).slice(0, 160), at: Number.isFinite(Number(at)) ? Number(at) : Date.now(), profile, type, actor: String(actor || 'system').slice(0, 80), outcome: String(outcome || 'ok').slice(0, 80), metadata: clone(operational) };
}

function cleanName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 240 || name.includes('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name)) throw new Error('Nombre de adjunto inválido');
  return name;
}

export function normalizeAttachmentDescriptor(input, profile) {
  profile = assertProfile(profile || input?.profile);
  if (input?.profile != null && assertProfile(input.profile) !== profile) throw new Error('Adjunto de otro perfil');
  assertNoInlinePayload(input || {});
  const name = cleanName(input?.name);
  const type = String(input?.type || 'application/octet-stream').toLowerCase().split(';')[0];
  const size = Number(input?.size || 0);
  if (!Number.isInteger(size) || size < 0 || size > 25 * 1024 * 1024) throw new Error('Adjunto demasiado grande');
  if (!(type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/') || ['application/pdf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/rtf', 'text/plain', 'text/markdown', 'text/csv', 'application/octet-stream'].includes(type))) throw new Error('Tipo MIME de adjunto no permitido');
  const storageKey = input?.storage_key == null ? null : normalizeStorageKey(input.storage_key, profile);
  return {
    id: String(input?.id || `attachment-${profile}-${Date.now()}`).slice(0, 160),
    profile,
    name,
    type,
    size,
    kind: String(input?.kind || (type.startsWith('image/') ? 'image' : type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : 'document')).slice(0, 32),
    source: String(input?.source || 'file').slice(0, 32),
    ...(storageKey ? { storage_key: storageKey } : {}),
    status: 'ready',
  };
}

function safeMarkdownSource(value) {
  return String(value || '').slice(0, 200000).replace(/<[^>]*>/g, '').replace(/\bjavascript\s*:/gi, '').replace(/\bvbscript\s*:/gi, '');
}

export function normalizeMarkdownDocument(source) {
  const clean = safeMarkdownSource(source);
  return { format: 'gfm-safe', source: clean, blocks: parseMarkdown(clean) };
}

export function normalizeVoiceDescriptor(input) {
  assertNoInlinePayload(input || {});
  const profile = assertProfile(input?.profile);
  const mime_type = String(input?.mime_type || '').toLowerCase().split(';')[0];
  if (!SAFE_VOICE_MIME.has(mime_type)) throw new Error('MIME de voz no permitido');
  const duration_ms = Number(input?.duration_ms || 0);
  if (!Number.isInteger(duration_ms) || duration_ms < 0 || duration_ms > 60 * 60 * 1000) throw new Error('Duración de voz inválida');
  const storage_key = normalizeStorageKey(input?.storage_key || `hermes-bots-console://${profile}/${String(input?.voice_id || `voice-${Date.now()}`)}`, profile, 'Voz');
  return {
    voice_id: String(input?.voice_id || `voice-${profile}-${Date.now()}`).slice(0, 160),
    profile,
    mime_type,
    duration_ms,
    source: ['microphone', 'remote', 'upload'].includes(input?.source) ? input.source : 'microphone',
    transcript: input?.transcript == null ? '' : String(input.transcript).slice(0, 10000),
    storage_key,
    status: 'ready',
  };
}

export function normalizeMultimodalResponse(input) {
  if (!input || typeof input !== 'object') throw new Error('Respuesta multimodal inválida');
  assertNoInlinePayload(input);
  const profile = assertProfile(input.profile);
  const text = String(input.text || '').slice(0, 200000);
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []).map((item) => normalizeAttachmentDescriptor(item, profile));
  if (input.voice?.profile != null && assertProfile(input.voice.profile) !== profile) throw new Error('Voz de otro perfil');
  const voice = input.voice ? normalizeVoiceDescriptor(input.voice.profile == null ? { ...input.voice, profile } : input.voice) : null;
  return {
    contract_version: CONTRACT_VERSION,
    response_id: String(input.response_id || `response-${profile}-${Date.now()}`).slice(0, 160),
    profile,
    role: input.role === 'user' ? 'user' : 'assistant',
    text,
    markdown: normalizeMarkdownDocument(text),
    attachments,
    voice,
    created_at: Number.isFinite(Number(input.created_at)) ? Number(input.created_at) : Date.now(),
  };
}

export function createDryRunRpc(responses = {}) {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
    emit(name, value) { for (const listener of listeners.get(name) || []) listener(value); },
    async request(method, params = {}) {
      calls.push({ method, params: clone(params) });
      const response = responses[method];
      return typeof response === 'function' ? clone(await response(params)) : clone(response ?? {});
    },
    close() { this.closed = true; },
  };
}

export function createDryRunRpcResponses(profile = 'researcher') {
  profile = assertProfile(profile);
  const secondProfile = profile === 'writer' ? 'researcher' : 'writer';
  const room = {
    room_id: `hermes-bots-dry-run-${profile}`,
    name: 'Dry run',
    members: [profile, secondProfile].map((member) => ({ member_id: member, profile: member, handle: member, display_name: member })),
  };
  return {
    'display.status': { profile, running: true, display: 22, desktop_name: `hermes:${profile}` },
    'display.start': { profile, running: true, display: 22, desktop_name: `hermes:${profile}` },
    'display.observe': { profile, viewer_id: `viewer-${profile}`, ticket: `dry-run-ticket-${profile}`, desktop_name: `hermes:${profile}`, lease: { profile, holder: 'agent', status: 'held' } },
    'display.lease.acquire': { profile, lease: { profile, holder: 'human', status: 'held', viewer_id: `viewer-${profile}` } },
    'display.lease.release': { profile, lease: { profile, holder: 'agent', status: 'released', viewer_id: `viewer-${profile}` } },
    'groups.capabilities': { driver: 'hermes.native.groups', methods: ['groups.list', 'groups.create', 'groups.log', 'groups.send', 'groups.state', 'groups.stop'], max_log_limit: 200 },
    'groups.list': { rooms: [room] },
    'groups.create': { room },
    'groups.log': { events: [{ event_id: `event-${profile}-1`, seq: 1, room_id: room.room_id, thread_id: `thread-${room.room_id}`, kind: 'message.member', actor: { profile, display_name: profile }, payload: { text: 'Dry run' } }], latest_seq: 1, has_more: false },
    'groups.state': { room, driver_status: { working: false, pending_actions: [] } },
    'groups.send': { accepted: true },
    'groups.stop': { accepted: true },
  };
}

export function createDryRunFixture(profile = 'researcher', { now = Date.now() } = {}) {
  profile = assertProfile(profile);
  let authorization = createAuthorizationLedger(profile, { clock: () => now });
  authorization = grantAuthorization(authorization, { grant_id: `grant-${profile}-dry-run`, service: 'gmail', account: 'demo@example.com', capabilities: ['read'], persistent: true }, { clock: () => now });
  const isolation = createIsolationBinding(profile, {
    browser_profile: `/profiles/${profile}/bot-desktop/browser-profile`,
    desktop_name: `hermes:${profile}`,
    display: { number: 0, socket: `/run/hermes/${profile}/display.sock` },
    gateway_socket: `/run/hermes/${profile}/gateway.sock`,
    lease: { profile, holder: 'agent', viewer_id: `viewer-${profile}`, status: 'held' },
  });
  const response = normalizeMultimodalResponse({
    response_id: `response-${profile}-dry-run`, profile, text: '# Dry run\n\n**Contrato listo**.',
    attachments: [{ id: `attachment-${profile}-1`, name: 'resultado.md', type: 'text/markdown', size: 64, kind: 'document', source: 'fixture', storage_key: `hermes-bots-console://${profile}/attachment-1` }],
    voice: { voice_id: `voice-${profile}-1`, profile, mime_type: 'audio/webm', duration_ms: 400, source: 'microphone', transcript: 'Contrato listo', storage_key: `hermes-bots-console://${profile}/voice-1` },
    created_at: now,
  });
  const rpc_responses = createDryRunRpcResponses(profile);
  return {
    contract_version: CONTRACT_VERSION,
    profile,
    state: normalizeProfileState(profile, { session: { stored_id: `stored-${profile}`, runtime_id: `runtime-${profile}` } }, { now }),
    isolation,
    authorization,
    audit: [createAuditEvent({ event_id: `audit-${profile}-dry-run`, profile, type: 'response.normalized', metadata: { response_id: response.response_id }, at: now })],
    screen: { profile, status: rpc_responses['display.status'], observe: rpc_responses['display.observe'], rfb: { protocol: '003.008', width: 1440, height: 900, desktop_name: `hermes:${profile}` } },
    group: { room: rpc_responses['groups.state'].room, capabilities: rpc_responses['groups.capabilities'], events: rpc_responses['groups.log'].events, thread_id: `thread-${rpc_responses['groups.state'].room.room_id}` },
    rpc_responses,
    response,
  };
}
