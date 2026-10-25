# Deployment configuration and security status

This document describes configuration needed for a future deployment. **The backend is still loopback-only and is not ready for public access.** Authentication and single-workspace authorization are implemented, but the backend deliberately refuses non-loopback binds until deployment-specific security review and verification are complete. Configuring an HTTPS frontend URL and production origins does not make public deployment safe.

## Configuration

| Variable | Purpose | Behavior |
| --- | --- | --- |
| `PORT` | Backend HTTP and WebSocket port assigned by a host | Defaults to `3001`; must be an integer from 1 through 65535. |
| `CODESTUDIO_BIND_HOST` | Backend bind address | Defaults to `127.0.0.1`. The current backend rejects every non-loopback address. Authentication is implemented, but external ingress remains intentionally disabled and this setting cannot enable it. |
| `CODESTUDIO_FRONTEND_ORIGINS` | Comma-separated production browser origins | Required when backend `NODE_ENV` is `production`. Use exact HTTPS origins only, without paths, credentials, or a wildcard, for example `https://studio.example.test`. Development mode explicitly allows Vite's default localhost origins on ports 5173 and 4173. |
| `CODESTUDIO_WORKSPACE_ID` | Stable ID for this single-workspace instance | Defaults to `codestudio-default`; use the same value across restarts. The current storage model is one workspace per backend instance. |
| `CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME` | Initial administrator account name | Required with the password in production. On first startup, choose a unique unused username; it is created as the workspace administrator. |
| `CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD` | Initial administrator password | Required with the username in production; at least 12 UTF-8 bytes. Never place it in frontend `VITE_` configuration or source control. |
| `CODESTUDIO_DEV_AUTH_BYPASS` | Explicit local-only development identity | Set to `true` only with `NODE_ENV=development` for a loopback development server. The server rejects this flag in every other mode. It is disabled by default. |
| `VITE_BACKEND_URL` | Frontend backend origin, read at Vite build/start time | Defaults to `http://127.0.0.1:3001`. Local HTTP is supported for `localhost` and `127.0.0.1`; HTTPS is supported for a future deployment and derives a `wss://` collaboration URL. Do not put secrets in `VITE_` variables. |
| `CODESTUDIO_DATA_DIR` | Root directory for persistent backend data | Required in production and must be an absolute path to an existing readable and writable directory. Startup checks the metadata and Yjs storage locations before listening. The directory must be on a persistent mounted filesystem; startup cannot verify that the provider preserves it across restarts. |

`CODESTUDIO_DATA_DIR` is resolved once and shared by the current JSON metadata store and Yjs persistence. The backend writes metadata to `<CODESTUDIO_DATA_DIR>/db.json` and Yjs history under `<CODESTUDIO_DATA_DIR>/yjs_db/`. In production, startup requires an explicitly configured absolute path, verifies the root and metadata file access, creates `yjs_db/` if absent, and performs temporary write/fsync probes before the listener starts. These checks do not clear, rewrite, or move existing records and history. `db.json` contains file/document metadata, folder metadata, member labels, and file tombstones. Yjs update logs contain collaborative document content. Revision identifiers and snapshots are derived from those persisted histories; losing the history directory can disconnect revision and document recovery even if metadata remains.

Use one backend instance with exclusive access to this data directory. Do not point multiple instances at an ephemeral per-instance disk or concurrently share the JSON store, and do not share it with unrelated CodeStudio instances. A writable directory is not proof of durability: the hosting provider must mount persistent storage at the configured path and preserve it across restarts and redeploys. Back up metadata and Yjs history together as a consistent set. If the provider only offers ephemeral storage or cannot guarantee a single writer, deployment requires a separately designed durable metadata/Yjs storage adapter and coordination layer; this phase does not replace either storage implementation.

## Commands

With dependencies already installed, start the backend from `backend` with:

```sh
node server.js
```

The frontend commands, from `frontend`, are:

```sh
npm run dev
npm run build
npm run preview
npm test
npm run lint
```

Set `VITE_BACKEND_URL` before running Vite or building the frontend. Set backend variables in the backend process environment. The project has no separate backend build or `start` script; its server entry point is `backend/server.js`.

