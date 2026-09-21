/** === Vobiz Calling — ServiceNow CTI Softphone ===
 *
 * A WebRTC softphone that integrates with ServiceNow OpenFrame or runs
 * standalone in the browser. It maintains a SIP registration with Vobiz,
 * enables outbound click-to-dial and keypad dialing, accepts inbound calls
 * with a visual popup and audio ringtone, and automatically logs Call Detail
 * Records (CDRs) and recordings into ServiceNow CRM interactions.
 *
 * Architecture: Browser is the A-leg. Outbound SIP INVITE originates in the
 * browser; backend answers with <Dial><Number>. Inbound calls bridge to the
 * registered SIP endpoint.
 */

const REGISTRAR_HOST = "registrar.vobiz.ai";

let backendUrl = "";
let agentId = "admin";
let registrarUrl = `wss://${REGISTRAR_HOST}:5063/`;

let sessionToken = "";
let vobizUA = null;
let currentRTCSession = null;
let agentIdentity = null;

let accountReady = false;
let sipRegistered = false;

let callDirection = "Outbound";
let callDurationSeconds = 0;
let timerInterval = null;
let lastDialedNumber = "";

// ─── Backend Fetch Helpers ──────────────────────────────────────────────────

async function backendFetch(pathname, options = {}) {
  const url = pathname.startsWith("http") ? pathname : `${backendUrl}${pathname}`;
  const headers = {
    "ngrok-skip-browser-warning": "1",
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

async function backendJson(pathname, options) {
  const res = await backendFetch(pathname, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `${(options && options.method) || "GET"} ${pathname} failed (${res.status})`);
  }
  return data;
}

// ─── Initialization ──────────────────────────────────────────────────────────

init();

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  
  // Resolve Backend URL (defaults to window.location.origin)
  const paramBackend = urlParams.get("backendUrl") || urlParams.get("backend_url");
  if (paramBackend) {
    backendUrl = paramBackend.trim().replace(/\/+$/, "");
  } else if (window.location.origin && window.location.origin !== "null") {
    backendUrl = window.location.origin;
  } else {
    backendUrl = "http://localhost:8092";
  }

  // Resolve Agent ID (defaults to ServiceNow username or 'admin')
  agentId = urlParams.get("agentId") || urlParams.get("agent_id") || localStorage.getItem("vobiz.agentId") || "admin";

  console.log(`[Vobiz] Softphone initializing. Agent: ${agentId}, Backend: ${backendUrl}`);

  wireUi();
  initOpenFrame();

  // Listen for click-to-dial messages from parent ServiceNow window
  window.addEventListener("message", onParentWindowMessage);

  // Clean disconnect on unload
  window.addEventListener("beforeunload", () => {
    try { if (vobizUA) vobizUA.stop(); } catch { /* ignore */ }
  });

  restoreAuthMode();
  if (authMode !== "sip") {
    await restoreVobizSession();
  }
}

// ─── UI Event Listeners ──────────────────────────────────────────────────────

function wireUi() {
  const loginBtn = document.getElementById("vobiz-login-btn");
  if (loginBtn) loginBtn.addEventListener("click", vobizLogin);

  const modeAccountTab = document.getElementById("mode-account-tab");
  if (modeAccountTab) modeAccountTab.addEventListener("click", () => setAuthMode("account"));

  const modeSipTab = document.getElementById("mode-sip-tab");
  if (modeSipTab) modeSipTab.addEventListener("click", () => setAuthMode("sip"));

  const sipConnectBtn = document.getElementById("sip-connect-btn");
  if (sipConnectBtn) sipConnectBtn.addEventListener("click", sipDirectConnect);

  const acceptBtn = document.getElementById("acceptbtn");
  if (acceptBtn) acceptBtn.addEventListener("click", acceptCall);

  const declineBtn = document.getElementById("declinebtn");
  if (declineBtn) declineBtn.addEventListener("click", declineCall);

  document.addEventListener("keydown", e => {
    if (!incomingPending) return;
    if (e.key === "Enter") {
      e.preventDefault();
      acceptCall();
    } else if (e.key === "Escape") {
      e.preventDefault();
      declineCall();
    }
  });

  const numSelect = document.getElementById("vobiz-number-select");
  if (numSelect) numSelect.addEventListener("change", vobizSelectNumber);

  const dialBtn = document.getElementById("dialbtn");
  if (dialBtn) dialBtn.addEventListener("click", onDialButtonClick);

  const hangupBtn = document.getElementById("hangupbtn");
  if (hangupBtn) hangupBtn.addEventListener("click", hangUp);

  const setupInboundBtn = document.getElementById("setup-inbound-btn");
  if (setupInboundBtn) setupInboundBtn.addEventListener("click", setupInboundCalling);

  const refreshHistoryBtn = document.getElementById("refresh-history-btn");
  if (refreshHistoryBtn) refreshHistoryBtn.addEventListener("click", loadCallHistory);

  const dialInput = document.getElementById("dialnumber");
  if (dialInput) {
    dialInput.addEventListener("keydown", e => {
      if (e.key === "Enter") onDialButtonClick();
    });
  }
}

