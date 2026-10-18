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

// process.loadEnvFile only exists from Node 20.12, and this service supports
// Node 18, where skipping .env would start an unconfigured server without a
// word. Variables already in the environment win, as they do with loadEnvFile.
function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
    return;
  }
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if (/^["']/.test(value)) {
      value = value.slice(1, value.indexOf(value[0], 1) === -1 ? undefined : value.indexOf(value[0], 1));
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[m[1]] = value;
  }
}
// ENV_FILE points elsewhere — the test suite uses it so it never reads, or
// overwrites, your real backend/.env.
loadDotEnv(process.env.ENV_FILE || path.join(__dirname, ".env"));

const cleanEnvVar = (val) => (val ? val.trim().replace(/^["']|["']$/g, "") : "");

// ─── Configuration ───────────────────────────────────────────────────────────
//
// Deployment settings only. No Vobiz account is configured here: every agent
// signs in with their own account's Auth ID and Auth Token, and the backend
// provisions what that account needs at sign-in (see /login).
const PORT = Number(cleanEnvVar(process.env.PORT) || 8092);
const VOBIZ_REGISTRAR = cleanEnvVar(process.env.VOBIZ_REGISTRAR) || "registrar.vobiz.ai";
const VOBIZ_API_URL = cleanEnvVar(process.env.VOBIZ_API_URL) || "https://api.vobiz.ai";
const VOBIZ_SHARED_SECRET = cleanEnvVar(process.env.VOBIZ_SHARED_SECRET || process.env.SHARED_SECRET);

const SERVICENOW_INSTANCE_URL = cleanEnvVar(process.env.SERVICENOW_INSTANCE_URL);
const SERVICENOW_USER = cleanEnvVar(process.env.SERVICENOW_USER);
const SERVICENOW_PASSWORD = cleanEnvVar(process.env.SERVICENOW_PASSWORD);

const SIGNING_SECRET = cleanEnvVar(process.env.SIGNING_SECRET) || crypto.randomBytes(32).toString("hex");
const RECORDING_URL_TTL_SECONDS = Number(cleanEnvVar(process.env.RECORDING_URL_TTL_SECONDS) || 300);

// Where the endpoint map lives: { "<authId>:<agentId>": { endpointId, username } }.
// Ids only — never a password or a token.
const DATA_DIR = cleanEnvVar(process.env.DATA_DIR) || path.join(__dirname, "data");
const ENDPOINTS_FILE = path.join(DATA_DIR, "endpoints.json");

const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");
function getPublicBaseUrl() {
  const configured = cleanEnvVar(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE || process.env.TUNNEL_URL);
  if (configured) return configured.replace(/\/+$/, "");
  try {
    const url = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    return url ? url.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

const AGENTS_FILE = path.join(__dirname, "agents.json");

/**
 * Agent display names. agents.json is committed, so it carries no SIP
 * identity or password: endpoints are provisioned per account at sign-in.
 */
function getAgentDisplayName(agentId) {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
      const a = agents[agentId];
      if (a) return a.displayName || a.name || agentId;
    }
  } catch (err) {
    console.warn("[backend] Error reading agents.json:", err.message);
  }
  return agentId;
}

// ─── State ───────────────────────────────────────────────────────────────────
// Session token -> { agentId, authId, sipUser, sipPassword, numbers, from, createdAt }
//   sipPassword is the fresh password set at this sign-in. It lives only here,
//   is served only to this session by /agent, and is never written to disk.
const sessions = new Map();
// Auth ID -> { authToken, numbers, appId }. In memory only: the Auth Token is
// never logged, returned, or persisted. After a restart an account is unknown
// until one of its agents signs in again.
const accounts = new Map();
// SIP username -> { authId, agentId, callerId }. Identifies the agent and
// account behind a browser-originated call, and the agents to ring inbound.
const sipUsers = new Map();
// CallUUID -> CDR record
const callsByUuid = new Map();
const recentCalls = []; // newest first, capped at 200
// Click-to-call from a ServiceNow record. The record's UI Action runs on the
// ServiceNow server and cannot reach the agent's browser, and the backend must
// not dial the customer itself (see /start-call). So it leaves the number here,
// and the agent's open softphone collects it and sends the INVITE.
//   session token -> { agentId, lastPollAt }   panels currently open
//   [{ id, to, token, createdAt }]             numbers waiting to be dialled
const openPanels = new Map();
const pendingDials = [];
const PANEL_LIVE_MS = 15 * 1000;
const DIAL_REQUEST_TTL_MS = 30 * 1000;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function newSession(fields) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...fields, createdAt: Date.now() });
  return token;
}

// A SIP user stays routable while any live session holds it.
function dropSession(token) {
  const s = sessions.get(token);
  sessions.delete(token);
  openPanels.delete(token);
  if (s && s.sipUser && ![...sessions.values()].some((o) => o.sipUser === s.sipUser)) {
    sipUsers.delete(s.sipUser);
  }
}

function getSession(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    dropSession(token);
    return null;
  }
  return s;
}

/**
 * Guard for every route that spends money, changes account configuration, or
 * reads call data. Returns the session, or answers 401 and returns null.
 */
function requireSession(req, res) {
  const s = getSession(req);
  if (s) return s;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Sign in first" }));
  return null;
}

// An account session sees its own account's calls; a SIP-direct session sees
// only its own endpoint's.
function sessionMaySee(session, rec) {
  if (!session || !rec) return false;
  if (session.mode === "sip") return Boolean(rec.agentSipUser) && rec.agentSipUser === session.sipUser;
  return Boolean(rec.authId) && rec.authId === session.authId;
}

