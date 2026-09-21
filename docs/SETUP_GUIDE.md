# Vobiz ServiceNow Calling Bridge: Setup Guide

This guide walks you through setting up the **Vobiz ServiceNow Calling Bridge** from scratch.

---

## 1. Prerequisites

1. **Node.js 18+** installed on your workstation or host server.
2. An active **Vobiz Developer Account** with:
   - `VOBIZ_AUTH_ID`
   - `VOBIZ_AUTH_TOKEN`
   - An active Vobiz Outbound Phone Number (DID) for Caller ID.
3. A **ServiceNow Instance** (Personal Developer Instance - PDI or enterprise instance).
4. **Cloudflared** CLI (or any public tunneling solution / reverse proxy).

---

## 2. Backend Bridge Configuration

1. In the repository, navigate to the `backend/` directory:
   ```bash
   cd backend
   cp .env.example .env
   ```

2. Open `backend/.env` and supply your credentials:
   ```env
   # Vobiz API Credentials
   VOBIZ_AUTH_ID=your_vobiz_auth_id
   VOBIZ_AUTH_TOKEN=your_vobiz_auth_token
   VOBIZ_FROM_NUMBER=+12345678901

   # Local Server Port
   PORT=8092

   # Optional Shared Secret between ServiceNow and Backend
   VOBIZ_SHARED_SECRET=your_secret_token_here   # required by the ServiceNow form button
   SIGNING_SECRET=your_recording_hmac_secret    # set it, or playback links die on restart
   ALLOWED_ORIGINS=                             # extra CORS origins, comma-separated

   # ServiceNow Instance Configuration (for automatic CDR & Recording logging)
   SERVICENOW_INSTANCE_URL=https://dev12345.service-now.com
   SERVICENOW_USER=admin
   SERVICENOW_PASSWORD=your_instance_admin_password
   ```

3. Configure agent mappings in `backend/agents.json`:
   Map ServiceNow user IDs (e.g. `admin`) to their corresponding Vobiz SIP endpoint credentials:
   ```json
   {
     "admin": {
       "displayName": "ServiceNow Admin",
       "sipUser": "agentadmin12345@registrar.vobiz.ai",
       "sipPassword": "AgentPassword123!"
     }
   }
   ```

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

   `/start-call` originates a billed call, so it is not open. With this property
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

Open the agent softphone in a browser tab:
```
http://localhost:8092/agent-phone.html?agentId=admin
```
The status indicator will show:
- 🟢 **Ready — registered as ServiceNow Admin**

Keep this tab open. When you click **Call via Vobiz** inside any ServiceNow record, the bridge dials the recipient and instantly connects audio to this browser tab.
