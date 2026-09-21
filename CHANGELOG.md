# Changelog

Notable changes to this integration. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-09-21

First public release.

### Features
- **Outbound calling** from the softphone, and click-to-dial from a ServiceNow
  record through the **Call via Vobiz** UI Action.
- **Inbound calling** to the softphone, with a floating caller banner, accept
  and decline, and keyboard shortcuts.
- **Two ways to sign in** — Vobiz account credentials with a caller-ID dropdown
  of the account's numbers, or a single SIP endpoint's own credentials.
- **Automatic CDR and recording sync** into the ServiceNow `interaction` table,
  with a playable recording link in the work notes.
- **OpenFrame support**, so the softphone lives in the Next Experience header
  rather than a separate tab.

### Security
- Recording playback is HMAC-signed with a short expiry. The endpoint takes a
  recording id, resolves the media URL server-side, and enforces a host
  allowlist on the first request and after every redirect.
- SIP credentials are served only to a signed-in caller; `agents.json` carries
  display names and usernames, never a password.
- Sign-in is validated against Vobiz. The browser holds a session token, not the
  Auth Token.
- `/start-call` requires the shared secret or a session, because it originates a
  billed call. Caller ID must be a number the account owns.
- CORS is an allowlist. `/health` reports configuration state, not values.

### Requirements
- Node 18 or newer. No runtime dependencies — the backend is Node's own `http`,
  and JsSIP is vendored.
- `cloudflared` on your PATH for the local tunnel, or any stable HTTPS hostname.