// ─── ServiceNow OpenFrame Integration ────────────────────────────────────────

function initOpenFrame() {
  if (typeof window.openFrameAPI !== "undefined") {
    try {
      window.openFrameAPI.init({ height: 560, width: 380 });
      window.openFrameAPI.subscribe(window.openFrameAPI.EVENTS.COMMUNICATION_EVENT, function(data) {
        console.log("[Vobiz] OpenFrame communication event received:", data);
        if (data && (data.telephoneNumber || data.phone || data.number)) {
          const num = data.telephoneNumber || data.phone || data.number;
          const input = document.getElementById("dialnumber");
          if (input) input.value = num;
          placeCall(num);
        }
      });
      console.log("[Vobiz] ServiceNow OpenFrame API initialized successfully.");
    } catch (e) {
      console.warn("[Vobiz] OpenFrame initialization note:", e);
    }
  }
}

function openOpenFrameIfAvailable() {
  if (typeof window.openFrameAPI !== "undefined" && typeof window.openFrameAPI.open === "function") {
    try {
      window.openFrameAPI.open();
    } catch (e) {
      console.warn("[Vobiz] openFrameAPI.open note:", e);
    }
  }
}

function onParentWindowMessage(event) {
  const data = event.data;
  if (!data) return;
  if (data.type === "vobiz.dial" || data.type === "cti.dial" || data.action === "dial") {
    const number = data.number || data.phone || data.to;
    if (number) {
      const input = document.getElementById("dialnumber");
      if (input) input.value = number;
      placeCall(number);
    }
  }
}

// ─── Auth Mode: Vobiz Account vs SIP Direct ──────────────────────────────────

const AUTH_MODE_KEY = "vobiz.authMode";
const SIP_CREDS_KEY = "vobiz.sipDirect";
let authMode = "account";

function readStore(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

function setAuthMode(mode) {
  authMode = mode === "sip" ? "sip" : "account";
  writeStore(AUTH_MODE_KEY, authMode);

  const isSip = authMode === "sip";
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !visible;
  };
  show("mode-account", !isSip);
  show("mode-sip", isSip);
  show("step-caller-id", !isSip);

  const tab = (id, active) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-selected", String(active));
  };
  tab("mode-account-tab", !isSip);
  tab("mode-sip-tab", isSip);

  if (isSip) {
    const userField = document.getElementById("sip-username");
    const passField = document.getElementById("sip-password");
    const callerField = document.getElementById("sip-caller-id");
    if (userField && !userField.value) {
      backendFetch(`/agent/${encodeURIComponent(agentId)}`)
        .then((r) => r.json())
        .then((agent) => {
          if (agent && agent.sipUser && !userField.value) {
            const clean = agent.sipUser.split("@")[0].replace(/^sip:/, "");
            userField.value = clean;
            if (passField && !passField.value) passField.value = agent.sipPassword || "";
          }
        })
        .catch(() => {});
    }
    if (callerField && !callerField.value) {
      backendFetch("/numbers")
        .then((r) => r.json())
        .then((data) => {
          if (data && data.selected && !callerField.value) {
            callerField.value = data.selected;
          }
        })
        .catch(() => {});
    }
  }
}

function sipDirectCallerId() {
  const el = document.getElementById("sip-caller-id");
  return el ? el.value.trim() : "";
}

