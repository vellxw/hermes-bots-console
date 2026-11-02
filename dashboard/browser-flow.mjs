import {
  CONTRACT_VERSION,
  assertProfile,
  createAuthorizationLedger,
  createIsolationBinding,
  grantAuthorization,
  isAuthorizationActive,
  revokeAuthorization,
  validateIsolationBinding,
} from './contracts.mjs';

export const BROWSER_FLOW_VERSION = '1';
export const BROWSER_MODES = Object.freeze(['planning', 'simulation', 'autonomous']);
export const BROWSER_STAGES = Object.freeze([
  'browser_open',
  'provider_consent',
  'hermes_enabled',
  'account_active',
  'action_executed',
]);
export const SAFE_BROWSER_TOOLS = Object.freeze(['local-browser', 'computer_use']);
export const RISK_GATES = Object.freeze([
  'account_ambiguous',
  'identity_required',
  'mfa',
  'captcha',
  'login',
  'payment',
  'irreversible',
  'mass_delete',
  'security_change',
  'legal',
  'high_risk',
]);

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SECRET_KEY_RE = /(?:password|passwd|token|secret|cookie|credential|authorization|api[_-]?key|private[_-]?key|connection|string|data[_-]?url|base64)/i;
const SECRET_VALUE_RE = /(?:data:[^,;\s]+;base64,|(?:password|passwd|token|secret|cookie|api[_-]?key|connection|string)\s*[:=])/i;
const ACCOUNT_ID_RE = /^[^\s]{1,160}$/;
const RISK_TEXT = [
  ['mfa', /\bmfa\b|two[- ]factor|2fa|verificaci[oó]n en dos pasos/i],
  ['captcha', /captcha|recaptcha|hcaptcha/i],
  ['login', /\blogin\b|sign[- ]?in|iniciar sesi[oó]n|contrase[nñ]a/i],
  ['payment', /pago|pay|payment|checkout|tarjeta|factura/i],
  ['mass_delete', /borrado masivo|eliminar todo|delete all|bulk delete/i],
  ['irreversible', /irreversible|borrar definitivamente|delete permanently|publicar|enviar definitivamente/i],
  ['security_change', /cambiar seguridad|security settings|2fa settings|permisos de seguridad/i],
  ['legal', /legal|jur[ií]dico|contrato|aceptar t[eé]rminos/i],
  ['high_risk', /alto riesgo|high risk|riesgo alto/i],
];

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function assertSafeObject(value, path = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeObject(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) throw new Error(`Campo secreto no permitido: ${path}${key}`);
    if (typeof child === 'string' && SECRET_VALUE_RE.test(child)) throw new Error(`Valor secreto no permitido: ${path}${key}`);
    assertSafeObject(child, `${path}${key}.`);
  }
}

function text(value, limit = 500) {
  const result = String(value ?? '').trim();
  if (SECRET_VALUE_RE.test(result)) throw new Error('Valor secreto no permitido');
  return result.slice(0, limit);
}

function safeAccountId(value) {
  const account = text(value, 160);
  if (!account || !ACCOUNT_ID_RE.test(account) || SECRET_VALUE_RE.test(account)) throw new Error('Identificador de cuenta inválido');
  return account;
}

function profileCheck(profile) {
  const normalized = assertProfile(profile);
  if (!PROFILE_RE.test(normalized)) throw new Error('Perfil inválido');
  return normalized;
}

function scopedPath(value, field, profile) {
  const path = text(value, 500);
  const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = new RegExp(`(?:^|[\\/:])${escaped}(?:$|[\\/])`, 'i');
  if (!path || /(?:^|[\\/])\.{1,2}(?:$|[\\/])/.test(path) || !marker.test(path)) throw new Error(`Recurso sin aislamiento por perfil: ${field}`);
  return path;
}

function normalizedEnvironment(profile, displayNumber, input = {}) {
  const display = text(input.DISPLAY ?? input.display ?? `:${displayNumber}`, 80);
  if (display !== `:${displayNumber}`) throw new Error('DISPLAY no coincide con el display del perfil');
  const xauthority = scopedPath(input.XAUTHORITY ?? input.xauthority ?? `/profiles/${profile}/bot-desktop/Xauthority`, 'XAUTHORITY', profile);
  return { DISPLAY: display, XAUTHORITY: xauthority };
}

