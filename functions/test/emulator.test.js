'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp } = require('firebase/firestore');
const { createCollaborationService, sharedProjectId } = require('../lib/collaboration');

const projectId = 'demo-tslwrite';
let environment, adminApp, db, service, users, sent, clock, failMail;
const projectPath = 'users/owner/projects/script';
const request = (uid, data = {}) => ({ auth: { uid }, data });
const client = (uid, email, verified = true) => environment.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const owner = () => client('owner', 'owner@example.com');
const reader = () => client('reader', 'reader@example.com');

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Use the Firebase emulator command; tests never connect to production.');
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  environment = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules: fs.readFileSync(path.resolve(__dirname, '../../firestore.rules'), 'utf8') } });
  adminApp = initializeApp({ projectId }, 'collaboration-tests');
  db = getFirestore(adminApp);
});
beforeEach(async () => {
  await environment.clearFirestore();
  users = new Map([
    ['owner', { uid: 'owner', email: 'owner@example.com', displayName: 'Owner', emailVerified: true }],
    ['reader', { uid: 'reader', email: 'reader@example.com', displayName: 'Reader', emailVerified: true }],
    ['other', { uid: 'other', email: 'other@example.com', emailVerified: true }],
    ['unverified', { uid: 'unverified', email: 'new@example.com', emailVerified: false }],
  ]);
  sent = []; clock = 1800000000000; failMail = false;
  service = createCollaborationService({
    db, now: () => clock,
    auth: {
      getUser: async (uid) => {
        if (!users.has(uid)) throw Object.assign(new Error('Missing user'), { code: 'auth/user-not-found' });
        return users.get(uid);
      },
      getUserByEmail: async (email) => {
        const user = [...users.values()].find((record) => record.email === email);
        if (!user) throw Object.assign(new Error('Missing user'), { code: 'auth/user-not-found' });
        return user;
      },
    },
    getBaseUrl: () => 'https://example.com/tslwrite/',
    sendMail: async (message) => {
      if (failMail) throw new Error('Simulated SMTP failure');
      sent.push(message); return { accepted: [message.to] };
    },
  });
  await db.doc(projectPath).set({ id: 'script', title: 'Test Script', format: 'screenplay', blocks: [], created: 1, revision: 0 });
});
after(async () => { await environment?.cleanup(); if (adminApp) await deleteApp(adminApp); });

async function invite(email = 'reader@example.com', role = 'editor') {
  return service.sendProjectInvitation(request('owner', { projectId: 'script', email, role }));
}
async function accepted(role = 'editor') {
  const invitation = await invite('reader@example.com', role);
  await service.acceptProjectInvitation(request('reader', { invitationId: invitation.invitationId }));
  return invitation;
}

test('sends confirmed emails for existing and new recipients without returning registration status', async () => {
  const existing = await invite();
  assert.deepEqual(Object.keys(existing).sort(), ['deliveryStatus', 'invitationId']);
  assert.equal(existing.deliveryStatus, 'sent');
  assert.match(sent[0].text, /mode=login/);
  const newcomer = await invite('brandnew@example.com', 'viewer');
  assert.match(sent[1].text, /mode=register/);
  assert.match(sent[1].text, /create a TSLwrite account/);
  await assert.rejects(() => service.acceptProjectInvitation({ data: { invitationId: newcomer.invitationId } }), { code: 'unauthenticated' });
  users.set('newcomer', { uid: 'newcomer', email: 'brandnew@example.com', emailVerified: true });
  assert.deepEqual(await service.acceptProjectInvitation(request('newcomer', { invitationId: newcomer.invitationId })), { ownerUid: 'owner', projectId: 'script', role: 'viewer' });
  assert.equal((await service.listMyInvitations(request('reader'))).invitations.length, 1);
  const details = await service.getProjectInvitation(request('reader', { invitationId: existing.invitationId }));
  assert.equal(typeof details.expiresAt, 'number');
  assert.equal(details.title, 'Test Script');
});

