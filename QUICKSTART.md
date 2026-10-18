# Quick start

Fifteen minutes, assuming a Vobiz account with a number and a ServiceNow
instance you can administer. Nothing about the Vobiz account goes into the
backend's configuration: agents sign in from the softphone, and any Vobiz
account works.

The long version, including the OpenFrame panel, is
[`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md).

---

## 1. Configure

```bash
cp backend/.env.example backend/.env
```

Deployment settings only:

| Variable | Why |
| --- | --- |
| `PUBLIC_BASE_URL` | This backend's public HTTPS address. Leave unset to use the tunnel's |
| `SERVICENOW_INSTANCE_URL` / `_USER` / `_PASSWORD` | Where call records are written |
| `VOBIZ_SHARED_SECRET` | Required by the ServiceNow form button. `openssl rand -hex 32` |
| `SIGNING_SECRET` | Signs recording links. Unset, it changes on every restart and old links die |

## 2. Run

```bash
npm start          # backend on :8092
npm run tunnel     # public HTTPS, in a second shell
```

`cloudflared` must be on your PATH — `brew install cloudflared`, or
`winget install --id Cloudflare.cloudflared -e`. The tunnel writes its hostname
to `backend/tunnel-url.txt`, which the backend reads; you do not need to paste
it anywhere in the code.

## 3. Verify before touching ServiceNow

```bash
BASE=$(cat backend/tunnel-url.txt)

curl -s "$BASE/health"
curl -s -X POST "$BASE/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

The second must return VobizXML: `<Response>` with `<Hangup/>`, because nobody is
signed in as `sip:x`. A tunnel error page here means every call will die
silently.

## 4. Point Vobiz at it

Open the softphone at `$BASE/` and sign in on the **Vobiz account** tab with
your Auth ID and Auth Token. Sign-in creates (or finds) an application whose
`answer_url` is this server, plus a SIP endpoint for you bound to it, and fills
the caller-ID dropdown with your account's numbers. For inbound calls, pick the
number and press **Enable inbound calls**. This moves the number off any other
application, and the panel says which one.

Already have an endpoint? The **SIP direct** tab takes its SIP username,
password and a caller ID instead. Bind that endpoint and number to an
application whose answer URL is `$BASE/answer` first; the README has the
Console steps and the API calls.

## 5. ServiceNow

Two system properties (`sys_properties.list`):

| Name | Type | Value |
| --- | --- | --- |
| `vobiz.calling.tunnel_url` | `string` | `$BASE`, no trailing slash |
| `vobiz.calling.shared_secret` | `password2` | the same value as `VOBIZ_SHARED_SECRET` |

Then create the UI Action — **System Definition → UI Actions → New**, name
`Call via Vobiz`, table `User [sys_user]`, form button checked, client
unchecked — and paste
[`servicenow-app/ui-actions/call_via_vobiz.js`](servicenow-app/ui-actions/call_via_vobiz.js)
into the Script field. **Nothing in that script needs editing**: it reads both
properties at runtime, which is the point of them.

For the softphone inside ServiceNow rather than a browser tab, follow
[`servicenow-app/openframe/openframe_config.md`](servicenow-app/openframe/openframe_config.md).

## 6. Make a call

Open the softphone, sign in, allow the microphone, and **wait for Ready** — that
is the SIP registration landing, and dialling before it rings the customer into
silence. Then dial, or press **Call via Vobiz** on a user record with a phone
number: the button hands the number to your open panel, which places the call.

---

## When it does not work

- Nothing in the log when you call the number → Vobiz is calling a stale
  hostname, or inbound was never enabled. Sign in again and press **Enable
  inbound calls**.
- `401` from the form button → `vobiz.calling.shared_secret` is empty or does
  not match `.env`.
- `409` from the form button → no softphone is open and signed in on the
  Vobiz account tab. Open the panel, sign in, wait for Ready, press the button again.
- Status never reads Ready → [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md),
  which is organised by symptom.
