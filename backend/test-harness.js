const http = require("http");
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BACKEND_PORT = 8094;
const MOCK_VOBIZ_PORT = 9094;
const BASE = `http://localhost:${BACKEND_PORT}`;

const SHARED_SECRET = "test_shared_secret";

// Two unrelated Vobiz accounts, both fake. Nothing here is a real account.
const ACCOUNTS = {
  MA_TEST0001: { token: "tok_one_secret_value", numbers: ["+12003004000", "+12003004001"] },
  MA_TEST0002: { token: "tok_two_secret_value", numbers: ["+12003004002"] },
};
// 17 digits: above Number.MAX_SAFE_INTEGER, so any trip through a JS number
// rounds it (to 43919358318796816). The mock returns it as a bare JSON number.
const APP_ID_ONE = "43919358318796814";
const APP_ID_TWO = "43919358318796999";

// The endpoint map goes to a throwaway directory, never backend/data.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-sn-test-"));

// The backend gets its configuration from the environment of the child process.
// Nothing is written to backend/.env or agents.json, and every setting is
// pinned, so values exported in your shell cannot leak in. No Vobiz account is
// configured: accounts arrive by signing in.
const TEST_ENV = {
  ENV_FILE: path.join(__dirname, "does-not-exist.test.env"),
  VOBIZ_REGISTRAR: "registrar.vobiz.ai",
  VOBIZ_SHARED_SECRET: SHARED_SECRET,
  PORT: String(BACKEND_PORT),
  // HTTPS, so sign-in provisions — against the mock below. Nothing resolves.
  PUBLIC_BASE_URL: "https://bridge.example.test",
  VOBIZ_API_URL: `http://localhost:${MOCK_VOBIZ_PORT}`,
  // ServiceNow is the mock below, never a real instance.
  SERVICENOW_INSTANCE_URL: `http://localhost:${MOCK_VOBIZ_PORT}`,
  SERVICENOW_USER: "mock_sn_user",
  SERVICENOW_PASSWORD: "mock_sn_password",
  SIGNING_SECRET: "test_signing_secret",
  DATA_DIR,
  ALLOWED_ORIGINS: "",
};

// ─── Mock Vobiz + ServiceNow ─────────────────────────────────────────────────
const vobizRequests = []; // { method, url, authId, rawBody }
const serviceNowWrites = [];
const apps = { MA_TEST0001: [], MA_TEST0002: [] };
const endpoints = {}; // endpointId -> { authId, username, application }
let nextEndpoint = 87654321;
let originatedOverRest = false;

const mockServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => handleMock(req, res, raw));
});