async function sipDirectConnect() {
  const username = (document.getElementById("sip-username") || {}).value?.trim() || "";
  const password = (document.getElementById("sip-password") || {}).value || "";
  const callerId = sipDirectCallerId();
  const remember = Boolean((document.getElementById("sip-remember") || {}).checked);

  if (!username || !password) {
    setLoginStatus("Enter the endpoint's SIP username and password.");
    return;
  }
  if (!callerId) {
    setLoginStatus("Enter the number to call from — carriers reject a call without one.");
    return;
  }

  writeStore(SIP_CREDS_KEY, remember ? { username, password, callerId } : null);

  const cleanUsername = username.includes("@") ? username.split("@")[0] : username;
  const sipUser = `${cleanUsername}@${REGISTRAR_HOST}`;
  setLoginStatus(`Signing in as ${cleanUsername}…`);

  try {
    // The backend answers with a session token scoped to SIP-direct mode. Call
    // history, caller-ID selection and CRM write-back all sit behind a session
    // now, so hold on to it.
    const sipSession = await backendJson("/login-sip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sipUser: cleanUsername, callerId }),
    });
    if (sipSession && sipSession.token) {
      sessionToken = sipSession.token;
      sessionStorage.setItem("vobiz_session_token", sessionToken);
    }
  } catch (err) {
    console.warn("[Vobiz] Backend /login-sip note:", err.message);
    setLoginStatus(`Backend rejected this caller ID: ${err.message}`);
  }

  setDialEnabled(true);
  startSipUA(sipUser, password, cleanUsername);
  loadCallHistory();
}

function restoreAuthMode() {
  setAuthMode(readStore(AUTH_MODE_KEY) || "account");
  if (authMode !== "sip") return;

  const saved = readStore(SIP_CREDS_KEY);
  if (!saved || !saved.username) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
  set("sip-username", saved.username);
  set("sip-password", saved.password);
  set("sip-caller-id", saved.callerId);
  const box = document.getElementById("sip-remember");
  if (box) box.checked = true;
  if (saved.password && saved.callerId) {
    sipDirectConnect();
  }
}

// ─── Session & Account Auth ──────────────────────────────────────────────────

async function restoreVobizSession() {
  sessionToken = sessionStorage.getItem("vobiz_session_token") || "";
  try {
    const res = await backendFetch(`/session/${encodeURIComponent(agentId)}`);
    const session = await res.json().catch(() => ({}));
    if (session.loggedIn) {
      try { await backendJson("/setup", { method: "POST" }); } catch (e) { console.warn("[Vobiz] setup note:", e); }
      renderNumberOptions(session.numbers, session.from);
      setLoginStatus(`Logged in as ${session.authId} — calling from ${session.from}`);
      setDialEnabled(true);
      loadCallHistory();
      initVobizSip();
    } else {
      setDialEnabled(false);
      initVobizSip();
    }
  } catch (err) {
    console.warn("[Vobiz] Could not restore session:", err);
    initVobizSip();
  }
}

async function vobizLogin() {
  const authIdInput = document.getElementById("vobiz-auth-id");
  const authTokenInput = document.getElementById("vobiz-auth-token");
  const authId = authIdInput ? authIdInput.value.trim() : "";
  const authToken = authTokenInput ? authTokenInput.value.trim() : "";

  if (!authId || !authToken) {
    setLoginStatus("Enter both an Auth ID and an Auth Token.");
    return;
  }

  setLoginStatus("Logging in…");
  try {
    const data = await backendJson("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, authId, authToken }),
    });

    sessionToken = data.token;
    sessionStorage.setItem("vobiz_session_token", sessionToken);

    try { await backendJson("/setup", { method: "POST" }); } catch (e) { console.warn("[Vobiz] setup note:", e); }
    renderNumberOptions(data.numbers, data.selected);
    setLoginStatus(`Logged in as ${authId} — calling from ${data.selected}`);
    setDialEnabled(true);
    loadCallHistory();
    initVobizSip();
  } catch (err) {
    setLoginStatus(`Login failed: ${err.message}`);
    setDialEnabled(false);
  }
}