export function createBrowserContext(profile, input = {}) {
  profile = profileCheck(profile);
  assertSafeObject(input);
  const source = input.binding || input;
  const isolation = createIsolationBinding(profile, {
    browser_profile: source.browser_profile || `/profiles/${profile}/bot-desktop/browser-profile`,
    desktop_name: source.desktop_name || `hermes:${profile}`,
    display: source.display || {},
    gateway_socket: source.gateway_socket || `/run/hermes/${profile}/gateway.sock`,
    lease: source.lease || { profile, holder: 'agent', viewer_id: `browser-flow-${profile}`, status: 'held' },
  });
  const env = normalizedEnvironment(profile, isolation.display.number, source.env || source.display_env || {});
  const context = {
    contract_version: CONTRACT_VERSION,
    browser_flow_version: BROWSER_FLOW_VERSION,
    profile,
    browser_profile: isolation.browser_profile,
    browser: {
      kind: 'local',
      visible: true,
      headed: true,
      headless: false,
      browser_profile: isolation.browser_profile,
    },
    desktop: { name: isolation.desktop_name },
    display: { number: isolation.display.number, socket: isolation.display.socket, env },
    gateway_socket: isolation.gateway_socket,
    lease: clone(isolation.lease),
  };
  return validateBrowserContext(context, profile);
}

export function validateBrowserContext(context, expectedProfile = context?.profile) {
  if (!context || typeof context !== 'object') throw new Error('Contexto de navegador inválido');
  const profile = profileCheck(expectedProfile);
  if (profileCheck(context.profile) !== profile) throw new Error('Contexto de otro perfil');
  if (context.browser?.kind !== 'local' || context.browser?.visible !== true || context.browser?.headed !== true || context.browser?.headless !== false) {
    throw new Error('El navegador debe ser local, headed y visible');
  }
  if (context.browser.browser_profile !== context.browser_profile && context.browser.browser_profile !== undefined) {
    throw new Error('browser_profile inconsistente');
  }
  const browserProfile = scopedPath(context.browser.browser_profile, 'browser_profile', profile);
  const desktopName = text(context.desktop?.name, 120);
  if (desktopName !== `hermes:${profile}`) throw new Error('desktop_name no coincide con el perfil');
  const displayNumber = Number(context.display?.number);
  if (!Number.isInteger(displayNumber) || displayNumber < 0) throw new Error('display inválido');
  const displaySocket = scopedPath(context.display?.socket, 'display.socket', profile);
  const gatewaySocket = scopedPath(context.gateway_socket, 'gateway_socket', profile);
  const env = normalizedEnvironment(profile, displayNumber, context.display?.env || {});
  const lease = context.lease || {};
  if (profileCheck(lease.profile) !== profile || !['agent', 'human', 'none'].includes(lease.holder) || !['held', 'released'].includes(lease.status) || !text(lease.viewer_id, 160)) {
    throw new Error('lease sin aislamiento por perfil');
  }
  return clone({ ...context, contract_version: CONTRACT_VERSION, browser_flow_version: BROWSER_FLOW_VERSION, profile,
    browser: { ...context.browser, browser_profile: browserProfile }, desktop: { name: desktopName },
    display: { number: displayNumber, socket: displaySocket, env }, gateway_socket: gatewaySocket, lease: { ...lease, profile } });
}

function accountDescriptor(raw, service) {
  if (!raw || typeof raw !== 'object') throw new Error('Cuenta detectada inválida');
  assertSafeObject(raw);
  const accountId = safeAccountId(raw.account_id ?? raw.id ?? raw.email ?? raw.account);
  const label = text(raw.display_name ?? raw.label ?? raw.email ?? accountId, 160) || accountId;
  return { account_id: accountId, display_name: label, service: text(raw.service || service || 'web', 80) };
}

