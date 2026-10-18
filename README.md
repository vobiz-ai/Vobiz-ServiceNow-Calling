# Vobiz Calling for ServiceNow

Make and take phone calls inside ServiceNow with Vobiz. Your agents get a
softphone in the ServiceNow header (or in a browser tab), call customers from a
record with one click, talk through the browser, and every call is written to
the ServiceNow `interaction` table with a link to its recording.

You run a small Node.js backend that sits between ServiceNow, your agents'
browsers and Vobiz. Agents sign in to the softphone with their own Vobiz
account, so no Vobiz credentials live in the backend's configuration.

**Features**

- **Click-to-call from a record.** A **Call via Vobiz** button on user, contact,
  incident or case forms dials the record's number from the agent's softphone.
- **Softphone in ServiceNow.** The panel mounts in the Next Experience header
  through OpenFrame, with a dial pad, a caller-ID picker and a call timer.
- **Inbound calls.** Calls to your Vobiz number ring every signed-in agent of
  that account. The panel opens itself and shows the incoming caller ID, with
  Accept and Decline buttons (Enter and Escape on the keyboard).
- **Call logging.** Each call becomes one `interaction` record with direction,
  numbers, duration, the agent, and a recording link in the work notes.
- **Recordings.** Every call is recorded. Agents play recent recordings in the
  panel, and the interaction record links to the recording.
- **Caller-ID choice.** Agents pick which of the account's numbers their calls
  go out from.
- **Multi-agent and multi-account.** Each agent gets their own SIP endpoint.
  One backend can serve several Vobiz accounts.
- **Two ways to sign in.** With a Vobiz account (Auth ID and Auth Token), or
  with an existing SIP endpoint ("SIP direct").

Full documentation: <https://www.vobiz.ai/docs/integrations/servicenow>

---

## Contents