function handleMock(req, res, raw) {
  const send = (status, text) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof text === "string" ? text : JSON.stringify(text));
  };

  // Mock ServiceNow Table API, on the same port.
  if (req.url.startsWith("/api/now/table/sys_user")) return send(200, { result: [] });
  if (req.url.startsWith("/api/now/table/interaction")) {
    serviceNowWrites.push({ method: req.method, url: req.url, body: JSON.parse(raw || "{}") });
    return send(req.method === "POST" ? 201 : 200, { result: { sys_id: "sn_sys_1", number: "IMS0001001" } });
  }

  const m = req.url.match(/^\/api\/v1\/Account\/([^/]+)(\/.*)$/);
  if (!m) return send(404, { error: "not found" });
  const authId = decodeURIComponent(m[1]);
  const rest = m[2];
  vobizRequests.push({ method: req.method, url: req.url, authId, rawBody: raw, headerId: req.headers["x-auth-id"] });

  const acct = ACCOUNTS[authId];
  if (!acct || req.headers["x-auth-id"] !== authId || req.headers["x-auth-token"] !== acct.token) {
    return send(401, { error: "authentication failed" });
  }

  if (req.method === "GET" && rest.startsWith("/numbers")) {
    // Two per page whatever is asked, so the backend has to page through
    // `total`. Account one also has a released number and a voice-disabled one,
    // which the caller-ID picker must not offer. application_id arrives as a
    // bare 17-digit JSON number for the attached one.
    const all = [
      ...acct.numbers.map((e164, i) => ({ e164, status: "active", voice_enabled: true, application_id: i === 1 ? "OLDAPP" : null })),
      ...(authId === "MA_TEST0001"
        ? [
            { e164: "+12003004008", status: "inactive", voice_enabled: true, application_id: null },
            { e164: "+12003004009", status: "active", voice_enabled: false, application_id: null },
          ]
        : []),
    ];
    const page = Number(new URL(rest, "http://x").searchParams.get("page") || 1);
    const slice = all.slice((page - 1) * 2, page * 2);
    const items = slice
      .map((n) => `{"e164":"${n.e164}","account_id":"${authId}","status":"${n.status}","voice_enabled":${n.voice_enabled},"application_id":${n.application_id ? "21234567890123456" : "null"}}`)
      .join(",");
    return send(200, `{"items":[${items}],"page":${page},"per_page":2,"total":${all.length}}`);
  }
  const attach = rest.match(/^\/numbers\/([^/]+)\/application$/);
  if (attach && req.method === "POST") return send(200, { message: "Number attached to application" });

  if (rest.startsWith("/Application/")) {
    if (req.method === "GET") {
      // app_id as a bare JSON number, the worst case for a JS client.
      return send(200, `{"objects":[${apps[authId].map((a) => `{"app_id":${a.app_id},"answer_url":"${a.answer_url}"}`).join(",")}]}`);
    }
    const body = JSON.parse(raw);
    const app_id = authId === "MA_TEST0001" ? APP_ID_ONE : APP_ID_TWO;
    apps[authId].push({ app_id, answer_url: body.answer_url });
    return send(201, `{"message":"created","app_id":${app_id}}`);
  }

  if (rest === "/Endpoint/" && req.method === "POST") {
    const body = JSON.parse(raw);
    if (!/^[A-Za-z0-9]+$/.test(body.username)) return send(400, { error: "Only alphanumeric characters are allowed" });
    const id = String(nextEndpoint++);
    // Vobiz rewrites the submitted username; the backend must read it back.
    endpoints[id] = { authId, username: `${body.username}1234`, alias: body.alias, application: null };
    applyBind(endpoints[id], authId, raw);
    return send(201, { message: "created", endpoint_id: id });
  }
  if (rest.startsWith("/Endpoint/?") && req.method === "GET") {
    const objects = Object.entries(endpoints)
      .filter(([, e]) => e.authId === authId)
      .map(([id, e]) => ({ endpoint_id: id, username: e.username, alias: e.alias }));
    return send(200, { objects });
  }
  const ep = rest.match(/^\/Endpoint\/(\d+)\/$/);
  if (ep) {
    const e = endpoints[ep[1]];
    if (!e || e.authId !== authId) return send(404, { error: "Endpoint not found" });
    if (req.method === "POST") {
      applyBind(e, authId, raw);
      return send(200, { message: "changed" });
    }
    return send(
      200,
      `{"endpoint_id":"${ep[1]}","username":"${e.username}","application":${e.application ? `{"app_id":"${e.application}"}` : "null"}}`
    );
  }

  if (req.method === "POST" && rest.startsWith("/Call/")) {
    originatedOverRest = true;
    return send(201, { message: "call fired" });
  }

  if (req.method === "GET" && rest.startsWith("/Recording/")) {
    return send(200, {
      objects: [{ recording_id: `rec_${authId}`, add_time: "2026-09-21 12:00:00", rounded_recording_duration: 35, call_uuid: "uuid_test_123" }],
    });
  }

  return send(404, { error: "no mock for " + rest });
}

// Account one's Vobiz honours {"app_id":"<string>"}; account two's only the
// documented {"application": <integer>} — so both bind paths are exercised.
// Ids are read from the raw text so all 17 digits survive.
function applyBind(e, authId, raw) {
  const byAppId = raw.match(/"app_id"\s*:\s*"(\d+)"/);
  const byApplication = raw.match(/"application"\s*:\s*(\d+)/);
  if (byAppId && authId === "MA_TEST0001") e.application = byAppId[1];
  if (byApplication) e.application = byApplication[1];
}

