# Vobiz Calling for ServiceNow

A WebRTC softphone inside ServiceNow. Agents call from a record or from the
OpenFrame panel, talk in the browser, and the call is written back to the
ServiceNow `interaction` table with a playable recording link.

[Docs](https://docs.vobiz.ai/integrations/servicenow) · [Quick start](QUICKSTART.md) · [Install](docs/SETUP_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API_SPECIFICATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

---

## The one thing to understand first

**The browser is the A leg.** The softphone sends the SIP INVITE itself; the
backend answers `<Dial><Number>` to reach the customer.

```
softphone ──SIP INVITE──▶ Vobiz ──answer_url──▶ backend /answer
                                                     │
                                              <Dial><Number> ──▶ customer
```

The intuitive design — backend dials the customer over the REST API, then
bridges the agent in with `<Dial><User>` — **cannot work**. Routing *into* a
registered WebRTC endpoint is blocked platform-side: Vobiz builds a gateway URI
it cannot itself parse and drops its own INVITE. The customer answers, hears
ringback, then "the agent could not be reached".

Inbound is the exception: `<Dial><User>` is the only way to reach a registered
endpoint, and it works.

---

## What talks to what

| Piece | Role |
| --- | --- |
| `agent-phone/` | The softphone ServiceNow iframes. JsSIP stack, dialpad, incoming-call popup, call history |
| `backend/server.js` | Answers Vobiz webhooks for every signed-in account, serves the softphone, provisions each account at sign-in, brokers the Vobiz REST API, writes to ServiceNow |
| `backend/tunnel.js` | Starts a Cloudflare quick tunnel and records its hostname |
| `servicenow-app/openframe/` | How to mount the softphone in the Next Experience header |
| `servicenow-app/ui-actions/` | The **Call via Vobiz** form button — server-side, uses `sn_ws.RESTMessageV2` |
| `servicenow-app/sys_properties/` | The two properties the UI Action reads, instead of hardcoded URLs |

The backend writes the interaction record itself, over the ServiceNow Table API,
using the instance credentials in `.env`. So the ServiceNow user you configure
there needs write access to the `interaction` table.

---

## Signing in: any Vobiz account

No Vobiz account is configured on the backend. There is no Auth ID, Auth
Token, SIP user, SIP password or caller-ID number in `.env`. One backend serves
every account whose agents sign in to it. The panel has two tabs.

### Vobiz account (Auth ID + Auth Token)

The agent types the account's Auth ID and Auth Token, from the
[Vobiz Console](https://console.vobiz.ai) under **API credentials**. The backend:

1. **Checks the pair with Vobiz** (`GET /Account/{auth_id}/numbers`). Vobiz
   refusing it means `401` and nothing else happens.
2. **Finds or creates this integration's application** in that account, matched
   on `answer_url = <PUBLIC_BASE_URL>/answer`. It never repoints an application
   it did not create.
3. **Finds or creates one SIP endpoint for this agent** on that account (by the
   stored id, else by its exact alias), sets a **fresh random password** on it,
   and binds it to the application. The binding uses `{"app_id":"<id>"}` first,
   checks it with a GET, then falls back to the documented
   `{"application": <id>}`. Application ids are 17 digits, so they stay strings
   throughout. The endpoint id and the username Vobiz stored go into
   `backend/data/endpoints.json` (mode 0600, git-ignored). No password goes there.
4. **Loads the caller-ID dropdown** from the account's numbers (every page;
   active, voice-enabled ones only). Outbound calls can only use a number on
   that list.

The SIP password is handed to that browser session only. The Auth Token stays in
the backend's memory. It is never returned to the browser, never logged and
never written to disk.

**Inbound** is off until an agent presses **Enable inbound calls**. That
attaches the selected number to the integration's application, which moves the
number off whatever application answered it before (the panel shows which one).
Nothing else attaches a number.

### SIP direct (an endpoint you already have)

The agent types an existing endpoint's SIP username and password, plus the
number to call from (E.164). The panel registers with those credentials
directly. The password never reaches the backend, which only records
*SIP user → caller ID* for routing. Calls to that number ring this endpoint.

SIP direct has no account credentials, so the customer sets up routing once:

- **Console:** Voice → Applications → New. Set the answer URL to
  `<PUBLIC_BASE_URL>/answer` (POST) and the hangup URL the same. Open the
  endpoint under Voice → Endpoints and choose that application. Then open the
  phone number and attach the same application.
- **API equivalent:**
  ```bash
  # 1. the application
  curl -X POST https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Application/ \
    -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
    -d '{"app_name":"ServiceNow Calling (Vobiz)","answer_url":"'$BASE'/answer","answer_method":"POST","hangup_url":"'$BASE'/answer","hangup_method":"POST"}'
  # 2. bind the endpoint (keep the 17-digit app_id as a string)
  curl -X POST https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/$ENDPOINT_ID/ \
    -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
    -d '{"app_id":"'$APP_ID'"}'
  # 3. route the number to it
  curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/numbers/%2B$DIGITS/application" \
    -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
    -d '{"application_id":"'$APP_ID'"}'
  ```

Recordings, the number list and **Enable inbound calls** need the account API.
In SIP direct they say "Sign in with your Vobiz account to use this", and the
**Call via Vobiz** button does not reach a SIP-direct panel. Vobiz itself refuses
a caller ID that is not on the endpoint's account.

### How webhooks find the account

- **Outbound** (`From=sip:<user>@…`): the SIP username identifies the agent and
  the account. The caller ID is the `X-VH-Caller-ID` header the panel puts on
  the INVITE, or else the number that agent selected. In account mode it must
  be on that account's list. A SIP user nobody has signed in as gets a polite
  `<Hangup/>`.
- **Inbound**: the webhook's `ParentAuthID` names the account, and its signed-in
  agents ring. Without it, the dialled number is matched against the signed-in
  accounts' numbers, then against SIP-direct agents' numbers. `<Dial callerId>`
  is the dialled number in E.164 (`0XXXXXXXXXX` becomes `+91XXXXXXXXXX`). No
  match means a polite `<Hangup/>` and one log line.

### After a restart

Accounts, sessions and the SIP-user map live in memory. Agents sign in again.
Their endpoints are reused, from `endpoints.json`. A recording link written into
a ServiceNow work note names its account and is HMAC-signed for it. Until
someone from that account signs in again after a restart, it answers "sign in
again" instead of playing.

---

## Quick start

```bash
npm start                                       # backend on :8092
npm run tunnel                                  # public HTTPS, writes backend/tunnel-url.txt
```

`cloudflared` must be on your PATH (`brew install cloudflared`,
`winget install --id Cloudflare.cloudflared -e`). The binary is deliberately not
committed.

Then **verify before touching ServiceNow**:

```bash
BASE=$(cat backend/tunnel-url.txt)

curl -s "$BASE/health"
curl -s -X POST "$BASE/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

The second must return VobizXML: `<Response>` with a `<Speak>` and `<Hangup/>`,
because nobody has signed in as `sip:x` (a signed-in agent's SIP user gets
`<Dial …><Number>`). Anything else, such as a tunnel error page or an ngrok
interstitial, means every call dies silently.

**If the tunnel hostname changed**, three things go stale together:

1. `PUBLIC_BASE_URL` in `backend/.env` (or `backend/tunnel-url.txt`, written for you)
2. each account's application — sign in again from the softphone, which finds or
   creates the application for the new `/answer` URL and rebinds the agent's
   endpoint; press **Enable inbound calls** again for the inbound number. SIP-direct
   customers update their application's answer URL in the Console.
3. `vobiz.calling.tunnel_url` in ServiceNow `sys_properties`, and the OpenFrame
   configuration URL

This is the single most common cause of "it stopped working".

---

## Making a call

**From the softphone.** Open the OpenFrame panel, sign in (either tab, see
above), pick the caller ID, allow the microphone, and **wait for the status to
read Ready**. That is the SIP registration landing; dialling before it rings the
customer into silence.

**From a record.** The **Call via Vobiz** UI Action on `sys_user` (or
`incident`, `sn_customerservice_case`) posts the record's number to
`/start-call`. The backend does not dial it: it hands the number to your open,
signed-in softphone, which places the call from the browser like any other —
so the panel must be open, signed in with the Vobiz account, and **Ready**
when you press the button. It requires
`vobiz.calling.shared_secret` to be set and to match `VOBIZ_SHARED_SECRET` in
`backend/.env`.

**Inbound.** Press **Enable inbound calls** once for the number, then call it. The softphone rings,
shows the caller, and Accept/Decline are wired to Enter/Escape.

---

## Reading the logs

The backend log is the honest account of what happened:

```
WEBHOOK /answer received: CallUUID=… From=sip:… To=+1…
  -> Browser is A-leg: dialing out to 91… as callerId=+91…
DIAL RESULT status=completed ring=true cause=NORMAL_CLEARING bleg=abc-123 dur=42
RECORDING READY call=… id=…
```

**`DialBLegUUID` is the single most useful field in this stack.** Present means
the call connected. Empty means no B leg was ever created, whatever the UI said.

Symptom-driven debugging lives in [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Security

This service holds, in memory, the Auth Token of every account signed in to it,
plus your ServiceNow instance credentials, and it is reachable from the internet because
Vobiz has to call its webhooks. It is built accordingly.

- **Recording playback is HMAC-signed with a short expiry.** The endpoint takes
  a recording *id*, resolves the media URL server-side, and refuses any host off
  an allowlist — before the request and again after every redirect. Never add a
  caller-supplied URL here: with account credentials attached, that hands them
  to whatever host is named.
- **`/agent` is session-gated** and serves only that session's own endpoint and
  the password set at that sign-in. `agents.json` holds display names only, and
  `endpoints.json` holds ids only.
- **Sign-in proves the credentials** against Vobiz, and the browser holds an
  opaque session token rather than the Auth Token. The token is never in an HTTP
  response, a log line or a file.
- **Recording links are account-scoped.** The HMAC covers the account and the id,
  so a link for one account's recording can never fetch another's.
- **CORS is an allowlist** — `*.service-now.com`, localhost, and anything in
  `ALLOWED_ORIGINS`.
- **`/health` reports whether things are configured, never what they are.**
- **`/start-call` requires the shared secret or an account session**, because
  it makes the agent's softphone place a billed call. It never dials from the
  backend.
- **In account mode, caller ID must be on the account's number list**, whether it
  comes from the dropdown or the `X-VH-Caller-ID` header.
- **A SIP-direct session covers that endpoint's own calls only.** Recordings,
  provisioning, caller-ID selection and click-to-call need an account sign-in.
  SIP direct cannot take over an endpoint that an account sign-in provisioned.

Two settings worth getting right before you go live: set `SIGNING_SECRET`
explicitly, or playback links stop working at every restart, and set
`VOBIZ_SHARED_SECRET` with the matching ServiceNow property, or the form button
cannot place calls.

Found a problem? `support@vobiz.ai` — see [SECURITY.md](SECURITY.md).

---

## Tests

```bash
npm test
```

Starts a backend against a mock Vobiz API and a mock ServiceNow Table API —
never your real `backend/.env` or instance — drives both call directions through
`/answer`, and signs in two unrelated fake accounts plus a SIP-direct endpoint.
It checks per-account provisioning, including the exact 17-digit app id in
the bind body. It checks that webhooks route to the right account, that a wrong
token is refused, that recording links are account-scoped and that no Auth Token
appears in any response or log. It also covers the CDR ledger, the
one-record-per-call write-back, the click-to-call hand-off and the security
properties above. It exits non-zero when any of that stops being true.

It does not place a real call. Before rolling out, make one outbound and one
inbound call on your own account and confirm two-way audio.

---

## Licence

MIT — see [LICENSE](LICENSE).
