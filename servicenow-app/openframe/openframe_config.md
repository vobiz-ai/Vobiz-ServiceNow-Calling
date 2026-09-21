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
   - **URL**: `https://<YOUR-TUNNEL-OR-BRIDGE-URL>/agent-phone.html`
   - **Width**: `380`
   - **Height**: `560`
   - **User group**: `All` (or assign to specific support agent roles like `sn_customerservice_agent`)
   - **Active**: `true`
4. Click **Submit**.

---

## 3. How It Works
- The OpenFrame panel will appear in the top-right banner of the ServiceNow Next Experience header.
- When clicked, it loads the WebRTC softphone interface directly inside the ServiceNow frame.
- The softphone automatically resolves the agent ID and connects audio when calls are initiated.
