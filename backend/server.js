/**
 * Vobiz Calling Bridge for ServiceNow CRM.
 *
 * Architecture: Browser is the A-leg. The softphone sends the SIP INVITE
 * itself and this service answers with <Dial><Number> to reach the customer.
 * Inbound calls route to <Dial><User> to bridge to the agent's softphone.
 * Completed calls and recordings are automatically synchronized with the
 * ServiceNow CRM interaction table.
 */
const http = require("http");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");

if (typeof process.loadEnvFile === "function") {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

const cleanEnvVar = (val) => (val ? val.trim().replace(/^["']|["']$/g, "") : "");

// ─── Configuration ───────────────────────────────────────────────────────────
const PORT = Number(cleanEnvVar(process.env.PORT) || 8092);
const VOBIZ_AUTH_ID = cleanEnvVar(process.env.VOBIZ_AUTH_ID);
const VOBIZ_AUTH_TOKEN = cleanEnvVar(process.env.VOBIZ_AUTH_TOKEN);
const VOBIZ_FROM_NUMBER = cleanEnvVar(process.env.VOBIZ_FROM_NUMBER);
const VOBIZ_SIP_USER = cleanEnvVar(process.env.VOBIZ_SIP_USER);
const VOBIZ_SIP_PASSWORD = cleanEnvVar(process.env.VOBIZ_SIP_PASSWORD);
const VOBIZ_REGISTRAR = cleanEnvVar(process.env.VOBIZ_REGISTRAR) || "registrar.vobiz.ai";
const VOBIZ_API_URL = cleanEnvVar(process.env.VOBIZ_API_URL) || "https://api.vobiz.ai";
const VOBIZ_SHARED_SECRET = cleanEnvVar(process.env.VOBIZ_SHARED_SECRET || process.env.SHARED_SECRET);
const DEFAULT_AGENT_ID = cleanEnvVar(process.env.DEFAULT_AGENT_ID) || "admin";

const SERVICENOW_INSTANCE_URL = cleanEnvVar(process.env.SERVICENOW_INSTANCE_URL);
const SERVICENOW_USER = cleanEnvVar(process.env.SERVICENOW_USER);
const SERVICENOW_PASSWORD = cleanEnvVar(process.env.SERVICENOW_PASSWORD);

const SIGNING_SECRET = cleanEnvVar(process.env.SIGNING_SECRET) || crypto.randomBytes(32).toString("hex");
const RECORDING_URL_TTL_SECONDS = Number(cleanEnvVar(process.env.RECORDING_URL_TTL_SECONDS) || 300);

const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");
function getPublicBaseUrl() {
  if (process.env.TUNNEL_URL) {
    return cleanEnvVar(process.env.TUNNEL_URL).replace(/\/+$/, "");
  }
  try {
    const url = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    return url ? url.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

const AGENTS_FILE = path.join(__dirname, "agents.json");

/**
 * Agent display metadata. Deliberately carries no SIP password.
 *
 * agents.json is committed, so a password written into it is a published
 * password. The SIP password comes from the environment and is served only to
 * a signed-in caller, by the /agent route below.
 */
function getAgent(agentId) {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
      if (agents[agentId]) {
        const a = agents[agentId];
        const sipUser = a.sipUser || `${agentId}@${VOBIZ_REGISTRAR}`;
        return {
          displayName: a.displayName || a.name || agentId,
          sipUser: sipUser.includes("@") ? sipUser : `${sipUser}@${VOBIZ_REGISTRAR}`,
        };
      }
    }
  } catch (err) {
    console.warn("[backend] Error reading agents.json:", err.message);
  }
  const effectiveSipUser = VOBIZ_SIP_USER || (agentId.includes("@") ? agentId : `${agentId}@${VOBIZ_REGISTRAR}`);
  return {
    displayName: `${agentId} (Vobiz)`,
    sipUser: effectiveSipUser.includes("@") ? effectiveSipUser : `${effectiveSipUser}@${VOBIZ_REGISTRAR}`,
  };
}

// ─── State ───────────────────────────────────────────────────────────────────
// Session Token -> { agentId, authId, numbers, from, createdAt }
const sessions = new Map();
// SIP Username -> caller ID mapping
const fromBySipUser = new Map();
// CallUUID -> CDR record
const callsByUuid = new Map();
const recentCalls = []; // newest first, capped at 200
// Active calls tracking for /start-call backwards compatibility
const activeCalls = new Map();

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function newSession(agentId, authId, numbers, from) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { agentId, authId, numbers, from, createdAt: Date.now() });
  return token;
}

function getSession(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/**
 * Guard for every route that spends money, changes account configuration, or
 * reads call data. Returns false and answers 401 when there is no session, so
 * a caller reads `if (!requireSession(req, res)) return;`.
 */
function requireSession(req, res) {
  if (getSession(req)) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Sign in first" }));
  return false;
}

function rememberCall(record) {
  callsByUuid.set(record.callUuid, record);
  recentCalls.unshift(record);
  while (recentCalls.length > 200) {
    const dropped = recentCalls.pop();
    if (dropped) callsByUuid.delete(dropped.callUuid);
  }
}

// ─── Vobiz REST Client ───────────────────────────────────────────────────────
async function vobiz(method, apiPath, body) {
  const base = VOBIZ_API_URL.replace(/\/+$/, "");
  const authId = VOBIZ_AUTH_ID || "";
  const url = `${base}/api/v1/Account/${authId}${apiPath}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "X-Auth-ID": VOBIZ_AUTH_ID,
        "X-Auth-Token": VOBIZ_AUTH_TOKEN,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await res.text();
    let parsed = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep raw */
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, body: { error: err.message } };
  }
}

// ─── Recording URL Signing ───────────────────────────────────────────────────
//
// A plain <audio> element cannot send an Authorization header, and these links
// are written into ServiceNow interaction work notes, where every agent on the
// instance can read them for as long as the record exists. So a playback link
// carries its own short-lived proof — and never account credentials.
function signRecordingUrl(recordingId) {
  const publicBase = getPublicBaseUrl();
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(`${recordingId}|${exp}`).digest("hex");
  return `${publicBase || ""}/recording-audio/${encodeURIComponent(recordingId)}?exp=${exp}&sig=${sig}`;
}

function signCallPlaybackUrl(callUuid) {
  const publicBase = getPublicBaseUrl() || `http://localhost:${PORT}`;
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(`${callUuid}|${exp}`).digest("hex");
  return `${publicBase}/play-recording?callUuid=${encodeURIComponent(callUuid)}&exp=${exp}&sig=${sig}`;
}

function verifyRecordingSignature(recordingId, exp, sig) {
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac("sha256", SIGNING_SECRET).update(`${recordingId}|${exp}`).digest("hex");
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Hosts this server is willing to fetch call media from. Anything else is
// refused — before the request is made, and again after every redirect.
const MEDIA_HOST_ALLOWLIST = [
  /(^|\.)vobiz\.ai$/i,
  /(^|\.)s3[.-][a-z0-9-]+\.amazonaws\.com$/i,
  /(^|\.)s3\.amazonaws\.com$/i,
];

function isAllowedMediaHost(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return MEDIA_HOST_ALLOWLIST.some((re) => re.test(u.hostname));
}

// ─── Audio Streaming Helper ──────────────────────────────────────────────────
//
// The account credentials go out on this request, so the destination is never
// allowed to come from a caller. Every URL reaching here has been resolved
// server-side from a recording ID and checked against the host allowlist, and
// each redirect is re-checked before it is followed — a presigned object-storage
// URL carries its own authorisation, so ours is dropped on the way.
async function streamAudioToClient(targetUrl, res) {
  try {
    if (!isAllowedMediaHost(targetUrl)) {
      console.error(`[backend] refusing off-allowlist media host: ${targetUrl}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Recording is hosted somewhere this server will not fetch from" }));
      return;
    }

    console.log(`[backend] Streaming recording audio from: ${targetUrl}`);
    let vobizRes = await fetch(targetUrl, {
      headers: {
        "X-Auth-ID": VOBIZ_AUTH_ID,
        "X-Auth-Token": VOBIZ_AUTH_TOKEN,
      },
      redirect: "manual",
    });

    let hops = 0;
    while (vobizRes.status >= 300 && vobizRes.status < 400 && hops < 3) {
      const location = vobizRes.headers.get("location");
      if (!location) break;
      const next = new URL(location, targetUrl).toString();
      if (!isAllowedMediaHost(next)) {
        console.error(`[backend] refusing redirect to ${next}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Recording redirected somewhere this server will not follow" }));
        return;
      }
      console.log(`[backend] Recording stream redirected to: ${next}`);
      vobizRes = await fetch(next, { redirect: "manual" });
      hops++;
    }

    if (!vobizRes.ok) {
      console.error("[backend] Upstream audio fetch failed HTTP", vobizRes.status);
      res.writeHead(vobizRes.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Vobiz returned ${vobizRes.status} fetching recording audio` }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": vobizRes.headers.get("content-type") || "audio/mpeg",
      "Content-Length": vobizRes.headers.get("content-length") || "",
      "Accept-Ranges": "bytes",
      "Content-Disposition": 'inline; filename="recording.mp3"',
    });

    const reader = vobizRes.body.getReader();
    async function push() {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(value);
      await push();
    }
    await push();
  } catch (err) {
    console.error("[backend] Recording stream failed:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Could not stream recording: ${err.message}` }));
  }
}

// ─── ServiceNow CRM Integration ──────────────────────────────────────────────
async function getServiceNowUserSysId(username) {
  if (!SERVICENOW_INSTANCE_URL || !SERVICENOW_USER || !SERVICENOW_PASSWORD) {
    return null;
  }
  const cleanUrl = SERVICENOW_INSTANCE_URL.replace(/\/$/, "");
  const auth = Buffer.from(`${SERVICENOW_USER}:${SERVICENOW_PASSWORD}`).toString("base64");
  try {
    const res = await fetch(
      `${cleanUrl}/api/now/table/sys_user?sysparm_query=user_name=${encodeURIComponent(username)}&sysparm_fields=sys_id`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.result && json.result[0] ? json.result[0].sys_id : null;
  } catch (err) {
    console.error("[backend] Error fetching user sys_id from ServiceNow:", err.message);
    return null;
  }
}

function formatServiceNowDate(date) {
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

async function createServiceNowInteraction(callData) {
  if (!SERVICENOW_INSTANCE_URL || !SERVICENOW_USER || !SERVICENOW_PASSWORD) {
    console.log("[backend] ServiceNow credentials not configured. Skipping interaction creation.");
    return null;
  }
  const { to, agentId, durationSeconds, recordingUrl, from, callDirection = "Outbound", notes = "" } = callData;
  const cleanUrl = SERVICENOW_INSTANCE_URL.replace(/\/$/, "");
  const userSysId = await getServiceNowUserSysId(agentId);
  const auth = Buffer.from(`${SERVICENOW_USER}:${SERVICENOW_PASSWORD}`).toString("base64");

  const recordLink = recordingUrl
    ? `[code]<a href="${recordingUrl}" target="_blank" style="color: #ea580c; text-decoration: underline; font-weight: bold;">Listen to Recording</a>[/code]`
    : "No recording file generated";

  const now = new Date();
  const opened = new Date(now.getTime() - ((durationSeconds || 0) * 1000));

  const payload = {
    type: "phone",
    state: "closed_complete",
    opened_at: formatServiceNowDate(opened),
    closed_at: formatServiceNowDate(now),
    short_description: `Vobiz ${callDirection} Call: ${to}`,
    recording_url: recordingUrl || "",
    work_notes: `Vobiz Call Details:\nDirection: ${callDirection}\nFrom: ${from}\nTo: ${to}\nDuration: ${durationSeconds || 0} seconds\nRecording: ${recordLink}${notes ? `\nNotes: ${notes}` : ""}`,
  };

  if (userSysId) {
    payload.assigned_to = userSysId;
  } else if (agentId) {
    payload.work_notes += `\nAgent: ${agentId}`;
  }

  try {
    const res = await fetch(`${cleanUrl}/api/now/table/interaction`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    console.log("[backend] ServiceNow Interaction created successfully:", res.status, json.result ? json.result.number : json);
    return json;
  } catch (err) {
    console.error("[backend] Error creating interaction in ServiceNow:", err.message);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function toE164(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return s;
  if (s.startsWith("0") && s.length === 11) return `+91${s.slice(1)}`;
  const digits = s.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

// Origins allowed to drive this backend. A wildcard would let any page on the
// internet read what this server exposes and place calls billed to the account.
//
// ServiceNow serves OpenFrame and the agent workspace from the customer's own
// *.service-now.com instance; ALLOWED_ORIGINS adds anything else you host the
// softphone on.
const ORIGIN_ALLOWLIST = [
  /^https:\/\/[a-z0-9-]+\.service-now\.com$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];
const EXTRA_ORIGINS = cleanEnvVar(process.env.ALLOWED_ORIGINS)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function withCors(res, req) {
  const origin = req && req.headers && req.headers.origin;
  if (origin && (EXTRA_ORIGINS.includes(origin) || ORIGIN_ALLOWLIST.some((re) => re.test(origin)))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Vobiz-Secret, ngrok-skip-browser-warning");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch {}
      try {
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ─── Webhooks Vobiz Calls ────────────────────────────────────────────────────
function handleAnswer(req, res, queryParams, bodyParams) {
  const p = { ...queryParams, ...bodyParams };
  console.log(`[backend] WEBHOOK /answer received:`, JSON.stringify(p).slice(0, 300));

  res.writeHead(200, { "Content-Type": "text/xml" });

  if ((p.Event || p.event) === "Hangup") {
    return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
  }

  const callUuid = String(p.CallUUID || p.call_uuid || "");
  const from = String(p.From || p.from || "");
  const to = String(p.To || p.to || "");
  const routeType = String(p.RouteType || p.routetype || "").toLowerCase();
  const isFromBrowser = from.startsWith("sip:") || routeType === "sip";

  const publicBase = getPublicBaseUrl() || `http://localhost:${PORT}`;
  const dialStatusUrl = `${publicBase}/dial-status`;
  const recordCallbackUrl = `${publicBase}/recording-ready`;

  // <Record> as a self-closing sibling BEFORE <Dial>
  const recordXml = `<Record fileFormat="mp3" recordSession="true" maxLength="3600" playBeep="false" redirect="false" callbackUrl="${recordCallbackUrl}" callbackMethod="POST"/>`;

  if (isFromBrowser) {
    // Browser dialed out to customer
    const sipUser = (from.match(/^sip:([^@]+)@/) || [])[1] || VOBIZ_SIP_USER || "agent";
    const sipHeaderCallerId =
      p["SIPHeader_X-VH-Caller-ID"] ||
      p["SIPHeader_X-PH-Caller-ID"] ||
      p["X-VH-Caller-ID"] ||
      p["X-PH-Caller-ID"] ||
      p.CallerID ||
      p.caller_id;
    const callerId = sipHeaderCallerId || fromBySipUser.get(sipUser) || VOBIZ_FROM_NUMBER;
    const destination = to.replace(/[^\d+]/g, "");

    rememberCall({
      callUuid,
      direction: "Outbound",
      agentSipUser: sipUser,
      from: callerId,
      to: destination,
      startedAt: Date.now(),
    });

    console.log(`[backend] -> Browser is A-leg: dialing out to ${destination} as callerId=${callerId}`);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${recordXml}\n` +
      `  <Dial callerId="${callerId}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">\n` +
      `    <Number>${destination}</Number>\n  </Dial>\n</Response>`;
    return res.end(xml);
  }

  // Inbound call from PSTN customer
  const callerId = toE164(to) || VOBIZ_FROM_NUMBER;
  const targetSipUser = VOBIZ_SIP_USER || DEFAULT_AGENT_ID || "admin";
  rememberCall({
    callUuid,
    direction: "Inbound",
    agentSipUser: targetSipUser,
    from,
    to: callerId,
    startedAt: Date.now(),
  });

  console.log(`[backend] -> Inbound call from ${from}, bridging to sip:${targetSipUser}@${VOBIZ_REGISTRAR}`);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${recordXml}\n` +
    `  <Dial callerId="${callerId}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">\n` +
    `    <User>sip:${targetSipUser}@${VOBIZ_REGISTRAR}</User>\n  </Dial>\n</Response>`;
  return res.end(xml);
}

function handleDialStatus(req, res, params) {
  const d = params;
  const bleg = d.DialBLegUUID || "";
  console.log(
    `[backend] DIAL RESULT status=${d.DialStatus || "-"} ring=${d.DialRingStatus || "-"} cause=${d.DialHangupCause || "-"} bleg=${bleg || "(none)"} dur=${d.DialBLegDuration || "-"}`
  );

  const callUuid = String(d.CallUUID || d.call_uuid || "");
  const rec = callsByUuid.get(callUuid);
  if (rec) {
    rec.dialStatus = d.DialStatus;
    rec.hangupCause = d.DialHangupCause;
    rec.bLegUuid = bleg || null;
    rec.duration = Number(d.DialBLegDuration || 0);
    rec.endedAt = Date.now();
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}

async function handleRecordingReady(req, res, params) {
  const d = params;
  const callUuid = String(d.CallUUID || d.call_uuid || "");
  const recordingId = d.RecordingID || d.RecordingId || d.recording_id || null;
  const recordingUrl = d.RecordUrl || d.RecordFile || d.recording_url || null;
  const duration = Number(d.RecordingDuration || d.duration || 0);

  console.log(`[backend] RECORDING READY call=${callUuid} id=${recordingId || "-"} duration=${duration}s`);

  const rec = callsByUuid.get(callUuid);
  if (rec) {
    rec.recordingId = recordingId;
    rec.recordingUrl = recordingUrl;
    rec.recordingDuration = duration;

    // Auto-create ServiceNow interaction if configured
    const playLink = signCallPlaybackUrl(callUuid);
    await createServiceNowInteraction({
      to: rec.to,
      from: rec.from,
      agentId: rec.agentSipUser || DEFAULT_AGENT_ID,
      durationSeconds: rec.duration || duration,
      recordingUrl: playLink,
      callDirection: rec.direction || "Outbound",
    });
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "captured" }));
}

// ─── Setup Vobiz Application Binding ─────────────────────────────────────────
async function bindEndpointToApp() {
  const publicBase = getPublicBaseUrl();
  if (!publicBase || !publicBase.startsWith("https://")) {
    console.log("[backend] Notice: PUBLIC_BASE / TUNNEL_URL is not public HTTPS. Skipping Vobiz application auto-bind.");
    return null;
  }

  const answerUrl = `${publicBase}/answer`;
  console.log(`[backend] Checking Vobiz application bindings for ${answerUrl}...`);

  const appsRes = await vobiz("GET", "/Application/?limit=50");
  const existing = ((appsRes.body && appsRes.body.objects) || []).find((a) => a.answer_url === answerUrl);

  let appId = existing && (existing.app_id || existing.id);
  if (!appId) {
    const created = await vobiz("POST", "/Application/", {
      app_name: "ServiceNow Calling (Vobiz)",
      answer_url: answerUrl,
      answer_method: "POST",
      hangup_url: answerUrl,
      hangup_method: "POST",
    });
    if (created.status >= 400) {
      console.warn("[backend] Could not create Vobiz application:", JSON.stringify(created.body).slice(0, 200));
      return null;
    }
    appId = created.body && (created.body.app_id || created.body.id);
  }

  if (!appId) return null;

  if (VOBIZ_SIP_USER) {
    const epRes = await vobiz("GET", "/Endpoint/?limit=100");
    const endpoint = ((epRes.body && epRes.body.objects) || []).find((e) => e.username === VOBIZ_SIP_USER);
    if (endpoint) {
      await vobiz("POST", `/Endpoint/${encodeURIComponent(endpoint.endpoint_id || endpoint.id)}/`, { app_id: appId });
      console.log(`[backend] Bound SIP endpoint ${VOBIZ_SIP_USER} to app ${appId}`);
    }
  }

  if (VOBIZ_FROM_NUMBER) {
    try {
      const cleanNum = VOBIZ_FROM_NUMBER.replace(/[^\d+]/g, "");
      await vobiz("POST", `/Number/${encodeURIComponent(cleanNum)}/`, { app_id: appId });
      console.log(`[backend] Bound phone number ${cleanNum} to app ${appId}`);
    } catch (e) {
      console.warn("[backend] Note binding number:", e.message);
    }
  }

  return { appId, answerUrl };
}

// ─── HTTP Server & Routing ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  withCors(res, req);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const queryParams = Object.fromEntries(parsedUrl.searchParams.entries());

  // Static files from agent-phone
  if (pathname === "/" || pathname === "/index.html" || pathname === "/agent-phone" || pathname === "/agent-phone.html") {
    const htmlPath = path.join(__dirname, "../agent-phone/agent-phone.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(htmlPath));
    }
  }

  if (pathname.startsWith("/styles/")) {
    const filePath = path.join(__dirname, "../agent-phone", pathname);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "text/css" });
      return res.end(fs.readFileSync(filePath));
    }
  }

  if (pathname.startsWith("/scripts/")) {
    const filePath = path.join(__dirname, "../agent-phone", pathname);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(fs.readFileSync(filePath));
    }
  }

  if (pathname.startsWith("/lib/")) {
    const filePath = path.join(__dirname, "../agent-phone", pathname);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(fs.readFileSync(filePath));
    }
  }

  if (pathname.startsWith("/assets/")) {
    const filePath = path.join(__dirname, "../agent-phone", pathname);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      return res.end(fs.readFileSync(filePath));
    }
  }

  if (pathname === "/agent-phone.bundle.js") {
    const bundlePath = path.join(__dirname, "../agent-phone/agent-phone.bundle.js");
    if (fs.existsSync(bundlePath)) {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(fs.readFileSync(bundlePath));
    }
  }

  // ── Webhooks (GET & POST) ──
  if (pathname === "/answer" || pathname === "/inbound-answer") {
    let body = {};
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch {}
    }
    return handleAnswer(req, res, queryParams, body);
  }

  if (pathname === "/dial-status") {
    let body = {};
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch {}
    }
    return handleDialStatus(req, res, { ...queryParams, ...body });
  }

  if (pathname === "/recording-ready" || pathname === "/recording-callback") {
    let body = {};
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch {}
    }
    return handleRecordingReady(req, res, { ...queryParams, ...body });
  }

  if (pathname === "/hangup-callback" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const callUuid = body.CallUUID || body.call_uuid || body.ALegUUID || body.RequestUUID;
      const duration = parseInt(body.Duration || body.duration || 0);
      console.log(`[backend] Hangup callback received for ${callUuid}, duration: ${duration}s`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "completed" }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── Authentication & Sessions ──
  if (pathname === "/login" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { agentId, authId, authToken } = body;
      if (!agentId || !authId || !authToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "agentId, authId and authToken are required" }));
      }

      // Credentials are proven, not assumed — including when this server is
      // not bound to an account, where the temptation is to accept anything
      // that looks like a key.
      let isValid = false;
      if (VOBIZ_AUTH_ID && authId === VOBIZ_AUTH_ID && authToken === VOBIZ_AUTH_TOKEN) {
        isValid = true;
      } else if (VOBIZ_AUTH_ID) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: `This backend is bound to account ${VOBIZ_AUTH_ID}. You signed in as ${authId}.`,
          })
        );
      } else {
        // Unbound backend: ask Vobiz whether these credentials are real.
        // 405 means the resource exists and rejected the verb, which still
        // proves the credentials were accepted.
        try {
          const check = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(authId)}/`, {
            headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken, Accept: "application/json" },
          });
          isValid = check.ok || check.status === 405;
          if (!isValid) console.log(`[backend] Vobiz rejected ${authId}: HTTP ${check.status}`);
        } catch (e) {
          console.error("[backend] Could not reach Vobiz to validate credentials:", e.message);
          isValid = false;
        }
      }

      if (!isValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid Vobiz Auth ID or Auth Token." }));
      }

      // Fetch account numbers from Vobiz API
      const r = await vobiz("GET", "/numbers?per_page=25");
      let numbers = [];
      if (r.body && (r.body.objects || r.body.items)) {
        numbers = (r.body.objects || r.body.items).map((n) => n.e164 || n.number || n.phone_number).filter(Boolean);
      }
      if (VOBIZ_FROM_NUMBER && !numbers.includes(VOBIZ_FROM_NUMBER)) {
        numbers.unshift(VOBIZ_FROM_NUMBER);
      }

      const token = newSession(agentId, authId, numbers, VOBIZ_FROM_NUMBER);
      if (VOBIZ_SIP_USER) fromBySipUser.set(VOBIZ_SIP_USER, VOBIZ_FROM_NUMBER);

      console.log(`[backend] Login ok: agent=${agentId}, numbers=${numbers.length}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ token, numbers, selected: VOBIZ_FROM_NUMBER, authId }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // The bearer token is the only thing that identifies a session.
  //
  // The /session/<agentId> form is accepted so older widgets do not 404, but the
  // id in the path proves nothing on its own: agent ids are ServiceNow
  // usernames, so answering from them would hand the account's Auth ID and
  // phone numbers to anyone who can guess one.
  if (pathname === "/session" || pathname.startsWith("/session/")) {
    const s = getSession(req);
    if (s) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ loggedIn: true, agentId: s.agentId, authId: s.authId, numbers: s.numbers, from: s.from })
      );
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ loggedIn: false }));
  }

  if (pathname === "/logout" && req.method === "POST") {
    const header = req.headers["authorization"] || "";
    if (header.startsWith("Bearer ")) sessions.delete(header.slice(7));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === "/login-sip" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { sipUser, callerId } = body;
      if (!sipUser || !callerId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "sipUser and callerId are required" }));
      }
      const cleanUser = String(sipUser).replace(/^sip:/, "").split("@")[0];

      // The caller ID is what the customer's handset displays and what the
      // carrier bills against, so it has to be a number the account actually
      // owns. An arbitrary string here is caller-ID spoofing on the account.
      const numRes = await vobiz("GET", "/numbers?per_page=50");
      const owned = (((numRes.body && (numRes.body.objects || numRes.body.items)) || [])
        .map((n) => n.e164 || n.number || n.phone_number)
        .filter(Boolean));
      if (VOBIZ_FROM_NUMBER) owned.push(VOBIZ_FROM_NUMBER);
      const wanted = toE164(callerId);
      if (owned.length > 0 && !owned.some((n) => toE164(n) === wanted)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: `${callerId} is not a number on this Vobiz account, so it cannot be a caller ID.` })
        );
      }

      fromBySipUser.set(cleanUser, callerId);

      // A session scoped to SIP-direct mode. It carries no account credentials
      // and /agent refuses it: an agent signing in this way already holds their
      // own SIP password, and serving the account's password to anyone who can
      // name an endpoint and a DID would defeat the point of gating it.
      const token = newSession(cleanUser, null, [callerId], callerId);
      sessions.get(token).mode = "sip";

      console.log(`[backend] SIP direct registered: ${cleanUser} -> ${callerId}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, token, sipUser: cleanUser, callerId }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === "/select-number" && req.method === "POST") {
    if (!requireSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const { number } = body;
      const s = getSession(req);
      if (s) {
        s.from = number;
      }
      if (VOBIZ_SIP_USER) fromBySipUser.set(VOBIZ_SIP_USER, number);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ selected: number }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // SIP credentials for the softphone to register with.
  //
  // Behind the session deliberately: SIP credentials let anyone place calls
  // billed to this account. An unknown agent id is refused rather than filled in
  // with a default, because a fallback here means the password is served to
  // whoever asks.
  if (pathname === "/agent" || pathname.startsWith("/agent/")) {
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Sign in first" }));
    }
    if (session.mode === "sip") {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: "SIP-direct sessions register with the password the agent supplied, not this one." })
      );
    }
    if (!VOBIZ_SIP_USER || !VOBIZ_SIP_PASSWORD) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: "VOBIZ_SIP_USER / VOBIZ_SIP_PASSWORD are not configured on this server" })
      );
    }
    const agent = getAgent(session.agentId || DEFAULT_AGENT_ID);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        displayName: agent.displayName,
        sipUser: `${VOBIZ_SIP_USER}@${VOBIZ_REGISTRAR}`,
        sipPassword: VOBIZ_SIP_PASSWORD,
        registrarUrl: `wss://${VOBIZ_REGISTRAR}:5063/`,
      })
    );
  }

  // ── CDR & Recordings ──
  if (pathname === "/call-record" && req.method === "GET") {
    if (!requireSession(req, res)) return;
    const wanted = String(queryParams.to || "").replace(/[^\d+]/g, "");
    const rec = recentCalls.find(
      (c) => !wanted || String(c.to).replace(/[^\d+]/g, "").endsWith(wanted.slice(-10))
    );
    if (!rec) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ found: false }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        found: true,
        callUuid: rec.callUuid,
        direction: rec.direction,
        from: rec.from,
        to: rec.to,
        duration: rec.duration || 0,
        dialStatus: rec.dialStatus || null,
        bLegUuid: rec.bLegUuid || null,
        recordingId: rec.recordingId || null,
        recordingUrl: signCallPlaybackUrl(rec.callUuid),
      })
    );
  }

  if (pathname === "/recordings" || pathname.startsWith("/recordings/")) {
    if (!requireSession(req, res)) return;
    const limit = Math.min(Number(queryParams.limit || 15), 50);
    const r = await vobiz("GET", `/Recording/?limit=${limit}`);
    const objects = ((r.body && r.body.objects) || []).map((o) => ({
      recording_id: o.recording_id,
      add_time: o.add_time,
      rounded_recording_duration: o.rounded_recording_duration,
      call_uuid: o.call_uuid,
      playUrl: signRecordingUrl(o.recording_id),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ objects, recordings: objects }));
  }

  if (pathname === "/play-recording") {
    const callUuid = queryParams.callUuid || queryParams.call_uuid;
    const recordingId = queryParams.recordingId || queryParams.recording_id;

    // These links live in ServiceNow work notes, so they are opened by a
    // browser with no session. A valid signature is the proof; a signed-in
    // caller from the softphone is the other accepted proof. A link that cannot
    // be resolved to its own call is refused — never answered with whatever
    // recording is most recent.
    const signedFor = callUuid || recordingId;
    if (!verifyRecordingSignature(signedFor, queryParams.exp, queryParams.sig) && !getSession(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "This playback link is invalid or has expired." }));
    }

    try {
      let targetAudioUrl = null;
      if (recordingId) {
        const meta = await vobiz("GET", `/Recording/${encodeURIComponent(recordingId)}/`);
        targetAudioUrl = meta.body && (meta.body.recording_url || meta.body.url || meta.body.file);
      }
      if (!targetAudioUrl && callUuid) {
        const recList = await vobiz("GET", `/Recording/?call_uuid=${encodeURIComponent(callUuid)}`);
        const items = (recList.body && (recList.body.objects || recList.body.items)) || [];
        if (items.length > 0) {
          targetAudioUrl = items[0].recording_url || items[0].url || items[0].file;
        }
      }

      // No "latest recording on the account" fallback. A link that cannot be
      // resolved to its own call says so, rather than playing someone else's.
      if (!targetAudioUrl) {
        res.writeHead(404, { "Content-Type": "text/html" });
        return res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h2>No Recording File Available</h2>
          <p>Recording is still processing or duration was 0s.</p>
          <code>Call UUID: ${callUuid || "N/A"}</code>
        </body></html>`);
      }

      return await streamAudioToClient(targetAudioUrl, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname.startsWith("/recording-audio/")) {
    const parts = pathname.slice("/recording-audio/".length).split("/");
    const recordingId = decodeURIComponent(parts[parts.length - 1]);

    // signRecordingUrl() has always produced exp and sig for these links, but
    // nothing verified them: recording IDs were enumerable by anyone who could
    // reach the tunnel.
    if (!verifyRecordingSignature(recordingId, queryParams.exp, queryParams.sig) && !getSession(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid or expired playback signature" }));
    }

    try {
      const meta = await vobiz("GET", `/Recording/${encodeURIComponent(recordingId)}/`);
      const src = meta.body && (meta.body.recording_url || meta.body.url);
      if (!src) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "No audio available" }));
      }
      return await streamAudioToClient(src, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // GET /recording-file?url=… is deliberately not implemented, and says so.
  //
  // Fetching a caller-supplied URL with the account credentials attached —
  //
  //     await fetch(targetUrl, { headers: { "X-Auth-ID": …, "X-Auth-Token": … } })
  //
  // — is a credential-exfiltration primitive, not merely SSRF: it posts the
  // account Auth Token to any host a caller names. Playback goes through
  // /recording-audio/<id>, which takes an id, resolves the media URL
  // server-side, and demands a signature.
  if (pathname === "/recording-file") {
    res.writeHead(410, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        error: "This endpoint has been removed. Use the signed /recording-audio/<recordingId> link instead.",
      })
    );
  }

  // ── CRM Write-back ──
  if (pathname === "/sync-call" && req.method === "POST") {
    if (!requireSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const { toNumber, duration, callDirection, agentId, notes, callUuid } = body;
      const rec = callUuid ? callsByUuid.get(callUuid) : null;
      const recordingUrl = callUuid ? signCallPlaybackUrl(callUuid) : "";

      const result = await createServiceNowInteraction({
        to: toNumber || (rec && rec.to),
        from: (rec && rec.from) || VOBIZ_FROM_NUMBER,
        durationSeconds: duration || (rec && rec.duration) || 0,
        recordingUrl,
        callDirection: callDirection || (rec && rec.direction) || "Outbound",
        agentId: agentId || (rec && rec.agentSipUser) || DEFAULT_AGENT_ID,
        notes,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true, result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── Setup Application ──
  if ((pathname === "/setup" || pathname === "/setup-inbound") && req.method === "POST") {
    if (!requireSession(req, res)) return;
    const result = await bindEndpointToApp();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: true,
        appId: result ? result.appId : null,
        message: result ? "Application bound successfully" : "Setup complete",
      })
    );
  }

  // ── Backwards compatibility: ServiceNow Form Button /start-call ──
  if (pathname === "/start-call" && req.method === "POST") {
    try {
      const publicBaseUrl = getPublicBaseUrl();
      const body = await readJsonBody(req);
      // This route spends money: it originates a call on the account. A caller
      // must present either the shared secret the ServiceNow UI Action sends,
      // or a softphone session — never neither, including when the secret is
      // simply not configured.
      const providedSecret = req.headers["x-vobiz-secret"] || req.headers["x-api-key"] || body.secret;
      const secretOk = Boolean(VOBIZ_SHARED_SECRET) && providedSecret === VOBIZ_SHARED_SECRET;
      if (!secretOk && !getSession(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: VOBIZ_SHARED_SECRET
              ? "unauthorized: invalid or missing shared secret"
              : "unauthorized: set VOBIZ_SHARED_SECRET and send it as X-Vobiz-Secret, or sign in first",
          })
        );
      }

      const { to, agentId: reqAgentId } = body;
      if (!to) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "missing 'to' number" }));
      }

      const agent = getAgent(reqAgentId || DEFAULT_AGENT_ID);
      const answerUrl = `${publicBaseUrl || `http://localhost:${PORT}`}/answer?agentId=${encodeURIComponent(reqAgentId || DEFAULT_AGENT_ID)}`;
      const params = new URLSearchParams({
        to,
        from: VOBIZ_FROM_NUMBER,
        answer_url: answerUrl,
        answer_method: "POST",
        hangup_url: `${publicBaseUrl || `http://localhost:${PORT}`}/hangup-callback`,
        hangup_method: "POST",
      });

      const auth = Buffer.from(`${VOBIZ_AUTH_ID}:${VOBIZ_AUTH_TOKEN}`).toString("base64");
      const vobizRes = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/Call/`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      const vobizJson = await vobizRes.json();
      res.writeHead(vobizRes.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(vobizJson));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── Health Check ──
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        // Health is unauthenticated, so it reports whether things are
        // configured, never what they are — publishing the account Auth ID, the
        // DID or the SIP username here would hand them to anyone who asks.
        ok: true,
        accountConfigured: Boolean(VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN),
        callerIdConfigured: Boolean(VOBIZ_FROM_NUMBER),
        sipConfigured: Boolean(VOBIZ_SIP_USER && VOBIZ_SIP_PASSWORD),
        publicBaseConfigured: Boolean(getPublicBaseUrl()),
        serviceNowConfigured: Boolean(SERVICENOW_INSTANCE_URL && SERVICENOW_USER && SERVICENOW_PASSWORD),
        sessions: sessions.size,
        recentCalls: recentCalls.length,
      })
    );
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `No route for ${req.method} ${pathname}` }));
});

server.listen(PORT, () => {
  bindEndpointToApp().catch((e) => console.log("[backend] Auto-bind error:", e.message));
  console.log(`Vobiz ServiceNow calling bridge listening on http://localhost:${PORT}`);
  console.log(`  account:     ${VOBIZ_AUTH_ID || "(unset)"}`);
  console.log(`  caller ID:   ${VOBIZ_FROM_NUMBER || "(unset)"}`);
  console.log(`  registers:   sip:${VOBIZ_SIP_USER || "(unset)"}@${VOBIZ_REGISTRAR}`);
  console.log(`  public base: ${getPublicBaseUrl() || "(not set)"}`);
  console.log(`  serviceNow:  ${SERVICENOW_INSTANCE_URL || "(unset)"}`);
});

module.exports = server;
