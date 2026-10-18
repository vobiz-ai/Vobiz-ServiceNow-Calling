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
| `backend/server.js` | Answers Vobiz webhooks, serves the softphone, holds credentials, brokers the Vobiz REST API, writes to ServiceNow |
| `backend/tunnel.js` | Starts a Cloudflare quick tunnel and records its hostname |
| `servicenow-app/openframe/` | How to mount the softphone in the Next Experience header |
| `servicenow-app/ui-actions/` | The **Call via Vobiz** form button — server-side, uses `sn_ws.RESTMessageV2` |
| `servicenow-app/sys_properties/` | The two properties the UI Action reads, instead of hardcoded URLs |

The backend writes the interaction record itself, over the ServiceNow Table API,
using the instance credentials in `.env`. So the ServiceNow user you configure
there needs write access to the `interaction` table.

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

The second must return `<Response>` containing `<Dial …><Number>`. Anything else
— a tunnel error page, an ngrok interstitial — and every call dies silently.

**If the tunnel hostname changed**, three things go stale together:

1. `TUNNEL_URL` in `backend/.env` (or `backend/tunnel-url.txt`, written for you)
2. the Vobiz application's `answer_url` — re-run `POST /setup` with a session
3. `vobiz.calling.tunnel_url` in ServiceNow `sys_properties`, and the OpenFrame
   configuration URL

This is the single most common cause of "it stopped working".

---

## Making a call

**From the softphone.** Open the OpenFrame panel, sign in — either with the
Vobiz Auth ID and Auth Token, or with a SIP endpoint username, password and a
caller ID the account owns — allow the microphone, and **wait for the status to
read Ready**. That is the SIP registration landing; dialling before it rings the
customer into silence.

**From a record.** The **Call via Vobiz** UI Action on `sys_user` (or
`incident`, `sn_customerservice_case`) posts the record's number to
`/start-call`. The backend does not dial it: it hands the number to your open,
signed-in softphone, which places the call from the browser like any other —
so the panel must be open and **Ready** when you press the button. It requires
`vobiz.calling.shared_secret` to be set and to match `VOBIZ_SHARED_SECRET` in
`backend/.env`.

**Inbound.** Call the DID bound to the Vobiz application. The softphone rings,
shows the caller, and Accept/Decline are wired to Enter/Escape.

---

## Reading the logs

The backend log is the honest account of what happened:

```
WEBHOOK /answer received: {"From":"sip:…","To":"91…","RouteType":"sip"}
  -> Browser is A-leg: dialing out to 91… as callerId=+91…
DIAL RESULT status=completed ring=true cause=NORMAL_CLEARING bleg=abc-123 dur=42
RECORDING READY call=… id=…
```

**`DialBLegUUID` is the single most useful field in this stack.** Present means
the call connected. Empty means no B leg was ever created, whatever the UI said.

Symptom-driven debugging lives in [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Security

This service holds your Vobiz Auth Token, a SIP endpoint password and your
ServiceNow instance credentials, and it is reachable from the internet because
Vobiz has to call its webhooks. It is built accordingly.

- **Recording playback is HMAC-signed with a short expiry.** The endpoint takes
  a recording *id*, resolves the media URL server-side, and refuses any host off
  an allowlist — before the request and again after every redirect. Never add a
  caller-supplied URL here: with account credentials attached, that hands them
  to whatever host is named.
- **`/agent` is session-gated**, and `agents.json` carries no passwords. SIP
  credentials let anyone place calls billed to the account.
- **Sign-in proves the credentials** against Vobiz, and the browser holds an
  opaque session token rather than the Auth Token.
- **CORS is an allowlist** — `*.service-now.com`, localhost, and anything in
  `ALLOWED_ORIGINS`.
- **`/health` reports whether things are configured, never what they are.**
- **`/start-call` requires the shared secret or an account session**, because
  it makes the agent's softphone place a billed call. It never dials from the
  backend.
- **Caller ID must be a number the account owns**, at SIP-direct sign-in and
  whenever it is changed.
- **A SIP-direct session covers that agent's own calls only.** Account
  recordings, provisioning, caller-ID selection and click-to-call need an
  account sign-in.

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
`/answer`, checks the CDR ledger, the one-record-per-call write-back, application
provisioning and the click-to-call hand-off, and asserts the security
properties above. It exits non-zero when any of that stops being true.

It does not place a real call. Before rolling out, make one outbound and one
inbound call on your own account and confirm two-way audio.

---

## Licence

MIT — see [LICENSE](LICENSE).
