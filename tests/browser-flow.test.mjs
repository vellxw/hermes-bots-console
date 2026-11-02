import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_MODES,
  SAFE_BROWSER_TOOLS,
  classifyRisk,
  createAccountPreference,
  createBrowserContext,
  createBrowserFlow,
  createBrowserOperation,
  createDryRunBrowserFixture,
  detectOpenAccounts,
  evaluateBrowserAuthorization,
  executeBrowserOperation,
  selectAccount,
  validateBrowserContext,
  verifyAccountReadback,
} from '../dashboard/browser-flow.mjs';
import { createAuthorizationLedger, grantAuthorization, revokeAuthorization } from '../dashboard/contracts.mjs';

const now = 1700000000000;

function context(profile = 'researcher') {
  return createBrowserContext(profile, {
    browser_profile: `/profiles/${profile}/bot-desktop/browser-profile`,
    desktop_name: `hermes:${profile}`,
    display: { number: 0, socket: `/run/hermes/${profile}/display.sock` },
    gateway_socket: `/run/hermes/${profile}/gateway.sock`,
    env: { DISPLAY: ':0', XAUTHORITY: `/profiles/${profile}/bot-desktop/Xauthority` },
    lease: { profile, holder: 'agent', viewer_id: `viewer-${profile}`, status: 'held' },
  });
}

function snapshot(accounts = [{ account_id: 'demo@example.com', display_name: 'Demo', service: 'example.com' }]) {
  return { profile: 'researcher', browser_open: true, provider_consent: true, hermes_enabled: true, account_active: true, accounts };
}

test('browser context is local, headed, visible and profile-isolated', () => {
  const isolated = context();
  assert.equal(isolated.browser.kind, 'local');
  assert.equal(isolated.browser.headless, false);
  assert.equal(isolated.browser.visible, true);
  assert.equal(isolated.browser.browser_profile.includes('researcher'), true);
  assert.equal(isolated.display.env.DISPLAY, ':0');
  assert.equal(isolated.display.env.XAUTHORITY.includes('researcher'), true);
  assert.equal(isolated.desktop.name, 'hermes:researcher');
  assert.throws(() => validateBrowserContext({ ...isolated, browser: { ...isolated.browser, headless: true } }, 'researcher'), /local|headed|visible/i);
  assert.throws(() => validateBrowserContext({ ...isolated, browser_profile: '/profiles/writer/bot-desktop/browser-profile' }, 'researcher'), /browser_profile|perfil/i);
  assert.throws(() => createBrowserContext('researcher', { browser_profile: '/tmp/shared-browser' }), /aislamiento|perfil/i);
});

test('detects an already-open account, asks once for ambiguity and reuses the preference', () => {
  const isolated = context();
  const ambiguous = detectOpenAccounts(isolated, snapshot([
    { account_id: 'demo@example.com', display_name: 'Demo', service: 'example.com' },
    { account_id: 'reviewer@example.com', display_name: 'Reviewer', service: 'example.com' },
  ]), { service: 'example.com' });
  assert.equal(ambiguous.status, 'needs_selection');
  assert.equal(ambiguous.selection_required, true);
  assert.equal(ambiguous.selected_account, null);
  const chosen = selectAccount(ambiguous, 'reviewer@example.com');
  assert.equal(chosen.status, 'ready');
  assert.equal(chosen.selected_account.account_id, 'reviewer@example.com');
  assert.deepEqual(createAccountPreference('researcher', 'example.com', 'reviewer@example.com'), {
    profile: 'researcher', service: 'example.com', account_id: 'reviewer@example.com', source: 'browser-profile',
  });
  const reused = detectOpenAccounts(isolated, snapshot([
    { account_id: 'demo@example.com', display_name: 'Demo', service: 'example.com' },
    { account_id: 'reviewer@example.com', display_name: 'Reviewer', service: 'example.com' },
  ]), { service: 'example.com', preferredAccount: 'reviewer@example.com' });
  assert.equal(reused.status, 'ready');
  assert.equal(reused.selected_account.account_id, 'reviewer@example.com');
  const missing = detectOpenAccounts(isolated, { ...snapshot(), browser_open: false }, { service: 'example.com' });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.stop_reason, 'browser-not-open');
});

test('keeps provider consent, Hermes enablement and account activation as separate readbacks', () => {
  const isolated = context();
  const pending = detectOpenAccounts(isolated, { ...snapshot(), provider_consent: false, account_active: false }, { service: 'example.com' });
  assert.equal(pending.status, 'needs_verification');
  assert.equal(pending.stages.browser_open, 'verified');
  assert.equal(pending.stages.provider_consent, 'pending');
  assert.equal(pending.stages.account_active, 'pending');
  assert.throws(() => selectAccount(pending, 'unknown@example.com'), /no está abierta/i);
  const verified = verifyAccountReadback(pending, snapshot());
  assert.equal(verified.status, 'ready');
  assert.equal(verified.stages.account_active, 'verified');
});