test('only verified owners may send, and failed SMTP is never reported or accepted as sent', async () => {
  await assert.rejects(() => service.sendProjectInvitation(request('other', { projectId: 'script', email: 'reader@example.com', role: 'viewer' })), { code: 'not-found' });
  users.get('owner').emailVerified = false;
  await assert.rejects(() => invite(), { code: 'failed-precondition' });
  users.get('owner').emailVerified = true;
  failMail = true;
  await assert.rejects(() => invite(), { code: 'unavailable' });
  const access = (await service.listProjectAccess(request('owner', { projectId: 'script' }))).invitations;
  assert.equal(access[0].deliveryStatus, 'failed');
  assert.equal((await service.listMyInvitations(request('reader'))).invitations.length, 0);
  await assert.rejects(() => service.acceptProjectInvitation(request('reader', { invitationId: access[0].id })), { code: 'failed-precondition' });
  assert.equal(sent.length, 0);
});

test('recipient must use the invited verified account and invitations expire', async () => {
  const invitation = await invite();
  const data = { invitationId: invitation.invitationId };
  await assert.rejects(() => service.getProjectInvitation(request('other', data)), { code: 'permission-denied' });
  await assert.rejects(() => service.acceptProjectInvitation(request('other', data)), { code: 'permission-denied' });
  users.get('reader').emailVerified = false;
  await assert.rejects(() => service.acceptProjectInvitation(request('reader', data)), { code: 'failed-precondition' });
  users.get('reader').emailVerified = true;
  clock += 7 * 24 * 60 * 60 * 1000;
  await assert.rejects(() => service.acceptProjectInvitation(request('reader', data)), { code: 'deadline-exceeded' });
  assert.equal((await service.listMyInvitations(request('reader'))).invitations.length, 0);
});

