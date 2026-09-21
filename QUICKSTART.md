# Quick start

Fifteen minutes, assuming a Vobiz account with a DID and a SIP endpoint, and a
ServiceNow instance you can administer.

The long version, including the OpenFrame panel, is
[`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md).

---

## 1. Configure

```bash
cp backend/.env.example backend/.env
```

The four that matter most:

| Variable | Why |
| --- | --- |
| `VOBIZ_AUTH_ID` / `VOBIZ_AUTH_TOKEN` | The account calls are billed to |
| `VOBIZ_SIP_USER` / `VOBIZ_SIP_PASSWORD` | The endpoint the softphone registers as |
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

The second must return `<Response>` containing `<Dial …><Number>`. A tunnel error
page here means every call will die silently.

## 4. Point Vobiz at it

Sign in to the softphone at `$BASE/` and press **Configure inbound**, or
`POST /setup` with the session token. Either binds your DID and SIP endpoint to
an application whose `answer_url` is this server.

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
number.

---

## When it does not work

- Nothing in the log when you call the DID → Vobiz is calling a stale hostname.
  Re-run step 4.
- `401` from the form button → `vobiz.calling.shared_secret` is empty or does
  not match `.env`.
- Status never reads Ready → [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md),
  which is organised by symptom.
