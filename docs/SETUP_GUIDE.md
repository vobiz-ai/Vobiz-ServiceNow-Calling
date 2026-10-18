# Vobiz ServiceNow Calling Bridge: Setup Guide

This guide walks you through setting up the **Vobiz ServiceNow Calling Bridge** from scratch.

---

## 1. Prerequisites

1. **Node.js 18+** installed on your workstation or host server.
2. A **Vobiz account** with at least one active, voice-enabled number. Its
   Auth ID and Auth Token are typed into the softphone by the agent. They are
   not configured on the backend, and any Vobiz account can sign in.
3. A **ServiceNow Instance** (Personal Developer Instance - PDI or enterprise instance).
4. **Cloudflared** CLI (or any public tunneling solution / reverse proxy).

---

## 2. Backend Bridge Configuration

1. In the repository, navigate to the `backend/` directory:
   ```bash
   cd backend
   cp .env.example .env
   ```

2. Open `backend/.env`. It holds deployment settings only. There is no
   Vobiz Auth ID, Auth Token, SIP user, SIP password or caller-ID number here:
   ```env
   PORT=8092
   # Public HTTPS address; unset = the tunnel's hostname (backend/tunnel-url.txt)
   # PUBLIC_BASE_URL=https://calling-bridge.example.com
   # DATA_DIR=./backend/data                    # endpoint ids per account+agent, mode 0600

   VOBIZ_SHARED_SECRET=your_secret_token_here   # required by the ServiceNow form button
   SIGNING_SECRET=your_recording_hmac_secret    # set it, or playback links die on restart
   ALLOWED_ORIGINS=                             # extra CORS origins, comma-separated

   # ServiceNow Instance Configuration (for automatic CDR & Recording logging)
   SERVICENOW_INSTANCE_URL=https://dev12345.service-now.com
   SERVICENOW_USER=admin
   SERVICENOW_PASSWORD=your_instance_admin_password
   ```

3. Optionally set display names in `backend/agents.json`, keyed by the agent id
   the softphone signs in with:
   ```json
   {
     "admin": { "displayName": "ServiceNow Admin" }
   }
   ```
   Never put a password or SIP identity in this file. Each agent's SIP endpoint
   is created on their account at sign-in, with a fresh password served only to
   that browser session.

---

## 3. Starting the Bridge & Tunnel

You can start the backend and tunnel easily using the provided scripts:

```bash
# Start backend server
node backend/server.js

# In a separate terminal, launch cloudflared tunnel
node backend/tunnel.js
```

The tunnel will capture your public HTTPS URL (e.g. `https://random-subdomain.trycloudflare.com`) and write it into `backend/tunnel-url.txt`.

---

## 4. ServiceNow Instance Setup

### Step 4.1: Configure System Properties
In ServiceNow Filter Navigator, go to **System Properties** > **All Properties** (`sys_properties.list`) and create the following properties:

1. **`vobiz.calling.tunnel_url`**
   - **Type**: `string`
   - **Value**: Your public tunnel URL (e.g. `https://random-subdomain.trycloudflare.com`)
   - **Description**: Public HTTPS endpoint of the Vobiz ServiceNow Bridge.

2. **`vobiz.calling.shared_secret`** (**Required** for the form button)
   - **Type**: `password2` — not `string`. As a string it is readable by anyone
     who can list `sys_properties`.
   - **Value**: the same secret as `VOBIZ_SHARED_SECRET` in `backend/.env`.
   - **Description**: Symmetric authentication secret between ServiceNow and the bridge.

   `/start-call` makes the agent's softphone place a billed call, so it is not open. With this property
   empty the UI Action sends no header and the bridge answers `401`. Generate
   one with `openssl rand -hex 32`.

### Step 4.2: Create the UI Action (Form Button)
1. Go to **System Definition** > **UI Actions**.
2. Click **New**:
   - **Name**: `Call via Vobiz`
   - **Table**: `User [sys_user]` (or `Contact [customer_contact]`, `Incident [incident]`)
   - **Form button**: `true` (checked)
   - **Active**: `true` (checked)
   - **Show insert**: `true`
   - **Show update**: `true`
   - **Client**: `false` (unchecked)
3. Paste the contents of `servicenow-app/ui-actions/call_via_vobiz.js` into the **Script** box.
4. Click **Submit**.

---

## 5. Agent Browser Softphone

Open the softphone — in the OpenFrame panel, or in a browser tab:
```
https://<your-bridge-url>/agent-phone.html?agentId=<your ServiceNow user name>
```
Pass a distinct `agentId` per agent. Each (account, agent id) pair gets its own
SIP endpoint, so two agents sharing an id would keep resetting each other's
password.

Sign in on one of the two tabs:

- **Vobiz account**: Auth ID and Auth Token from the Vobiz Console. The
  backend checks them with Vobiz, finds or creates the integration's
  application and your SIP endpoint, and fills the caller-ID dropdown with the
  account's active, voice-enabled numbers. Press **Enable inbound calls** to
  route the selected number to signed-in agents. The panel shows which
  application the number is moving from.
- **SIP direct**: an existing endpoint's SIP username and password plus an E.164
  caller ID. The endpoint and the number must already be attached to an
  application whose answer URL is `https://<your-bridge-url>/answer`. The README
  has the Console steps and the API calls. Recordings and Enable inbound need the
  account tab.

Allow the microphone, and wait for the badge to read **READY**.

Keep it open. When you click **Call via Vobiz** on a ServiceNow record, the
bridge hands the record's number to this softphone, which places the call from
the browser. With no signed-in softphone open, the button reports `409`.