async function vobizSelectNumber(e) {
  const number = e.target.value;
  try {
    await backendJson("/select-number", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number }),
    });
    setLoginStatus(`Caller ID set to ${number}`);
  } catch (err) {
    setLoginStatus(`Could not set caller ID: ${err.message}`);
  }
}

// ─── UI Status & Controls ────────────────────────────────────────────────────

function setStatus(text, tone = "pending") {
  const badge = document.getElementById("status");
  const msg = document.getElementById("status-message");

  if (badge) {
    if (text === "Ready" || tone === "ok") {
      badge.textContent = "READY";
      badge.className = "status-badge is-ok registered";
    } else if (tone === "error") {
      badge.textContent = "OFFLINE";
      badge.className = "status-badge is-error unregistered";
    } else {
      badge.textContent = text.toUpperCase();
      badge.className = `status-badge is-${tone}`;
    }
  }

  if (msg) {
    msg.textContent = text;
    if (text === "Ready" || tone === "ok") {
      msg.className = "status-message is-ok";
    } else if (tone === "error") {
      msg.className = "status-message is-error";
    } else if (tone === "busy") {
      msg.className = "status-message is-busy";
    } else {
      msg.className = `status-message is-${tone}`;
    }
  }
}

function setLoginStatus(text) {
  const el = document.getElementById("vobiz-login-status");
  if (el) el.textContent = text;
}

function setDialEnabled(enabled) {
  accountReady = Boolean(enabled);
  updateDialButtonState();
}

function setSipRegistered(registered) {
  sipRegistered = Boolean(registered);
  const badge = document.getElementById("status");
  if (badge) {
    if (registered) {
      badge.textContent = "READY";
      badge.className = "status-badge is-ok registered";
    } else {
      badge.textContent = "OFFLINE";
      badge.className = "status-badge is-error unregistered";
    }
  }
  updateDialButtonState();
}

function updateDialButtonState() {
  const dialBtn = document.getElementById("dialbtn");
  const numSelect = document.getElementById("vobiz-number-select");
  const dialInput = document.getElementById("dialnumber");

  const canDial = accountReady && sipRegistered;
  if (dialBtn) dialBtn.disabled = !canDial;
  if (dialInput) dialInput.disabled = !accountReady;
  if (numSelect) numSelect.disabled = !accountReady;
}

function setHangupVisible(visible) {
  const dialBtn = document.getElementById("dialbtn");
  const hangupBtn = document.getElementById("hangupbtn");
  const numEl = document.getElementById("callnum");
  const timerEl = document.getElementById("call-timer-container");

  if (visible) {
    if (dialBtn) dialBtn.hidden = true;
    if (hangupBtn) hangupBtn.hidden = false;
    if (timerEl) timerEl.hidden = false;
  } else {
    if (dialBtn) dialBtn.hidden = false;
    if (hangupBtn) hangupBtn.hidden = true;
    if (timerEl) timerEl.hidden = true;
    if (numEl) numEl.hidden = true;
  }
}

