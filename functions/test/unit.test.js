'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmail, validateId, validateRole, invitationMessage, invitationStatus, sharedProjectId } = require('../lib/collaboration');

test('email input is canonicalized and unsafe recipient lists rejected', () => {
  assert.equal(normalizeEmail('  Writer@Example.com '), 'writer@example.com');
  for (const email of ['a@example.com\r\nBcc: victim@example.com', 'a@example.com b@example.com', '', null, 'bad', 'a@b']) {
    assert.throws(() => normalizeEmail(email), { code: 'invalid-argument' });
  }
});
test('document path injection and unsupported roles are rejected', () => {
  assert.equal(validateId('project_123'), 'project_123');
  for (const id of ['../x', 'a/b', '', null]) assert.throws(() => validateId(id), { code: 'invalid-argument' });
  assert.equal(validateRole('viewer'), 'viewer');
  assert.throws(() => validateRole('owner'), { code: 'invalid-argument' });
});
test('invitation HTML escapes names and script titles and instructs signup', () => {
  const message = invitationMessage({ email: 'writer@example.com', title: '<script>x</script>', ownerName: '<img>\r\nBcc:', role: 'viewer', url: 'https://example.com/index.html?invite=example&mode=register' });
  assert.match(message.html, /&lt;script&gt;/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.doesNotMatch(message.subject, /[\r\n]/);
  assert.match(message.text, /create a TSLwrite account/);
  assert.match(message.text, /Verify your email/);
});
test('expiry never changes revoked or accepted status and pointer ids include owner', () => {
  assert.equal(invitationStatus({ status: 'pending', expiresAt: { toMillis: () => 100 } }, 100), 'expired');
  assert.equal(invitationStatus({ status: 'revoked', expiresAt: { toMillis: () => 100 } }, 200), 'revoked');
  assert.notEqual(sharedProjectId('owner-one', 'project'), sharedProjectId('owner-two', 'project'));
});