function stageState(snapshot, selected) {
  const browserOpen = snapshot.browser_open === true;
  const providerConsent = snapshot.provider_consent === true;
  const hermesEnabled = snapshot.hermes_enabled === true;
  const accountActive = snapshot.account_active === true && browserOpen && providerConsent && hermesEnabled;
  return {
    browser_open: browserOpen ? 'verified' : 'unknown',
    provider_consent: providerConsent ? 'verified' : 'pending',
    hermes_enabled: hermesEnabled ? 'verified' : 'pending',
    account_active: accountActive ? 'verified' : 'pending',
    action_executed: 'not_executed',
  };
}

function detectionResult(context, snapshot, service, accounts, selected, reason = '') {
  const stages = stageState(snapshot, selected);
  const selectedAccount = accounts.find((account) => account.account_id === selected) || null;
  const active = Boolean(selectedAccount && stages.account_active === 'verified');
  return {
    contract_version: CONTRACT_VERSION,
    browser_flow_version: BROWSER_FLOW_VERSION,
    profile: context.profile,
    service,
    source: 'browser-profile',
    browser_profile: context.browser.browser_profile,
    context: clone(context),
    accounts: clone(accounts),
    selected_account: selectedAccount,
    preferred_account: selected || null,
    selection_required: accounts.length > 1 && !selected,
    account_state: active ? 'active' : selectedAccount ? 'pending' : accounts.length ? 'ambiguous' : 'missing',
    stages,
    evidence: [
      'browser.status.readback',
      ...(snapshot.provider_consent === true ? ['provider.consent.readback'] : []),
      ...(snapshot.hermes_enabled === true ? ['hermes.connection.readback'] : []),
      ...(active ? ['account.active.readback'] : []),
    ],
    status: reason ? 'blocked' : active ? 'ready' : accounts.length > 1 && !selected ? 'needs_selection' : accounts.length ? 'needs_verification' : 'blocked',
    stop: Boolean(reason),
    stop_reason: reason || null,
  };
}

export function detectOpenAccounts(context, snapshot = {}, { service = 'web', preferredAccount = '' } = {}) {
  context = validateBrowserContext(context);
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Snapshot de navegador inválido');
  assertSafeObject(snapshot);
  const cleanService = text(service, 80) || 'web';
  if (snapshot.profile && profileCheck(snapshot.profile) !== context.profile) throw new Error('Snapshot de otro perfil');
  const rawAccounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  const accounts = [];
  for (const raw of rawAccounts) {
    const account = accountDescriptor(raw, cleanService);
    if (!accounts.some((item) => item.account_id === account.account_id)) accounts.push(account);
  }
  if (snapshot.browser_open !== true) return detectionResult(context, snapshot, cleanService, accounts, '', 'browser-not-open');
  let selected = '';
  if (preferredAccount) {
    const preferred = safeAccountId(preferredAccount);
    if (accounts.some((account) => account.account_id === preferred)) selected = preferred;
  }
  if (!selected && accounts.length === 1) selected = accounts[0].account_id;
  return detectionResult(context, snapshot, cleanService, accounts, selected);
}

export function selectAccount(detection, accountId) {
  if (!detection || typeof detection !== 'object' || !Array.isArray(detection.accounts)) throw new Error('Detección de cuenta inválida');
  const profile = profileCheck(detection.profile);
  const selected = safeAccountId(accountId);
  const account = detection.accounts.find((item) => item.account_id === selected);
  if (!account) throw new Error('La cuenta no está abierta en este browser-profile');
  const next = clone(detection);
  next.profile = profile;
  next.selected_account = clone(account);
  next.preferred_account = selected;
  next.selection_required = false;
  next.account_state = next.stages?.account_active === 'verified' ? 'active' : 'pending';
  next.status = next.account_state === 'active' ? 'ready' : 'needs_verification';
  next.stop = false;
  next.stop_reason = null;
  next.evidence = [...new Set([...(next.evidence || []), 'account.selected.readback'])];
  return next;
}

export function createAccountPreference(profile, service, accountId) {
  return { profile: profileCheck(profile), service: text(service, 80) || 'web', account_id: safeAccountId(accountId), source: 'browser-profile' };
}

