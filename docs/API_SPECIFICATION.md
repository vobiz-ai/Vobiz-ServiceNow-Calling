# HTTP API reference

## Endpoints Summary

All requests to the backend server accept and return JSON unless otherwise specified.

No Vobiz account is configured on the server. Every route that touches Vobiz
uses the account of the session (or, for webhooks, of the call). You only need
this reference to build your own client or debug one; the softphone and the
**Call via Vobiz** button already use these routes.

---

### 0. `POST /login`: Vobiz account sign-in
```json
{ "agentId": "admin", "authId": "MA_XXXXXXXX", "authToken": "<typed by the agent>" }
```
1. `GET /Account/{authId}/numbers?page=N&per_page=100` with those credentials,
   paged to `total`. Any non-2xx response gives `401` and stops here.
2. Finds or creates this integration's application, matched on
   `answer_url = <PUBLIC_BASE_URL>/answer`.
3. Finds or creates the agent's endpoint (stored id, else exact alias), sets a
   fresh random password, and attaches it to the application. Application ids
   are 17 digits, so they are kept as strings.
4. Stores `{authId:agentId → endpointId, username}` in `DATA_DIR/endpoints.json`
   (mode 0600). The Auth Token and the password stay in memory.

```json
{
  "token": "<session>",
  "authId": "MA_XXXXXXXX",
  "numbers": ["+91XXXXXXXXXX", "+91YYYYYYYYYY"],
  "numberDetails": [{ "e164": "+91XXXXXXXXXX", "applicationId": "" }],
  "appId": "12345678901234567",
  "selected": "+91XXXXXXXXXX"
}
```
Only active, voice-enabled numbers are listed. `applicationId` is the
application each number is attached to now. `401` means the credentials were
refused. `503` means the backend has no public HTTPS address. `502` means Vobiz
refused a provisioning step.

### 0a. `POST /login-sip`: SIP direct
```json
{ "sipUser": "deskphone01", "callerId": "+91 XXXXX XXXXX" }
```
Records `deskphone01 → +91XXXXXXXXXX` for webhook routing (outbound caller ID,
and the number whose inbound calls ring it). The SIP password stays in the
browser, which registers with it directly. No account credentials are involved.
Vobiz enforces that the caller ID is on the endpoint's account. `400` is
returned for a malformed username or a caller ID that is not E.164. `409` is
returned when that SIP user was provisioned by an account sign-in.

### 0b. `POST /select-number` · `POST /setup-inbound`
Both need an account session. `/select-number {"number"}` sets the caller ID,
which must be on the account's list. `/setup-inbound {"number"}` is the **Enable
inbound calls** button and the only route that attaches a number:
`POST /numbers/%2B<digits>/application {"application_id":"<id>"}`. The response
carries `previousAppId`, the application the number was moved from.

---

### 1. `POST /start-call`
The **Call via Vobiz** UI Action's target. It originates nothing itself: it hands
the number to the agent's open, signed-in softphone, which places the call from
the browser (see `/dial-requests`).

