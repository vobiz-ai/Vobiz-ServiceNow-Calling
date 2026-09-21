# Troubleshooting

Organised by symptom. Several of these fail with a message that names the wrong
cause entirely, so read the whole entry before acting on the error text.

---

## "It worked yesterday and today nothing connects"

The tunnel hostname changed. Three things go stale together:

1. `TUNNEL_URL` in `backend/.env` — or delete it and let `backend/tunnel-url.txt`
   supply the value, which `npm run tunnel` rewrites for you
2. the Vobiz application's `answer_url` — `POST /setup` with a session, or
   press **Configure inbound** in the softphone
3. ServiceNow: the `vobiz.calling.tunnel_url` property **and** the OpenFrame
   configuration URL

Confirm the first with `curl -s "$BASE/health"`, and the second by watching the
backend log while you call the DID. No `WEBHOOK /answer` line means Vobiz is
still calling the old hostname.

---

## The softphone never reads Ready

The status badge is the SIP registration, not the backend connection.

- **Account mode**: the softphone fetches SIP credentials from `/agent`, which
  now requires a session. If sign-in failed, registration never starts. Look for
  `401` on `/agent` in the browser console.
- **`VOBIZ_SIP_USER / VOBIZ_SIP_PASSWORD are not configured on this server`** —
  exactly what it says; `/agent` refuses to invent credentials.
- **SIP-direct mode**: the password is proven by the REGISTER itself. A wrong
  password shows as "not Ready", with no sign-in error, because the backend
  never sees it.
- Microphone permission must be granted **before** registration, and the page
  must be HTTPS (or `localhost`) for `getUserMedia` to exist at all.

---

## "Sign in first" (HTTP 401) from the softphone

Expected on `/agent`, `/recordings`, `/call-record`, `/select-number`,
`/sync-call` and `/setup` when the session has expired — it lasts 12 hours — or
when the page was reloaded without a stored token. Sign in again.

If it happens immediately after a successful sign-in, the token is not reaching
the backend: check that the softphone is served from the same origin as the API,
or that the origin is in `ALLOWED_ORIGINS`. A cross-origin request that CORS
refuses looks exactly like a missing session.

---

## The ServiceNow **Call via Vobiz** button fails with 401

`/start-call` originates a billed call and is no longer open. Set both:

- `VOBIZ_SHARED_SECRET` in `backend/.env`
- `vobiz.calling.shared_secret` in ServiceNow `sys_properties`, to the same value

The UI Action sends it as `X-Vobiz-Secret`. With the property empty, no header
is sent and the backend refuses — which is the intended behaviour, not a bug.

---

## The customer answers, hears ringback, then "the agent could not be reached"

The classic symptom of the architecture that cannot work: something is dialling
the customer first and trying to bridge the agent in with `<Dial><User>`.
Routing into a registered WebRTC endpoint is blocked platform-side. The
softphone must send the INVITE. Check that `/answer` returned
`<Dial><Number>` — `RouteType=sip` or a `From` beginning `sip:` is what selects
that branch.

---

## No audio in one direction

- One-way audio is almost always ICE. The softphone needs STUN reachable; a
  corporate network that blocks UDP will register fine and carry no media.
- Check `DialBLegUUID` in the `DIAL RESULT` log line. Empty means no B leg was
  ever created — that is a signalling failure, not an audio one.

---

## Interactions are not appearing in ServiceNow

1. `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USER`, `SERVICENOW_PASSWORD` must all
   be set — with any one missing the backend logs
   `ServiceNow credentials not configured. Skipping interaction creation.` and
   carries on.
2. The user needs write access to `interaction`. A 403 from the Table API is
   logged, not surfaced in the softphone.
3. The record is created when the **recording** callback arrives, not at hangup.
   A call with no recording produces no automatic interaction; use
   **Sync to CRM** in the softphone, which posts `/sync-call`.

---

## "This playback link is invalid or has expired"

Both halves are real causes:

- **Expired.** `RECORDING_URL_TTL_SECONDS` defaults to 300 seconds. Links in old
  work notes die.
- **Invalid.** `SIGNING_SECRET` was not set, so it was regenerated on the last
  restart and every previously issued link is now unverifiable.

Open the recording from the softphone's recordings list to get a fresh link.

---

## `/recording-file` returns HTTP 410

Deliberate. That endpoint took a caller-supplied URL and fetched it with the
account credentials attached; it was removed. Use the signed
`/recording-audio/<recordingId>` link that `/recordings` returns.

---

## CORS errors in the browser console

The allowlist is `*.service-now.com`, `localhost`, `127.0.0.1`, and anything in
`ALLOWED_ORIGINS` (comma-separated). ServiceNow serves OpenFrame from the
instance hostname, so a custom domain on the instance needs adding there. The
response simply omits the header for an unknown origin — the browser reports it
as a CORS failure with no detail.

---

## Recording is empty or missing

- `maxLength` is 3600 seconds; longer calls truncate.
- A call that never connected has nothing to record, and Vobiz emits no
  recording callback.
- Recording is asynchronous: the callback can arrive seconds after hangup.

---

## Reading the log

```
WEBHOOK /answer received: {"From":"sip:…","To":"91…","RouteType":"sip"}
  -> Browser is A-leg: dialing out to 91… as callerId=+91…
DIAL RESULT status=completed ring=true cause=NORMAL_CLEARING bleg=abc-123 dur=42
RECORDING READY call=… id=…
```

| Line | Means |
| --- | --- |
| No `WEBHOOK /answer` | Vobiz never reached this server — tunnel or `answer_url` |
| `Browser is A-leg` | Outbound branch taken, as it should be |
| `bleg=(none)` | The B leg was never created; the customer was never dialled |
| `cause=NO_ANSWER` / `USER_BUSY` | Reached the customer, who did not answer |
| No `RECORDING READY` | No recording — check the call actually connected |