// Every response body the backend sends in this suite, to prove no Auth Token
// ever leaves it.
const responseBodies = [];
async function call(p, init = {}) {
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  responseBodies.push(`${p} ${JSON.stringify([...res.headers])} ${text}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}
const post = (p, body, token, extra = {}) =>
  call(p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body || {}),
  });
const get = (p, token) => call(p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const login = (agentId, authId) => post("/login", { agentId, authId, authToken: ACCOUNTS[authId].token });

let passed = 0;
function ok(name) {
  passed++;
  console.log(`[test] ✓ ${name}`);
}

mockServer.listen(MOCK_VOBIZ_PORT, () => {
  console.log(`[test] Mock Vobiz server listening on port ${MOCK_VOBIZ_PORT}`);
  const serverProc = spawn("node", [path.join(__dirname, "server.js")], {
    env: { PATH: process.env.PATH, ...TEST_ENV },
  });
  const serverLog = [];
  serverProc.stdout.on("data", (d) => {
    serverLog.push(d.toString());
    console.log(`[server.js] ${d.toString().trim()}`);
  });
  serverProc.stderr.on("data", (d) => {
    serverLog.push(d.toString());
    console.error(`[server.js ERR] ${d.toString().trim()}`);
  });
  setTimeout(runTests, 1500);

  async function runTests() {
    try {
      console.log("\n--- Starting test suite ---");

      // ── Sign-in: any account, verified, nothing else ──
      const wrong = await post("/login", { agentId: "test-agent", authId: "MA_TEST0001", authToken: "not_the_token" });
      assert.strictEqual(wrong.status, 401, "a wrong token is refused");
      assert.ok(/did not accept/i.test(wrong.json.error), "with a clear message");
      assert.ok(!wrong.json.token, "and no session");
      const unknown = await post("/login", { agentId: "test-agent", authId: "MA_NOBODY01", authToken: "x" });
      assert.strictEqual(unknown.status, 401, "an account Vobiz does not know is refused");
      assert.ok(!vobizRequests.some((r) => r.url.includes("/Endpoint/")), "nothing is provisioned for refused credentials");
      ok("wrong credentials are refused before anything is provisioned");

      const one = await login("test-agent", "MA_TEST0001");
      assert.strictEqual(one.status, 200, "account one signs in");
      assert.ok(one.json.token);
      assert.deepStrictEqual(one.json.numbers, ACCOUNTS.MA_TEST0001.numbers, "every page loaded; only active, voice-enabled numbers offered");
      assert.ok(vobizRequests.some((r) => r.authId === "MA_TEST0001" && r.url.includes("/numbers?page=2")), "the number list is paged");
      assert.deepStrictEqual(
        one.json.numberDetails,
        [{ e164: "+12003004000", applicationId: "" }, { e164: "+12003004001", applicationId: "21234567890123456" }],
        "each number's current application id, unrounded"
      );
      assert.strictEqual((await post("/select-number", { number: "+12003004009" }, one.json.token)).status, 400, "a voice-disabled number is not a caller ID");
      assert.strictEqual((await post("/select-number", { number: "+12003004008" }, one.json.token)).status, 400, "nor an inactive one");
      assert.strictEqual(one.json.selected, "+12003004000");

      const two = await login("other-agent", "MA_TEST0002");
      assert.strictEqual(two.status, 200, "an unrelated second account signs in to the same backend");
      assert.deepStrictEqual(two.json.numbers, ACCOUNTS.MA_TEST0002.numbers);
      ok("two different Vobiz accounts sign in to one backend");

      // Each account's calls go to that account, with that account's headers.
      for (const r of vobizRequests.filter((x) => ACCOUNTS[x.authId])) {
        assert.strictEqual(r.headerId, r.authId, "every Vobiz call uses the account it is about");
      }

      // ── Provisioning ──
      assert.ok(apps.MA_TEST0001[0] && apps.MA_TEST0001[0].answer_url === "https://bridge.example.test/answer", "app answer_url is /answer");
      assert.strictEqual(apps.MA_TEST0002.length, 1, "account two gets its own application");

      const epPosts = (acct) => vobizRequests.filter((r) => r.authId === acct && r.method === "POST" && r.url.includes("/Endpoint/"));
      assert.ok(
        epPosts("MA_TEST0001").some((r) => r.rawBody.includes(`"app_id":"${APP_ID_ONE}"`)),
        "account one: the endpoint is bound with app_id as the exact 17-digit string"
      );
      assert.ok(!epPosts("MA_TEST0001").some((r) => r.rawBody.includes('"application"')), "no fallback needed when app_id binds");
      assert.ok(
        epPosts("MA_TEST0002").some((r) => r.rawBody === `{"application":${APP_ID_TWO}}`),
        "account two: the fallback bind body carries the 17-digit integer exactly"
      );
      assert.ok(!vobizRequests.some((r) => r.rawBody.includes("43919358318796816")), "never a rounded id");
      const epOne = Object.values(endpoints).find((e) => e.authId === "MA_TEST0001");
      const epTwo = Object.values(endpoints).find((e) => e.authId === "MA_TEST0002");
      assert.strictEqual(epOne.application, APP_ID_ONE, "bound to account one's app, unrounded");
      assert.strictEqual(epTwo.application, APP_ID_TWO, "bound to account two's app");
      assert.ok(
        !vobizRequests.some((r) => /\/numbers\/[^/]+\/application/.test(r.url)),
        "sign-in attaches no phone number to anything"
      );
      ok("sign-in finds-or-creates the app and binds a per-agent endpoint with the exact 17-digit id");

      const agentOne = await get("/agent", one.json.token);
      const agentTwo = await get("/agent", two.json.token);
      assert.strictEqual(agentOne.status, 200);
      assert.strictEqual(agentOne.json.sipUser, `${epOne.username}@registrar.vobiz.ai`, "the username Vobiz stored is the one served");
      assert.strictEqual(agentTwo.json.sipUser, `${epTwo.username}@registrar.vobiz.ai`);
      assert.notStrictEqual(agentOne.json.sipUser, agentTwo.json.sipUser, "two accounts, two distinct endpoints");
      assert.ok(agentOne.json.sipPassword && agentOne.json.sipPassword.length >= 12, "a fresh SIP password for this session");
      assert.strictEqual(agentOne.json.displayName, "Test Agent");
      ok("each session gets its own endpoint and its own password");

      const map = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "endpoints.json"), "utf8"));
      assert.deepStrictEqual(Object.keys(map).sort(), ["MA_TEST0001:test-agent", "MA_TEST0002:other-agent"]);
      const mapText = JSON.stringify(map);
      assert.ok(!mapText.includes(agentOne.json.sipPassword) && !/password|token/i.test(mapText), "no password or token on disk");
      assert.ok(!mapText.includes("tok_one") && !mapText.includes("tok_two"));
      if (process.platform !== "win32") {
        assert.strictEqual(fs.statSync(path.join(DATA_DIR, "endpoints.json")).mode & 0o777, 0o600, "endpoint map is 0600");
      }
      ok("the endpoint map holds ids only, mode 0600");

      // Same agent again: same endpoint, new password, no new endpoint.
      const endpointCount = Object.keys(endpoints).length;
      const oneAgain = await login("test-agent", "MA_TEST0001");
      assert.strictEqual(oneAgain.status, 200);
      assert.strictEqual(Object.keys(endpoints).length, endpointCount, "the endpoint is reused, not duplicated");
      const agentOneAgain = await get("/agent", oneAgain.json.token);
      assert.strictEqual(agentOneAgain.json.sipUser, agentOne.json.sipUser);
      assert.notStrictEqual(agentOneAgain.json.sipPassword, agentOne.json.sipPassword, "each sign-in sets a new password");
      ok("signing in again reuses the endpoint and rotates its password");

      const sipOne = epOne.username;
      const sipTwo = epTwo.username;

      // ── Outbound: routed by SIP username ──
      const outOne = await post("/answer", { CallUUID: "uuid_out_1", From: `sip:${sipOne}@registrar.vobiz.ai`, To: "+15550199", RouteType: "sip" });
      assert.strictEqual(outOne.status, 200);
      assert.strictEqual(outOne.headers.get("content-type"), "text/xml");
      assert.ok(outOne.text.includes("<Number>+15550199</Number>"), "dials the destination");
      assert.ok(outOne.text.includes('callerId="+12003004000"'), "as account one's selected number");
      assert.ok(outOne.text.includes("<Record"), "with <Record>");
      assert.ok(outOne.text.includes('redirect="false"'));

      const outTwo = await post("/answer", { CallUUID: "uuid_out_2", From: `sip:${sipTwo}@registrar.vobiz.ai`, To: "+15550100", RouteType: "sip" });
      assert.ok(outTwo.text.includes('callerId="+12003004002"'), "account two's call goes out on account two's number");

      const outHeader = await post("/answer", {
        CallUUID: "uuid_out_h", From: `sip:${sipOne}@registrar.vobiz.ai`, To: "+15550103", RouteType: "sip", "X-VH-Caller-ID": "+12003004001",
      });
      assert.ok(outHeader.text.includes('callerId="+12003004001"'), "the X-VH-Caller-ID header picks the caller ID");
      const outPrefixed = await post("/answer", {
        CallUUID: "uuid_out_h2", From: `sip:${sipOne}@registrar.vobiz.ai`, To: "+15550104", RouteType: "sip", "SIPHeader_X-VH-Caller-ID": "+12003004001",
      });
      assert.ok(outPrefixed.text.includes('callerId="+12003004001"'), "also with the SIPHeader_ prefix");
      const outForeign = await post("/answer", {
        CallUUID: "uuid_out_h3", From: `sip:${sipOne}@registrar.vobiz.ai`, To: "+15550105", RouteType: "sip", "X-VH-Caller-ID": "+12003004002",
      });
      assert.ok(outForeign.text.includes("<Hangup/>") && !outForeign.text.includes("<Dial"), "another account's number in the header is refused");

      const outUnknown = await post("/answer", { CallUUID: "uuid_out_x", From: "sip:intruder@registrar.vobiz.ai", To: "+15550101", RouteType: "sip" });
      assert.ok(outUnknown.text.includes("<Hangup/>") && !outUnknown.text.includes("<Dial"), "an unknown SIP user is hung up on");
      ok("outbound webhooks route to the right account and caller ID");

      // Caller ID: only the account's own numbers, then used on the next call.
      assert.strictEqual((await post("/select-number", { number: "+12003004002" }, one.json.token)).status, 400, "another account's number is refused");
      assert.strictEqual((await post("/select-number", { number: "+15555550123" }, one.json.token)).status, 400);
      assert.strictEqual((await post("/select-number", { number: "+12003004001" }, oneAgain.json.token)).status, 200);
      const outOneB = await post("/answer", { CallUUID: "uuid_out_1b", From: `sip:${sipOne}@registrar.vobiz.ai`, To: "+15550102", RouteType: "sip" });
      assert.ok(outOneB.text.includes('callerId="+12003004001"'), "the selected number is used");
      await post("/select-number", { number: "+12003004000" }, oneAgain.json.token);
      ok("caller ID is limited to the account's numbers and follows the selection");

      // ── Inbound: routed by the dialled number ──
      const inTwo = await post("/answer", { CallUUID: "uuid_in_2", From: "+19998887777", To: "+12003004002" });
      assert.ok(inTwo.text.includes(`<User>sip:${sipTwo}@registrar.vobiz.ai</User>`), "rings account two's agent");
      assert.ok(!inTwo.text.includes(sipOne), "and not account one's");
      assert.ok(inTwo.text.includes('callerId="+12003004002"'), "callerId is the dialled DID");
      const inOne = await post("/answer", { CallUUID: "uuid_in_1", From: "+19998887776", To: "12003004000" });
      assert.ok(inOne.text.includes(`<User>sip:${sipOne}@`) && !inOne.text.includes(sipTwo), "account one's DID rings account one");
      assert.ok(inOne.text.includes('callerId="+12003004000"'), "in E.164");
      const inParent = await post("/answer", {
        CallUUID: "uuid_in_p", From: "+19998887773", To: "+12003004000", Direction: "inbound", ParentAuthID: "MA_TEST0002",
      });
      assert.ok(inParent.text.includes(`<User>sip:${sipTwo}@`) && !inParent.text.includes(sipOne), "ParentAuthID names the account first");
      const inLocal = await post("/answer", { CallUUID: "uuid_in_l", From: "+19998887772", To: "02003004002", Direction: "inbound", ParentAuthID: "MA_TEST0002" });
      assert.ok(inLocal.text.includes('callerId="+912003004002"'), "a 0-prefixed 11-digit To becomes +91 E.164");
      const inNobody = await post("/answer", { CallUUID: "uuid_in_x", From: "+19998887775", To: "+15550109" });
      assert.ok(inNobody.text.includes("<Hangup/>") && !inNobody.text.includes("<Dial"), "a number no signed-in account owns is hung up on");
      ok("inbound webhooks route to the account that owns the dialled number");

      // ── CDR, scoped per account ──
      await post("/dial-status", { CallUUID: "uuid_out_1", DialStatus: "completed", DialBLegUUID: "bleg_12345", DialBLegDuration: "42" });
      const rec = await get("/call-record?to=+15550199", one.json.token);
      assert.strictEqual(rec.json.found, true);
      assert.strictEqual(rec.json.callUuid, "uuid_out_1");
      assert.strictEqual(rec.json.duration, 42);
      assert.ok(rec.json.recordingUrl.includes("acct=MA_TEST0001"), "the playback link names its account");
      const recFromTwo = await get("/call-record?to=+15550199", two.json.token);
      assert.strictEqual(recFromTwo.json.found, false, "account two cannot see account one's calls");
      ok("CDR lookup is scoped to the session's account");

      // One interaction per call, no credentials in it.
      assert.strictEqual((await post("/sync-call", { callUuid: "uuid_out_1", toNumber: "+15550199", duration: 42 }, one.json.token)).status, 200);
      await call("/recording-ready", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ CallUUID: "uuid_out_1", RecordingID: "rec_123", RecordingDuration: "40" }).toString(),
      });
      const creates = serviceNowWrites.filter((w) => w.method === "POST");
      const updates = serviceNowWrites.filter((w) => w.method === "PATCH");
      assert.strictEqual(creates.length, 1, "one interaction record per call");
      assert.strictEqual(updates.length, 1, "the recording webhook updates that record");
      assert.ok(updates[0].url.endsWith("/interaction/sn_sys_1"));
      const written = JSON.stringify(serviceNowWrites);
      assert.ok(!written.includes("tok_one") && !written.includes("tok_two"), "no Auth Token is written into ServiceNow");
      assert.ok(/play-recording\?callUuid=uuid_out_1&acct=MA_TEST0001&exp=\d+&sig=[0-9a-f]{64}/.test(written), "the work note carries an account-scoped signed link");
      assert.strictEqual(
        (await post("/sync-call", { callUuid: "uuid_out_1", toNumber: "+15550199" }, two.json.token)).status,
        403,
        "account two cannot write account one's call into ServiceNow"
      );
      ok("one interaction per call, signed account-scoped link, no credentials");

      // ── Recording links are account-scoped ──
      const signed = new URL(rec.json.recordingUrl);
      const before = vobizRequests.length;
      const play = await get(`/play-recording${signed.search}`);
      assert.strictEqual(play.status, 404, "a valid link is resolved (the mock has no audio)");
      const lookups = vobizRequests.slice(before).filter((r) => r.url.includes("/Recording/"));
      assert.ok(lookups.length && lookups.every((r) => r.authId === "MA_TEST0001"), "with the link's own account's credentials");
      const swapped = new URLSearchParams(signed.search);
      swapped.set("acct", "MA_TEST0002");
      assert.strictEqual((await get(`/play-recording?${swapped}`)).status, 403, "the account in a link cannot be swapped");
      const stretched = await get(`/play-recording${signed.search}&recordingId=someone_elses_recording`);
      assert.ok(stretched.status !== 200);
      assert.ok(!vobizRequests.some((r) => r.url.includes("someone_elses_recording")), "the signature covers the id actually looked up");
      const list = await get("/recordings", two.json.token);
      assert.strictEqual(list.status, 200);
      assert.ok(list.json.recordings[0].playUrl.includes("acct=MA_TEST0002"), "account two's recording list is signed for account two");
      assert.ok(list.json.recordings[0].recording_id === "rec_MA_TEST0002", "and fetched with account two's credentials");
      const audio = new URL(list.json.recordings[0].playUrl, BASE);
      const audioSwapped = new URLSearchParams(audio.search);
      audioSwapped.set("acct", "MA_TEST0001");
      assert.strictEqual((await get(`${audio.pathname}?${audioSwapped}`)).status, 403, "a recording-audio link cannot change account");
      ok("recording links are bound to one account");

      // ── Enable inbound calls: the only number attachment ──
      assert.strictEqual((await post("/setup-inbound", { number: "+12003004002" }, one.json.token)).status, 400, "only your own account's number");
      const enable = await post("/setup-inbound", { number: "+12003004000" }, one.json.token);
      assert.strictEqual(enable.status, 200);
      assert.strictEqual(enable.json.previousAppId, "", "it was on no application");
      const enable2 = await post("/setup-inbound", { number: "+12003004001" }, one.json.token);
      assert.strictEqual(enable2.json.previousAppId, "21234567890123456", "it says which application the number moved from");
      assert.ok(enable2.json.message.includes("21234567890123456"));
      const attaches = vobizRequests.filter((r) => /\/numbers\/[^/]+\/application/.test(r.url));
      assert.strictEqual(attaches.length, 2, "one attach per explicit action, none otherwise");
      assert.ok(attaches[0].url.endsWith("/Account/MA_TEST0001/numbers/%2B12003004000/application"), "on the lowercase /numbers path, + encoded");
      assert.deepStrictEqual(JSON.parse(attaches[0].rawBody), { application_id: APP_ID_ONE }, "with the exact app id as a string");
      assert.strictEqual(apps.MA_TEST0001.length, 1, "the existing application is found, not duplicated");
      ok("Enable inbound calls attaches the chosen DID, and nothing else does");

      // ── Softphone UI ──
      const html = await get("/agent-phone.html");
      assert.strictEqual(html.status, 200);
      assert.ok(html.text.includes("Vobiz Calling for ServiceNow"));
      assert.ok(html.text.includes('id="acceptbtn"'), "incoming call popup");
      assert.ok(html.text.includes('id="mode-account-tab"') && html.text.includes('id="mode-sip-tab"'), "both sign-in tabs");
      assert.ok(html.text.includes('id="sip-caller-id"'), "SIP direct asks for a caller ID");
      const appJs = (await get("/scripts/app.js")).text;
      const ua = (appJs.match(/user_agent:\s*"([^"]*)"/) || [])[1];
      assert.ok(ua && !/\s/.test(ua), "the JsSIP user_agent must be set and contain no space");
      assert.ok(!/\+\d{10,}/.test(html.text.replace(/placeholder="[^"]*"/g, "")) && !/["'`]\+\d{10,}/.test(appJs), "the panel hard-codes no number");
      ok("softphone UI is served with both sign-in modes");

      // ── Click-to-call ──
      const startCall = (headers) => post("/start-call", { to: "+91 00000-00001", agentId: "test-agent" }, null, headers);
      assert.strictEqual((await startCall({})).status, 401, "/start-call must be authenticated");
      assert.strictEqual((await startCall({ "X-Vobiz-Secret": "wrong" })).status, 401, "a wrong secret is refused");
      assert.strictEqual((await startCall({ "X-Vobiz-Secret": SHARED_SECRET })).status, 409, "no panel open");
      const poll = () => get("/dial-requests", one.json.token);
      assert.strictEqual((await poll()).json.dial, null);
      await get("/dial-requests", two.json.token);
      const started = await startCall({ "X-Vobiz-Secret": SHARED_SECRET });
      assert.strictEqual(started.status, 202, "the number goes to test-agent's panel even with another account's panel open");
      assert.strictEqual(started.json.to, "+910000000001");
      assert.strictEqual((await get("/dial-requests", two.json.token)).json.dial, null, "not to the other account's panel");
      assert.strictEqual((await poll()).json.dial.to, "+910000000001");
      assert.strictEqual((await poll()).json.dial, null, "each number is dialled once");
      assert.strictEqual(originatedOverRest, false, "the backend must not originate the call over REST");
      ok("Call via Vobiz hands the number to the right agent's softphone");

      // ── SIP direct: an existing endpoint, no account credentials anywhere ──
      assert.strictEqual((await post("/login-sip", { sipUser: "deskphone01", callerId: "call me maybe" })).status, 400, "caller ID must be a number");
      assert.strictEqual((await post("/login-sip", { sipUser: "bad user!", callerId: "+12003004005" })).status, 400, "SIP username is alphanumeric");
      assert.strictEqual((await post("/login-sip", { sipUser: sipOne, callerId: "+12003004005" })).status, 409, "cannot take over an account-provisioned endpoint");
      const sipLogin = await post("/login-sip", { sipUser: "sip:deskphone01@registrar.vobiz.ai", callerId: "+1 200 300 4005" });
      assert.strictEqual(sipLogin.status, 200);
      assert.strictEqual(sipLogin.json.sipUser, "deskphone01");
      assert.strictEqual(sipLogin.json.callerId, "+12003004005", "caller ID normalised to E.164");
      const sipTok = sipLogin.json.token;
      const sipOut = await post("/answer", { CallUUID: "uuid_sip_out", From: "sip:deskphone01@registrar.vobiz.ai", To: "+15550120", RouteType: "sip" });
      assert.ok(sipOut.text.includes('callerId="+12003004005"') && sipOut.text.includes("<Number>+15550120</Number>"), "SIP direct dials out on its caller ID");
      const sipOutH = await post("/answer", {
        CallUUID: "uuid_sip_out2", From: "sip:deskphone01@registrar.vobiz.ai", To: "+15550121", RouteType: "sip", "X-VH-Caller-ID": "+12003004006",
      });
      assert.ok(sipOutH.text.includes('callerId="+12003004006"'), "the header caller ID is used in SIP direct too");
      const sipOutBad = await post("/answer", {
        CallUUID: "uuid_sip_out3", From: "sip:deskphone01@registrar.vobiz.ai", To: "+15550122", RouteType: "sip", "X-VH-Caller-ID": "12345",
      });
      assert.ok(sipOutBad.text.includes('callerId="+12003004005"'), "a malformed header is ignored, not trusted");
      const sipIn = await post("/answer", { CallUUID: "uuid_sip_in", From: "+19998887771", To: "+12003004005", Direction: "inbound" });
      assert.ok(sipIn.text.includes("<User>sip:deskphone01@registrar.vobiz.ai</User>") && sipIn.text.includes('callerId="+12003004005"'), "its number rings it");
      for (const [p, method] of [["/recordings", "GET"], ["/setup-inbound", "POST"], ["/agent", "GET"], ["/dial-requests", "GET"], ["/select-number", "POST"]]) {
        const r = method === "GET" ? await get(p, sipTok) : await post(p, { number: "+12003004005" }, sipTok);
        assert.strictEqual(r.status, 403, `SIP direct cannot use ${p}`);
        assert.ok(/Sign in with your Vobiz account/.test(r.json.error), "and is told to sign in with the account");
      }
      assert.strictEqual((await get("/call-record?to=+15550120", sipTok)).json.found, true, "SIP direct sees its own calls");
      assert.strictEqual((await get("/call-record?to=+15550199", sipTok)).json.found, false, "but not an account's");
      assert.strictEqual((await get(`/play-recording?callUuid=uuid_out_1`, sipTok)).status, 403, "nor its recordings");
      assert.strictEqual(
        (await post("/start-call", { to: "+15550199", agentId: "test-agent" }, sipTok)).status,
        401,
        "nor the click-to-call button"
      );
      ok("SIP direct works with typed credentials only and is scoped to its own endpoint");

      // ── Security properties ──
      assert.strictEqual((await get(`/recording-file?url=${encodeURIComponent("http://127.0.0.1:1/steal")}`)).status, 410);
      assert.strictEqual((await get("/recording-audio/rec_123")).status, 403, "unsigned recording-audio refused");
      assert.strictEqual((await get("/recording-audio/rec_123?acct=MA_TEST0001&exp=99999999999&sig=deadbeef")).status, 403, "forged signature refused");
      assert.strictEqual((await get("/play-recording?callUuid=uuid_out_1")).status, 403, "unsigned play-recording refused");
      assert.strictEqual((await get("/agent/test-agent")).status, 401, "/agent needs a session");
      assert.strictEqual((await get("/agent/nobody")).status, 401);
      assert.strictEqual((await get("/session/test-agent")).json.loggedIn, false, "an agent id in the path proves nothing");
      assert.strictEqual((await get("/recordings")).status, 401);
      assert.strictEqual((await post("/setup-inbound", {})).status, 401);

      const health = await get("/health");
      assert.strictEqual(health.json.accountsSignedIn, 2);
      assert.ok(!health.text.includes("MA_TEST") && !health.text.includes(sipOne) && !health.text.includes("+1200"), "/health publishes no account data");

      const cors = await call("/health", { headers: { Origin: "https://evil.example" } });
      assert.ok(!cors.headers.get("access-control-allow-origin"), "an unknown origin is not echoed back");

      await post("/logout", {}, two.json.token);
      const afterLogout = await post("/answer", { CallUUID: "uuid_in_y", From: "+19998887774", To: "+12003004002" });
      assert.ok(afterLogout.text.includes("<Hangup/>"), "a signed-out agent is no longer rung");
      ok("security properties held");

      // The Auth Token never leaves the backend: not in a response, not in a log.
      for (const t of [ACCOUNTS.MA_TEST0001.token, ACCOUNTS.MA_TEST0002.token, "not_the_token"]) {
        assert.ok(!responseBodies.some((b) => b.includes(t)), `an Auth Token appeared in an HTTP response`);
        assert.ok(!serverLog.join("").includes(t), "an Auth Token appeared in the server log");
      }
      ok(`no Auth Token in any of ${responseBodies.length} HTTP responses or the log`);

      console.log("\n=========================");
      console.log(`ALL ${passed} TESTS PASSED SUCCESSFULLY`);
      console.log("=========================");
    } catch (err) {
      console.error("\n[test] ❌ TEST SUITE FAILED:", err);
      process.exitCode = 1;
    } finally {
      try {
        mockServer.close();
      } catch {}
      try {
        serverProc.kill();
      } catch {}
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
      } catch {}
      setTimeout(() => process.exit(process.exitCode || 0), 200);
    }
  }
});