## Security assessment and deployment gate

HTTP CORS and Origin checks, plus the WebSocket Origin check, remain browser-boundary controls rather than authentication; non-browser clients can omit or forge an Origin header. Access is enforced separately using bearer sessions, server-derived workspace membership, role checks for administrative operations, and authenticated document-scoped WebSocket tickets. The profile-label records remain presentation labels, not authenticated identities.

## Implemented authentication model (Milestone 8B)

The backend stores users, workspace memberships, and sessions in the existing JSON metadata store. Passwords use Node's built-in scrypt password hashing with a random salt. Session credentials are 256-bit opaque bearer tokens; only SHA-256 token digests are stored. Sessions expire after eight hours. The frontend keeps the bearer token in memory only, so a page reload requires signing in again. Login responses are generic and login attempts are throttled per source address. The bootstrap administrator is created only when absent; changing the bootstrap password environment variable does not rotate an existing account.

Each backend instance represents exactly one configured workspace. Existing project records remain in that workspace without rewriting file identities or Yjs history. Workspace membership is explicit in metadata. All `/api` endpoints require a valid session except `POST /api/auth/login` and CORS preflight; a mismatched `X-CodeStudio-Workspace-Id` is rejected. `admin` and `member` workspace roles can edit project files; only admins can manage profile labels or provision/disable accounts. Profile labels are not accounts and do not authorize access.

### Bootstrap and restart procedure

For a new data directory, set both bootstrap variables before the first backend start. The server atomically creates that account and its admin membership before it begins listening. Keep the same bootstrap username and password configuration for restarts: startup succeeds idempotently only when that existing account is enabled, is already an admin in the configured workspace, and its stored password matches the configured password. It never promotes a matching member or overwrites an existing password. If the configured username collides with an existing non-admin, disabled, or differently credentialed account, startup stops with a non-sensitive conflict message and makes no bootstrap changes. Select a unique username only after confirming ownership of the data directory. There is no unauthenticated remote provisioning route or built-in password recovery; resolving an existing-account conflict requires a separately reviewed offline administrative recovery procedure. Changing the bootstrap password variable does not rotate a stored password.

SSE project-event streams require the same bearer session and are registered with the authenticated workspace. WebSocket clients first request an authenticated, document-scoped ticket. The ticket is single-use, expires after 30 seconds, and is required along with an allowed Origin for room admission. A maximum of 12 outstanding tickets is enforced per user; expired and revoked-session tickets are removed during issuance/revocation. The ticket appears briefly in the WebSocket request query because the browser WebSocket API cannot set an Authorization header; configure any reverse-proxy/access logging to redact query strings. Long-lived session tokens are never put in URLs. The server derives workspace identity from the session/ticket, not request body IDs, profile labels, or client-supplied names. Final room admission is serialized with logout and account disabling so either admission completes first and revocation closes it, or revocation completes first and admission is rejected.

The explicit local bypass is available only when `CODESTUDIO_DEV_AUTH_BYPASS=true` and `NODE_ENV=development`. It is off by default and rejected outside development. For local work in PowerShell, set both variables in the backend terminal before `node server.js`.

## Remaining deployment gate

This is a single-workspace, single-backend-instance authentication layer; it is not a multi-tenant workspace service. Password reset, MFA, invitation delivery, persistent login throttling across restarts, and automated backup/restore are not implemented. Awareness names and colors are presentation data supplied by connected clients; they do not grant permissions and must not be treated as verified identity. Serve production traffic through HTTPS/WSS at a trusted TLS-terminating host, protect bootstrap credentials, back up the data volume, and complete deployment-specific security review before use with public users.

The server still calls `assertPublicBindDisabled` before creating its listener. Every non-loopback bind remains blocked, regardless of authentication settings; this milestone does not provide a private-ingress exception. A normal hosted ingress cannot reach the backend while it listens only on loopback unless a specifically designed same-host private proxy can do so. These startup and storage checks do not make the application deployment-ready or production-secure. Do not deploy this backend publicly in the current state.
