# Vobiz ServiceNow Calling Bridge: API Specification

## Endpoints Summary

All requests to the backend server accept and return JSON unless otherwise specified.

---

### 1. `POST /start-call`
The **Call via Vobiz** UI Action's target. It originates nothing itself: it hands
the number to the agent's open, signed-in softphone, which places the call from
the browser (see `/dial-requests`). Dialling the customer from the backend and
bridging the agent in with `<Dial><User>` does not work on Vobiz.

#### Headers
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Content-Type` | `application/json` | Yes | Request MIME type |
| `X-Vobiz-Secret` | `string` | **Required** | Shared secret configured in `VOBIZ_SHARED_SECRET`. An account session in `Authorization: Bearer` is accepted instead. |

#### Request Body
```json
{
  "to": "+919876543210",
  "agentId": "admin"
}
```
`agentId` picks the panel signed in as that agent; with exactly one panel open,
that one is used.

#### Response (202 Accepted)
```json
{ "queued": true, "id": "9f2c41aa07d3b6e1", "to": "+919876543210" }
```

#### Error Responses
- `400 Bad Request`: missing or malformed `to`.
- `401 Unauthorized`: invalid or missing `X-Vobiz-Secret`, and no account session.
- `409 Conflict`: no signed-in softphone is open, or several are and none is
  signed in as `agentId`.

---

### 1a. `GET /dial-requests`
Polled every two seconds by the softphone while it is signed in with the
account. Returns the next number handed over by `/start-call`, once; requests
expire after 30 seconds.

```json
{ "dial": { "id": "9f2c41aa07d3b6e1", "to": "+919876543210" } }
```
`{ "dial": null }` when there is nothing to dial. Requires an account session.

---

### 2. `POST /answer`
The VobizXML Vobiz fetches for every call on the application. Vobiz posts it
form-encoded. A `From` beginning `sip:` (or `RouteType=sip`) is the softphone
calling out; anything else is a customer calling the DID.

#### Outbound (the softphone is the A leg)
```xml
<Response>
  <Record fileFormat="mp3" recordSession="true" maxLength="3600" redirect="false" callbackUrl="https://<bridge>/recording-ready" callbackMethod="POST"/>
  <Dial callerId="+91XXXXXXXXXX" timeout="30" timeLimit="14400" action="https://<bridge>/dial-status" method="POST" redirect="false">
    <Number>919876543210</Number>
  </Dial>
</Response>
```

#### Inbound (a customer calls the DID)
`callerId` is the dialled DID, in E.164.
```xml
<Response>
  <Record … />
  <Dial callerId="+91XXXXXXXXXX" timeout="30" timeLimit="14400" action="https://<bridge>/dial-status" method="POST" redirect="false">
    <User>sip:<VOBIZ_SIP_USER>@registrar.vobiz.ai</User>
  </Dial>
</Response>
```

`Event=Hangup` is answered with an empty `<Response>`.

---

### 3. `POST /hangup-callback`
Vobiz Voice API webhook invoked when the call terminates.

#### Payload
```json
{
  "CallUUID": "d4f3b5e1-8899-4c12-9c1a-9f4a62df89b2",
  "Duration": "45",
  "From": "+12003004000",
  "To": "+15550199"
}
```

#### Actions Taken
1. Calculates call duration in seconds.
2. Formats timestamp for ServiceNow.
3. Logs it. The interaction record is written by `/sync-call` and
   `/recording-ready`, once per call: the first creates it, the second updates it.

---

### 4. `POST /recording-callback`
Vobiz Voice API webhook invoked when the audio recording finishes processing.

#### Payload
```json
{
  "CallUUID": "d4f3b5e1-8899-4c12-9c1a-9f4a62df89b2",
  "RecordUrl": "https://media.vobiz.ai/recordings/rec_abc123.mp3"
}
```

---

### 5. `GET /recording-audio/:recordingId`
Streams a recording, after proving the caller may hear it.

#### Query Parameters
- `exp`, `sig`: the HMAC signature issued by `/recordings` or written into a
  ServiceNow work note. A session token is accepted instead.

#### Response (`audio/mpeg`)
The backend resolves the media URL from the recording id through the Vobiz API,
refuses any host off `MEDIA_HOST_ALLOWLIST`, re-checks after every redirect, and
streams the bytes. Credentials are the server's own and are never taken from the
request.

- `403 Forbidden`: missing, forged or expired signature, and no session.

> **`GET /recording-file?url=` is not implemented and answers `410 Gone`.**
> Fetching a caller-supplied URL with `X-Auth-ID` and `X-Auth-Token` attached
> delivers the account credentials to whatever host the caller names. Do not add
> a URL parameter here.

---

### 6. `GET /agent` and `GET /agent/:agentId`
Fetches SIP registration credentials for the browser softphone.

**Requires a session.** SIP credentials let anyone place calls billed to the
account, so this route is closed to unauthenticated callers and to sessions
created by `/login-sip` — those agents already hold their own password.

#### Request
```
Authorization: Bearer <session token from /login>
```

#### Response (200 OK)
```json
{
  "displayName": "ServiceNow Admin",
  "sipUser": "admin@registrar.vobiz.ai",
  "sipPassword": "<from VOBIZ_SIP_PASSWORD>",
  "registrarUrl": "wss://registrar.vobiz.ai:5063/"
}
```

- `401 Unauthorized`: no session.
- `403 Forbidden`: a SIP-direct session.
- `500`: `VOBIZ_SIP_USER` / `VOBIZ_SIP_PASSWORD` not configured — the backend
  will not invent credentials.

---

### 7. `GET /health`
Unauthenticated, so it reports whether things are configured rather than what
they are.

```json
{
  "ok": true,
  "accountConfigured": true,
  "callerIdConfigured": true,
  "sipConfigured": true,
  "publicBaseConfigured": true,
  "serviceNowConfigured": false,
  "sessions": 1,
  "recentCalls": 4
}
```

---

## Authentication

| Route | Requires |
| --- | --- |
| `/answer`, `/dial-status`, `/recording-ready`, `/hangup-callback` | Nothing — Vobiz calls these. Keep them fast and side-effect-safe. |
| `/health` | Nothing |
| `/login`, `/login-sip` | Credentials, which are verified |
| `/agent` | A session, and not a SIP-direct one |
| `/call-record`, `/sync-call` | A session. A SIP-direct session sees and logs only its own endpoint's calls |
| `/select-number`, `/recordings`, `/setup`, `/dial-requests` | An account session |
| `/start-call` | `X-Vobiz-Secret` or an account session |
| `/recording-audio/:id`, `/play-recording` | A valid signature for that id, or an account session |

Sessions come from `POST /login` (account mode) or `POST /login-sip`
(SIP-direct mode), last 12 hours, and are sent as `Authorization: Bearer <token>`.