export function verifyAccountReadback(detection, snapshot = {}) {
  if (!detection?.selected_account) throw new Error('No hay una cuenta seleccionada');
  const contextProfile = profileCheck(detection.profile);
  const context = detection.context ? validateBrowserContext(detection.context, contextProfile) : createBrowserContext(contextProfile, { browser_profile: detection.browser_profile });
  const observed = detectOpenAccounts(context, { ...snapshot, profile: contextProfile }, { service: detection.service, preferredAccount: detection.selected_account.account_id });
  if (!observed.selected_account || observed.selected_account.account_id !== detection.selected_account.account_id) {
    return { ...observed, status: 'blocked', stop: true, stop_reason: 'account-readback-mismatch' };
  }
  return observed;
}

export function classifyRisk({ action = '', risk_flags = [], risk = '' } = {}) {
  const values = [action, risk, ...(Array.isArray(risk_flags) ? risk_flags : [])].map((value) => text(value, 240).toLowerCase()).join(' ');
  const gates = [];
  for (const [gate, pattern] of RISK_TEXT) if (pattern.test(values) && !gates.includes(gate)) gates.push(gate);
  return { gated: gates.length > 0, gates, primary: gates[0] || null };
}

export function evaluateBrowserAuthorization({ mode, capability = 'read', ledger, grantId = '', risk = {}, service = '', account = '' } = {}) {
  if (!BROWSER_MODES.includes(mode)) throw new Error('Modo Turbo inválido');
  const allowed = {
    planning: new Set(['read', 'plan', 'explain']),
    simulation: new Set(['read', 'plan', 'explain', 'prepare']),
    autonomous: new Set(['read', 'plan', 'explain', 'prepare', 'confirm', 'write']),
  }[mode];
  if (!allowed.has(capability)) return { allowed: false, reason: 'mode-capability-blocked', requires_confirmation: false };
  if (risk?.gated) return { allowed: false, reason: `risk-gate:${risk.primary}`, gates: risk.gates, requires_confirmation: true };
  if (mode !== 'autonomous') return { allowed: true, reason: mode === 'planning' ? 'planning-only' : 'simulation-only', requires_confirmation: false, execute: false };
  const grant = ledger?.grants?.find((item) => item.grant_id === grantId);
  const grantMatches = grant && grant.profile === ledger?.profile && grant.owner?.profile === ledger?.profile && (!service || grant.service === service) && (!account || grant.account === account);
  if (!grantMatches || !isAuthorizationActive(ledger, grantId, capability)) return { allowed: false, reason: 'authorization-required', requires_confirmation: true, execute: false };
  return { allowed: true, reason: 'persistent-grant', requires_confirmation: false, execute: true };
}

function cleanSteps(values) {
  const steps = Array.isArray(values) ? values : [];
  return steps.map((step) => text(step, 240)).filter(Boolean).slice(0, 32);
}

function cleanEvidence(values) {
  const evidence = Array.isArray(values) ? values : [];
  return evidence.map((item) => {
    if (typeof item === 'string') return { kind: text(item, 120), status: 'expected' };
    if (!item || typeof item !== 'object') throw new Error('Evidencia inválida');
    assertSafeObject(item);
    return { kind: text(item.kind || item.type || 'readback', 120), status: text(item.status || 'expected', 80), reference: text(item.reference || '', 180) || undefined };
  }).slice(0, 32);
}

