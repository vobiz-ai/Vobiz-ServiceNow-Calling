const http = require("http");
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const BACKEND_PORT = 8094;
const MOCK_VOBIZ_PORT = 9094;

// Set up mock agents
const AGENTS_FILE = path.join(__dirname, "agents.json");
const originalAgents = fs.existsSync(AGENTS_FILE) ? fs.readFileSync(AGENTS_FILE, "utf8") : "{}";

// Setup dummy .env
const ENV_FILE = path.join(__dirname, ".env");
let envExisted = false;
let originalEnv = "";
if (fs.existsSync(ENV_FILE)) {
  envExisted = true;
  originalEnv = fs.readFileSync(ENV_FILE, "utf8");
}

fs.writeFileSync(
  ENV_FILE,
  `
VOBIZ_AUTH_ID=mock_auth_id
VOBIZ_AUTH_TOKEN=mock_auth_token
VOBIZ_FROM_NUMBER=+12003004000
VOBIZ_SIP_USER=testuser_abc
VOBIZ_SIP_PASSWORD=testpassword123
PORT=${BACKEND_PORT}
TUNNEL_URL=http://localhost:${BACKEND_PORT}
VOBIZ_API_URL=http://localhost:${MOCK_VOBIZ_PORT}
`,
  "utf8"
);

// Write dummy test agent config
fs.writeFileSync(
  AGENTS_FILE,
  JSON.stringify(
    {
      "test-agent": {
        displayName: "Test Agent",
        sipUser: "testuser_abc@registrar.vobiz.ai",
      },
    },
    null,
    2
  ),
  "utf8"
);

console.log("[test] Mock environment configured.");

// Create Mock Vobiz API Server
let lastVobizCallRequest = null;
const mockVobizServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.includes("/numbers")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        objects: [{ number: "+12003004000" }, { number: "+12003004001" }],
      })
    );
  }

  if (req.method === "POST" && req.url.includes("/Call/")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastVobizCallRequest = {
        headers: req.headers,
        body: Object.fromEntries(new URLSearchParams(body)),
      };

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "queued",
          call_sid: "mock_call_sid_12345",
          direction: "outbound",
        })
      );
    });
    return;
  }

  if (req.method === "GET" && req.url.includes("/Recording/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        objects: [
          {
            recording_id: "rec_123",
            add_time: "2026-09-21 12:00:00",
            rounded_recording_duration: 35,
            call_uuid: "uuid_test_123",
          },
        ],
      })
    );
  }

  res.writeHead(404);
  res.end();
});

