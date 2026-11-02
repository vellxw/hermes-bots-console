import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dashboard/turbo-policy.mjs';
import { authorizationDecision, requiresConfirmation as interactionRequiresConfirmation } from '../dashboard/interaction-core.mjs';

test('planning and simulation fail closed even with grants', () => {
  for (const mode of ['planning', 'simulation']) for (const capability of ['write', 'confirm']) {
    const d = p.decide({ profile: 'alpha', mode, grants: [] }, { profile: 'alpha', service: 'web', account: 'demo@example.com', capability, tool: 'browser_click' });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'mode_restriction');
  }
});

test('autonomous reuses exact active grants but not wrong profiles, accounts or capabilities', () => {
  const state = { profile: 'alpha', mode: 'autonomous', grants: [{ profile: 'alpha', service: 'web', account: 'demo@example.com', capabilities: ['read'], status: 'active', persistent: true, expires_at: null }] };
  const op = { profile: 'alpha', service: 'web', account: 'demo@example.com', capability: 'read', tool: 'browser_snapshot' };
  assert.equal(p.decide(state, op).allowed, true);
  assert.equal(p.decide(state, op).requires_confirmation, false);
  for (const patch of [{ profile: 'beta' }, { account: 'other@example.com' }, { capability: 'write' }]) assert.equal(p.decide(state, { ...op, ...patch }).allowed, false);
  for (const status of ['pending', 'revoked']) assert.equal(p.decide({ ...state, grants: [{ ...state.grants[0], status }] }, op).allowed, false);
  assert.equal(p.decide({ ...state, grants: [{ ...state.grants[0], expires_at: 1 }] }, op).allowed, false);
});

test('all explicit exceptions require confirmation', () => {
  for (const exception of p.EXCEPTIONS) {
    const d = p.decide({ profile: 'alpha', mode: 'autonomous', grants: [] }, { profile: 'alpha', service: 'web', account: 'demo@example.com', capability: 'read', tool: 'browser_snapshot', exceptions: [exception] });
    assert.equal(d.allowed, false);
    assert.equal(d.requires_confirmation, true);
  }
});

test('singular risk fields cannot be hidden by an empty exceptions array', () => {
  const state = { profile: 'alpha', mode: 'autonomous', grants: [{ profile: 'alpha', service: 'web', account: 'demo@example.com', capabilities: ['write'], status: 'active', persistent: true, expires_at: null }] };
  const base = { profile: 'alpha', service: 'web', account: 'demo@example.com', capability: 'write', tool: 'browser_click', exceptions: [] };
  assert.equal(p.decide(state, { ...base, exception: 'payment' }).allowed, false);
  assert.equal(p.decide(state, { ...base, risk: 'high_risk' }).requires_confirmation, true);
  assert.equal(interactionRequiresConfirmation('autonomous', { ...base, exception: 'payment' }), true);
  assert.equal(authorizationDecision('autonomous', { grants: state.grants }, { ...base, risk: 'high_risk' }).allowed, false);
});

test('redacts nested secrets without retaining values', () => {
  const out = p.redact({ token: 'FAKE_SECRET', nested: { cookie: 'FAKE_COOKIE' }, detail: 'password=FAKE_PASSWORD' });
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.nested.cookie, '[REDACTED]');
  assert.ok(!JSON.stringify(out).includes('FAKE_'));
});

test('unknown capabilities and malformed identities fail closed', () => {
  assert.equal(p.decide({ profile: 'alpha', mode: 'autonomous', grants: [] }, { profile: 'alpha', service: 'web', account: 'demo@example.com', capability: 'whatever' }).allowed, false);
});