export function createBrowserOperation({
  profile,
  context,
  detection,
  account,
  mode = 'planning',
  capability = mode === 'autonomous' ? 'write' : mode === 'simulation' ? 'prepare' : 'plan',
  grantLedger = null,
  grantId = '',
  tool = 'local-browser',
  action = 'read example.com',
  steps = [],
  evidence = [],
  expected_result = '',
  risk_flags = [],
} = {}) {
  profile = profileCheck(profile);
  context = validateBrowserContext(context, profile);
  if (!SAFE_BROWSER_TOOLS.includes(tool)) throw new Error('Herramienta de navegador no permitida');
  if (!detection || profileCheck(detection.profile) !== profile) throw new Error('Detección sin aislamiento por perfil');
  const verifiedStages = ['browser_open', 'provider_consent', 'hermes_enabled', 'account_active'];
  if (detection.status !== 'ready' || detection.account_state !== 'active' || verifiedStages.some((stage) => detection.stages?.[stage] !== 'verified')) throw new Error('La cuenta no tiene verificación completa');
  if (grantLedger && profileCheck(grantLedger.profile) !== profile) throw new Error('Ledger de autorización de otro perfil');
  const selected = detection.selected_account?.account_id || detection.preferred_account || '';
  const accountId = safeAccountId(account || selected);
  if (selected && accountId !== selected) throw new Error('La operación usa una cuenta distinta de la seleccionada');
  if (!detection.accounts.some((item) => item.account_id === accountId)) throw new Error('La cuenta no pertenece al browser-profile');
  const cleanAction = text(action, 240);
  const risk = classifyRisk({ action: cleanAction, risk_flags });
  const authorization = evaluateBrowserAuthorization({ mode, capability, ledger: grantLedger, grantId, risk, service: detection.service, account: accountId });
  const normalizedSteps = cleanSteps(steps);
  const normalizedEvidence = cleanEvidence(evidence);
  const expected = text(expected_result || 'El resultado esperado queda registrado sin ejecutar una acción externa.', 500);
  const operation = {
    contract_version: CONTRACT_VERSION,
    browser_flow_version: BROWSER_FLOW_VERSION,
    operation_id: `browser-op-${profile}-${Date.now()}`,
    profile,
    account: { service: detection.service, account_id: accountId, source: 'browser-profile' },
    browser_profile: context.browser.browser_profile,
    desktop: context.desktop.name,
    tool,
    mode,
    action: cleanAction,
    capability,
    steps: normalizedSteps,
    evidence: normalizedEvidence,
    expected_result: expected,
    risk,
    authorization,
    status: authorization.allowed ? (mode === 'planning' ? 'planned' : mode === 'simulation' ? 'prepared' : 'ready') : 'blocked',
    execute: authorization.execute === true,
    stop: authorization.allowed !== true,
    stop_reason: authorization.allowed ? null : authorization.reason,
  };
  operation.audit = {
    profile,
    account: accountId,
    tool,
    steps: clone(normalizedSteps),
    evidence: clone(normalizedEvidence),
    expected_result: expected,
  };
  return operation;
}

export function executeBrowserOperation(operation, adapter) {
  if (!operation || operation.stop !== false || operation.execute !== true || operation.mode !== 'autonomous') {
    throw new Error('La operación está bloqueada y no puede ejecutarse');
  }
  if (!adapter || typeof adapter.execute !== 'function') throw new Error('Adaptador de navegador no disponible');
  if (profileCheck(adapter.profile) !== profileCheck(operation.profile)) throw new Error('Adaptador de otro perfil');
  if (text(adapter.browser_profile, 500) !== text(operation.browser_profile, 500)) throw new Error('Adaptador de otro browser-profile');
  const result = adapter.execute(clone(operation));
  if (!result || typeof result !== 'object' || !Array.isArray(result.evidence)) throw new Error('La ejecución no devolvió evidencia de lectura');
  return { ...clone(operation), status: 'executed', execute: false, stop: false, evidence: result.evidence, result: text(result.result || 'Ejecución confirmada por el adaptador.', 500) };
}

