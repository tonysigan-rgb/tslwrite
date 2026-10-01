# TSLwrite collaboration deployment

The static GitHub Pages frontend needs the Firebase backend in this repository to send invitations and enforce shared access. Publishing HTML alone does not activate email delivery. This document describes setup; it is not confirmation of a production deployment.

## Prerequisites

- Access to the existing Firebase project **tslwrite**, its Firestore database, Authentication settings, and deployed rules.
- Firebase's **Blaze billing plan** for production Cloud Functions. Functions, Firestore operations, Secret Manager, builds/artifact storage and the email provider may incur charges. No billing upgrade is performed by this code. [Firebase deployment requirements](https://firebase.google.com/docs/functions/get-started)
- Node.js **22**, npm and Java 21 for local Firestore emulator tests. Functions use Node.js 22 and run in `us-central1`. [Supported runtimes](https://firebase.google.com/docs/functions/manage-functions)
- A transactional SMTP provider account with a verified sender address/domain. Configure the provider's SPF/DKIM records and any required DMARC policy. Use an SMTP credential restricted to this application.
- In Firebase Authentication, retain the existing providers and add **tonysigan-rgb.github.io** under Authorized domains. Email verification uses a continue URL back to this site. [Firebase email action configuration](https://firebase.google.com/docs/auth/web/passing-state-in-email-actions)

## Install and verify locally

From the repository root in PowerShell:

```powershell
npm.cmd --prefix functions ci
npm.cmd --prefix functions test
npm.cmd --prefix functions run test:emulator
npm.cmd test
```

The emulator tests explicitly target **demo-tslwrite**, use fake users and a fake SMTP sender, and refuse to run without a Firestore emulator. They send no real emails and do not access production Firestore. The first run downloads the official emulator. These tests cover callable service authorization plus actual Firestore rules, including viewer/editor permissions, conflicting revisions, failed mail, verification, expiry, rate limits, acceptance, revocation/replay and project deletion/recreation.

## Configure and deploy

1. Sign in with the authorized project administrator:

   ```powershell
   .\functions\node_modules\.bin\firebase.cmd login
   .\functions\node_modules\.bin\firebase.cmd projects:list
   ```

2. Review and back up the **current live Firestore rules and indexes** in the Firebase console before applying these files. The repository originally contained no Firebase deployment configuration. Reconcile any existing production paths or unrelated functions; do not overwrite rules blindly. The new rules preserve this app's private projects and folders and add server-controlled collaboration paths.

3. Store the SMTP connection string using the interactive Secret Manager prompt:

   ```powershell
   .\functions\node_modules\.bin\firebase.cmd functions:secrets:set SMTP_CONNECTION_URI --project tslwrite
   ```

   Enter a URI in the form `smtps://USERNAME:PASSWORD@SMTP_HOST:465` or `smtp://USERNAME:PASSWORD@SMTP_HOST:587`. URI-encode special characters in the username/password. Port 465 uses TLS immediately; port 587 requires STARTTLS. TLS certificate validation is mandatory. Paste the real credential only at the secret prompt, never into source, chat, shell command history or a committed file. [Firebase secret parameters](https://firebase.google.com/docs/functions/config-env)

4. The CLI will request the non-secret parameter **INVITATION_FROM**, for example `TSLwrite <invites@your-verified-domain.com>`. **APP_BASE_URL** defaults to `https://tonysigan-rgb.github.io/tslwrite/`. Keep a trailing slash and use HTTPS. The CLI may store these parameters in ignored `functions/.env.tslwrite`.

5. Deploy the reviewed rules/indexes and this function codebase, then publish the frontend:

   ```powershell
   .\functions\node_modules\.bin\firebase.cmd deploy --project tslwrite --only firestore:rules,firestore:indexes,functions:collaboration
   ```

   Wait for indexes to finish building before enabling invitations. The `collaboration` codebase contains six callables and one project-deletion cleanup trigger. Do not remove existing unrelated function codebases. Rotating the SMTP secret requires redeploying `sendProjectInvitation` so its instances pick up the new secret.

6. After setup, use controlled test accounts to verify an existing account and a new email can each receive an invitation, verify their email, accept, and open the intended project. Verify read-only access, editor saves, owner revocation, and a fresh browser session. A production email test sends a real message; choose recipients authorized to receive it.

## Behavior and API contract

All callable functions use the Firebase SDK with region `us-central1`. Authentication tokens are handled by Firebase callables; authorization is checked again in the service using the current Admin Auth user. [Callable functions](https://firebase.google.com/docs/functions/callable)

| Callable | Input | Result |
| --- | --- | --- |
| `sendProjectInvitation` | `{projectId,email,role}` | `{invitationId,deliveryStatus:"sent"}` after SMTP accepts the recipient |
| `getProjectInvitation` | `{invitationId}` | `{id,title,ownerName,role,status,deliveryStatus,expiresAt}` |
| `acceptProjectInvitation` | `{invitationId}` | `{ownerUid,projectId,role}` |
| `listMyInvitations` | `{}` | `{invitations:[...]}` containing current pending invitations |
| `listProjectAccess` | `{projectId}` | `{invitations:[...]}` including recipient email and optional `memberUid` |
| `revokeProjectAccess` | `{projectId,invitationId}` | `{status:"revoked"}` |

`expiresAt` is milliseconds since the Unix epoch. Roles are `editor` and `viewer`. Status values are `pending`, `accepted`, `revoked`, or computed `expired`; delivery states are `sending`, `sent`, and `failed`. Sender and recipient email verification failures return `failed-precondition` with `details.reason = "email-unverified"`.

Invitations expire after seven days. Sending is limited to 30 per owner per UTC day and once per project/recipient per minute, including failed attempts. A retry creates a fresh invitation and invalidates previous pending invitations. Recipient registration status is never returned to the sender. The backend uses it only to choose the sign-in or create-account tab in the recipient's email.

“Sent” means the SMTP server accepted the address, not guaranteed inbox delivery. Provider bounces and spam filtering require provider monitoring. Failed or interrupted delivery is not shown as successful; if a process stops after SMTP acceptance but before saving confirmation, the invitation remains unusable until resent. There is no automatic background resend, avoiding duplicate messages. Email content is generated server-side and safely escapes user-controlled names/titles.

## Security and data model

Projects remain at `users/{ownerUid}/projects/{projectId}`. Accepted memberships live below `members/{uid}`; the recipient has a server-written pointer under `users/{uid}/sharedProjects/{shareId}` containing `ownerUid`, `projectId`, `role`, `title`, and `generation`. Invitation state is in server-only `projectInvitations`; sender/recipient rate counters are in server-only `invitationRateLimits`.

An invitation ID is a random lookup identifier, not an access credential. Acceptance requires the current signed-in account's verified email to match the invitation. Pending/failed/expired/revoked invitations never grant access. No bearer tokens or SMTP credentials are put in Firestore documents or public source.

Accepted members are bound to UID, verified email and a server-generated project generation. Owners alone may invite, revoke or delete a project. Viewers can read; editors can update only screenplay content with an incremented `revision` and server `updatedAt`. Collaboration metadata, identity, creation time and folder metadata are protected from editor edits. Owners also use revision checks after sharing is enabled. This prevents silent overwrite when two clients save the same revision; it does not provide character-by-character merging.

Acceptance and revocation update invitation state, membership and the shared pointer transactionally. Revocation invalidates all invitations for that project/recipient, so an old accepted link cannot restore access. Deleting a project removes access immediately through rules, and a background trigger cleans up membership/pointers. Reusing a project ID generates a new collaboration generation, so delayed cleanup and old invitations cannot reopen the replacement project. [Transactions](https://firebase.google.com/docs/firestore/manage-data/transactions), [role-based rules](https://firebase.google.com/docs/firestore/solutions/role-based-access)

App Check enforcement is not enabled because the existing frontend has no configured attestation provider. Configure App Check and then enable callable enforcement if abuse protection beyond verified senders and rate limits is required. Admin SDK bypasses Firestore rules, so production IAM and these service authorization checks are both necessary. Before enabling other clients or importing new production collections, review the rules again.