#### Headers
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Content-Type` | `application/json` | Yes | Request MIME type |
| `X-Vobiz-Secret` | `string` | **Required** | Shared secret configured in `VOBIZ_SHARED_SECRET`. An account session in `Authorization: Bearer` is accepted instead (and rings only that agent's own panel). |

#### Request Body
```json
{
  "to": "+91XXXXXXXXXX",
  "agentId": "admin",
  "table": "incident",
  "sysId": "0123456789abcdef0123456789abcdef"
}
```
`agentId` is required and picks the panel signed in as that agent. No other
panel is ever used. `table` and `sysId` (optional) name the record the call was
started from; the interaction names it and the record gets a work note.

#### Response (202 Accepted)
```json
{ "queued": true, "id": "9f2c41aa07d3b6e1", "to": "+91XXXXXXXXXX" }
```

#### Error Responses
- `400 Bad Request`: missing or malformed `to`, or no `agentId`.
- `401 Unauthorized`: invalid or missing `X-Vobiz-Secret`, and no account session.
- `409 Conflict`: `"<agentId> has no Vobiz panel open..."`: no signed-in
  softphone of that agent is open.

---

### 1a. `GET /dial-requests`
Polled every two seconds by the softphone while it is signed in with a Vobiz
account. Returns the next number handed over by `/start-call`, once; requests
expire after 30 seconds.

```json
{ "dial": { "id": "9f2c41aa07d3b6e1", "to": "+91XXXXXXXXXX" } }
```
`{ "dial": null }` when there is nothing to dial. Requires an account session.

---

### 2. `POST /answer`
The VobizXML Vobiz fetches for every call on the application. Vobiz posts it
form-encoded. A `From` beginning `sip:` (or `RouteType=sip`) is the softphone
calling out; anything else is a customer calling the DID.

- **Outbound:** the SIP username in `From` names the agent and account. The
  caller ID is `X-VH-Caller-ID` (also accepted as `SIPHeader_X-VH-Caller-ID`,
  strict E.164) or else the agent's selected number. In account mode it must be
  on that account's list. An unknown SIP user gets `<Speak>` + `<Hangup/>`.
- **Inbound:** `ParentAuthID` names the account and every signed-in agent of it
  is rung. Without it, `To` is matched against signed-in accounts' numbers, then
  against SIP-direct agents' numbers. No match gets `<Speak>` + `<Hangup/>`.

#### Outbound (the softphone is the A leg)
```xml
<Response>
  <Record fileFormat="mp3" recordSession="true" maxLength="3600" redirect="false" callbackUrl="https://<bridge>/recording-ready" callbackMethod="POST"/>
  <Dial callerId="+91YYYYYYYYYY" timeout="30" timeLimit="14400" action="https://<bridge>/dial-status" method="POST" redirect="false">
    <Number>+91XXXXXXXXXX</Number>
  </Dial>
</Response>
```

#### Inbound (a customer calls the DID)
`callerId` is the dialled DID, in E.164 (`0XXXXXXXXXX` becomes `+91XXXXXXXXXX`).
`callerName` is the customer's number, which the softphone displays and logs.
```xml
<Response>
  <Record … />
  <Dial callerId="+91YYYYYYYYYY" callerName="+91XXXXXXXXXX" timeout="30" timeLimit="14400" action="https://<bridge>/dial-status" method="POST" redirect="false" callbackUrl="https://<bridge>/dial-events" callbackMethod="POST">
    <User>sip:<agent endpoint username>@<VOBIZ_REGISTRAR></User>
    <!-- one <User> per signed-in agent of that account -->
  </Dial>