mockVobizServer.listen(MOCK_VOBIZ_PORT, () => {
  console.log(`[test] Mock Vobiz server listening on port ${MOCK_VOBIZ_PORT}`);

  // Start backend server
  console.log("[test] Starting backend/server.js...");
  const serverProc = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: BACKEND_PORT },
  });

  serverProc.stdout.on("data", (data) => {
    console.log(`[server.js] ${data.toString().trim()}`);
  });
  serverProc.stderr.on("data", (data) => {
    console.error(`[server.js ERR] ${data.toString().trim()}`);
  });

  // Wait for server to start
  setTimeout(runTests, 1500);

  async function runTests() {
    try {
      console.log("\n--- Starting test suite ---");

      // Test 1: Vobiz Account Login (auth_id and auth_token)
      console.log("[test] Test 1: Testing /login with Vobiz Account credentials...");
      const loginRes = await fetch(`http://localhost:${BACKEND_PORT}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "test-agent",
          authId: "mock_auth_id",
          authToken: "mock_auth_token",
        }),
      });
      assert.strictEqual(loginRes.status, 200, "Expected 200 OK from /login");
      const loginData = await loginRes.json();
      assert.ok(loginData.token, "Login should return a session token");
      assert.ok(loginData.numbers.includes("+12003004000"), "Numbers list should include caller ID");
      console.log("[test] ✓ Test 1 Passed: Account login succeeded.");

      // Test 2: SIP Direct Login (sipUser and callerId)
      console.log("[test] Test 2: Testing /login-sip with direct endpoint credentials...");
      const sipLoginRes = await fetch(`http://localhost:${BACKEND_PORT}/login-sip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sipUser: "sip_agent_direct",
          callerId: "+12003004000",
        }),
      });
      assert.strictEqual(sipLoginRes.status, 200, "Expected 200 OK from /login-sip");
      const sipLoginData = await sipLoginRes.json();
      assert.strictEqual(sipLoginData.ok, true);
      assert.strictEqual(sipLoginData.sipUser, "sip_agent_direct");
      assert.ok(sipLoginData.token, "SIP-direct login should return a session token");
      console.log("[test] ✓ Test 2 Passed: SIP direct login succeeded.");

      // A caller ID the account does not own is caller-ID spoofing.
      const spoofRes = await fetch(`http://localhost:${BACKEND_PORT}/login-sip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sipUser: "sip_agent_direct", callerId: "+19999999999" }),
      });
      assert.strictEqual(spoofRes.status, 400, "/login-sip must refuse a caller ID the account does not own");
      console.log("[test] ✓ Test 2b Passed: caller ID spoofing refused.");

      // Test 3: Browser-as-A-Leg Outbound Answer Webhook (/answer)
      console.log("[test] Test 3: Simulating browser WebRTC outbound call to /answer...");
      const outboundAnswerRes = await fetch(`http://localhost:${BACKEND_PORT}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          CallUUID: "uuid_outbound_test_1",
          From: "sip:testuser_abc@registrar.vobiz.ai",
          To: "+15550199",
          RouteType: "sip",
        }),
      });
      assert.strictEqual(outboundAnswerRes.status, 200);
      assert.strictEqual(outboundAnswerRes.headers.get("content-type"), "text/xml");
      const outboundXml = await outboundAnswerRes.text();
      assert.ok(outboundXml.includes("<Number>+15550199</Number>"), "XML should dial destination number");
      assert.ok(outboundXml.includes("<Record"), "XML should include self-closing <Record> tag");
      assert.ok(outboundXml.includes('redirect="false"'), "Dial should include redirect=false");
      console.log("[test] ✓ Test 3 Passed: Outbound answer XML verified.");

      // Test 4: Inbound Call Answer Webhook (/answer)
      console.log("[test] Test 4: Simulating inbound PSTN call to /answer...");
      const inboundAnswerRes = await fetch(`http://localhost:${BACKEND_PORT}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          CallUUID: "uuid_inbound_test_2",
          From: "+19998887777",
          To: "+12003004000",
        }),
      });
      assert.strictEqual(inboundAnswerRes.status, 200);
      assert.strictEqual(inboundAnswerRes.headers.get("content-type"), "text/xml");
      const inboundXml = await inboundAnswerRes.text();
      assert.ok(inboundXml.includes("<User>sip:"), "Inbound XML should dial agent User");
      assert.ok(inboundXml.includes("<Record"), "Inbound XML should include Record tag");
      console.log("[test] ✓ Test 4 Passed: Inbound answer XML verified.");

      // Test 5: Dial status and CDR tracking
      console.log("[test] Test 5: Testing /dial-status and /call-record CDR ledger...");
      await fetch(`http://localhost:${BACKEND_PORT}/dial-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          CallUUID: "uuid_outbound_test_1",
          DialStatus: "completed",
          DialBLegUUID: "bleg_12345",
          DialBLegDuration: "42",
        }),
      });

      const callRecordRes = await fetch(`http://localhost:${BACKEND_PORT}/call-record?to=+15550199`, {
        headers: { Authorization: `Bearer ${loginData.token}` },
      });
      assert.strictEqual(callRecordRes.status, 200);
      const callRecord = await callRecordRes.json();
      assert.strictEqual(callRecord.found, true);
      assert.strictEqual(callRecord.callUuid, "uuid_outbound_test_1");
      assert.strictEqual(callRecord.duration, 42);
      console.log("[test] ✓ Test 5 Passed: CDR dial status and query verified.");

      // Test 6: Softphone agent info lookup
      console.log("[test] Test 6: Verifying softphone /agent/:agentId endpoint...");

      // SIP credentials are never served to an unauthenticated caller, and an
      // unknown agent id is refused rather than filled in with a default.
      const agentAnon = await fetch(`http://localhost:${BACKEND_PORT}/agent/test-agent`);
      assert.strictEqual(agentAnon.status, 401, "/agent must refuse an unauthenticated caller");
      const agentAnonBody = await agentAnon.text();
      assert.ok(!agentAnonBody.includes("testpassword123"), "/agent must never leak the SIP password unauthenticated");

      const agentInvented = await fetch(`http://localhost:${BACKEND_PORT}/agent/nobody-by-this-name`);
      assert.strictEqual(agentInvented.status, 401, "/agent must not invent an agent for an unknown id");

      const agentRes = await fetch(`http://localhost:${BACKEND_PORT}/agent/test-agent`, {
        headers: { Authorization: `Bearer ${loginData.token}` },
      });
      assert.strictEqual(agentRes.status, 200);
      const agentData = await agentRes.json();
      assert.strictEqual(agentData.displayName, "Test Agent");
      assert.strictEqual(agentData.sipUser, "testuser_abc@registrar.vobiz.ai");
      assert.strictEqual(agentData.sipPassword, "testpassword123", "a signed-in agent still gets the password");
      console.log("[test] ✓ Test 6 Passed: Agent info is behind the session.");

      // Test 7: Static asset serving for softphone UI
      console.log("[test] Test 7: Verifying softphone HTML and static asset serving...");
      const phoneHtmlRes = await fetch(`http://localhost:${BACKEND_PORT}/agent-phone.html`);
      assert.strictEqual(phoneHtmlRes.status, 200);
      const phoneHtml = await phoneHtmlRes.text();
      assert.ok(phoneHtml.includes("Vobiz Calling for ServiceNow"), "HTML should include Vobiz branding");
      assert.ok(phoneHtml.includes('id="acceptbtn"'), "HTML should include incoming call popup buttons");
      assert.ok(phoneHtml.includes('id="mode-account-tab"'), "HTML should include login tabs");
      console.log("[test] ✓ Test 7 Passed: Softphone UI serving verified.");

      // Test 8: ServiceNow Form Button click-to-dial (/start-call backward compatibility)
      console.log("[test] Test 8: Verifying ServiceNow UI Action trigger to /start-call...");
      const startAnon = await fetch(`http://localhost:${BACKEND_PORT}/start-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "+15550199", agentId: "test-agent" }),
      });
      assert.strictEqual(startAnon.status, 401, "/start-call originates a billed call and must be authenticated");

      const startRes = await fetch(`http://localhost:${BACKEND_PORT}/start-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({
          to: "+15550199",
          agentId: "test-agent",
        }),
      });
      assert.strictEqual(startRes.status, 201);
      const startData = await startRes.json();
      assert.strictEqual(startData.call_sid, "mock_call_sid_12345");
      console.log("[test] ✓ Test 8 Passed: /start-call proxy succeeded.");

      // ── Security properties ──
      //
      // Each of these is a guarantee this backend makes. They are permanent: if
      // any stops holding, the suite fails.
      console.log("[test] Test 9: Security properties...");

      // A media proxy that fetches a caller-supplied URL with the account
      // credentials attached hands them to whatever host is named.
      const exfil = await fetch(
        `http://localhost:${BACKEND_PORT}/recording-file?url=${encodeURIComponent("http://127.0.0.1:1/steal")}`
      );
      assert.strictEqual(exfil.status, 410, "/recording-file?url= is not implemented, not merely guarded");

      // A playback link carries a signature, and it is checked.
      const unsigned = await fetch(`http://localhost:${BACKEND_PORT}/recording-audio/rec_123`);
      assert.strictEqual(unsigned.status, 403, "/recording-audio must verify the playback signature");

      const badSig = await fetch(`http://localhost:${BACKEND_PORT}/recording-audio/rec_123?exp=99999999999&sig=deadbeef`);
      assert.strictEqual(badSig.status, 403, "/recording-audio must reject a forged signature");

      // An unsigned playback link is refused outright, never answered with
      // whatever recording is most recent.
      const unsignedPlay = await fetch(`http://localhost:${BACKEND_PORT}/play-recording?callUuid=uuid_outbound_test_1`);
      assert.strictEqual(unsignedPlay.status, 403, "/play-recording must demand a signature or a session");

      // An agent id in the path is not a credential: it proves nothing without
      // a token, and leaks neither the Auth ID nor the account's numbers.
      const sessionByName = await fetch(`http://localhost:${BACKEND_PORT}/session/test-agent`);
      const sessionByNameJson = await sessionByName.json();
      assert.strictEqual(sessionByNameJson.loggedIn, false, "/session/<agentId> must prove nothing without a token");
      assert.ok(!JSON.stringify(sessionByNameJson).includes("mock_auth_id"), "/session must not leak the account Auth ID");

      // Wrong credentials must fail, and /health must not publish the account.
      const badLogin = await fetch(`http://localhost:${BACKEND_PORT}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "test-agent", authId: "wrong_id", authToken: "wrong_token" }),
      });
      assert.strictEqual(badLogin.status, 401, "/login must reject credentials this backend is not bound to");

      const health = await fetch(`http://localhost:${BACKEND_PORT}/health`);
      const healthText = await health.text();
      assert.ok(!healthText.includes("mock_auth_id"), "/health must not publish the account Auth ID");
      assert.ok(!healthText.includes("testuser_abc"), "/health must not publish the SIP username");

      // CORS is an allowlist; a wildcard would let any page drive this server.
      const corsRes = await fetch(`http://localhost:${BACKEND_PORT}/health`, {
        headers: { Origin: "https://evil.example" },
      });
      assert.notStrictEqual(
        corsRes.headers.get("access-control-allow-origin"),
        "*",
        "CORS must not be a wildcard"
      );
      assert.ok(
        !corsRes.headers.get("access-control-allow-origin"),
        "an unknown origin must not be echoed back as allowed"
      );
      console.log("[test] ✓ Test 9 Passed: all security properties held.");

      console.log("\n=========================");
      console.log("ALL TESTS PASSED SUCCESSFULLY");
      console.log("=========================");
    } catch (err) {
      console.error("\n[test] ❌ TEST SUITE FAILED:", err);
      process.exitCode = 1;
    } finally {
      console.log("[test] Cleaning up processes and temp files...");
      try {
        mockVobizServer.close();
      } catch {}
      try {
        serverProc.kill();
      } catch {}

      // Restore files
      fs.writeFileSync(AGENTS_FILE, originalAgents, "utf8");
      if (envExisted) {
        fs.writeFileSync(ENV_FILE, originalEnv, "utf8");
      } else {
        try {
          fs.unlinkSync(ENV_FILE);
        } catch {}
      }
      setTimeout(() => process.exit(process.exitCode || 0), 200);
    }
  }
});