function renderNumberOptions(numbers, selected) {
  const select = document.getElementById("vobiz-number-select");
  const label = document.getElementById("vobiz-number-label");
  if (!select) return;
  select.innerHTML = "";
  if (!numbers || !numbers.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No numbers found on this account";
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  numbers.forEach(num => {
    const opt = document.createElement("option");
    opt.value = num;
    opt.textContent = num;
    if (num === selected) opt.selected = true;
    select.appendChild(opt);
  });
  select.disabled = false;
  select.hidden = false;
  if (label) label.hidden = false;
}

// ─── Call History & Recordings ───────────────────────────────────────────────

async function loadCallHistory() {
  const historyList = document.getElementById("call-history-list");
  if (!historyList) return;

  historyList.innerHTML = `<li class="history-empty">Loading recent recordings…</li>`;
  try {
    const data = await backendJson("/recordings?limit=10");
    const recordings = (data && (data.recordings || data.objects)) || [];
    if (!recordings.length) {
      historyList.innerHTML = `<li class="history-empty">No calls recorded yet. Completed calls with audio will appear here automatically.</li>`;
      return;
    }

    historyList.innerHTML = "";
    recordings.forEach(rec => {
      const li = document.createElement("li");
      li.className = "history-item";

      const topRow = document.createElement("div");
      topRow.className = "history-top";

      const timeSpan = document.createElement("span");
      timeSpan.className = "history-time";
      timeSpan.textContent = rec.add_time || "Recent call";

      const durSpan = document.createElement("span");
      durSpan.className = "history-dur";
      durSpan.textContent = formatDuration(Number(rec.rounded_recording_duration || rec.duration || 0));

      topRow.appendChild(timeSpan);
      topRow.appendChild(durSpan);

      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "none";
      audio.className = "history-audio";
      const playSrc = rec.playUrl || `${backendUrl}/play-recording?callUuid=${encodeURIComponent(rec.call_uuid || "")}&recordingId=${encodeURIComponent(rec.recording_id || "")}`;
      audio.src = playSrc;

      li.appendChild(topRow);
      li.appendChild(audio);
      historyList.appendChild(li);
    });
  } catch (err) {
    historyList.innerHTML = `<li class="history-empty">Recordings unavailable (${err.message}). Sign in above to view recordings.</li>`;
  }
}

// ─── Inbound Webhook Setup ───────────────────────────────────────────────────

async function setupInboundCalling() {
  const statusEl = document.getElementById("inbound-setup-status");
  if (statusEl) {
    statusEl.textContent = "Configuring inbound routing…";
    statusEl.hidden = false;
  }
  try {
    const data = await backendJson("/setup-inbound", { method: "POST" });
    if (statusEl) {
      statusEl.textContent = data.message || "Inbound configuration updated successfully.";
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Inbound setup note: ${err.message}`;
    }
  }
}

// ─── WebRTC Media & Audio ────────────────────────────────────────────────────

function attachRemoteAudio(session) {
  const audioEl = document.getElementById("vobiz-remote-audio");
  if (!audioEl) return;
  const bindTrack = pc => {
    if (!pc) return;
    pc.addEventListener("track", event => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(err => console.warn("[Vobiz] Audio autoplay note:", err));
    });
  };
  session.on("peerconnection", e => bindTrack(e.peerconnection));
  bindTrack(session.connection);
}

// ─── Incoming Call Popup & Ringtone ──────────────────────────────────────────

let incomingPending = false;
let ringCtx = null;
let ringTimer = null;

function startRingtone() {
  stopRingtone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringCtx = new Ctx();
    const beep = () => {
      if (!ringCtx) return;
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, ringCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ringCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + 0.9);
      osc.connect(gain).connect(ringCtx.destination);
      osc.start();
      osc.stop(ringCtx.currentTime + 0.95);
    };
    beep();
    ringTimer = setInterval(beep, 2000);
  } catch (err) {
    console.warn("[Vobiz] Ringtone note:", err);
  }
}

function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (ringCtx) {
    try { ringCtx.close(); } catch { /* ignore */ }
    ringCtx = null;
  }
}

function showIncoming(caller) {
  const fromEl = document.getElementById("incoming-from");
  if (fromEl) fromEl.textContent = caller || "Unknown";
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = false;
  openOpenFrameIfAvailable();
}

function endIncoming(status = "Ready") {
  incomingPending = false;
  stopRingtone();
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = true;
  setHangupVisible(false);
  currentRTCSession = null;
  if (status) setStatus(status, "ok");
}

async function acceptCall() {
  if (!currentRTCSession) return;
  incomingPending = false;
  stopRingtone();
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = true;

  try {
    attachRemoteAudio(currentRTCSession);
    currentRTCSession.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });
    setHangupVisible(true);
    setStatus("On a call", "busy");
  } catch (err) {
    console.error("[Vobiz] Could not answer incoming call:", err);
    try { currentRTCSession.terminate(); } catch { /* ignore */ }
    endIncoming();
  }
}

function declineCall() {
  if (!currentRTCSession) return;
  incomingPending = false;
  try {
    currentRTCSession.terminate();
  } catch (err) {
    console.warn("[Vobiz] Decline note:", err);
  }
  endIncoming();
}

// ─── SIP Registration ────────────────────────────────────────────────────────

async function initVobizSip() {
  if (vobizUA && vobizUA.isRegistered()) return;

  let agent;
  try {
    const res = await backendFetch(`/agent/${encodeURIComponent(agentId)}`);
    if (!res.ok) {
      const resSession = await backendFetch("/agent");
      if (resSession.ok) agent = await resSession.json();
      else {
        setStatus(`Could not load identity for "${agentId}".`, "error");
        setSipRegistered(false);
        return;
      }
    } else {
      agent = await res.json();
    }
  } catch (err) {
    console.error("[Vobiz] Cannot reach calling bridge backend:", err);
    setStatus("Cannot reach the calling backend bridge.", "error");
    setSipRegistered(false);
    return;
  }

  agentIdentity = agent;
  startSipUA(agent.sipUser, agent.sipPassword, agent.displayName);
}

function startSipUA(sipUser, sipPassword, displayName) {
  setStatus(`Connecting as ${displayName || sipUser}…`, "pending");

  if (vobizUA) {
    const prev = vobizUA;
    vobizUA = null;
    try { prev.removeAllListeners(); } catch { /* ignore */ }
    try { prev.stop(); } catch { /* ignore */ }
  }

  if (typeof JsSIP === "undefined") {
    console.error("[Vobiz] JsSIP library is not loaded.");
    setStatus("JsSIP library failed to load.", "error");
    setSipRegistered(false);
    return;
  }

  try {
    const cleanUri = sipUser.startsWith("sip:") ? sipUser : `sip:${sipUser}`;
    const vobizSocket = new JsSIP.WebSocketInterface(registrarUrl);
    vobizUA = new JsSIP.UA({
      sockets: [vobizSocket],
      uri: cleanUri,
      password: sipPassword,
      display_name: displayName || sipUser,
      register: true,
      user_agent: "VobizServiceNowCalling/2.0.0",
      session_timers: false,
    });

    vobizUA.on("registered", () => {
      setStatus("Ready", "ok");
      setSipRegistered(true);
    });

    vobizUA.on("registrationFailed", e => {
      setStatus(`Registration failed: ${(e && e.cause) || "unknown"}`, "error");
      setSipRegistered(false);
    });

    vobizUA.on("unregistered", () => {
      setStatus("Not registered — reconnecting…", "pending");
      setSipRegistered(false);
    });

    vobizUA.on("disconnected", () => {
      setStatus("Disconnected from registrar", "error");
      setSipRegistered(false);
    });

    // Inbound call handler
    vobizUA.on("newRTCSession", data => {
      if (data.originator !== "remote") return;

      const remoteCaller = (data.session && data.session.remote_identity && data.session.remote_identity.uri && data.session.remote_identity.uri.user) || "Unknown caller";
      callDirection = "Inbound";
      lastDialedNumber = remoteCaller;
      currentRTCSession = data.session;
      incomingPending = true;

      setStatus(`Incoming call from ${remoteCaller}`, "busy");
      showIncoming(remoteCaller);
      startRingtone();

      currentRTCSession.on("confirmed", () => {
        startTimer();
        setStatus("On a call", "busy");
        const numEl = document.getElementById("callnum");
        if (numEl) {
          numEl.textContent = `On a call with ${remoteCaller}`;
          numEl.hidden = false;
        }
      });

      const onCallDone = () => {
        stopTimer();
        endIncoming("Ready");
        const numEl = document.getElementById("callnum");
        if (numEl) {
          numEl.textContent = "Call ended";
          setTimeout(() => { numEl.hidden = true; }, 4000);
        }
        setHangupVisible(false);
        autoLogCallToServiceNow();
        setTimeout(loadCallHistory, 5000);
      };

      currentRTCSession.on("ended", onCallDone);
      currentRTCSession.on("failed", onCallDone);
    });

    vobizUA.start();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("No microphone access — calls cannot connect.", "error");
    }
  } catch (err) {
    console.error("[Vobiz] Failed to initialise SIP UA:", err);
    setStatus("Failed to connect SIP transport.", "error");
    setSipRegistered(false);
  }
}

function callHeaders() {
  const headers = [];
  if (authMode === "sip") {
    const callerId = sipDirectCallerId().replace(/[^\d+]/g, "");
    if (callerId) headers.push(`X-VH-Caller-ID: ${callerId}`);
  }
  return headers;
}

// ─── Outbound Calling ────────────────────────────────────────────────────────

function onDialButtonClick() {
  const input = document.getElementById("dialnumber");
  const number = input && input.value.trim();
  placeCall(number);
}

async function placeCall(number) {
  if (!number) return;

  const numEl = document.getElementById("callnum");
  if (numEl) {
    numEl.textContent = `Calling ${number}…`;
    numEl.hidden = false;
  }

  if (!vobizUA || !sipRegistered) {
    const message = "Not registered yet — wait for the badge to turn green.";
    if (numEl) numEl.textContent = message;
    setLoginStatus(message);
    return;
  }

  if (currentRTCSession) {
    if (numEl) numEl.textContent = "Already on an active call.";
    return;
  }

  callDirection = "Outbound";
  lastDialedNumber = number;

  const cleanNumber = String(number).replace(/[^\d+]/g, "");
  const target = `sip:${cleanNumber}@${REGISTRAR_HOST}`;

  try {
    const session = vobizUA.call(target, {
      extraHeaders: callHeaders(),
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });

    currentRTCSession = session;
    attachRemoteAudio(session);
    setHangupVisible(true);

    session.on("progress", () => {
      if (numEl) numEl.textContent = `Ringing ${number}…`;
      setStatus("Ringing", "busy");
    });

    session.on("confirmed", () => {
      startTimer();
      if (numEl) numEl.textContent = `On a call with ${number}`;
      setStatus("On a call", "busy");
    });

    session.on("failed", e => {
      stopTimer();
      const cause = (e && e.cause) || "unknown";
      if (numEl) numEl.textContent = `Call failed — ${cause}`;
      setStatus("Ready", "ok");
      currentRTCSession = null;
      setHangupVisible(false);
    });

    session.on("ended", () => {
      stopTimer();
      if (numEl) {
        numEl.textContent = "Call ended";
        setTimeout(() => { numEl.hidden = true; }, 4000);
      }
      setStatus("Ready", "ok");
      currentRTCSession = null;
      setHangupVisible(false);

      // Auto-log call to ServiceNow CRM interaction
      autoLogCallToServiceNow();
      setTimeout(loadCallHistory, 5000);
    });
  } catch (err) {
    console.error("[Vobiz] Could not place call:", err);
    const message = err && err.name === "NotAllowedError"
      ? "Microphone permission was denied."
      : `Could not start call — ${err.message}`;
    if (numEl) numEl.textContent = message;
    setLoginStatus(message);
    setHangupVisible(false);
  }
}

function hangUp() {
  if (!currentRTCSession) return;
  try {
    currentRTCSession.terminate();
  } catch (err) {
    console.warn("[Vobiz] Hangup failed:", err);
  }
}

// ─── ServiceNow CRM Interaction Write-back ───────────────────────────────────

async function autoLogCallToServiceNow() {
  if (!backendUrl) return;

  // Short delay to allow backend call ledger to capture CallUUID
  await new Promise(r => setTimeout(r, 1200));

  let recordingUrl = "";
  let callUuid = "";
  try {
    const recData = await backendJson(`/call-record?to=${encodeURIComponent(lastDialedNumber)}`);
    if (recData && recData.found) {
      callUuid = recData.callUuid || "";
      recordingUrl = recData.recordingUrl || `${backendUrl}/play-recording?callUuid=${encodeURIComponent(callUuid)}`;
    }
  } catch (e) {
    console.warn("[Vobiz] /call-record query note:", e.message);
  }

  try {
    await backendJson("/sync-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toNumber: lastDialedNumber,
        duration: callDurationSeconds,
        callDirection,
        agentId,
        callUuid,
        notes: `Call with ${lastDialedNumber} via Vobiz Softphone`,
      }),
    });
    console.log("[Vobiz] Call successfully synced to ServiceNow interaction.");
  } catch (err) {
    console.warn("[Vobiz] ServiceNow sync note:", err.message);
  }
}

// ─── Duration Timer ──────────────────────────────────────────────────────────

function startTimer() {
  callDurationSeconds = 0;
  clearInterval(timerInterval);
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    callDurationSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function updateTimerDisplay() {
  const timerEl = document.getElementById("call-timer");
  if (timerEl) {
    const m = String(Math.floor(callDurationSeconds / 60)).padStart(2, "0");
    const s = String(callDurationSeconds % 60).padStart(2, "0");
    timerEl.textContent = `${m}:${s}`;
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