// Guard for what needs the account API: recordings, the number list,
// Enable inbound, and the provisioned endpoint's credentials.
function requireAccountSession(req, res) {
  const s = requireSession(req, res);
  if (!s) return null;
  if (s.mode === "sip") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Sign in with your Vobiz account to use this." }));
    return null;
  }
  return s;
}

// A number that is already strict E.164, or "".
function strictE164(raw) {
  const s = String(raw || "").trim();
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : "";
}

// A caller ID typed by an agent: E.164, 8 to 15 digits, or "" if it is not one.
function cleanPhone(raw) {
  const s = String(raw || "").trim();
  if (!s || /[^\d+\s().-]/.test(s)) return "";
  const e164 = toE164(s);
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : "";
}

function rememberCall(record) {
  callsByUuid.set(record.callUuid, record);
  recentCalls.unshift(record);
  while (recentCalls.length > 200) {
    const dropped = recentCalls.pop();
    if (dropped) callsByUuid.delete(dropped.callUuid);
  }
}

// ─── Endpoint map (ids only, on disk) ────────────────────────────────────────
function readEndpointMap() {
  try {
    return JSON.parse(fs.readFileSync(ENDPOINTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeEndpointMap(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${ENDPOINTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ENDPOINTS_FILE);
  try {
    fs.chmodSync(ENDPOINTS_FILE, 0o600);
  } catch {
    /* best effort on filesystems without modes */
  }
}

// ─── Vobiz REST Client ───────────────────────────────────────────────────────
//
// Vobiz application ids are 17 digits, above Number.MAX_SAFE_INTEGER, so a
// plain JSON.parse silently rounds any that arrive as JSON numbers. Long
// integers are quoted before parsing, and ids are kept as strings everywhere.
function parseJsonKeepingBigIds(raw) {
  const quoted = String(raw).replace(/(:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(quoted);
}

/**
 * One call to the Vobiz API as one account. `body` is either an object, sent
 * as JSON, or a string, sent verbatim (used where a 17-digit integer has to
 * reach Vobiz exactly).
 */
async function vobiz(creds, method, apiPath, body) {
  const base = VOBIZ_API_URL.replace(/\/+$/, "");
  const url = `${base}/api/v1/Account/${encodeURIComponent(creds.authId)}${apiPath}`;
  const hasBody = body !== undefined && body !== null;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "X-Auth-ID": creds.authId,
        "X-Auth-Token": creds.authToken,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const raw = await res.text();
    let parsed = raw;
    try {
      parsed = parseJsonKeepingBigIds(raw);
    } catch {
      /* keep raw */
    }
    return { status: res.status, ok: res.ok, body: parsed, raw };
  } catch (err) {
    return { status: 0, ok: false, body: { error: err.message }, raw: "" };
  }
}

function credsFor(authId) {
  const a = accounts.get(authId);
  return a ? { authId, authToken: a.authToken } : null;
}

/**
 * Every number on the account that can carry a call, for the caller-ID
 * picker: pages through GET /numbers until `total` is loaded and keeps those
 * with status "active" and voice enabled. Each entry keeps the application
 * the number is attached to now, so "Enable inbound calls" can say what it
 * moves the number away from. Ids stay strings.
 */
async function fetchAccountNumbers(creds, firstPage) {
  const out = [];
  let page = 1;
  let seen = 0;
  let res = firstPage || (await vobiz(creds, "GET", "/numbers?page=1&per_page=100"));
  for (;;) {
    if (!res.ok) throw new Error(`Vobiz refused the number list (HTTP ${res.status})`);
    const items = (res.body && (res.body.items || res.body.objects)) || [];
    for (const n of items) {
      if (!n || typeof n !== "object") continue;
      const e164 = toE164(n.e164 || n.number || n.phone_number);
      if (!e164) continue;
      if (n.status && n.status !== "active") continue;
      if (n.voice_enabled === false || (n.capabilities && n.capabilities.voice === false)) continue;
      const appId = n.application_id === undefined || n.application_id === null ? "" : String(n.application_id);
      if (!out.some((o) => o.e164 === e164)) out.push({ e164, applicationId: appId });
    }
    seen += items.length;
    const total = Number(res.body && res.body.total);
    page++;
    if (!items.length || !Number.isFinite(total) || seen >= total || page > 100) break;
    res = await vobiz(creds, "GET", `/numbers?page=${page}&per_page=100`);
  }
  return out;
}

// The app id an endpoint is bound to, however the response spells it.
function boundAppId(epBody) {
  if (!epBody || typeof epBody !== "object") return "";
  const a = epBody.application;
  const candidates = [
    a && typeof a === "object" ? a.app_id || a.id : a,
    epBody.app_id,
  ];
  for (const c of candidates) {
    const m = c === undefined || c === null ? null : String(c).match(/(\d+)\/?$/);
    if (m) return m[1];
  }
  return "";
}

// ─── Per-sign-in provisioning ────────────────────────────────────────────────

/**
 * This integration's application in the signed-in account, found by its
 * answer_url or created. An application with any other answer_url is never
 * touched.
 */
async function ensureApplication(creds) {
  const publicBase = getPublicBaseUrl();
  const answerUrl = `${publicBase}/answer`;
  const list = await vobiz(creds, "GET", "/Application/?limit=100");
  const existing = ((list.body && list.body.objects) || []).find((a) => a.answer_url === answerUrl);
  let appId = existing ? String(existing.app_id || "") : "";
  if (!appId) {
    const created = await vobiz(creds, "POST", "/Application/", {
      app_name: "ServiceNow Calling (Vobiz)",
      answer_url: answerUrl,
      answer_method: "POST",
      hangup_url: answerUrl,
      hangup_method: "POST",
    });
    if (!created.ok) {
      throw new Error(`Vobiz refused to create the application (HTTP ${created.status})`);
    }
    appId = String((created.body && (created.body.app_id || created.body.id)) || "");
  }
  if (!/^\d+$/.test(appId)) throw new Error("Vobiz did not return a usable application id");
  return appId;
}

function endpointUsernameFor(agentId) {
  const slug = String(agentId).replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  const hash = crypto.createHash("sha256").update(String(agentId)).digest("hex").slice(0, 8);
  return `sn${slug}${hash}`;
}

function endpointAliasFor(agentId) {
  const slug = String(agentId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "agent";
  const hash = crypto.createHash("sha256").update(String(agentId)).digest("hex").slice(0, 8);
  return `ServiceNow-${slug}-${hash}`;
}

/**
 * One endpoint per (account, agent), found by the stored id or by its exact
 * alias, created on the first sign-in. Each sign-in sets a fresh random
 * password and binds the endpoint to the integration's application. The
 * username is always read back from Vobiz (POST /Endpoint/ may rewrite it).
 *
 * Binding follows the proven order: {"app_id":"<id>"} as a string first, then
 * a GET to verify, then the documented {"application": <integer>} with the
 * integer spliced into the body text, never passed through a JS number.
 */
async function ensureEndpoint(creds, agentId, appId) {
  if (!/^\d+$/.test(appId)) throw new Error("refusing to bind a non-numeric application id");
  const key = `${creds.authId}:${agentId}`;
  const alias = endpointAliasFor(agentId);
  const map = readEndpointMap();
  const password = crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 20) + "aA1";
  const bindByAppId = '{"app_id":"' + appId + '"}';
  const bindByApplication = '{"application":' + appId + "}";

  let endpointId = map[key] && map[key].endpointId ? String(map[key].endpointId) : "";
  if (endpointId) {
    const probe = await vobiz(creds, "GET", `/Endpoint/${encodeURIComponent(endpointId)}/`);
    if (probe.status === 404) endpointId = "";
  }
  if (!endpointId) {
    const list = await vobiz(creds, "GET", "/Endpoint/?limit=100");
    const mine = ((list.body && list.body.objects) || []).find((e) => e.alias === alias);
    if (mine) endpointId = String(mine.endpoint_id || mine.id || "");
  }

  if (endpointId) {
    const rotated = await vobiz(
      creds,
      "POST",
      `/Endpoint/${encodeURIComponent(endpointId)}/`,
      '{"alias":' + JSON.stringify(alias) + ',"password":' + JSON.stringify(password) + ',"app_id":"' + appId + '"}'
    );
    if (!rotated.ok) throw new Error(`Vobiz refused to update the SIP endpoint (HTTP ${rotated.status})`);
  } else {
    const created = await vobiz(
      creds,
      "POST",
      "/Endpoint/",
      '{"username":' + JSON.stringify(endpointUsernameFor(agentId)) + ',"password":' + JSON.stringify(password) +
        ',"alias":' + JSON.stringify(alias) + ',"app_id":"' + appId + '"}'
    );
    if (!created.ok) throw new Error(`Vobiz refused to create the SIP endpoint (HTTP ${created.status})`);
    endpointId = String((created.body && (created.body.endpoint_id || created.body.id)) || "");
    if (!endpointId) throw new Error("Vobiz did not return an endpoint id");
  }

  const epPath = `/Endpoint/${encodeURIComponent(endpointId)}/`;
  let ep = await vobiz(creds, "GET", epPath);
  let how = "on create/update";
  if (boundAppId(ep.body) !== appId) {
    await vobiz(creds, "POST", epPath, bindByAppId);
    ep = await vobiz(creds, "GET", epPath);
    how = "with app_id";
  }
  if (boundAppId(ep.body) !== appId) {
    await vobiz(creds, "POST", epPath, bindByApplication);
    ep = await vobiz(creds, "GET", epPath);
    how = "with application";
  }
  const bound = boundAppId(ep.body) === appId;
  console.log(`[backend] Endpoint ${endpointId} ${bound ? `bound to app ${appId} (${how})` : `NOT confirmed bound to app ${appId}`}`);

  const username = String((ep.body && ep.body.username) || "") || (map[key] && map[key].username) || "";
  if (!username) throw new Error("Could not read the SIP endpoint's username from Vobiz");

  const fresh = readEndpointMap();
  fresh[key] = { endpointId, username };
  writeEndpointMap(fresh);
  return { endpointId, username, password, bound };
}

// ─── Recording URL Signing ───────────────────────────────────────────────────
//
// A plain <audio> element cannot send an Authorization header, and these links
// are written into ServiceNow interaction work notes, where every agent on the
// instance can read them for as long as the record exists. So a playback link
// carries its own short-lived proof — and never account credentials.
//
// The HMAC covers the account as well as the id, and the account travels in the
// link: a link signed for one account's recording can never be replayed to
// fetch another account's audio with that other account's credentials.
function hmacFor(authId, id, exp) {
  return crypto.createHmac("sha256", SIGNING_SECRET).update(`${authId}|${id}|${exp}`).digest("hex");
}

function signRecordingUrl(authId, recordingId) {
  const publicBase = getPublicBaseUrl();
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = hmacFor(authId, recordingId, exp);
  return `${publicBase || ""}/recording-audio/${encodeURIComponent(recordingId)}?acct=${encodeURIComponent(authId)}&exp=${exp}&sig=${sig}`;
}

function signCallPlaybackUrl(authId, callUuid) {
  const publicBase = getPublicBaseUrl() || `http://localhost:${PORT}`;
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = hmacFor(authId, callUuid, exp);
  return `${publicBase}/play-recording?callUuid=${encodeURIComponent(callUuid)}&acct=${encodeURIComponent(authId)}&exp=${exp}&sig=${sig}`;
}

function verifyRecordingSignature(authId, id, exp, sig) {
  if (!authId || !id || !exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = hmacFor(authId, id, exp);
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
async function streamAudioToClient(creds, targetUrl, res) {
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
        "X-Auth-ID": creds.authId,
        "X-Auth-Token": creds.authToken,
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
  const { to, agentId, durationSeconds, recordingUrl, from, callDirection = "Outbound", notes = "", existingSysId } = callData;
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

  // The same call is reported twice — by the softphone when it hangs up, and by
  // Vobiz when the recording is ready. The second report updates the record the
  // first one created (work_notes is a journal field, so this appends).
  const url = existingSysId
    ? `${cleanUrl}/api/now/table/interaction/${encodeURIComponent(existingSysId)}`
    : `${cleanUrl}/api/now/table/interaction`;
  const body = existingSysId
    ? { recording_url: payload.recording_url, work_notes: payload.work_notes }
    : payload;
  if (existingSysId && !body.recording_url) delete body.recording_url;

  try {
    const res = await fetch(url, {
      method: existingSysId ? "PATCH" : "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[backend] ServiceNow refused the interaction (HTTP ${res.status}):`, JSON.stringify(json).slice(0, 300));
      return null;
    }
    console.log(
      `[backend] ServiceNow interaction ${existingSysId ? "updated" : "created"}:`,
      json.result ? json.result.number : res.status
    );
    return json;
  } catch (err) {
    console.error("[backend] Error creating interaction in ServiceNow:", err.message);
    return null;
  }
}

// One interaction per call: callUuid -> Promise of that call's interaction
// sys_id. Writes for the same call are chained, so the second one updates the
// record the first created even when both arrive together.
const interactionByCall = new Map();

function logCallToServiceNow(callUuid, callData) {
  if (!callUuid) return createServiceNowInteraction(callData);
  const previous = interactionByCall.get(callUuid) || Promise.resolve(null);
  let result = null;
  const sysId = previous.then(async (existingSysId) => {
    result = await createServiceNowInteraction({ ...callData, existingSysId });
    return existingSysId || (result && result.result && result.result.sys_id) || null;
  });
  interactionByCall.set(callUuid, sysId);
  if (interactionByCall.size > 500) interactionByCall.delete(interactionByCall.keys().next().value);
  return sysId.then(() => result);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function toE164(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return `+${s.replace(/\D/g, "")}`;
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
//
// One backend serves every account that has signed in, so each webhook is
// matched to its account: an outbound call by the SIP username that placed
// it, an inbound call by the number that was dialled.
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const politeHangup = (sentence) =>
  `${XML_HEAD}<Response>\n  <Speak>${escapeHtml(sentence)}</Speak>\n  <Hangup/>\n</Response>`;

// The signed-in agents of one account, by SIP username.
function signedInSipUsers(authId) {
  return [...sipUsers.entries()].filter(([, v]) => v.authId === authId).map(([user]) => user);
}

function handleAnswer(req, res, queryParams, bodyParams) {
  const p = { ...queryParams, ...bodyParams };
  console.log(`[backend] WEBHOOK /answer received: CallUUID=${p.CallUUID || p.call_uuid || "-"} From=${p.From || p.from || "-"} To=${p.To || p.to || "-"}`);

  res.writeHead(200, { "Content-Type": "text/xml" });

  if ((p.Event || p.event) === "Hangup") {
    return res.end(`${XML_HEAD}<Response></Response>`);
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
    // Browser dialled out. The SIP username says which agent, and so which
    // account, this call belongs to. The caller ID is the number that agent
    // chose, and only ever one of that account's own numbers.
    const sipUser = (from.match(/^sip:([^@;]+)@/) || [])[1] || "";
    const who = sipUsers.get(sipUser);
    const account = who && accounts.get(who.authId);
    // The caller ID the panel chose: the X-VH-Caller-ID header on the INVITE
    // (Vobiz passes X-VH-* headers to the webhook as top-level params,
    // sometimes prefixed SIPHeader_), else the per-SIP-user state set at
    // sign-in or by /select-number. Strict E.164 either way.
    const headerCallerId = strictE164(
      p["X-VH-Caller-ID"] || p["SIPHeader_X-VH-Caller-ID"] || p["X-Vh-Caller-Id"] || p["SIPHeader_X-Vh-Caller-Id"] || ""
    );
    const callerId = who ? headerCallerId || strictE164(who.callerId) : "";
    // Account mode: the caller ID must be one of the account's numbers. SIP
    // direct: there is no account here to ask, and Vobiz enforces ownership.
    const allowed = who && (who.mode === "sip" ? Boolean(callerId) : Boolean(account && callerId && (account.numbers || []).includes(callerId)));
    if (!allowed) {
      console.log(`[backend] Outbound call from unknown or unsigned-in SIP user ${sipUser || "(none)"}; hanging up.`);
      return res.end(politeHangup("This phone is not signed in. Please sign in to Vobiz Calling and try again."));
    }
    const destination = to.replace(/^sip:/, "").split("@")[0].replace(/[^\d+]/g, "");

    rememberCall({
      callUuid,
      authId: who.authId,
      agentId: who.agentId,
      direction: "Outbound",
      agentSipUser: sipUser,
      from: callerId,
      to: destination,
      startedAt: Date.now(),
    });

    console.log(`[backend] -> Browser is A-leg: dialing out to ${destination} as callerId=${callerId}`);
    const xml =
      `${XML_HEAD}<Response>\n  ${recordXml}\n` +
      `  <Dial callerId="${escapeHtml(callerId)}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">\n` +
      `    <Number>${escapeHtml(destination)}</Number>\n  </Dial>\n</Response>`;
    return res.end(xml);
  }

  // Inbound call from a PSTN customer: the dialled number names the account,
  // and that account's signed-in agents ring.
  // The account is named by the webhook's ParentAuthID; the dialled number
  // is the fallback when that is absent or not an account signed in here.
  const dialled = toE164(to);
  const parentAuthId = String(p.ParentAuthID || p.parentauthid || p.ParentAuthId || "");
  const byParent = parentAuthId && accounts.has(parentAuthId) ? [parentAuthId, accounts.get(parentAuthId)] : null;
  const owner = byParent || [...accounts.entries()].find(([, a]) => (a.numbers || []).includes(dialled));
  let targets = owner ? signedInSipUsers(owner[0]) : [];
  // No signed-in account owns it: SIP-direct agents who named it as their
  // number take it.
  if (!owner) {
    targets = [...sipUsers.entries()].filter(([, v]) => v.mode === "sip" && v.inbound === dialled).map(([u]) => u);
  }
  if (targets.length === 0) {
    console.log(`[backend] Inbound call to ${dialled || "(no number)"}: ${owner ? "no agent of that account is signed in" : "no signed-in account or SIP-direct agent has this number"}; hanging up.`);
    return res.end(politeHangup("Sorry, no one is available to take your call right now. Please try again later."));
  }

  rememberCall({
    callUuid,
    authId: owner ? owner[0] : null,
    agentId: (sipUsers.get(targets[0]) || {}).agentId,
    direction: "Inbound",
    agentSipUser: targets[0],
    from,
    to: dialled,
    startedAt: Date.now(),
  });

  console.log(`[backend] -> Inbound call from ${from} to ${dialled}, ringing ${targets.length} agent(s)`);
  const users = targets.map((u) => `    <User>sip:${escapeHtml(u)}@${VOBIZ_REGISTRAR}</User>`).join("\n");
  const xml =
    `${XML_HEAD}<Response>\n  ${recordXml}\n` +
    `  <Dial callerId="${escapeHtml(dialled)}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">\n` +
    `${users}\n  </Dial>\n</Response>`;
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
    // A SIP-direct call has no account credentials here to fetch audio with.
    const playLink = rec.authId ? signCallPlaybackUrl(rec.authId, callUuid) : "";
    await logCallToServiceNow(callUuid, {
      to: rec.to,
      from: rec.from,
      agentId: rec.agentId || rec.agentSipUser,
      durationSeconds: rec.duration || duration,
      recordingUrl: playLink,
      callDirection: rec.direction || "Outbound",
    });
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "captured" }));
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
  //
  // Any Vobiz account can sign in. The pair is proven against Vobiz itself, and
  // then this account's application and this agent's SIP endpoint are found or
  // created. The Auth Token stays in this process's memory; it is never
  // returned, logged or written to disk.
  if (pathname === "/login" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const agentId = String(body.agentId || "").trim();
      const authId = String(body.authId || "").trim();
      const authToken = String(body.authToken || "").trim();
      if (!agentId || !authId || !authToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "agentId, authId and authToken are required" }));
      }
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(authId)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Vobiz did not accept this Auth ID and Auth Token." }));
      }

      const creds = { authId, authToken };
      const check = await vobiz(creds, "GET", "/numbers?page=1&per_page=100");
      if (!check.ok) {
        console.log(`[backend] Sign-in refused by Vobiz (HTTP ${check.status || "unreachable"})`);
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: check.status
              ? "Vobiz did not accept this Auth ID and Auth Token. Copy both from the Vobiz Console and try again."
              : "Could not reach Vobiz to check these credentials. Try again in a moment.",
          })
        );
      }
      let numberDetails;
      try {
        numberDetails = await fetchAccountNumbers(creds, check);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
      const numbers = numberDetails.map((n) => n.e164);

      const publicBase = getPublicBaseUrl();
      if (!publicBase.startsWith("https://")) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "This backend has no public HTTPS address (PUBLIC_BASE_URL or a running tunnel), so Vobiz cannot reach it." })
        );
      }

      let appId;
      let endpoint;
      try {
        appId = await ensureApplication(creds);
        endpoint = await ensureEndpoint(creds, agentId, appId);
      } catch (err) {
        console.error("[backend] Provisioning failed:", err.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: `Signed in, but could not set up calling on this account: ${err.message}` }));
      }

      accounts.set(authId, { authToken, numbers, numberDetails, appId });
      const from = numbers[0] || "";
      sipUsers.set(endpoint.username, { authId, agentId, callerId: from });
      const token = newSession({
        agentId,
        authId,
        sipUser: endpoint.username,
        sipPassword: endpoint.password,
        numbers,
        numberDetails,
        from,
      });

      console.log(`[backend] Login ok: agent=${agentId}, endpoint=${endpoint.endpointId}, numbers=${numbers.length}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ token, numbers, numberDetails, appId, selected: from, authId }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // The bearer token is the only thing that identifies a session.
  //
  // The /session/<agentId> form is accepted so older widgets do not 404, but the
  // id in the path proves nothing on its own: agent ids are ServiceNow
  // usernames, so answering from them would hand out an account's Auth ID and
  // phone numbers to anyone who can guess one.
  if (pathname === "/session" || pathname.startsWith("/session/")) {
    const s = getSession(req);
    if (s) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          loggedIn: true,
          mode: s.mode === "sip" ? "sip" : "account",
          agentId: s.agentId,
          authId: s.authId,
          numbers: s.numbers,
          numberDetails: s.numberDetails || [],
          appId: s.authId && accounts.get(s.authId) ? accounts.get(s.authId).appId : null,
          from: s.from,
        })
      );
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ loggedIn: false }));
  }

  // The softphone polls this while it is open and signed in.
  // Each number is handed to exactly one panel, once.
  if (pathname === "/dial-requests" && req.method === "GET") {
    const s = requireAccountSession(req, res);
    if (!s) return;
    const token = (req.headers["authorization"] || "").slice(7);
    openPanels.set(token, { agentId: s.agentId, lastPollAt: Date.now() });
    const now = Date.now();
    for (let i = pendingDials.length - 1; i >= 0; i--) {
      if (now - pendingDials[i].createdAt > DIAL_REQUEST_TTL_MS) pendingDials.splice(i, 1);
    }
    const idx = pendingDials.findIndex((d) => d.token === token);
    const dial = idx === -1 ? null : pendingDials.splice(idx, 1)[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ dial: dial ? { id: dial.id, to: dial.to } : null }));
  }

  if (pathname === "/logout" && req.method === "POST") {
    const header = req.headers["authorization"] || "";
    if (header.startsWith("Bearer ")) dropSession(header.slice(7));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // SIP direct: the agent brings an endpoint they already have. The panel
  // registers with the SIP username and password the agent typed; the
  // password never comes here. The backend only records which caller ID this
  // SIP user calls from, and which number's inbound calls ring it, so the
  // webhooks can route. No account credentials exist in this mode — the
  // customer has attached the endpoint and the number to an application whose
  // answer URL is this backend, and Vobiz itself refuses a caller ID that is
  // not on the endpoint's account.
  if (pathname === "/login-sip" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const cleanUser = String(body.sipUser || "").replace(/^sip:/, "").split("@")[0].trim();
      const callerId = cleanPhone(body.callerId);
      if (!/^[A-Za-z0-9]{3,64}$/.test(cleanUser)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Enter the endpoint's SIP username (letters and digits only)." }));
      }
      if (!callerId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Enter the caller ID as a full number with country code, e.g. +1 200 300 4000." }));
      }
      // An endpoint provisioned by an account sign-in stays with that account:
      // SIP direct cannot re-point its caller ID or its inbound routing.
      const existing = sipUsers.get(cleanUser);
      if (existing && existing.mode !== "sip") {
        res.writeHead(409, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "This endpoint is signed in through a Vobiz account. Sign in with that account instead." }));
      }
      sipUsers.set(cleanUser, { mode: "sip", authId: null, agentId: cleanUser, callerId, inbound: callerId });
      const token = newSession({
        mode: "sip",
        agentId: cleanUser,
        authId: null,
        sipUser: cleanUser,
        numbers: [callerId],
        from: callerId,
      });
      console.log(`[backend] SIP direct sign-in: ${cleanUser} -> ${callerId}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, token, sipUser: cleanUser, callerId }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === "/select-number" && req.method === "POST") {
    const s = requireAccountSession(req, res);
    if (!s) return;
    try {
      const body = await readJsonBody(req);
      const { number } = body;
      // The caller ID is what the customer's handset displays and what the
      // carrier bills against: it has to be one of this account's numbers.
      const allowed = (s.numbers || []).map(toE164);
      if (!number || !allowed.includes(toE164(number))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: `${number} is not a number on this Vobiz account, so it cannot be a caller ID.` }));
      }
      s.from = toE164(number);
      const who = sipUsers.get(s.sipUser);
      if (who) who.callerId = s.from;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ selected: s.from }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // SIP credentials for the softphone to register with: this session's own
  // endpoint and the password set at this sign-in, served only to it.
  if (pathname === "/agent" || pathname.startsWith("/agent/")) {
    const session = requireAccountSession(req, res);
    if (!session) return;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(
      JSON.stringify({
        displayName: getAgentDisplayName(session.agentId),
        sipUser: `${session.sipUser}@${VOBIZ_REGISTRAR}`,
        sipPassword: session.sipPassword,
        registrarUrl: `wss://${VOBIZ_REGISTRAR}:5063/`,
      })
    );
  }

  // ── CDR & Recordings ──
  if (pathname === "/call-record" && req.method === "GET") {
    const session = requireSession(req, res);
    if (!session) return;
    const wanted = String(queryParams.to || "").replace(/[^\d+]/g, "");
    // Match the other party: the number dialled on an outbound call, the caller
    // on an inbound one.
    const otherParty = (c) => String(c.direction === "Inbound" ? c.from : c.to).replace(/[^\d+]/g, "");
    const rec = recentCalls.find(
      (c) => sessionMaySee(session, c) && (!wanted || otherParty(c).endsWith(wanted.slice(-10)))
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
        recordingUrl: rec.authId ? signCallPlaybackUrl(rec.authId, rec.callUuid) : null,
      })
    );
  }

  if (pathname === "/recordings" || pathname.startsWith("/recordings/")) {
    const session = requireAccountSession(req, res);
    if (!session) return;
    const creds = credsFor(session.authId);
    const limit = Math.min(Number(queryParams.limit || 15), 50);
    const r = await vobiz(creds, "GET", `/Recording/?limit=${limit}`);
    const objects = ((r.body && r.body.objects) || []).map((o) => ({
      recording_id: o.recording_id,
      add_time: o.add_time,
      rounded_recording_duration: o.rounded_recording_duration,
      call_uuid: o.call_uuid,
      playUrl: signRecordingUrl(session.authId, o.recording_id),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ objects, recordings: objects }));
  }

  // After a restart the account's token is gone until someone signs in again.
  const signInAgain = () => {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "This recording belongs to a Vobiz account nobody has signed in to since the backend restarted. Sign in again to play it." })
    );
  };

  if (pathname === "/play-recording") {
    const callUuid = queryParams.callUuid || queryParams.call_uuid;
    const recordingId = queryParams.recordingId || queryParams.recording_id;
    const acct = String(queryParams.acct || "");

    // These links live in ServiceNow work notes, so they are opened by a
    // browser with no session. A valid signature is the proof; a signed-in
    // caller from the softphone is the other accepted proof, for its own
    // account only. A link that cannot be resolved to its own call is refused
    // — never answered with whatever recording is most recent.
    //
    // The signature covers exactly one account and one id, and only that id is
    // looked up, with that account's credentials.
    const anySession = getSession(req);
    const session = anySession && anySession.mode !== "sip" ? anySession : null;
    const recordingSigned = Boolean(recordingId) && verifyRecordingSignature(acct, recordingId, queryParams.exp, queryParams.sig);
    const callSigned = !recordingSigned && Boolean(callUuid) && verifyRecordingSignature(acct, callUuid, queryParams.exp, queryParams.sig);
    if (!session && !recordingSigned && !callSigned) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "This playback link is invalid or has expired." }));
    }
    const authId = recordingSigned || callSigned ? acct : session.authId;
    const useRecordingId = recordingSigned || (!callSigned && session);
    const useCallUuid = callSigned || (!recordingSigned && session);
    const creds = credsFor(authId);
    if (!creds) return signInAgain();

    try {
      let targetAudioUrl = null;
      if (recordingId && useRecordingId) {
        const meta = await vobiz(creds, "GET", `/Recording/${encodeURIComponent(recordingId)}/`);
        targetAudioUrl = meta.body && (meta.body.recording_url || meta.body.url || meta.body.file);
      }
      if (!targetAudioUrl && callUuid && useCallUuid) {
        const recList = await vobiz(creds, "GET", `/Recording/?call_uuid=${encodeURIComponent(callUuid)}`);
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
          <code>Call UUID: ${escapeHtml(callUuid || "N/A")}</code>
        </body></html>`);
      }

      return await streamAudioToClient(creds, targetAudioUrl, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname.startsWith("/recording-audio/")) {
    const parts = pathname.slice("/recording-audio/".length).split("/");
    const recordingId = decodeURIComponent(parts[parts.length - 1]);
    const acct = String(queryParams.acct || "");

    const signed = verifyRecordingSignature(acct, recordingId, queryParams.exp, queryParams.sig);
    const anySession = signed ? null : getSession(req);
    const session = anySession && anySession.mode !== "sip" ? anySession : null;
    if (!signed && !session) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid or expired playback signature" }));
    }
    const creds = credsFor(signed ? acct : session.authId);
    if (!creds) return signInAgain();

    try {
      const meta = await vobiz(creds, "GET", `/Recording/${encodeURIComponent(recordingId)}/`);
      const src = meta.body && (meta.body.recording_url || meta.body.url);
      if (!src) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "No audio available" }));
      }
      return await streamAudioToClient(creds, src, res);
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
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const body = await readJsonBody(req);
      const { toNumber, duration, callDirection, notes, callUuid } = body;
      const found = callUuid ? callsByUuid.get(callUuid) : null;
      // A session writes to ServiceNow only for its own account's calls.
      if (found && !sessionMaySee(session, found)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "That call does not belong to this account." }));
      }
      const rec = found;
      const recordingUrl = rec && rec.authId ? signCallPlaybackUrl(rec.authId, callUuid) : "";

      const result = await logCallToServiceNow(rec ? callUuid : null, {
        to: toNumber || (rec && rec.to),
        from: (rec && rec.from) || session.from,
        durationSeconds: duration || (rec && rec.duration) || 0,
        recordingUrl,
        callDirection: callDirection || (rec && rec.direction) || "Outbound",
        agentId: session.agentId,
        notes,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true, result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── Calling setup ──
  //
  // /setup re-checks this account's application and reports it; sign-in has
  // already done the work. It changes nothing on any phone number.
  if (pathname === "/setup" && req.method === "POST") {
    const session = requireAccountSession(req, res);
    if (!session) return;
    const creds = credsFor(session.authId);
    if (!creds) return signInAgain();
    try {
      const appId = await ensureApplication(creds);
      accounts.get(session.authId).appId = appId;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, appId, message: "Calling is set up on this account." }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // "Enable inbound calls": the only place a number is attached to this
  // integration's application. Attaching moves the number off whatever
  // application answered it before, so it happens only when an agent asks.
  if (pathname === "/setup-inbound" && req.method === "POST") {
    const session = requireAccountSession(req, res);
    if (!session) return;
    const creds = credsFor(session.authId);
    if (!creds) return signInAgain();
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const number = toE164(body.number || session.from);
      if (!number || !(session.numbers || []).includes(number)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Choose one of this account's numbers first." }));
      }
      const appId = await ensureApplication(creds);
      accounts.get(session.authId).appId = appId;
      const attached = await vobiz(creds, "POST", `/numbers/${encodeURIComponent(number)}/application`, {
        application_id: appId,
      });
      if (!attached.ok) {
        console.warn(`[backend] Could not attach ${number} to app ${appId}: HTTP ${attached.status}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: `Vobiz refused to route ${number} here (HTTP ${attached.status}).` }));
      }
      console.log(`[backend] Attached ${number} to app ${appId} for inbound calls`);
      const detail = (accounts.get(session.authId).numberDetails || []).find((n) => n.e164 === number);
      const previousAppId = detail ? detail.applicationId : "";
      if (detail) detail.applicationId = appId;
      const moved = previousAppId && previousAppId !== appId ? ` It was attached to application ${previousAppId}.` : "";
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ ok: true, appId, number, previousAppId, message: `Calls to ${number} now ring signed-in agents here.${moved}` })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── Click-to-call: the ServiceNow "Call via Vobiz" button ──
  if (pathname === "/start-call" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      // This route spends money: it makes an agent's softphone place a billed
      // call. A caller must present either the shared secret the ServiceNow UI
      // Action sends, or a session — never neither, including when the secret
      // is simply not configured.
      const providedSecret = req.headers["x-vobiz-secret"] || req.headers["x-api-key"] || body.secret;
      const secretOk = Boolean(VOBIZ_SHARED_SECRET) && providedSecret === VOBIZ_SHARED_SECRET;
      const anyCaller = secretOk ? null : getSession(req);
      const caller = anyCaller && anyCaller.mode !== "sip" ? anyCaller : null;
      if (!secretOk && !caller) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: VOBIZ_SHARED_SECRET
              ? "unauthorized: invalid or missing shared secret"
              : "unauthorized: set VOBIZ_SHARED_SECRET and send it as X-Vobiz-Secret, or sign in first",
          })
        );
      }

      const { to } = body;
      // A signed-in caller can only ring its own panel.
      const reqAgentId = caller ? caller.agentId : body.agentId;
      if (!to) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "missing 'to' number" }));
      }

      // The browser is the A leg, for this button too. Dialling the customer
      // over the REST API and then bridging the agent in with <Dial><User> does
      // not work on Vobiz: the customer answers, hears ringback, and is told the
      // agent could not be reached. So this route originates nothing. It hands
      // the number to the agent's open softphone, which sends the INVITE, and
      // /answer replies <Dial><Number> exactly as for a call typed in the panel.
      const destination = String(to).replace(/[^\d+]/g, "");
      if (destination.replace(/\D/g, "").length < 6) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: `'${to}' is not a phone number` }));
      }

      const now = Date.now();
      const live = [...openPanels.entries()].filter(
        ([token, p]) => now - p.lastPollAt < PANEL_LIVE_MS && sessions.has(token)
      );
      const wantedAgent = reqAgentId || "";
      const mine = live.filter(([, p]) => wantedAgent && p.agentId === wantedAgent);
      const target = mine.length ? mine[0] : !caller && live.length === 1 ? live[0] : null;
      if (!target) {
        res.writeHead(409, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: live.length
              ? `No open Vobiz panel is signed in as ${wantedAgent || "this agent"}. Dial from your panel instead.`
              : "No Vobiz panel is open and signed in. Open the Vobiz Calling panel, sign in, wait for Ready, and try again.",
          })
        );
      }

      const id = crypto.randomBytes(8).toString("hex");
      pendingDials.push({ id, to: destination, token: target[0], createdAt: now });
      console.log(`[backend] Click-to-call queued for the softphone: ${destination} (agent ${target[1].agentId})`);
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ queued: true, id, to: destination }));
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
        // Health is unauthenticated, so it reports counts and whether things
        // are configured — never an Auth ID, a number or a SIP username.
        ok: true,
        publicBaseConfigured: Boolean(getPublicBaseUrl()),
        serviceNowConfigured: Boolean(SERVICENOW_INSTANCE_URL && SERVICENOW_USER && SERVICENOW_PASSWORD),
        accountsSignedIn: accounts.size,
        sessions: sessions.size,
        recentCalls: recentCalls.length,
      })
    );
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `No route for ${req.method} ${pathname}` }));
});

server.listen(PORT, () => {
  console.log(`Vobiz ServiceNow calling bridge listening on http://localhost:${PORT}`);
  console.log("  accounts:    any Vobiz account can sign in from the softphone");
  console.log(`  public base: ${getPublicBaseUrl() || "(not set)"}`);
  console.log(`  serviceNow:  ${SERVICENOW_INSTANCE_URL || "(unset)"}`);
});

module.exports = server;
