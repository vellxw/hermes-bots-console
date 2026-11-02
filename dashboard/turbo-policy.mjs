// Fail-closed Turbo policy. This module contains no network or UI dependencies.
export const MODES = Object.freeze(['planning', 'simulation', 'autonomous']);
export const EXCEPTIONS = Object.freeze([
  'ambiguous_account', 'identity_required', 'mfa_or_captcha', 'payment',
  'irreversible_delete', 'security_change', 'legal_action', 'high_risk',
]);
const MODE_CAPABILITIES = Object.freeze({
  planning: new Set(['read', 'plan', 'explain']),
  simulation: new Set(['read', 'plan', 'explain', 'prepare']),
  autonomous: new Set(['read', 'plan', 'explain', 'prepare', 'confirm', 'write']),
});
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SECRET_KEY_RE = /(?:password|passwd|passphrase|token|secret|cookie|credential|authorization|api[_-]?key|private[_-]?key|connection[_-]?string|verification[_-]?code|mfa|otp|cvc|data[_-]?url|base64)/i;
const SECRET_VALUE_RE = /(?:data:[^,;\s]+;base64,|(?:password|passwd|passphrase|token|secret|cookie|api[_-]?key|connection[_-]?string|verification[_-]?code|mfa|otp|cvc)\s*[:=])/i;
const SAFE_AUDIT_KEY_RE = /^(?:account|service|capabilit(?:y|ies)|tool|evidence|expected_result|result|operation_id|grant_id|mode|action|status|reason|response_id|dry_run|executed)$/;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

export function assertProfile(profile) {
  const value = String(profile || '');
  if (!PROFILE_RE.test(value)) throw new Error('Perfil inválido');
  return value;
}

function assertSafe(value, path = '') {
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) throw new Error(`Valor secreto no permitido: ${path}`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => assertSafe(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) throw new Error(`Campo secreto no permitido: ${path}${key}`);
    if (typeof child === 'string' && SECRET_VALUE_RE.test(child)) throw new Error(`Valor secreto no permitido: ${path}${key}`);
    assertSafe(child, `${path}${key}.`);
  }
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return typeof value === 'string' && SECRET_VALUE_RE.test(value) ? '[REDACTED]' : value;
  const output = {};
  for (const [key, child] of Object.entries(value)) output[key] = SECRET_KEY_RE.test(key) || (typeof child === 'string' && SECRET_VALUE_RE.test(child)) ? '[REDACTED]' : redact(child);
  return output;
}

export function modeAllows(mode, capability) {
  return Boolean(MODE_CAPABILITIES[mode]?.has(capability));
}

export function requiresConfirmation(mode, operation = {}) {
  if (!MODES.includes(mode)) throw new Error('Modo Turbo inválido');
  const exceptions = [...(Array.isArray(operation.exceptions) ? operation.exceptions : []), operation.exception, operation.risk].filter(Boolean);
  if (exceptions.length) return true;
  return ['confirm', 'write'].includes(String(operation.capability || operation.action || '')) && !modeAllows(mode, String(operation.capability || operation.action || ''));
}

function operationIsScoped(state, operation) {
  return assertProfile(operation.profile) === assertProfile(state.profile)
    && String(operation.service || '').trim() !== ''
    && String(operation.account || '').trim() !== ''
    && String(operation.capability || '').trim() !== '';
}

function hasActiveGrant(state, operation, now = Date.now()) {
  if (!operationIsScoped(state, operation)) return false;
  return (state.grants || []).some((grant) => grant.profile === state.profile && grant.service === operation.service && grant.account === operation.account && grant.status === 'active' && grant.capabilities?.includes(operation.capability) && (grant.expires_at == null || Number(grant.expires_at) > now));
}

export function decide(state, operation = {}, { now = Date.now() } = {}) {
  assertSafe(operation);
  if (!state || !MODES.includes(state.mode) || !operationIsScoped(state, operation)) return { allowed: false, requires_confirmation: false, reason: 'scope_mismatch', executed: false };
  const exceptions = [...(Array.isArray(operation.exceptions) ? operation.exceptions : []), operation.exception, operation.risk].filter(Boolean);
  if (exceptions.length) return { allowed: false, requires_confirmation: true, reason: exceptions.find((item) => EXCEPTIONS.includes(item)) || 'protected_operation', executed: false };
  if (!modeAllows(state.mode, operation.capability)) return { allowed: false, requires_confirmation: false, reason: 'mode_restriction', executed: false };
  if (state.mode !== 'autonomous') return { allowed: true, requires_confirmation: false, reason: state.mode, executed: false };
  if (!hasActiveGrant(state, operation, now)) return { allowed: false, requires_confirmation: true, reason: 'grant_required', executed: false };
  // A policy decision is not execution evidence; the adapter must provide readback.
  return { allowed: true, requires_confirmation: false, reason: 'active_grant', executed: false };
}

export function createAuditEvent({ profile, event_id, type = 'turbo.operation.blocked', outcome = 'ok', account, tool, evidence, expected_result, result, metadata = {}, at = Date.now() }) {
  profile = assertProfile(profile);
  const operational = { ...metadata, account, tool, evidence, expected_result, result };
  for (const [key, value] of Object.entries(operational)) if (value == null) delete operational[key];
  assertSafe(operational);
  for (const key of Object.keys(operational)) if (!SAFE_AUDIT_KEY_RE.test(key)) throw new Error(`Metadata de auditoría no permitida: ${key}`);
  return { contract_version: '1', event_id: String(event_id || `audit-${profile}-${at}`).slice(0, 160), at, profile, type, actor: 'turbo-policy', outcome, metadata: clone(operational) };
}
