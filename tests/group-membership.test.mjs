import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMembershipChanged, assertNativeMembershipEditable } from '../dashboard/group-membership.mjs';

test('member comparison is order-insensitive', () => {
  assert.equal(isMembershipChanged(['alpha', 'beta'], ['beta', 'alpha']), false);
  assert.equal(isMembershipChanged(['alpha'], ['alpha', 'beta']), true);
});
test('native group blocks membership edits before local write', () => {
  assert.throws(() => assertNativeMembershipEditable(
    ['alpha', 'beta'], ['alpha', 'gamma'],
    {rooms: [{room_id: 'hermes-bots-default-research'}]}, 'hermes-bots-default-research'
  ), /membresía/);
});
test('listing failure fails closed, new rooms are editable', () => {
  assert.throws(() => assertNativeMembershipEditable(['alpha'], ['beta'], null, 'room'), /verificar/);
  assert.equal(assertNativeMembershipEditable(['alpha'], ['beta'], {rooms: []}, 'room'), true);
  assert.equal(assertNativeMembershipEditable(['alpha'], ['alpha'], null, 'room'), true);
});
