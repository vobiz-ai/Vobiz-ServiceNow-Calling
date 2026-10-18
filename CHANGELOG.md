# Changelog

Notable changes to this integration. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **Call via Vobiz rings only the requesting agent's panel.** If that agent had
  no panel open and exactly one panel was open on the backend, that panel was
  rung, even another agent's on another Vobiz account. That fallback is gone:
  the request is refused with "<user> has no Vobiz panel open". `agentId` is now
  required.

### Fixed
- Inbound calls that rang several agents are logged once. The backend learns
  which panel answered from the Dial events (`/dial-events`) and ignores
  `/sync-call` from any other panel. A missed call is logged once by the
  backend, as missed, with 0 seconds.
- Inbound calls show and log the customer's number: it travels in the Dial's
  `callerName`, since `callerId` has to be the account's own DID.
- The softphone takes the registrar from the backend (`VOBIZ_REGISTRAR`)
  instead of a hard-coded `registrar.vobiz.ai`.

### Added
- `RECORD_LINK_TTL_SECONDS` (default 7 days) for recording links written into
  ServiceNow records; `RECORDING_URL_TTL_SECONDS` (300 s) now covers only links
  the panel plays.
- Call via Vobiz sends the record's table and sys_id. The interaction names the
  record, and the backend writes a work note on it naming the interaction.

## [2.3.0] - 2026-10-18

### Changed
- **Any Vobiz account can sign in.** The backend no longer has a Vobiz account
  configured. `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER`,
  `VOBIZ_SIP_USER` and `VOBIZ_SIP_PASSWORD` are gone. Sign-in verifies the Auth
  ID and Auth Token with Vobiz. It then finds or creates the integration's
  application and the agent's own SIP endpoint on that account, with a fresh
  password per sign-in. The endpoint ids go in `DATA_DIR/endpoints.json`, mode
  0600.
- Webhooks are multi-tenant. Outbound calls are matched by SIP username.
  Inbound calls are matched by `ParentAuthID`, then by the dialled number.
- The caller-ID dropdown lists every active, voice-enabled number on the
  account, across all pages, and shows which application each is attached to.
  The caller ID also travels as `X-VH-Caller-ID`, and the backend accepts only
  numbers on that account's list.
- **SIP direct** works with nothing configured. The agent types the endpoint's
  SIP credentials and an E.164 caller ID; recordings and Enable inbound ask for
  an account sign-in.
- A number is attached to the application only by **Enable inbound calls**,
  never at sign-in or startup.
- `PUBLIC_BASE_URL` (or `PUBLIC_BASE`) names the public address; `TUNNEL_URL`
  still works.

### Security
- Recording links are signed over account, id and expiry, and carry the account,
  so one account's link cannot fetch another's audio.
- The Auth Token is held in memory only. It is never in a response, a log or a
  file.

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
