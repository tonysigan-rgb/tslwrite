'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onCall } = require('firebase-functions/v2/https');
const { onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { defineSecret, defineString } = require('firebase-functions/params');
const nodemailer = require('nodemailer');
const { createCollaborationService } = require('./lib/collaboration');

initializeApp();
const smtpConnection = defineSecret('SMTP_CONNECTION_URI');
const invitationFrom = defineString('INVITATION_FROM', {
  description: 'Verified sender address, for example TSLwrite <invites@your-domain.com>',
});
const appBaseUrl = defineString('APP_BASE_URL', {
  default: 'https://tonysigan-rgb.github.io/tslwrite/',
});
const service = createCollaborationService({
  db: getFirestore(),
  auth: getAuth(),
  getBaseUrl: () => appBaseUrl.value(),
  sendMail: async (message) => {
    const connection = smtpConnection.value();
    const endpoint = new URL(connection);
    if (!['smtp:', 'smtps:'].includes(endpoint.protocol) || !endpoint.hostname || !endpoint.username || !endpoint.password) {
      throw new Error('SMTP is not configured.');
    }
    const transport = nodemailer.createTransport({
      host: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'smtps:' ? 465 : 587,
      secure: endpoint.protocol === 'smtps:',
      requireTLS: true,
      auth: { user: decodeURIComponent(endpoint.username), pass: decodeURIComponent(endpoint.password) },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    });
    try {
      return await transport.sendMail({ ...message, from: invitationFrom.value() });
    } finally {
      transport.close();
    }
  },
});

const options = { region: 'us-central1', timeoutSeconds: 60, maxInstances: 10 };
exports.sendProjectInvitation = onCall({ ...options, secrets: [smtpConnection] }, service.sendProjectInvitation);
for (const name of ['getProjectInvitation', 'acceptProjectInvitation', 'listMyInvitations', 'listProjectAccess', 'revokeProjectAccess']) {
  exports[name] = onCall(options, service[name]);
}
exports.cleanupDeletedProjectAccess = onDocumentDeleted({
  document: 'users/{ownerUid}/projects/{projectId}',
  region: 'us-central1',
  retry: true,
  timeoutSeconds: 300,
  maxInstances: 5,
}, async (event) => {
  if (event.data) await service.cleanupDeletedProject(event.params.ownerUid, event.params.projectId, event.data.data());
});
