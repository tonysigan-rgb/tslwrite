'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_INVITATION_LIMIT = 30;
const RECIPIENT_COOLDOWN_MS = 60000;
const INVITATIONS = 'projectInvitations';

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  }
  return email;
}
function validateId(value, name = 'projectId') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpsError('invalid-argument', `Invalid ${name}.`);
  }
  return value;
}
function validateRole(role) {
  if (!['editor', 'viewer'].includes(role)) throw new HttpsError('invalid-argument', 'Choose editor or viewer access.');
  return role;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function sharedProjectId(ownerUid, projectId) { return hash(`${ownerUid}/${projectId}`); }
function millis(value) { return value?.toMillis?.() || 0; }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
function invitationStatus(invitation, now) {
  return invitation.status === 'pending' && millis(invitation.expiresAt) <= now ? 'expired' : invitation.status;
}
function invitationSummary(id, data, now, owner = false) {
  const summary = {
    id,
    title: data.title,
    ownerName: data.ownerName,
    role: data.role,
    status: invitationStatus(data, now),
    deliveryStatus: data.deliveryStatus,
    expiresAt: millis(data.expiresAt),
  };
  if (owner) {
    summary.email = data.email;
    if (data.memberUid) summary.memberUid = data.memberUid;
  }
  return summary;
}
function invitationMessage({ email, title, ownerName, role, url }) {
  const permission = role === 'editor' ? 'edit' : 'read';
  return {
    to: email,
    subject: `${ownerName.replace(/[\r\n]/g, ' ')} invited you to a TSLwrite script`,
    text: `${ownerName} invited you to ${permission} “${title}” on TSLwrite.\n\nOpen your invitation: ${url}\n\nSign in, or create a TSLwrite account using ${email}. Verify your email address to accept. This invitation expires in 7 days.\n\nIf you were not expecting this invitation, you can ignore it.`,
    html: `<p>${escapeHtml(ownerName)} invited you to ${permission} <strong>${escapeHtml(title)}</strong> on TSLwrite.</p><p><a href="${escapeHtml(url)}">Open invitation</a></p><p>Sign in, or create a TSLwrite account using <strong>${escapeHtml(email)}</strong>. Verify your email address to accept.</p><p>This invitation expires in 7 days. If you were not expecting it, you can ignore this email.</p>`,
  };
}

function createCollaborationService({ db, auth, sendMail, getBaseUrl, now = Date.now }) {
  const projectRef = (ownerUid, projectId) => db.doc(`users/${ownerUid}/projects/${projectId}`);
  const memberRef = (ownerUid, projectId, uid) => projectRef(ownerUid, projectId).collection('members').doc(uid);
  const pointerRef = (uid, ownerUid, projectId) => db.doc(`users/${uid}/sharedProjects/${sharedProjectId(ownerUid, projectId)}`);
  const relatedInvitations = (ownerUid, projectId, email) => db.collection(INVITATIONS)
    .where('ownerUid', '==', ownerUid).where('projectId', '==', projectId).where('email', '==', email);

  async function signedIn(request, requireVerified = false) {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
    let user;
    try { user = await auth.getUser(request.auth.uid); } catch {
      throw new HttpsError('unauthenticated', 'Sign in again to continue.');
    }
    if (user.disabled || !user.email) throw new HttpsError('permission-denied', 'An email account is required.');
    if (requireVerified && !user.emailVerified) {
      throw new HttpsError('failed-precondition', 'Verify your email address, then try again.', { reason: 'email-unverified' });
    }
    return { uid: user.uid, email: normalizeEmail(user.email), name: (user.displayName || user.email).slice(0, 120) };
  }
  function checkInvitationRecipient(data, user) {
    if (!data || data.email !== user.email) throw new HttpsError('permission-denied', 'This invitation is not available for your signed-in email.');
  }
  function checkPending(data, currentProject) {
    if (data.status !== 'pending') throw new HttpsError('failed-precondition', 'This invitation is no longer pending.');
    if (millis(data.expiresAt) <= now()) throw new HttpsError('deadline-exceeded', 'This invitation has expired. Ask the owner for a new invitation.');
    if (data.deliveryStatus !== 'sent') throw new HttpsError('failed-precondition', 'This invitation email has not been sent successfully.');
    if (!currentProject || currentProject.collaborationGeneration !== data.generation) {
      throw new HttpsError('not-found', 'The shared project is no longer available.');
    }
  }

  async function sendProjectInvitation(request) {
    const user = await signedIn(request, true);
    const projectId = validateId(request.data?.projectId);
    const email = normalizeEmail(request.data?.email);
    const role = validateRole(request.data?.role);
    if (email === user.email) throw new HttpsError('invalid-argument', 'You already own this project.');
    const currentTime = now();
    const id = randomBytes(24).toString('hex');
    const invitationRef = db.collection(INVITATIONS).doc(id);
    const ownerLimitRef = db.doc(`invitationRateLimits/${hash(user.uid)}`);
    const recipientLimitRef = db.doc(`invitationRateLimits/${hash(`${user.uid}/${projectId}/${email}`)}`);
    const ownerProject = projectRef(user.uid, projectId);
    const data = await db.runTransaction(async (transaction) => {
      const [project, ownerLimit, recipientLimit, previous] = await Promise.all([
        transaction.get(ownerProject), transaction.get(ownerLimitRef), transaction.get(recipientLimitRef),
        transaction.get(relatedInvitations(user.uid, projectId, email)),
      ]);
      if (!project.exists) throw new HttpsError('not-found', 'Save this project to the cloud before inviting someone.');
      const day = new Date(currentTime).toISOString().slice(0, 10);
      const count = ownerLimit.data()?.day === day ? ownerLimit.data().count : 0;
      if (count >= DAILY_INVITATION_LIMIT) throw new HttpsError('resource-exhausted', 'Your daily invitation limit has been reached. Try again tomorrow.');
      if (recipientLimit.exists && currentTime - millis(recipientLimit.data().lastSentAt) < RECIPIENT_COOLDOWN_MS) {
        throw new HttpsError('resource-exhausted', 'Please wait one minute before sending another invitation to this person.');
      }
      const projectData = project.data();
      const generation = projectData.collaborationGeneration || randomBytes(16).toString('hex');
      if (!projectData.collaborationGeneration) {
        transaction.update(ownerProject, {
          collaborationEnabled: true,
          collaborationGeneration: generation,
          revision: Number.isSafeInteger(projectData.revision) ? projectData.revision : 0,
        });
      }
      for (const old of previous.docs) {
        if (old.data().status === 'pending') transaction.update(old.ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp() });
      }
      const invitation = {
        ownerUid: user.uid, projectId, email, role, generation,
        title: String(projectData.title || 'Untitled Script').slice(0, 200), ownerName: user.name,
        status: 'pending', deliveryStatus: 'sending', createdAt: Timestamp.fromMillis(currentTime),
        expiresAt: Timestamp.fromMillis(currentTime + INVITATION_LIFETIME_MS),
      };
      transaction.create(invitationRef, invitation);
      transaction.set(ownerLimitRef, { day, count: count + 1 });
      transaction.set(recipientLimitRef, { lastSentAt: Timestamp.fromMillis(currentTime) });
      return invitation;
    });

    let mode = 'login';
    try { await auth.getUserByEmail(email); } catch (error) {
      if (error.code === 'auth/user-not-found') mode = 'register';
      // Auth lookup failure never changes access or exposes registration status.
    }
    try {
      const base = new URL(getBaseUrl());
      if (base.protocol !== 'https:') throw new Error('APP_BASE_URL must use HTTPS.');
      const url = new URL('index.html', base.href.endsWith('/') ? base : `${base.href}/`);
      url.searchParams.set('invite', id);
      url.searchParams.set('mode', mode);
      const result = await sendMail(invitationMessage({ ...data, url: url.href }));
      const accepted = (result?.accepted || []).map((address) => String(address).trim().toLowerCase());
      if (!accepted.includes(email)) throw new Error('SMTP did not accept the recipient.');
      await invitationRef.update({ deliveryStatus: 'sent', sentAt: FieldValue.serverTimestamp() });
    } catch {
      // Do not log provider errors: they can include credentials, recipient data, or invitation URLs.
      await invitationRef.update({ deliveryStatus: 'failed', deliveryFailedAt: FieldValue.serverTimestamp() });
      throw new HttpsError('unavailable', 'The invitation email could not be confirmed as sent. Check email setup or try again later.');
    }
    return { invitationId: id, deliveryStatus: 'sent' };
  }

  async function getProjectInvitation(request) {
    const user = await signedIn(request, true);
    const id = validateId(request.data?.invitationId, 'invitationId');
    const snapshot = await db.collection(INVITATIONS).doc(id).get();
    const data = snapshot.data();
    checkInvitationRecipient(data, user);
    const project = await projectRef(data.ownerUid, data.projectId).get();
    if (!project.exists || project.data().collaborationGeneration !== data.generation) {
      throw new HttpsError('not-found', 'The shared project is no longer available.');
    }
    return invitationSummary(id, data, now());
  }

  async function acceptProjectInvitation(request) {
    const user = await signedIn(request, true);
    const id = validateId(request.data?.invitationId, 'invitationId');
    const invitationRef = db.collection(INVITATIONS).doc(id);
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(invitationRef);
      const data = snapshot.data();
      checkInvitationRecipient(data, user);
      const membershipRef = memberRef(data.ownerUid, data.projectId, user.uid);
      const [project, membership] = await Promise.all([
        transaction.get(projectRef(data.ownerUid, data.projectId)), transaction.get(membershipRef),
      ]);
      if (data.status === 'accepted' && data.memberUid === user.uid) {
        if (!project.exists || !membership.exists || membership.data().generation !== project.data().collaborationGeneration) {
          throw new HttpsError('failed-precondition', 'Your access to this project has been removed.');
        }
        return { ownerUid: data.ownerUid, projectId: data.projectId, role: membership.data().role };
      }
      checkPending(data, project.data());
      const previous = await transaction.get(relatedInvitations(data.ownerUid, data.projectId, data.email));
      for (const old of previous.docs) {
        if (old.id !== id && old.data().status === 'accepted') {
          transaction.update(old.ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp() });
          if (old.data().memberUid && old.data().memberUid !== user.uid) {
            transaction.delete(memberRef(data.ownerUid, data.projectId, old.data().memberUid));
            transaction.delete(pointerRef(old.data().memberUid, data.ownerUid, data.projectId));
          }
        }
      }
      transaction.set(membershipRef, {
        uid: user.uid, email: user.email, role: data.role, invitationId: id,
        generation: data.generation, acceptedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(pointerRef(user.uid, data.ownerUid, data.projectId), {
        ownerUid: data.ownerUid, projectId: data.projectId, role: data.role,
        title: project.data().title || data.title, generation: data.generation,
      });
      transaction.update(invitationRef, { status: 'accepted', memberUid: user.uid, acceptedAt: FieldValue.serverTimestamp() });
      return { ownerUid: data.ownerUid, projectId: data.projectId, role: data.role };
    });
  }

  async function listMyInvitations(request) {
    const user = await signedIn(request, true);
    const snapshot = await db.collection(INVITATIONS).where('email', '==', user.email).where('status', '==', 'pending').get();
    const candidates = snapshot.docs.filter((doc) => doc.data().deliveryStatus === 'sent' && millis(doc.data().expiresAt) > now());
    const valid = await Promise.all(candidates.map(async (doc) => {
      const data = doc.data();
      const project = await projectRef(data.ownerUid, data.projectId).get();
      return project.exists && project.data().collaborationGeneration === data.generation ? invitationSummary(doc.id, data, now()) : null;
    }));
    return { invitations: valid.filter(Boolean).sort((a, b) => b.expiresAt - a.expiresAt) };
  }

  async function listProjectAccess(request) {
    const user = await signedIn(request);
    const projectId = validateId(request.data?.projectId);
    if (!(await projectRef(user.uid, projectId).get()).exists) throw new HttpsError('not-found', 'Project not found.');
    const snapshot = await db.collection(INVITATIONS).where('ownerUid', '==', user.uid).where('projectId', '==', projectId).get();
    return { invitations: snapshot.docs.map((doc) => invitationSummary(doc.id, doc.data(), now(), true)).sort((a, b) => b.expiresAt - a.expiresAt) };
  }

  async function revokeProjectAccess(request) {
    const user = await signedIn(request);
    const projectId = validateId(request.data?.projectId);
    const id = validateId(request.data?.invitationId, 'invitationId');
    await db.runTransaction(async (transaction) => {
      const [project, invitation] = await Promise.all([
        transaction.get(projectRef(user.uid, projectId)), transaction.get(db.collection(INVITATIONS).doc(id)),
      ]);
      const data = invitation.data();
      if (!project.exists || !data || data.ownerUid !== user.uid || data.projectId !== projectId) {
        throw new HttpsError('permission-denied', 'Only the project owner can remove access.');
      }
      const related = await transaction.get(relatedInvitations(user.uid, projectId, data.email));
      const active = related.docs.filter((doc) => ['pending', 'accepted'].includes(doc.data().status));
      const memberUids = [...new Set(active.map((doc) => doc.data().memberUid).filter(Boolean))];
      for (const uid of memberUids) {
        transaction.delete(memberRef(user.uid, projectId, uid));
        transaction.delete(pointerRef(uid, user.uid, projectId));
      }
      for (const doc of active) transaction.update(doc.ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp() });
    });
    return { status: 'revoked' };
  }

  async function cleanupDeletedProject(ownerUid, projectId, deletedProject) {
    const generation = deletedProject.collaborationGeneration;
    if (!generation) return;
    const snapshot = await db.collection(INVITATIONS).where('ownerUid', '==', ownerUid).where('projectId', '==', projectId).get();
    for (const invitation of snapshot.docs) {
      if (invitation.data().generation !== generation || invitation.data().cleanupGeneration === generation) continue;
      await db.runTransaction(async (transaction) => {
        const latest = await transaction.get(invitation.ref);
        if (!latest.exists || latest.data().generation !== generation || latest.data().cleanupGeneration === generation) return;
        const uid = latest.data().memberUid;
        const member = uid ? await transaction.get(memberRef(ownerUid, projectId, uid)) : null;
        const pointer = uid ? await transaction.get(pointerRef(uid, ownerUid, projectId)) : null;
        transaction.update(invitation.ref, { status: 'revoked', cleanupGeneration: generation, revokedAt: FieldValue.serverTimestamp() });
        if (member?.data()?.generation === generation) transaction.delete(member.ref);
        if (pointer?.data()?.generation === generation) transaction.delete(pointer.ref);
      });
    }
  }

  return { sendProjectInvitation, getProjectInvitation, acceptProjectInvitation, listMyInvitations, listProjectAccess, revokeProjectAccess, cleanupDeletedProject };
}

module.exports = { createCollaborationService, normalizeEmail, validateId, validateRole, sharedProjectId, invitationMessage, invitationStatus };
