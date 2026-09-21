# ServiceNow System Properties Configuration Guide

To avoid hardcoding URLs, secrets, or identifiers in script files, configure the following System Properties in your ServiceNow instance (`sys_properties.list`).

---

## Required Property

### `vobiz.calling.tunnel_url`
- **Description**: The public base URL of your running Vobiz ServiceNow Calling Bridge (e.g. Cloudflare Quick Tunnel, AWS ALB, or Reverse Proxy).
- **Type**: `string`
- **Example Value**: `https://calling-bridge.yourdomain.com` (or `https://your-tunnel.trycloudflare.com`)
- **Suffix Note**: Do not include a trailing slash.

---

## Security Properties

### `vobiz.calling.shared_secret` — required for the Call via Vobiz button
- **Description**: Symmetric authentication secret matching `VOBIZ_SHARED_SECRET` in your backend `.env`. ServiceNow sends it as the `X-Vobiz-Secret` header.
- **Type**: `password2`. Do **not** use `string`: any user who can list `sys_properties` can read a string property, and this value authorises outbound calls billed to the Vobiz account.
- **Example Value**: generate with `openssl rand -hex 32`.
- **If it is empty**, the UI Action sends no header and `/start-call` answers `401 unauthorized`. That endpoint originates a billed call and is deliberately not open.

### `vobiz.calling.default_table`
- **Description**: Default table to navigate or log interactions to if non-standard.
- **Type**: `string`
- **Default**: `interaction`

---

## How to Create Properties in ServiceNow

1. Navigate to **System Properties** > **All Properties** (`sys_properties.list`).
2. Click **New**.
3. Fill in:
   - **Name**: `vobiz.calling.tunnel_url`
   - **Type**: `string`
   - **Value**: `<Your Public Bridge URL>`
   - **Ignore cache**: `true`
4. Click **Submit**.
5. Repeat for `vobiz.calling.shared_secret` if using shared secret authentication.
