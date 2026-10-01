/* Shared invitation and account-cache helpers. Authorization is enforced by Firebase. */
(function () {
  'use strict';
  const validInvite = value => typeof value === 'string' && /^[A-Za-z0-9_-]{10,128}$/.test(value) ? value : '';
  function invitationUrl(id) { return 'invitation.html?invite=' + encodeURIComponent(validInvite(id)); }
  function authUrl(id, mode = 'login') {
    return 'index.html?invite=' + encodeURIComponent(validInvite(id)) + '&mode=' + (mode === 'register' ? 'register' : 'login');
  }
  function prepareAccountCache(uid) {
    if (!uid) throw new Error('An account is required to read cached scripts.');
    const activeKey = 'tslwrite_cache_uid', dataKey = 'scriptwriter_v2';
    const previous = localStorage.getItem(activeKey);
    if (previous === uid) return;
    const previousData = localStorage.getItem(dataKey);
    const archiveKey = previous ? dataKey + '_account_' + previous : dataKey + '_unclaimed';
    const nextKey = dataKey + '_account_' + uid;
    const nextData = localStorage.getItem(nextKey);
    const keys = [...new Set([dataKey, activeKey, archiveKey, nextKey, 'tslwrite_share_preferences'])];
    const original = keys.map(key => [key, localStorage.getItem(key)]);
    try {
      // Move cached scripts, rather than briefly duplicating them and exhausting storage.
      // Keep the originals in memory until every write succeeds so a failed switch can roll back.
      localStorage.removeItem(dataKey);
      localStorage.removeItem(nextKey);
      if (previousData) localStorage.removeItem(archiveKey);
      localStorage.removeItem('tslwrite_share_preferences');
      // Legacy drafts have no proven owner; they remain quarantined for explicit recovery.
      if (previousData) localStorage.setItem(archiveKey, previousData);
      if (nextData) localStorage.setItem(dataKey, nextData);
      localStorage.setItem(activeKey, uid);
    } catch (error) {
      try {
        keys.forEach(key => localStorage.removeItem(key));
        original.forEach(([key, value]) => { if (value !== null) localStorage.setItem(key, value); });
      } catch (restoreError) {
        // Retain the only remaining copy if the browser stops accepting all storage writes.
        window.TSLInvite.cacheRecoveryBackup = original;
        throw new Error('Browser storage failed. Keep this tab open so the local draft backup can be recovered.');
      }
      throw new Error('Could not switch account storage. Your original local drafts are preserved. Free some browser storage and reload this page.');
    }
  }
  function message(error) {
    const code = String(error && error.code || '').replace(/^functions\//, '');
    const messages = {
      unauthenticated: 'Please sign in again to continue.',
      'permission-denied': 'This account cannot access this invitation or project. Sign in with the invited email address.',
      'failed-precondition': 'Verify your email address before continuing. If it is already verified, this invitation may no longer be available.',
      'not-found': 'This invitation or project is no longer available. Ask the owner for a new invitation.',
      'deadline-exceeded': 'The request timed out. Refresh the access list before trying again.',
      'resource-exhausted': 'Too many invitations have been sent. Please try again later.',
      unavailable: 'The invitation service is unavailable. Please try again later.',
      'already-exists': 'This person already has an active invitation or access to this project.',
      'invalid-argument': 'Check the email address and selected access level.'
    };
    return messages[code] || 'The request could not be completed. Please try again.';
  }
  async function call(name, data = {}) {
    if (typeof firebase === 'undefined' || typeof firebase.functions !== 'function') throw {code: 'functions/unavailable'};
    const response = await firebase.app().functions('us-central1').httpsCallable(name)(data);
    return response.data;
  }
  window.TSLInvite = { validInvite, invitationUrl, authUrl, prepareAccountCache, message, call };
})();