export function createDryRunBrowserFixture(profile = 'researcher', { now = Date.now() } = {}) {
  profile = profileCheck(profile);
  const context = createBrowserContext(profile, {
    browser_profile: `/profiles/${profile}/bot-desktop/browser-profile`,
    desktop_name: `hermes:${profile}`,
    display: { socket: `/run/hermes/${profile}/display.sock` },
    gateway_socket: `/run/hermes/${profile}/gateway.sock`,
    env: { XAUTHORITY: `/profiles/${profile}/bot-desktop/Xauthority` },
    lease: { profile, holder: 'agent', viewer_id: `dry-run-browser-${profile}`, status: 'held' },
  });
  const snapshot = {
    profile,
    browser_open: true,
    provider_consent: true,
    hermes_enabled: true,
    account_active: true,
    accounts: [
      { account_id: 'demo@example.com', display_name: 'Demo Example', service: 'example.com' },
      { account_id: 'reviewer@example.com', display_name: 'Reviewer Example', service: 'example.com' },
    ],
    observed_at: now,
  };
  const ambiguous = detectOpenAccounts(context, snapshot, { service: 'example.com' });
  const detection = selectAccount(ambiguous, 'demo@example.com');
  let ledger = createAuthorizationLedger(profile, { clock: () => now });
  ledger = grantAuthorization(ledger, { grant_id: `grant-${profile}-example`, service: 'example.com', account: 'demo@example.com', capabilities: ['read', 'prepare', 'write'], persistent: true }, { clock: () => now });
  const planning = createBrowserOperation({ profile, context, detection, mode: 'planning', capability: 'plan', grantLedger: ledger, grantId: `grant-${profile}-example`, tool: 'local-browser', action: 'read example.com', steps: ['Abrir example.com en el Bot Desktop propio', 'Leer el título visible', 'Registrar evidencia de lectura'], evidence: ['browser.status.readback', 'page.title.readback'], expected_result: 'Se prepara un plan sin escribir fuera de Hermes.' });
  const simulation = createBrowserOperation({ profile, context, detection, mode: 'simulation', capability: 'prepare', grantLedger: ledger, grantId: `grant-${profile}-example`, tool: 'local-browser', action: 'preparar formulario de ejemplo', steps: ['Navegar al formulario mock', 'Rellenar datos ficticios', 'No pulsar confirmar'], evidence: ['form.visible.readback'], expected_result: 'El formulario queda preparado en memoria sin envío.' });
  const autonomous = createBrowserOperation({ profile, context, detection, mode: 'autonomous', capability: 'write', grantLedger: ledger, grantId: `grant-${profile}-example`, tool: 'local-browser', action: 'ejecutar una acción mock reversible', steps: ['Comprobar grant activo', 'Ejecutar mock local', 'Leer respuesta'], evidence: ['grant.active.readback'], expected_result: 'El mock confirma la operación sin contactar un proveedor real.' });
  const blocked = createBrowserOperation({ profile, context, detection, mode: 'autonomous', capability: 'write', grantLedger: ledger, grantId: `grant-${profile}-example`, tool: 'local-browser', action: 'pagar con tarjeta', steps: ['Detener antes del checkout'], evidence: ['risk-gate.readback'], expected_result: 'Se solicita confirmación explícita y no se paga.', risk_flags: ['payment'] });
  return { contract_version: CONTRACT_VERSION, browser_flow_version: BROWSER_FLOW_VERSION, profile, context, snapshot, ambiguous, detection, ledger, planning, simulation, autonomous, blocked };
}

export function createBrowserFlow(profile, { context, ledger, preferredAccounts = {} } = {}) {
  profile = profileCheck(profile);
  const safeContext = validateBrowserContext(context || createBrowserContext(profile), profile);
  const initialLedger = ledger || createAuthorizationLedger(profile);
  if (profileCheck(initialLedger.profile) !== profile) throw new Error('Ledger de otro perfil');
  let currentLedger = clone(initialLedger);
  return {
    profile,
    context: safeContext,
    get ledger() { return clone(currentLedger); },
    detect(snapshot, service = 'web') {
      return detectOpenAccounts(safeContext, snapshot, { service, preferredAccount: preferredAccounts[service] || '' });
    },
    select(detection, accountId) { return selectAccount(detection, accountId); },
    remember(service, accountId) { return createAccountPreference(profile, service, accountId); },
    operation(input) { return createBrowserOperation({ ...input, profile, context: safeContext, grantLedger: input?.grantLedger || currentLedger }); },
    revoke(grantId) { currentLedger = revokeAuthorization(currentLedger, grantId); return clone(currentLedger); },
  };
}

export function redactAccount(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  return SECRET_VALUE_RE.test(source) ? '[REDACTED]' : source.slice(0, 160);
}

export function browserContextFromIsolation(binding, profile = binding?.profile) {
  const isolated = validateIsolationBinding(binding, profileCheck(profile));
  return createBrowserContext(profile, {
    browser_profile: isolated.browser_profile,
    desktop_name: isolated.desktop_name,
    display: isolated.display,
    gateway_socket: isolated.gateway_socket,
    lease: isolated.lease,
  });
}

export { createAuthorizationLedger, grantAuthorization, isAuthorizationActive, revokeAuthorization };
