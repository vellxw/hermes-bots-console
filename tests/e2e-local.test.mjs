import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthorizationLedger,
  createMemoryStorage,
  createProfileStateStore,
  createIsolationBinding,
  grantAuthorization,
  normalizeAttachmentDescriptor,
  normalizeMarkdownDocument,
  revokeAuthorization,
} from '../dashboard/contracts.mjs';
import {
  createBrowserContext as createFlowContext,
  createBrowserOperation,
  detectOpenAccounts,
  selectAccount,
} from '../dashboard/browser-flow.mjs';
import { decide } from '../dashboard/turbo-policy.mjs';

// Local-only acceptance scenario: mocks, fixtures and dry-run policy only.
// It deliberately does not open a socket, fetch example.com, or invoke a provider.
test('local E2E keeps profiles isolated across attachment, Markdown, account, plan and Turbo grant flow', () => {
  const storage = createMemoryStorage();
  const state = createProfileStateStore(storage, { clock: () => 1700000000000 });
  const alphaBinding = createIsolationBinding('alpha', {
    browser_profile: '/profiles/alpha/bot-desktop/browser-profile',
    desktop_name: 'hermes:alpha',
    display: { number: 0, socket: '/run/hermes/alpha/display.sock' },
    gateway_socket: '/run/hermes/alpha/gateway.sock',
    lease: { profile: 'alpha', holder: 'agent', viewer_id: 'e2e-alpha', status: 'held' },
  });
  const betaBinding = createIsolationBinding('beta', {
    browser_profile: '/profiles/beta/bot-desktop/browser-profile',
    desktop_name: 'hermes:beta',
    display: { number: 1, socket: '/run/hermes/beta/display.sock' },
    gateway_socket: '/run/hermes/beta/gateway.sock',
    lease: { profile: 'beta', holder: 'agent', viewer_id: 'e2e-beta', status: 'held' },
  });
  const alpha = createFlowContext('alpha', alphaBinding);
  const beta = createFlowContext('beta', betaBinding);
  assert.notEqual(alpha.browser_profile, beta.browser_profile);
  assert.notEqual(alpha.gateway_socket, beta.gateway_socket);
  assert.throws(() => createFlowContext('alpha', betaBinding), /perfil|aislamiento/i);

  const attachment = normalizeAttachmentDescriptor({
    id: 'attachment-alpha-notes',
    profile: 'alpha',
    name: 'notes.md',
    type: 'text/markdown',
    size: 128,
    kind: 'document',
    source: 'fixture',
    storage_key: 'hermes-bots-console://alpha/attachment-alpha-notes',
  }, 'alpha');
  assert.equal(attachment.profile, 'alpha');
  assert.equal(attachment.type, 'text/markdown');
  assert.equal(attachment.storage_key.includes('alpha'), true);
  assert.throws(() => normalizeAttachmentDescriptor(attachment, 'beta'), /perfil|storage_key/i);

  const markdown = normalizeMarkdownDocument('# Resultado\n\n**Listo** para [example.com](https://example.com).\n\n- sin efectos externos');
  assert.equal(markdown.format, 'gfm-safe');
  assert.equal(markdown.blocks[0].type, 'heading');
  assert.equal(markdown.blocks.some((block) => block.type === 'list'), true);
  assert.equal(JSON.stringify(markdown).includes('<script>'), false);

  const snapshot = {
    profile: 'alpha',
    browser_open: true,
    provider_consent: true,
    hermes_enabled: true,
    account_active: true,
    accounts: [
      { account_id: 'demo@example.com', display_name: 'Demo mock', service: 'example.com' },
      { account_id: 'reviewer@example.com', display_name: 'Reviewer mock', service: 'example.com' },
    ],
  };
  const ambiguous = detectOpenAccounts(alpha, snapshot, { service: 'example.com' });
  assert.equal(ambiguous.status, 'needs_selection');
  const selected = selectAccount(ambiguous, 'demo@example.com');
  assert.equal(selected.selected_account.account_id, 'demo@example.com');

  let ledger = createAuthorizationLedger('alpha', { clock: () => 1700000000000 });
  ledger = grantAuthorization(ledger, {
    grant_id: 'grant-alpha-example',
    service: 'example.com',
    account: selected.selected_account.account_id,
    capabilities: ['read', 'prepare', 'write'],
    persistent: true,
  }, { clock: () => 1700000000000 });
  state.update('alpha', { turbo: { mode: 'autonomous', grants: ledger.grants }, ui: { route: 'chat' } });
  assert.equal(state.get('beta').turbo.mode, 'planning');
  assert.equal(state.get('beta').turbo.grants.length, 0);

  const plan = createBrowserOperation({
    profile: 'alpha', context: alpha, detection: selected, mode: 'planning', capability: 'plan',
    grantLedger: ledger, grantId: 'grant-alpha-example', tool: 'local-browser',
    action: 'leer example.com', steps: ['Abrir fixture local', 'Registrar título mock'],
    evidence: ['browser.status.readback'], expected_result: 'Plan preparado sin escritura externa.',
  });
  const simulation = createBrowserOperation({
    profile: 'alpha', context: alpha, detection: selected, mode: 'simulation', capability: 'prepare',
    grantLedger: ledger, grantId: 'grant-alpha-example', tool: 'local-browser',
    action: 'preparar formulario mock', steps: ['Preparar datos ficticios', 'No confirmar'],
    evidence: ['form.visible.readback'], expected_result: 'Borrador en memoria; no se envía nada.',
  });
  assert.equal(plan.status, 'planned');
  assert.equal(plan.execute, false);
  assert.equal(simulation.status, 'prepared');
  assert.equal(simulation.execute, false);
  let externalCalls = 0;
  assert.equal(externalCalls, 0);

  const operation = {
    profile: 'alpha', service: 'example.com', account: 'demo@example.com', capability: 'write',
    tool: 'local-browser', evidence: 'dry-run', expected_result: 'mock reversible',
  };
  const turboState = { profile: 'alpha', mode: 'autonomous', grants: ledger.grants };
  const first = decide(turboState, operation, { now: 1700000000000 });
  const second = decide(turboState, operation, { now: 1700000000000 });
  assert.equal(first.allowed, true);
  assert.equal(first.requires_confirmation, false);
  assert.equal(second.allowed, true);
  assert.equal(second.requires_confirmation, false);
  assert.equal(first.executed, false);

  for (const exception of ['mfa_or_captcha', 'payment', 'irreversible_delete', 'security_change', 'high_risk']) {
    const gated = decide(turboState, { ...operation, exceptions: [exception] });
    assert.equal(gated.allowed, false, exception);
    assert.equal(gated.requires_confirmation, true, exception);
  }

  const revoked = revokeAuthorization(ledger, 'grant-alpha-example', { clock: () => 1700000000001 });
  const afterRevoke = decide({ ...turboState, grants: revoked.grants }, operation, { now: 1700000000001 });
  assert.equal(afterRevoke.allowed, false);
  assert.equal(afterRevoke.reason, 'grant_required');
  assert.equal(state.get('alpha').turbo.grants[0].profile, 'alpha');
});
