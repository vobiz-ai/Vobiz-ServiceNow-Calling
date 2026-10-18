# ServiceNow OpenFrame / CTI Softphone Configuration

ServiceNow **OpenFrame** enables embedding softphones and CTI telephony widgets directly inside the ServiceNow Agent Workspace or Next Experience header.

---

## 1. Prerequisites
- **OpenFrame plugin** (`com.sn_openframe`) active on your ServiceNow instance.
- Vobiz Calling Bridge running and accessible via HTTPS.

---

## 2. OpenFrame Configuration

1. In the Filter Navigator, navigate to **OpenFrame** > **Configurations**.
2. Click **New**.
3. Set the following values:
   - **Name**: `Vobiz Softphone`
   - **Title**: `Vobiz Calling`
   - **URL**: `https://<YOUR-TUNNEL-OR-BRIDGE-URL>/agent-phone.html?instance=<your-instance>&agentId=<user name>`
     — `instance` is the `dev12345` in `dev12345.service-now.com`; the panel loads
     the OpenFrame API from there. Without it the panel falls back to the framing
     page's host. `agentId` is optional and only labels the agent.
   - **Width**: `380`
   - **Height**: `560`
   - **User group**: `All` (or assign to specific support agent roles like `sn_customerservice_agent`)
   - **Active**: `true`
4. Click **Submit**.

---

## 3. How It Works
- The OpenFrame panel will appear in the top-right banner of the ServiceNow Next Experience header.
- When clicked, it loads the WebRTC softphone interface directly inside the ServiceNow frame.
- The softphone loads `https://<instance>.service-now.com/scripts/openframe/latest/openFrameAPI.min.js`,
  initialises OpenFrame, and opens the panel on an incoming call.
- **Call via Vobiz** on a record hands the number to the open, signed-in panel,
  which dials it from the browser.
- If the browser blocks the microphone inside the frame, run the softphone in
  its own tab at the same URL instead; **Call via Vobiz** works the same way.
