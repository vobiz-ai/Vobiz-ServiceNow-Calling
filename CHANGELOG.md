# Changelog

Notable changes to this integration. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-10-18

### Fixed
- **Call via Vobiz now works the way the rest of the softphone does.** The
  button hands the record's number to the agent's open softphone, which places
  the call from the browser. It previously had the backend dial the customer and
  bridge the agent in with `<Dial><User>`, which does not connect on Vobiz.
  `/start-call` answers `202` when a panel takes the number and `409` when no
  signed-in panel is open.
- One interaction record per call. The softphone's hang-up report and the
  recording webhook previously created a record each.
- Inbound calls: the DID is attached to the application on the
  `/numbers/%2B<E164>/application` path. The previous call was refused, so
  "Enable inbound calls" reported success without routing the number.
- The OpenFrame API is loaded from the ServiceNow instance, so the panel
  initialises inside ServiceNow and opens itself on an incoming call. Set
  `?instance=<name>` on the OpenFrame URL.
- `backend/.env` is loaded on Node 18.
- The Call via Vobiz UI Action finds the number on an incident's caller and a
  case's contact.

### Security
- A SIP-direct session is scoped to the agent's own calls. Account recordings,
  provisioning, caller-ID selection and click-to-call need an account sign-in.
- Caller-ID changes are checked against the numbers the account owns.
- A recording playback signature covers exactly the id that is played.
- The softphone no longer stores a SIP password in the browser.
- A failed sign-in no longer names the account the backend serves.

### Removed
- The unused `agent-phone.bundle.js` development build.

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
