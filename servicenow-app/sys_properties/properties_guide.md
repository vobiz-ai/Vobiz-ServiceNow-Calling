# ServiceNow system properties

The **Call via Vobiz** UI Action reads two system properties, so nothing about
your backend is written into its script.

| Name | Type | Value |
| --- | --- | --- |
| `vobiz.calling.tunnel_url` | `string` | Your backend's public HTTPS URL, such as `https://calling.example.com`. No trailing slash. |
| `vobiz.calling.shared_secret` | `password2` | The same value as `VOBIZ_SHARED_SECRET` in the backend's `.env`. Generate it with `openssl rand -hex 32`. |

Use `password2` for the secret, not `string`: anyone who can list system
properties can read a string property, and this value lets ServiceNow start
calls billed to your Vobiz account. The UI Action sends it as the
`X-Vobiz-Secret` header. If either property is missing, the button shows an
error that names it instead of calling.

## Create them

1. Go to **System Properties → All Properties** (`sys_properties.list`).
2. Click **New**.
3. Enter the **Name**, **Type** and **Value** from the table above.
4. Click **Submit**.
5. Repeat for the second property.

When your backend's hostname changes, update `vobiz.calling.tunnel_url` and the
OpenFrame configuration URL.
