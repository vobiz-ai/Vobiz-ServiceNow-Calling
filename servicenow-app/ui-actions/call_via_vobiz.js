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
// Initiates an outbound Vobiz phone call to the phone number on the current record.
// Automatically connects to the logged-in agent's browser softphone.
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
    
    // 2. Resolve target recipient phone number
    var phone = "";
    if (current.mobile_phone) {
        phone = current.mobile_phone.toString().trim();
    }
    if (!phone && current.phone) {
        phone = current.phone.toString().trim();
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
        
        // Support both 200 (Success) and 201 (Created/Queued)
        if (httpStatus == 200 || httpStatus == 201) {
            gs.addInfoMessage("Vobiz call initiated to " + phone + "! Connecting audio to your softphone...");
        } else {
            gs.addErrorMessage("Vobiz Call failed (Status " + httpStatus + "): " + responseBody);
        }
    } catch (ex) {
        gs.addErrorMessage("Vobiz Call Error: " + ex.getMessage());
    }
    
    // Refresh the page
    action.setRedirectURL(current);
})();