1. [How it works](#how-it-works)
2. [Requirements](#requirements)
3. [Quick start](#quick-start)
4. [Sign in](#sign-in)
5. [Using it](#using-it)
6. [Configuration reference](#configuration-reference)
7. [Deploying to production](#deploying-to-production)
8. [Security and privacy](#security-and-privacy)
9. [Troubleshooting](#troubleshooting)
10. [Limitations](#limitations)
11. [Development](#development)
12. [Support and links](#support-and-links)

---

## How it works

```
 ServiceNow                         Your backend                     Vobiz
 ──────────                         ────────────                     ─────
 "Call via Vobiz" button ──POST /start-call──▶ queues the number
 Softphone panel (OpenFrame) ◀──collects it── GET /dial-requests
 Softphone ───────────────── SIP over WebSocket (call) ──────────────▶ registrar
                                    /answer ◀──────── webhook ──────── Vobiz
                                    replies <Record> + <Dial> ───────▶ dials the customer
 interaction table ◀── Table API ── logs the call, adds the recording link
```

- The softphone is a WebRTC SIP phone that runs in the browser. It registers
  with Vobiz using an endpoint the backend creates for each agent.
- **Outbound:** the browser places the call. Vobiz asks your backend's `/answer`
  URL what to do, and the backend replies with VobizXML that records the call
  and dials the customer from the caller ID the agent chose.
- **Click-to-call:** the **Call via Vobiz** button runs on the ServiceNow
  server. It sends the record's phone number to your backend, and the agent's
  open softphone picks it up within two seconds and dials it.
- **Inbound:** Vobiz calls `/answer` for the incoming call, and the backend
  rings every signed-in agent of the account that owns the number.
- **Logging:** when a call ends, the softphone asks the backend to create the
  `interaction` record. When the recording is ready, Vobiz notifies the backend,
  which adds the recording link to the same record.
- **Recordings** are played through the backend with signed, expiring links.
  The browser never receives a Vobiz credential.

## Requirements

- **A Vobiz account** with:
  - its **Auth ID** and **Auth Token**, from the
    [Vobiz Console](https://console.vobiz.ai) dashboard under **API credentials**;
  - at least one active, voice-enabled phone number;
  - enough balance for calls.
- **A ServiceNow instance** where you are an administrator, with:
  - the **OpenFrame** plugin (`com.sn_openframe`) active, for the softphone panel;
  - the `interaction` table, where calls are logged;
  - a user for the backend that can create and update `interaction` records and
    read `sys_user`.
- **A public HTTPS URL for the backend.** Vobiz and ServiceNow must both reach
  it. For a trial, `cloudflared` gives you one in seconds
  (`brew install cloudflared`, or `winget install --id Cloudflare.cloudflared -e`).
- **Node.js 18 or newer.** The backend has no npm dependencies.
- **Agents need** a current Chrome, Edge or Firefox, a microphone, and
  permission for the softphone to use it.

## Quick start

1. **Get the code.**

   ```bash
   git clone https://github.com/vobiz-ai/Vobiz-ServiceNow-Calling.git
   cd Vobiz-ServiceNow-Calling
   ```

   There is nothing to install: the backend uses only Node's standard library.

2. **Configure the backend.** Copy the example file and fill in the deployment
   settings. Nothing about your Vobiz account goes here.

   ```bash
   cp backend/.env.example backend/.env
   openssl rand -hex 32    # run twice: one value for each secret below
   ```

   ```env
   PORT=8092
   PUBLIC_BASE_URL=https://calling.example.com     # leave out when using npm run tunnel
   SERVICENOW_INSTANCE_URL=https://your-instance.service-now.com
   SERVICENOW_USER=vobiz.integration
   SERVICENOW_PASSWORD=your-integration-user-password
   VOBIZ_SHARED_SECRET=<first random value>
   SIGNING_SECRET=<second random value>
   ```

3. **Start the backend.**

   ```bash
   npm start            # listens on http://localhost:8092
   ```

4. **Give it a public HTTPS address.** Either put it behind your own HTTPS
   reverse proxy and set `PUBLIC_BASE_URL`, or, for a trial, run a quick tunnel
   in a second terminal:

   ```bash
   npm run tunnel       # writes the tunnel's URL to backend/tunnel-url.txt
   ```

   The backend reads `backend/tunnel-url.txt` automatically when
   `PUBLIC_BASE_URL` is not set.

5. **Check it from outside.**

   ```bash
   BASE=https://calling.example.com     # or: BASE=$(cat backend/tunnel-url.txt)
   curl -s "$BASE/health"
   curl -s -X POST "$BASE/answer" -d "From=sip:test@registrar.vobiz.ai&To=91XXXXXXXXXX"
   ```

   The first returns `{"ok":true,...}` with `"publicBaseConfigured":true`. The
   second returns a short VobizXML `<Response>` that says the phone is not
   signed in and hangs up. That is correct: nobody has signed in yet. An HTML
   error page instead means Vobiz cannot reach your backend either.

6. **Create two system properties in ServiceNow.** Go to **System Properties →
   All Properties** (`sys_properties.list`) and click **New** for each:

   | Name | Type | Value |
   | --- | --- | --- |
   | `vobiz.calling.tunnel_url` | `string` | Your backend's public URL, for example `https://calling.example.com`, with no trailing slash |
   | `vobiz.calling.shared_secret` | `password2` | The same value as `VOBIZ_SHARED_SECRET` |

   Use `password2` for the secret, not `string`: anyone who can list system
   properties can read a string property.

7. **Create the "Call via Vobiz" button.** Go to **System Definition → UI
   Actions → New**:

   - **Name:** `Call via Vobiz`
   - **Table:** `User [sys_user]` (repeat for `Contact [customer_contact]`,
     `Incident [incident]` or `Case [sn_customerservice_case]` if you want the
     button there too)
   - **Form button:** checked. **Client:** unchecked. **Active**, **Show
     insert** and **Show update:** checked.
   - **Script:** paste the whole of
     [`servicenow-app/ui-actions/call_via_vobiz.js`](servicenow-app/ui-actions/call_via_vobiz.js).
     You do not need to edit it; it reads both properties at run time.

8. **Add the softphone panel.** Go to **OpenFrame → Configurations → New**:

   | Field | Value |
   | --- | --- |
   | Name | `Vobiz Softphone` |
   | Title | `Vobiz Calling` |
   | URL | `https://calling.example.com/agent-phone.html?instance=your-instance&agentId=<ServiceNow user name>` |
   | Width / Height | `380` / `560` |
   | User group | The agents who should see it |
   | Active | checked |

   `instance` is the `your-instance` part of `your-instance.service-now.com`.
   Read [Agent identity](#agent-identity) before choosing `agentId`.
   [`servicenow-app/openframe/openframe_config.md`](servicenow-app/openframe/openframe_config.md)
   has the same steps.

9. **Sign in and call.** Open the panel from the ServiceNow header, sign in (see
   [Sign in](#sign-in)), allow the microphone, and wait for the badge to read
   **READY**. Then type a number and press **Call**, or press **Call via Vobiz**
   on a record.

## Sign in

The softphone has two tabs: **Vobiz account** and **SIP direct**.

### Vobiz account (recommended)

Enter the account's **Auth ID** (it looks like `MA_XXXXXXXX`) and **Auth
Token**, and press **Log in**. The backend checks them with Vobiz, then sets up
everything the account needs:

- **An application** named **ServiceNow Calling (Vobiz)**, with its answer URL
  and hangup URL set to `<your backend>/answer` (POST). If the account already
  has an application with exactly that answer URL, it is reused. No other
  application is changed.
- **One SIP endpoint per agent**, attached to that application. It is reused at
  every later sign-in, and each sign-in gives it a new random password that only
  that browser session receives.
- **The caller-ID list.** **Choose a caller ID** lists every active,
  voice-enabled number on the account, and shows which application each one is
  attached to now. Outgoing calls can only use a number on this list.

Your Auth Token never leaves the backend and is never stored on disk. The
browser gets a session token instead, which expires after 12 hours.

#### Enable inbound calls

Calls to your number reach the softphone only after you route them there. Pick
the number under **Choose a caller ID**, then press **Enable inbound calls**
under **Receive calls here**.

This attaches the number to the **ServiceNow Calling (Vobiz)** application.
**A number answers to one application at a time**, so this moves the number off
the application it was attached to before, and calls stop going there. Before
you press the button, the panel says what will happen ("Enabling moves
+91XXXXXXXXXX off application 12345678901234567"); afterwards it confirms where
the number was moved from. Nothing else ever attaches a number: not sign-in, and
not restarting the backend.

### SIP direct

Use this when you already have a Vobiz SIP endpoint and do not want to give the
backend an Auth Token. Enter the endpoint's **SIP username** and **SIP
password**, and under **Calling from** a number on the same Vobiz account in
international format (`+91XXXXXXXXXX`). Press **Connect**.

The browser registers with Vobiz using the password directly. The backend never
receives the password and holds no account credentials; it only remembers which
caller ID this endpoint uses, and that calls to that number ring it. You can tick
**Remember the username and caller ID**; the password is never stored.

**Before you use SIP direct**, attach the endpoint and the number to an
application whose answer URL is your backend.

In the Vobiz Console:

1. **Voice → Applications → New.** Set **Answer URL** and **Hangup URL** to
   `https://calling.example.com/answer`, method **POST**.
2. **Voice → Endpoints**, open your endpoint, and choose that application.
3. Open the phone number and attach the same application.

Or with the API:

```bash
AUTH_ID=MA_XXXXXXXX
AUTH_TOKEN=your-auth-token
BASE=https://calling.example.com
API="https://api.vobiz.ai/api/v1/Account/$AUTH_ID"
H=(-H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json")

# 1. Create the application. Note the app_id in the response.
curl -X POST "$API/Application/" "${H[@]}" -d '{
  "app_name": "ServiceNow Calling (Vobiz)",
  "answer_url": "'"$BASE"'/answer", "answer_method": "POST",
  "hangup_url": "'"$BASE"'/answer", "hangup_method": "POST"}'

# 2. Attach the endpoint. Send app_id as a string: it is too long for a JSON number.
curl -X POST "$API/Endpoint/$ENDPOINT_ID/" "${H[@]}" -d '{"app_id": "'"$APP_ID"'"}'

# 3. Route the number. Write the + as %2B.
curl -X POST "$API/numbers/%2B91XXXXXXXXXX/application" "${H[@]}" \
  -d '{"application_id": "'"$APP_ID"'"}'
```

**Not available in SIP direct:** the caller-ID list, **Enable inbound calls**,
the recordings list and recording links, and the **Call via Vobiz** button.
These need the account's API access, so the panel says "Sign in with your Vobiz
account to use this." Calls are still recorded in your Vobiz account and logged
to ServiceNow, without a recording link.

An endpoint that the backend created for a Vobiz-account sign-in cannot be used
with SIP direct.

### Agent identity

The softphone identifies the agent by the `agentId` in its URL. This matters in
three places:

- **Each `agentId` gets its own SIP endpoint.** Two agents with the same
  `agentId` share one endpoint, and each sign-in resets the other's password,
  so the other agent's panel drops out of **READY**.
- **Call via Vobiz** finds the agent's panel by the ServiceNow user name of the
  person who pressed the button. It reaches your panel only if your `agentId`
  is your ServiceNow user name.
- **Call logging** assigns the interaction to the ServiceNow user whose user
  name equals the `agentId`.

So set `agentId` to the agent's ServiceNow user name. An OpenFrame configuration
has one URL for everyone in its user group, so for several agents either create
one configuration per agent (each for a group that contains only that agent), or
have agents open the softphone in a browser tab at their own URL. Without an
`agentId`, the browser makes up its own id and keeps it; calling and inbound
work, but interactions are not assigned to the agent, and **Call via Vobiz**
cannot reach the panel: the button rings only a panel signed in as the person
who pressed it, never another agent's.

## Using it

### Make a call

1. Wait for the badge to read **READY**. The **Call** button stays disabled
   until then.
2. Pick the caller ID under **Choose a caller ID** (Vobiz account sign-in only).
3. Type the number in international format, such as `+91XXXXXXXXXX`, and press
   **Call** or Enter.
4. Press **Hang up** to end the call.

### Call from a record

Open a user, contact, incident or case and press **Call via Vobiz**. The button
uses the record's **Mobile phone**, then **Phone**, then **Business phone**. On an
incident it calls the **Caller**; on a case, the **Contact**.

Your softphone must be open, signed in with a Vobiz account, and **READY** when
you press the button. ServiceNow shows "Calling +91XXXXXXXXXX from your Vobiz
panel." and the panel dials within two seconds. If the panel is already on a
call, it does not dial. A request no panel collects expires after 30 seconds.

Only your own panel is rung: one whose `agentId` is your ServiceNow user name.
If you have none open, ServiceNow shows "<your user name> has no Vobiz panel
open" and nothing is dialled, even if other agents' panels are open.

The call's interaction names the record you pressed the button on ("Started
from: incident <sys_id>"), and the backend adds a work note to that record
naming the interaction. Tables without work notes, such as `sys_user`, get no
note.

If your instance sends OpenFrame communication events when an agent clicks a
phone number, the panel dials those too.

### Receive a call

After **Enable inbound calls**, a call to the number rings every agent of that
account who is signed in. The panel opens, plays a ring tone, and shows the
customer's number (the backend passes it as the call's caller name, because the
SIP caller ID has to be your own number). Press **Accept** or Enter to answer, **Decline** or Escape
to reject. If nobody from the account is signed in, the caller hears "Sorry, no
one is available to take your call right now" and the call ends.

### Call logging

When a call ends, the softphone tells the backend, which creates one record in
the ServiceNow `interaction` table through the Table API:

| Field | Value |
| --- | --- |
| `type` | `phone` |
| `state` | `closed_complete` |
| `short_description` | `Vobiz Outbound Call: +91XXXXXXXXXX` (or `Inbound`) |
| `opened_at`, `closed_at` | Start and end of the call, worked out from its duration |
| `assigned_to` | The ServiceNow user whose user name equals the agent's `agentId`. If none matches, the work notes name the agent instead |
| `work_notes` | Direction, from, to, duration in seconds, a **Listen to Recording** link, and a note |
| `recording_url` | The recording link, if your `interaction` table has this field |

When the recording is ready, the backend updates the same record: it fills
`recording_url` and adds a work note with the recording link.

An inbound call rings several agents but is logged once. The backend learns from
Vobiz which panel answered, and only that panel's report is logged, assigned to
that agent; the panels that only rang are ignored. A call nobody answers is
logged once by the backend as `Vobiz Missed Inbound Call`, with 0 seconds and no
agent.

Logging needs `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USER` and
`SERVICENOW_PASSWORD`. If any is missing, calls work but nothing is logged.

### Recordings

Every call is recorded, as MP3, for up to an hour. The **Call recordings**
section of the panel lists the account's 10 most recent recordings with a
player; press the refresh icon to reload it.

Recording links, in the panel and in work notes, play through your backend.
Each link is signed for one recording on one account. Links the panel plays
expire after `RECORDING_URL_TTL_SECONDS` (300 seconds by default); links written
into interaction work notes expire after `RECORD_LINK_TTL_SECONDS` (7 days by
default). After that, play the call from the panel.

## Configuration reference

The backend reads `backend/.env` at startup. Variables already set in the
environment take precedence.

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | Yes, unless you use `npm run tunnel` | Contents of `backend/tunnel-url.txt` | Public HTTPS address of the backend, without a trailing slash. The answer URL Vobiz calls is `<PUBLIC_BASE_URL>/answer`. Sign-in fails until this is an `https://` URL. `PUBLIC_BASE` and `TUNNEL_URL` are accepted as alternative names |
| `PORT` | No | `8092` | Port the backend listens on |
| `VOBIZ_SHARED_SECRET` | Yes, for **Call via Vobiz** | none | Must equal the `vobiz.calling.shared_secret` property. Without it the button is refused. `SHARED_SECRET` is accepted as an alternative name |
| `SIGNING_SECRET` | Yes, in production | Random at each start | Signs recording links. If unset, every link stops working when the backend restarts |
| `RECORDING_URL_TTL_SECONDS` | No | `300` | How long a recording link the panel plays stays valid, in seconds |
| `RECORD_LINK_TTL_SECONDS` | No | `604800` (7 days) | How long a recording link written into a ServiceNow interaction stays valid, in seconds |
| `SERVICENOW_INSTANCE_URL` | Yes, for call logging | none | Your instance, such as `https://your-instance.service-now.com` |
| `SERVICENOW_USER` | Yes, for call logging | none | ServiceNow user the backend logs calls as |
| `SERVICENOW_PASSWORD` | Yes, for call logging | none | That user's password (HTTP basic authentication) |
| `DATA_DIR` | No | `backend/data` | Where the backend keeps `endpoints.json`, the map of which SIP endpoint belongs to which agent on which account |
| `ALLOWED_ORIGINS` | No | none | Extra browser origins allowed to call the backend, comma-separated. `https://*.service-now.com` and `localhost` are always allowed |
| `VOBIZ_API_URL` | No | `https://api.vobiz.ai` | Vobiz API base URL. Leave the default |
| `VOBIZ_REGISTRAR` | No | `registrar.vobiz.ai` | Vobiz SIP registrar. The backend serves it to the softphone, which registers and places calls through it. Leave the default unless Vobiz gives you another |
| `ENV_FILE` | No | `backend/.env` | Load settings from a different file. Set it in the environment, not in `.env` |

`backend/agents.json` optionally sets a display name for each `agentId`:

```json
{ "jane.doe": { "displayName": "Jane Doe" } }
```

ServiceNow reads two system properties: `vobiz.calling.tunnel_url` (your
backend's public URL) and `vobiz.calling.shared_secret` (equal to
`VOBIZ_SHARED_SECRET`). See
[`servicenow-app/sys_properties/properties_guide.md`](servicenow-app/sys_properties/properties_guide.md).

## Deploying to production

- **Use a stable HTTPS hostname** behind a reverse proxy or load balancer, and
  set `PUBLIC_BASE_URL`. A quick tunnel gets a new hostname every time it
  starts. When the hostname changes, update `PUBLIC_BASE_URL`, the
  `vobiz.calling.tunnel_url` property and the OpenFrame URL; have agents sign in
  again so the application is set up for the new answer URL; and press **Enable
  inbound calls** again.
- **Run exactly one instance.** Sessions, signed-in accounts and in-progress
  calls are held in memory, so a second instance behind a load balancer would
  not know about calls the first one started.
- **Keep `DATA_DIR` on persistent storage.** It lets agents get the same SIP
  endpoint after a restart or redeploy instead of a new one each time.
- **Set `SIGNING_SECRET` and `VOBIZ_SHARED_SECRET`** to long random values
  (`openssl rand -hex 32`), and keep `backend/.env` out of version control.
- **Restarts sign everyone out.** Plan restarts outside working hours; agents
  sign in again afterwards.
- **Use a dedicated ServiceNow user** for `SERVICENOW_USER`, with only the
  access it needs: create and update on `interaction`, read on `sys_user`.
- **Keep your ServiceNow artifacts in an update set.** Create the two system
  properties, the UI Action and the OpenFrame configuration in an update set on
  a sub-production instance, then move it to production.
- If you serve the softphone from a domain other than `*.service-now.com` or
  your backend, add it to `ALLOWED_ORIGINS`.

## Security and privacy

- **Your Auth Token stays on the backend.** It is checked with Vobiz at sign-in,
  kept in memory only, and never logged, written to disk or sent to the browser.
- **Nothing secret is stored on disk.** `endpoints.json` holds endpoint ids and
  SIP usernames only, with file mode 0600. `backend/.env` holds your ServiceNow
  credentials and the two secrets.
- **The browser receives** a session token, the Auth ID, the account's phone numbers, and the
  SIP username and password of its own endpoint, which change at every sign-in.
  In SIP direct, the password the agent types stays in the browser.
- **Recording links are signed and expire.** Each link works for one recording
  on one account until it expires. The backend fetches audio only from Vobiz
  hosts, and never from an address supplied in a request.
- **Click-to-call is authenticated and per agent.** `/start-call` requires the
  shared secret from ServiceNow or a signed-in session, and rings only a panel
  signed in as the requesting agent, never another agent's or another account's. Outgoing caller IDs must be numbers on
  the signed-in account.
- **Only allowed origins** (`*.service-now.com`, `localhost` and
  `ALLOWED_ORIGINS`) can call the backend from a browser.
- **`/health` shows only counts** and whether settings are present, never
  account ids, numbers or usernames.
- **Webhooks are not signature-checked.** The backend acts on a Vobiz webhook
  only for SIP users and numbers of accounts signed in to it.
- **Recordings are visible across the account.** Any agent signed in with an
  account sees that account's recent recordings in the panel, and anyone who can
  read an interaction's work notes can play its recording until the link
  expires (`RECORD_LINK_TTL_SECONDS`, 7 days by default).

To report a security issue, see [SECURITY.md](SECURITY.md).

## Troubleshooting

The backend log shows each call: `WEBHOOK /answer received`, then the dial
result (`DIAL RESULT status=... bleg=...`) and `RECORDING READY`. If `bleg` is
`(none)`, the customer's leg was never created.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Sign-in says "Vobiz did not accept this Auth ID and Auth Token" | Wrong or mistyped credentials | Copy both from the Vobiz Console under **API credentials** |
| Sign-in says "Could not reach Vobiz to check these credentials" | The backend cannot reach `api.vobiz.ai` | Check the backend host's outbound internet access |
| Sign-in says "This backend has no public HTTPS address" | `PUBLIC_BASE_URL` is unset and no tunnel is running | Set `PUBLIC_BASE_URL` to an `https://` URL, or run `npm run tunnel` |
| Sign-in says "could not set up calling on this account" | Vobiz refused to create the application or the endpoint | The message names the step. Check the account is active and try again |
| Caller-ID list says "No numbers found on this account" | The account has no active, voice-enabled number | Buy or activate a number in the Console, then sign in again |
| Badge never reads **READY**, or shows "Registration failed" | The browser cannot reach the registrar (`registrar.vobiz.ai`, or `VOBIZ_REGISTRAR`) on port 5063, or another panel signed in with the same `agentId` | Allow secure WebSockets to `registrar.vobiz.ai:5063` through your network, and give each agent their own `agentId` |
| "No microphone access" or "Microphone permission was denied" | The page is not served over HTTPS, or the browser blocked the microphone | Open the panel over HTTPS and allow the microphone. If the ServiceNow frame blocks it, open the softphone URL in its own tab |
| SIP direct never reaches **READY** | Wrong SIP username or password | Check the endpoint's credentials in the Console |
| Outbound call ends at once with "This phone is not signed in" | The backend restarted, or the session expired | Sign in again |
| Call via Vobiz: "Status 401" | `vobiz.calling.shared_secret` is empty or differs from `VOBIZ_SHARED_SECRET` | Set both to the same value |
| Call via Vobiz: "Status 409 ... <user> has no Vobiz panel open" | You have no softphone open and signed in with a Vobiz account, or your panel's `agentId` is not your ServiceNow user name | Open the panel, sign in on **Vobiz account**, wait for **READY**, press the button again. See [Agent identity](#agent-identity) |
| Call via Vobiz: "set the system property 'vobiz.calling.tunnel_url'" | Property missing or not `https://` | Create it with your backend's public URL |
| Calls to your number are not answered, or reach another system | The number is not attached to this integration's application | Sign in and press **Enable inbound calls** for that number |
| Caller hears "no one is available" | Nobody from that account is signed in | Have an agent sign in and wait for **READY** |
| Everything stopped after a restart of the tunnel | The quick-tunnel hostname changed | Update the property and OpenFrame URL, sign in again, press **Enable inbound calls** again |
| No interaction records appear | ServiceNow settings missing, or the user lacks access | Set all three `SERVICENOW_*` variables; the backend log shows `ServiceNow refused the interaction (HTTP 403)` if access is missing |
| Recording link says "invalid or has expired" | A work-note link is older than `RECORD_LINK_TTL_SECONDS` (7 days), or `SIGNING_SECRET` changed | Play the call from the panel; set `SIGNING_SECRET`, or raise `RECORD_LINK_TTL_SECONDS` |
| Recording link asks you to sign in again | The backend restarted and nobody from that account has signed in since | Sign in with that account, then open the link |
| One-way or no audio | The network blocks the media path | Try another network; allow WebRTC media (UDP) through your firewall |

More detail: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Limitations

- **Restarting the backend signs everyone out.** Agents must sign in again, and
  recording links for an account play only after someone from it signs in.
- **Run one backend instance.** State is held in memory.
- **Sessions last 12 hours**, after which agents sign in again.
- **Recording links in work notes expire** after `RECORD_LINK_TTL_SECONDS`
  (7 days by default). Raising it keeps them playable longer, for anyone who
  can see the work note.
- **SIP direct** has no caller-ID list, inbound setup, recording playback or
  **Call via Vobiz**.
- **Call via Vobiz needs the agent's panel open and READY**, and reaches the
  panel only when `agentId` is the agent's ServiceNow user name.
- **The source record is linked by a work note**, not a reference field on the
  interaction, and only on tables that have work notes.
- **One call at a time** per panel. There is no hold, transfer or mute.
- **Limits per call:** 30 seconds of ringing, 4 hours of talk, and 1 hour of
  recording.

## Development

```bash
npm test             # runs the suite against a mock Vobiz API and a mock ServiceNow
npm start            # backend on :8092
npm run tunnel       # Cloudflare quick tunnel; needs cloudflared on your PATH
```

The suite never reads your `backend/.env` and never places a real call. CI also
checks that no credentials are committed.

```
agent-phone/            the softphone (HTML, CSS, JavaScript, vendored JsSIP)
backend/server.js       the backend: webhooks, sign-in, recordings, ServiceNow logging
backend/tunnel.js       starts a Cloudflare quick tunnel
backend/test-harness.js the test suite
backend/agents.json     optional display names per agentId
servicenow-app/         the UI Action script, system properties and OpenFrame setup
docs/                   architecture, HTTP API reference and troubleshooting
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Support and links

- Vobiz documentation: <https://www.vobiz.ai/docs>
- This integration: <https://www.vobiz.ai/docs/integrations/servicenow>
- HTTP API: [docs/API_SPECIFICATION.md](docs/API_SPECIFICATION.md)
- Support: `support@vobiz.ai`

## License

MIT. See [LICENSE](LICENSE).
