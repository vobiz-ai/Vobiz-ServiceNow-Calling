# Vobiz ServiceNow Calling Bridge: API Specification

## Endpoints Summary

All requests to the backend server accept and return JSON unless otherwise specified.

---

### 1. `POST /start-call`
Triggered by ServiceNow UI Action or CTI panel to place an outbound call.

#### Headers
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Content-Type` | `application/json` | Yes | Request MIME type |
| `X-Vobiz-Secret` | `string` | **Required** | Shared secret configured in `VOBIZ_SHARED_SECRET`. A session token in `Authorization: Bearer` is accepted instead. This endpoint originates a billed call and is not open. |

#### Request Body
```json
{
  "to": "+15550199",
  "agentId": "admin"
}
```

#### Response (201 Created / 200 OK)
```json
{
  "request_uuid": "d4f3b5e1-8899-4c12-9c1a-9f4a62df89b2",
  "message": "call queued",
  "api_id": "api-12345"
}
```

#### Error Responses
- `400 Bad Request`: Missing `to` phone number or unknown `agentId`.
- `401 Unauthorized`: Invalid or missing `X-Vobiz-Secret`.
- `500 Internal Server Error`: Backend tunnel or Vobiz credentials unconfigured.

---

### 2. `POST /answer`
Vobiz Voice API webhook invoked when the customer answers the phone call.

#### Query Parameters
- `agentId`: Identifier of the agent assigned to the call.

#### Response (`text/xml`)
Returns Vobiz XML instructions directing Vobiz to bridge the call to the agent's SIP WebRTC endpoint:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record action="https://<tunnel-url>/recording-callback" redirect="false" maxLength="3600" />
  <Speak voice="WOMAN" language="en-US">
    Hello! Connecting you to your agent now. Please hold...
  </Speak>
  <Dial>
    <User>sip:admin@registrar.vobiz.ai</User>
  </Dial>
</Response>
```

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
3. Performs authenticated POST to ServiceNow Table API (`/api/now/table/interaction`).
4. Cleans up memory tracking for the call session.

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
| `/select-number`, `/call-record`, `/recordings`, `/sync-call`, `/setup` | A session |
| `/start-call` | `X-Vobiz-Secret` or a session |
| `/recording-audio/:id`, `/play-recording` | A valid signature, or a session |

Sessions come from `POST /login` (account mode) or `POST /login-sip`
(SIP-direct mode), last 12 hours, and are sent as `Authorization: Bearer <token>`.