test('formal modes expose operation details and block writes or high-risk actions', () => {
  const fixture = createDryRunBrowserFixture('researcher', { now });
  assert.deepEqual(BROWSER_MODES, ['planning', 'simulation', 'autonomous']);
  assert.deepEqual(SAFE_BROWSER_TOOLS, ['local-browser', 'computer_use']);
  for (const operation of [fixture.planning, fixture.simulation, fixture.autonomous, fixture.blocked]) {
    assert.equal(operation.profile, 'researcher');
    assert.equal(operation.account.account_id, 'demo@example.com');
    assert.equal(operation.browser_profile.includes('researcher'), true);
    assert.equal(operation.tool, 'local-browser');
    assert.ok(operation.steps.length);
    assert.ok(operation.evidence.length);
    assert.ok(operation.expected_result);
    assert.equal(operation.audit.profile, operation.profile);
  }
  assert.equal(fixture.planning.status, 'planned');
  assert.equal(fixture.planning.execute, false);
  assert.equal(fixture.simulation.status, 'prepared');
  assert.equal(fixture.simulation.execute, false);
  assert.equal(fixture.autonomous.status, 'ready');
  assert.equal(fixture.autonomous.execute, true);
  assert.equal(fixture.blocked.status, 'blocked');
  assert.equal(fixture.blocked.stop_reason, 'risk-gate:payment');
  assert.equal(fixture.blocked.authorization.requires_confirmation, true);
  assert.equal(JSON.stringify(fixture).includes('password'), false);
  assert.equal(JSON.stringify(fixture).includes('token'), false);
});

test('autonomous mode requires a current grant and revocation blocks execution', () => {
  const fixture = createDryRunBrowserFixture('researcher', { now });
  let revoked = revokeAuthorization(fixture.ledger, 'grant-researcher-example', { clock: () => now + 1 });
  const blocked = createBrowserOperation({
    profile: 'researcher', context: fixture.context, detection: fixture.detection, mode: 'autonomous', capability: 'write',
    grantLedger: revoked, grantId: 'grant-researcher-example', tool: 'local-browser', action: 'mock reversible write',
    steps: ['Detener si el grant no está activo'], evidence: ['grant.active.readback'], expected_result: 'No se ejecuta.',
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stop_reason, 'authorization-required');
  assert.throws(() => executeBrowserOperation(blocked, { profile: 'researcher', execute: () => ({ evidence: [] }) }), /bloqueada/i);
  const risk = classifyRisk({ action: 'abrir checkout y pagar', risk_flags: ['high risk'] });
  assert.deepEqual(risk.gates, ['payment', 'high_risk']);
  assert.equal(evaluateBrowserAuthorization({ mode: 'autonomous', capability: 'write', ledger: fixture.ledger, grantId: 'grant-researcher-example', risk }).allowed, false);
  const forgedLedger = { ...fixture.ledger, grants: fixture.ledger.grants.map((grant) => ({ ...grant, profile: 'writer', owner: { type: 'profile', profile: 'writer' } })) };
  const forged = createBrowserOperation({ profile: 'researcher', context: fixture.context, detection: fixture.detection, mode: 'autonomous', capability: 'write', grantLedger: forgedLedger, grantId: 'grant-researcher-example', tool: 'local-browser', action: 'mock reversible write' });
  assert.equal(forged.status, 'blocked');
  assert.equal(forged.stop_reason, 'authorization-required');
});

test('executed result is accepted only from a profile-matched adapter with readback evidence', () => {
  const fixture = createDryRunBrowserFixture('researcher', { now });
  const result = executeBrowserOperation(fixture.autonomous, {
    profile: 'researcher',
    browser_profile: fixture.autonomous.browser_profile,
    execute: (operation) => ({ result: `mock:${operation.account.account_id}`, evidence: [{ kind: 'mock.readback', status: 'verified' }] }),
  });
  assert.equal(result.status, 'executed');
  assert.equal(result.execute, false);
  assert.equal(result.evidence[0].status, 'verified');
  assert.throws(() => executeBrowserOperation(fixture.autonomous, { profile: 'writer', execute: () => ({ evidence: [] }) }), /otro perfil/i);
  assert.throws(() => executeBrowserOperation(fixture.autonomous, { profile: 'researcher', browser_profile: fixture.autonomous.browser_profile, execute: () => ({ result: 'missing evidence' }) }), /evidencia/i);
});

test('browser flow facade keeps the ledger and operations profile-scoped', () => {
  const isolated = context();
  let ledger = createAuthorizationLedger('researcher', { clock: () => now });
  ledger = grantAuthorization(ledger, { grant_id: 'grant-example', service: 'example.com', account: 'demo@example.com', capabilities: ['read'], persistent: true }, { clock: () => now });
  const flow = createBrowserFlow('researcher', { context: isolated, ledger, preferredAccounts: { 'example.com': 'demo@example.com' } });
  const detection = flow.detect(snapshot(), 'example.com');
  assert.equal(detection.status, 'ready');
  assert.equal(flow.operation({ detection, mode: 'planning', capability: 'plan', grantId: 'grant-example', action: 'read example.com' }).profile, 'researcher');
  assert.throws(() => createBrowserFlow('writer', { context: isolated, ledger }), /otro perfil|perfil/i);
});

test('cache-busted dashboard wires the browser-flow policy and visible evidence card', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../dashboard/index-v054.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../dashboard/style-v054.css', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../dashboard/manifest.json', import.meta.url), 'utf8'));
  const browserFlow = await import(new URL('../dashboard/browser-flow-v001.mjs', import.meta.url));
  assert.equal(typeof browserFlow.createBrowserContext, 'function');
  assert.match(source, /browser-flow-v001\.mjs/);
  assert.match(source, /BrowserFlowCard/);
  assert.match(source, /local · headed · visible/);
  assert.match(source, /No se afirma que la cuenta esté activa/);
  assert.match(css, /\.hb-browser-flow/);
  assert.equal(manifest.version, '0.5.0-rc.1');
  assert.equal(manifest.entry, 'index-v054.js');
  assert.equal(manifest.css, 'style-v054.css');
  assert.equal(manifest.browser_flow, 'browser-flow-v001.mjs');
});