test('pending invitations grant no access; accepted editors get only revision-checked content updates', async () => {
  const invitation = await invite();
  const readerDb = reader();
  await assertFails(getDoc(doc(readerDb, projectPath)));
  await service.acceptProjectInvitation(request('reader', { invitationId: invitation.invitationId }));
  await assertSucceeds(getDoc(doc(readerDb, projectPath)));
  await assertSucceeds(updateDoc(doc(readerDb, projectPath), { title: 'Revised', revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(readerDb, projectPath), { title: 'Stale', revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(readerDb, projectPath), { created: 2, revision: 2, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(readerDb, projectPath), { collaborationGeneration: 'forged', revision: 2, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(readerDb, projectPath)));
  await assertFails(getDocs(collection(readerDb, 'users/owner/projects')));
  await assertFails(getDoc(doc(client('reader', 'reader@example.com', false), projectPath)));
  await assertFails(getDoc(doc(client('reader', 'changed@example.com'), projectPath)));
  const pointer = doc(readerDb, `users/reader/sharedProjects/${sharedProjectId('owner', 'script')}`);
  await assertSucceeds(getDoc(pointer));
  await assertFails(setDoc(pointer, { ownerUid: 'owner', projectId: 'forged', role: 'editor' }));
  await assertFails(setDoc(doc(readerDb, `${projectPath}/members/reader`), { role: 'owner' }));
  await assertFails(getDoc(doc(readerDb, `projectInvitations/${invitation.invitationId}`)));
});

test('viewer access is read-only and owners cannot bypass shared revision checks or rewrite membership', async () => {
  await accepted('viewer');
  await assertSucceeds(getDoc(doc(reader(), projectPath)));
  await assertFails(updateDoc(doc(reader(), projectPath), { title: 'Cannot edit', revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(owner(), projectPath), { title: 'Missing revision' }));
  await assertSucceeds(updateDoc(doc(owner(), projectPath), { title: 'Owner edit', revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(owner(), `${projectPath}/members/reader`), { role: 'editor' }));
  await assertFails(updateDoc(doc(owner(), projectPath), { collaborationEnabled: false, revision: 2, updatedAt: serverTimestamp() }));
});

test('revocation removes access and every invite for the recipient; replay cannot regrant access', async () => {
  const first = await accepted();
  clock += 61000;
  const second = await invite('reader@example.com', 'viewer');
  await assert.rejects(() => service.revokeProjectAccess(request('other', { projectId: 'script', invitationId: first.invitationId })), { code: 'permission-denied' });
  await service.revokeProjectAccess(request('owner', { projectId: 'script', invitationId: first.invitationId }));
  for (const invitation of [first, second]) {
    await assert.rejects(() => service.acceptProjectInvitation(request('reader', { invitationId: invitation.invitationId })), { code: 'failed-precondition' });
  }
  assert.equal((await db.doc(`${projectPath}/members/reader`).get()).exists, false);
  assert.equal((await db.doc(`users/reader/sharedProjects/${sharedProjectId('owner', 'script')}`).get()).exists, false);
  await assertFails(getDoc(doc(reader(), projectPath)));
});

test('concurrent acceptance and revocation end with access removed', async () => {
  const invitation = await invite();
  await Promise.allSettled([
    service.acceptProjectInvitation(request('reader', { invitationId: invitation.invitationId })),
    service.revokeProjectAccess(request('owner', { projectId: 'script', invitationId: invitation.invitationId })),
  ]);
  assert.equal((await db.doc(`projectInvitations/${invitation.invitationId}`).get()).data().status, 'revoked');
  assert.equal((await db.doc(`${projectPath}/members/reader`).get()).exists, false);
});

test('recreated project ids cannot resurrect old memberships or invitations; delayed cleanup preserves new access', async () => {
  const first = await accepted();
  const deletedProject = (await db.doc(projectPath).get()).data();
  await db.doc(projectPath).delete();
  await assertSucceeds(setDoc(doc(owner(), projectPath), { id: 'script', title: 'New Script', format: 'screenplay', blocks: [], revision: 0 }));
  await assertFails(getDoc(doc(reader(), projectPath)));
  clock += 61000;
  const second = await invite();
  await service.acceptProjectInvitation(request('reader', { invitationId: second.invitationId }));
  await service.cleanupDeletedProject('owner', 'script', deletedProject);
  await assertSucceeds(getDoc(doc(reader(), projectPath)));
  assert.equal((await db.doc(`${projectPath}/members/reader`).get()).data().invitationId, second.invitationId);
  await assert.rejects(() => service.acceptProjectInvitation(request('reader', { invitationId: first.invitationId })), { code: 'failed-precondition' });
});

test('resends are throttled and replace earlier pending invitations', async () => {
  const first = await invite();
  await assert.rejects(() => invite(), { code: 'resource-exhausted' });
  clock += 61000;
  const second = await invite();
  assert.notEqual(first.invitationId, second.invitationId);
  assert.equal((await db.doc(`projectInvitations/${first.invitationId}`).get()).data().status, 'revoked');
  await service.acceptProjectInvitation(request('reader', { invitationId: second.invitationId }));
  const result = await service.acceptProjectInvitation(request('reader', { invitationId: second.invitationId }));
  assert.deepEqual(result, { ownerUid: 'owner', projectId: 'script', role: 'editor' });
});

test('unauthenticated users cannot read projects, private folders, or shared pointers', async () => {
  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonymous, projectPath)));
  await assertFails(setDoc(doc(client('other', 'other@example.com'), 'users/owner/folders/folder'), { name: 'Injected' }));
  await assertSucceeds(setDoc(doc(owner(), 'users/owner/folders/folder'), { name: 'Private' }));
  await assertFails(getDoc(doc(client('other', 'other@example.com'), 'users/owner/folders/folder')));
  await assertFails(setDoc(doc(owner(), 'users/owner/projects/forged'), { collaborationGeneration: 'known', collaborationEnabled: true }));
});

test('daily sender limit is enforced before SMTP sends', async () => {
  const counterId = createHash('sha256').update('owner').digest('hex');
  await db.doc(`invitationRateLimits/${counterId}`).set({ day: new Date(clock).toISOString().slice(0, 10), count: 30 });
  await assert.rejects(() => invite(), { code: 'resource-exhausted' });
  assert.equal(sent.length, 0);
});