</Response>
```

`Event=Hangup` is answered with an empty `<Response>`.

---

### 3. `POST /dial-status`
The `action` URL of `<Dial>`. Vobiz posts the dial result (`DialStatus`,
`DialHangupCause`, `DialBLegUUID`, `DialBLegDuration`); the backend stores it on
the call and logs a `DIAL RESULT` line. An empty `DialBLegUUID` means the second
leg was never created. For an inbound call nobody answered, the backend logs one
`interaction` marked missed, with 0 seconds and no agent.

### 3b. `POST /dial-events`
The `callbackUrl` of the inbound `<Dial>`. On `DialAnswer` (or
`DialConnected`), `DialBLegTo` names the SIP user that answered; the backend
records it as the call's agent, if that user was one of those rung. Only that
agent's `/sync-call` is logged for the call.

### 3a. `POST /hangup-callback`
Accepted and logged; it changes nothing. The application's hangup URL is
`/answer`, which answers `Event=Hangup` with an empty `<Response>`.

---

### 4. `POST /recording-ready` (also `/recording-callback`)
The `callbackUrl` of `<Record>`. Vobiz posts it, form-encoded, when the
recording is ready:

```
CallUUID=<call uuid>&RecordingID=<recording id>&RecordUrl=https://...&RecordingDuration=42
```

If the call is one the backend placed or answered since it started, the
backend updates that call's `interaction` record in ServiceNow with a signed
playback link (or creates the record, if the softphone has not logged it yet).
Links written into ServiceNow last `RECORD_LINK_TTL_SECONDS` (7 days by
default); links the panel plays last `RECORDING_URL_TTL_SECONDS` (300 s).

---

### 5. `GET /recording-audio/:recordingId`
Streams a recording, after proving the caller may hear it.

#### Query Parameters
- `acct`, `exp`, `sig`: the account and the HMAC signature (over
  `acct|id|exp`) issued by `/recordings` or written into a ServiceNow work note.
  An account session is accepted instead, for its own account only. Changing
  `acct` invalidates the signature.

#### Response (`audio/mpeg`)
The backend resolves the media URL from the recording id through the Vobiz API,
refuses any host off `MEDIA_HOST_ALLOWLIST`, re-checks after every redirect, and
streams the bytes. It uses the signing account's credentials, held in memory,
and never takes credentials from the request.

- `403 Forbidden`: missing, forged or expired signature, and no session.
- `409 Conflict`: the backend restarted and nobody from that account has
  signed in since. Signing in again makes the link playable.

> **`GET /recording-file?url=` is not implemented and answers `410 Gone`.**
> Fetching a caller-supplied URL with `X-Auth-ID` and `X-Auth-Token` attached
> delivers the account credentials to whatever host the caller names. Do not add
> a URL parameter here.

---

### 6. `GET /agent`
The SIP credentials the softphone registers with: this session's own endpoint
and the password set at this sign-in. Sent with `Cache-Control: no-store`.

```json
{
  "displayName": "Admin User",
  "sipUser": "<endpoint username>@<VOBIZ_REGISTRAR>",
  "sipPassword": "<random, set at this sign-in>",
  "registrar": "<VOBIZ_REGISTRAR>",
  "registrarUrl": "wss://<VOBIZ_REGISTRAR>:5063/"
}
```
`/session` (signed in or not) and `/login-sip` also return `registrar`; the
softphone uses it for registration and call URIs.

- `401 Unauthorized`: no session.
- `403 Forbidden`: a SIP-direct session (it registers with what the agent typed).

---

### 7. `GET /health`
Unauthenticated, so it reports counts and configuration state, never an Auth
ID, a number or a SIP username.

```json
{
  "ok": true,
  "publicBaseConfigured": true,
  "serviceNowConfigured": false,
  "accountsSignedIn": 2,
  "sessions": 3,
  "recentCalls": 4
}
```

---

## Authentication

| Route | Requires |
| --- | --- |
| `/answer`, `/dial-status`, `/recording-ready`, `/hangup-callback` | Nothing. Vobiz calls these. Webhook signatures are not checked; the backend acts only for SIP users and numbers of accounts signed in to it. |
| `/health` | Nothing |
| `/login` | An Auth ID and Auth Token, which Vobiz verifies |
| `/login-sip` | A SIP username and an E.164 caller ID; the SIP password is proven by the browser's REGISTER |
| `/agent` | An account session |
| `/call-record`, `/sync-call` | A session. An account session sees its own account's calls; a SIP-direct session only its own endpoint's |
| `/select-number`, `/recordings`, `/setup`, `/setup-inbound`, `/dial-requests` | An account session. SIP direct gets `403 Sign in with your Vobiz account to use this.` |
| `/start-call` | `X-Vobiz-Secret` or an account session |
| `/recording-audio/:id`, `/play-recording` | A valid signature for that account and id, or an account session for its own account |

Sessions come from `POST /login` (account mode) or `POST /login-sip`
(SIP-direct mode), last 12 hours, and are sent as `Authorization: Bearer <token>`.
