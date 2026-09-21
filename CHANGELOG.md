# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-09-21

Security rewrite. Every item below was reproduced against the running server
before it was fixed, and each now has a permanent test — `npm test` fails if any
of them starts working again.

### Security
- **Removed `GET /recording-file?url=`.** It fetched any URL a caller named with
  `X-Auth-ID` and `X-Auth-Token` attached; pointed at a listener, it delivered
  both. Unauthenticated, and CORS was `*`, so any web page could drive it.
  Playback goes through the signed `/recording-audio/<recordingId>`, which
  resolves the media URL server-side and refuses any host off an allowlist —
  before the first request and again after each redirect.
- **`/agent/<id>` is behind the session.** It served the real SIP password to
  any caller: an unknown id fell through to a manufactured agent carrying
  `VOBIZ_SIP_PASSWORD`. `agents.json` no longer holds passwords at all.
- **Playback signatures are verified.** `signRecordingUrl()` had always emitted
  `exp` and `sig`; nothing checked them, so recording IDs were enumerable. An
  unmatched playback link also fell through to "the account's most recent
  recording" — that fallback is gone.
- **Sign-in proves the credentials.** `/login` skipped its check entirely when
  the server had no `VOBIZ_AUTH_ID`, admitting anyone; it now validates against
  Vobiz.
- **`/session/<agentId>` no longer answers without a token.** It replied from
  any live session whose agent id matched, leaking the account Auth ID and the
  account's phone numbers.
- **`/start-call` requires the shared secret or a session.** It originates a
  billed call and was open whenever `VOBIZ_SHARED_SECRET` was unset, the
  default.
- **CORS is an allowlist** — `*.service-now.com`, localhost, `ALLOWED_ORIGINS`.
- **`/health` reports configuration state, not values.** It published the
  account Auth ID and the SIP username.
- **`/login-sip` validates the caller ID** against the account's own numbers;
  any string was accepted, which is caller-ID spoofing. It now returns a session
  scoped to SIP-direct mode, which `/agent` deliberately refuses.
- **Session guards** on `/select-number`, `/call-record`, `/recordings`,
  `/sync-call` and `/setup`.

### Changed
- Recording links written into ServiceNow work notes are signed and expire.
- `backend/cloudflared.exe` (54 MB, Windows-only) is no longer committed;
  `tunnel.js` already fell back to `cloudflared` on PATH and now says how to
  install it on each platform.
- The softphone stores the session token returned by SIP-direct sign-in.

### Docs
- README, SECURITY, ISSUES and a new `docs/TROUBLESHOOTING.md` rewritten for the
  public repository, including what has **not** been verified since the rewrite.

## [2.0.0] - 2026-09-21

Upgraded to full feature parity with reference Vobiz calling app (Zendesk standard):

### Added
- **Dual Authentication Modes**:
  - **Vobiz Account Mode**: Log in with Auth ID and Auth Token (`POST /login`), dynamic account number retrieval, and session token storage.
  - **SIP Direct Mode**: Log in directly with endpoint SIP username and password (`POST /login-sip`), with optional local credential persistence.
- **Zendesk-Style UI Softphone**:
  - Modern branded header with SVG logomark, status badge (`READY`, `OFFLINE`, `CONNECTING`, `ON A CALL`), and status message.
  - Step 1: Authentication tabs for Vobiz Account and SIP Direct.
  - Step 2: Account caller ID dropdown.
  - Step 3: Keypad/dialer with number input, Call button, Hang up button, and live duration timer.
  - Step 4: Optional one-click inbound webhook configuration (`/setup-inbound`).
  - Step 5: Call recordings section with recent call timestamps, formatted durations, inline audio player controls, and refresh button.
  - Collapsible FAQ section for agent troubleshooting.
- **Outbound WebRTC Calling (Browser-as-the-A-Leg)**:
  - Softphone initiates WebRTC SIP INVITE directly via vendored JsSIP to `sip:<number>@registrar.vobiz.ai` with caller ID header.
  - Backend answers with `<Dial><Number>` and sibling `<Record recordSession="true">`.
- **Inbound Calling Support**:
  - Inbound calls arriving on account DID route to `<Dial><User>sip:agent@registrar</User></Dial>`.
  - Incoming call popup banner displaying caller ID with Accept and Decline actions.
  - Keyboard shortcuts (`Enter` to accept, `Escape` to decline).
  - Built-in Web Audio API synthesizer ringtone alert (no external audio assets required).
- **CDR Ledger & Recording Streaming**:
  - In-memory CDR tracking with `/dial-status` and `/recording-ready` webhooks.
  - Authenticated audio proxy streaming endpoint (`/play-recording` and `/recording-audio/:recordingId`).
  - Automatic interaction logging into ServiceNow `interaction` table.
- **Brand Standardization**:
  - Standardized all product naming to `Vobiz` across all files, code comments, UI labels, and documentation.

## [1.0.0] - 2026-09-17

### Added
- Rebuilt architecture on the browser-as-a-leg WebRTC pattern.
- Added comprehensive architecture specification (`docs/ARCHITECTURE.md`).
- Added ServiceNow setup guide and API specification (`docs/SETUP_GUIDE.md`, `docs/API_SPECIFICATION.md`).
- Added modular ServiceNow components (`servicenow-app/` with UI Actions, System Properties guide, and OpenFrame CTI guide).
- Added GitHub CI workflow and contribution templates (`.github/`).
- Added standardized npm scripts (`scripts/start.js`, `scripts/test.js`).
- Added support for `VOBIZ_SHARED_SECRET` header validation (`X-Vobiz-Secret`).

### Fixed / Security
- Removed plain-text credential logging from console outputs.
- Removed startup debug API calls that executed without authentication validation.
- Decoupled hardcoded tunnel URLs from ServiceNow UI Actions via `gs.getProperty('vobiz.calling.tunnel_url')`.
- Replaced hardcoded fallback agent IDs with configurable environment options.
