// ==========================================
// ServiceNow UI Action Script: Call via Vobiz
// ==========================================
// Table: sys_user [sys_user] (or customer_contact, sn_customerservice_case, incident)
// Form Button: Checked (true)
// Client: Unchecked (false)
// Show insert: Checked (true)
// Show update: Checked (true)
//
// Description:
// Calls the phone number on the current record from the agent's Vobiz softphone.
// The bridge hands the number to the agent's open, signed-in Vobiz panel, and
// the panel places the call from the browser. The panel must be open and Ready.
//
// Properties used:
// - vobiz.calling.tunnel_url: Base HTTPS URL of the Vobiz Calling Bridge
// - vobiz.calling.shared_secret: Required. Secret key authenticating this request
// ==========================================

(function() {
    // 1. Retrieve tunnel URL and optional shared secret from ServiceNow System Properties
    var tunnelUrl = gs.getProperty("vobiz.calling.tunnel_url", "https://<YOUR-TUNNEL-URL>").replace(/\/$/, "");
    var sharedSecret = gs.getProperty("vobiz.calling.shared_secret", "");

    // /start-call originates a billed call and is not open. Without this
    // property the bridge answers 401, so say why here rather than surfacing a
    // bare HTTP status to the agent.
    if (!sharedSecret) {
        gs.addErrorMessage("Vobiz Call failed: the system property 'vobiz.calling.shared_secret' is not set. It must match VOBIZ_SHARED_SECRET in the bridge's .env.");
        action.setRedirectURL(current);
        return;
    }
    
    // 2. Resolve the number to call. On sys_user (and contacts) it is on the
    //    record itself; on an incident it is the caller's; on a CSM case, the
    //    contact's.
    var phone = vobizPhoneFrom(current);
    if (!phone && current.isValidField("caller_id") && !current.caller_id.nil()) {
        phone = vobizPhoneFrom(current.caller_id.getRefRecord());
    }
    if (!phone && current.isValidField("contact") && !current.contact.nil()) {
        phone = vobizPhoneFrom(current.contact.getRefRecord());
    }

    if (!phone) {
        gs.addErrorMessage("Vobiz Call failed: No mobile or phone number found on this record.");
        action.setRedirectURL(current);
        return;
    }

    // 3. Resolve logged-in ServiceNow username for agent mapping
    var agentId = gs.getUserName();

    try {
        var r = new sn_ws.RESTMessageV2();
        r.setEndpoint(tunnelUrl + "/start-call");
        r.setHttpMethod("POST");
        r.setRequestHeader("Content-Type", "application/json");
        r.setRequestHeader("X-Vobiz-Secret", sharedSecret);
        
        var body = {
            to: phone,
            agentId: agentId
        };
        
        r.setRequestBody(JSON.stringify(body));
        
        // Execute HTTP call synchronously
        var response = r.execute();
        var responseBody = response.getBody();
        var httpStatus = response.getStatusCode();
        
        // 202: the number was handed to your open Vobiz panel, which places the
        // call from the browser. 409: no signed-in panel is open to place it.
        if (httpStatus == 202) {
            gs.addInfoMessage("Calling " + phone + " from your Vobiz panel.");
        } else {
            var reason = responseBody;
            try { reason = JSON.parse(responseBody).error || responseBody; } catch (e) {}
            gs.addErrorMessage("Vobiz Call failed (Status " + httpStatus + "): " + reason);
        }
    } catch (ex) {
        gs.addErrorMessage("Vobiz Call Error: " + ex.getMessage());
    }
    
    // Refresh the page
    action.setRedirectURL(current);
})();

function vobizPhoneFrom(gr) {
    if (!gr) return "";
    var fields = ["mobile_phone", "phone", "business_phone"];
    for (var i = 0; i < fields.length; i++) {
        if (gr.isValidField(fields[i]) && !gr.getElement(fields[i]).nil()) {
            return gr.getValue(fields[i]).toString().trim();
        }
    }
    return "";
}
