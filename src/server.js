const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const PORT = Number(process.env.PORT || 8080);
const HUB_ID = process.env.HUB_ID || "hub-trial";
const OPENCLAW_AUTH_TOKEN_ENV = String(process.env.OPENCLAW_AUTH_TOKEN || "").trim();
const OPENCLAW_RECONNECT_MS = Number(process.env.OPENCLAW_RECONNECT_MS || 2000);
const OPENCLAW_DISCOVERY_TIMEOUT_MS = Number(
  process.env.OPENCLAW_DISCOVERY_TIMEOUT_MS || 1600
);
const SETTINGS_FILE = path.resolve(
  process.env.SETTINGS_FILE || path.join(__dirname, "..", "data", "settings.json")
);

const ENV_OPENCLAW_WS_URL = String(process.env.OPENCLAW_WS_URL || "").trim();
const ENV_OPENCLAW_WS_CANDIDATES = String(
  process.env.OPENCLAW_WS_CANDIDATES || ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ENV_OPENCLAW_HOST = String(process.env.OPENCLAW_HOST || "").trim();
const ENV_OPENCLAW_PORT = Number(process.env.OPENCLAW_PORT || 43136);
const ENV_OPENCLAW_PATH = normalizePath(
  String(process.env.OPENCLAW_PATH || "").trim()
);
const ENV_OPENCLAW_AUTO_DISCOVER = parseBoolean(
  process.env.OPENCLAW_AUTO_DISCOVER,
  true
);

const PROXY_MANAGER_KIND = String(process.env.PROXY_MANAGER_KIND || "none")
  .trim()
  .toLowerCase();
const PROXY_AUTO_REGISTER = parseBoolean(process.env.PROXY_AUTO_REGISTER, false);
const PROXY_MANAGER_URL = String(process.env.PROXY_MANAGER_URL || "").trim();
const PROXY_MANAGER_EMAIL = String(process.env.PROXY_MANAGER_EMAIL || "").trim();
const PROXY_MANAGER_PASSWORD = String(
  process.env.PROXY_MANAGER_PASSWORD || ""
).trim();
const PROXY_PUBLIC_DOMAIN = String(process.env.PROXY_PUBLIC_DOMAIN || "").trim();
const PROXY_TARGET_HOST = String(process.env.PROXY_TARGET_HOST || "hub").trim();
const PROXY_TARGET_PORT = Number(process.env.PROXY_TARGET_PORT || PORT);
const PROXY_TARGET_SCHEME = String(process.env.PROXY_TARGET_SCHEME || "http")
  .trim()
  .toLowerCase();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim();
const HUB_ALLOWED_ORIGINS = parseAllowedOrigins(
  String(process.env.HUB_ALLOWED_ORIGINS || "*").trim()
);

const DOCKER_AUTOMATION_ENABLED = parseBoolean(
  process.env.DOCKER_AUTOMATION_ENABLED,
  true
);
const DOCKER_AUTOMATION_AUTO_PAIR_ON_STARTUP = parseBoolean(
  process.env.DOCKER_AUTOMATION_AUTO_PAIR_ON_STARTUP,
  true
);
const DOCKER_BIN = String(process.env.DOCKER_BIN || "docker").trim() || "docker";
const DOCKER_COMMAND_TIMEOUT_MS = Number(process.env.DOCKER_COMMAND_TIMEOUT_MS || 12000);
const OPENCLAW_DOCKER_CONTAINER_NAME = String(
  process.env.OPENCLAW_DOCKER_CONTAINER_NAME || ""
).trim();
const OPENCLAW_DOCKER_CONTAINER_MATCH = String(
  process.env.OPENCLAW_DOCKER_CONTAINER_MATCH || "openclaw"
)
  .trim()
  .toLowerCase();
const OPENCLAW_DOCKER_NETWORK = String(
  process.env.OPENCLAW_DOCKER_NETWORK || ""
).trim();
const OPENCLAW_DOCKER_WS_URL = String(
  process.env.OPENCLAW_DOCKER_WS_URL || ""
).trim();
const OPENCLAW_DOCKER_GATEWAY_PORT = Number(
  process.env.OPENCLAW_DOCKER_GATEWAY_PORT || 43136
);
const OPENCLAW_DOCKER_PROBE_IMAGE = String(
  process.env.OPENCLAW_DOCKER_PROBE_IMAGE || "ghcr.io/hostinger/hvps-openclaw:latest"
).trim();
const OPENCLAW_DOCKER_STATE_VOLUME = String(
  process.env.OPENCLAW_DOCKER_STATE_VOLUME || "hub_openclaw_state"
).trim();
const OPENCLAW_DOCKER_ALLOW_INSECURE_PRIVATE_WS = parseBoolean(
  process.env.OPENCLAW_DOCKER_ALLOW_INSECURE_PRIVATE_WS,
  true
);
const OPENCLAW_DOCKER_PROBE_TIMEOUT_MS = Number(
  process.env.OPENCLAW_DOCKER_PROBE_TIMEOUT_MS || 5000
);
const OPENCLAW_DOCKER_AUTO_APPROVE = parseBoolean(
  process.env.OPENCLAW_DOCKER_AUTO_APPROVE,
  true
);

const DEFAULT_SETTINGS = {
  openclaw: {
    url: "",
    token: "",
    autoDiscover: ENV_OPENCLAW_AUTO_DISCOVER,
    candidates: []
  },
  discovery: {
    openclaw: {
      scannedAt: "",
      bestUrl: "",
      results: []
    }
  },
  proxy: {
    lastAction: null
  },
  docker: {
    lastAction: null
  }
};

const settings = loadSettings();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  applyCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));

const state = {
  agents: new Map(),
  localClients: new Set(),
  openclawConnected: false,
  openclawLastError: "",
  openclawSocket: null,
  reconnectTimer: null,
  openclawTargetUrl: null,
  openclawAttempt: 0,
  openclawManualClose: false,
  openclawCandidatesCache: [],
  proxyLastAction: settings.proxy.lastAction || null,
  dockerLastAction: settings.docker.lastAction || null
};

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseAllowedOrigins(raw) {
  const value = String(raw || "").trim();
  if (!value || value === "*") {
    return "*";
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin) {
  if (HUB_ALLOWED_ORIGINS === "*") {
    return true;
  }
  return Array.isArray(HUB_ALLOWED_ORIGINS) && HUB_ALLOWED_ORIGINS.includes(origin);
}

function applyCorsHeaders(req, res) {
  const origin = String(req.headers.origin || "").trim();
  if (HUB_ALLOWED_ORIGINS === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function normalizePath(pathValue) {
  const value = String(pathValue || "").trim();
  if (!value || value === "/") {
    return "";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function toIsoNow() {
  return new Date().toISOString();
}

function log(message, details = "") {
  const suffix = details ? ` ${details}` : "";
  console.log(`${toIsoNow()} ${message}${suffix}`);
}

function safeParse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (_error) {
    return null;
  }
}

function maskToken(token) {
  if (!token) {
    return "";
  }
  if (token.length <= 6) {
    return "*".repeat(token.length);
  }
  return `${token.slice(0, 3)}***${token.slice(-2)}`;
}

function mergeObjects(baseValue, overrideValue) {
  if (!overrideValue || typeof overrideValue !== "object" || Array.isArray(overrideValue)) {
    return baseValue;
  }
  const merged = { ...baseValue };
  for (const [key, value] of Object.entries(overrideValue)) {
    const baseChild = merged[key];
    if (Array.isArray(baseChild)) {
      merged[key] = Array.isArray(value) ? value : baseChild;
      continue;
    }
    if (baseChild && typeof baseChild === "object" && !Array.isArray(baseChild)) {
      merged[key] = mergeObjects(baseChild, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return structuredClone(DEFAULT_SETTINGS);
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return mergeObjects(structuredClone(DEFAULT_SETTINGS), parsed);
  } catch (error) {
    log("Failed to load settings file:", error.message);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    log("Failed to save settings:", error.message);
  }
}

function sanitizeOpenClawUrl(url) {
  const candidate = String(url || "").trim();
  if (!candidate) {
    return "";
  }
  if (!candidate.startsWith("ws://") && !candidate.startsWith("wss://")) {
    throw new Error("OpenClaw URL wajib pakai ws:// atau wss://");
  }
  return candidate;
}

function sendJson(socket, message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function broadcast(message) {
  const encoded = JSON.stringify(message);
  for (const client of state.localClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(encoded);
    }
  }
}

function getProxyContext(requestHeaders = {}) {
  const forwardedProto = String(requestHeaders["x-forwarded-proto"] || "").trim();
  const forwardedHost = String(requestHeaders["x-forwarded-host"] || "").trim();
  const requestHost = String(requestHeaders.host || "").trim();
  const effectiveHost = forwardedHost || requestHost;
  const effectiveProto = forwardedProto || "http";
  const effectiveBaseUrl = PUBLIC_BASE_URL || (effectiveHost ? `${effectiveProto}://${effectiveHost}` : "");
  return {
    effectiveBaseUrl,
    requestHost,
    forwardedHost,
    forwardedProto,
    localAccessUrl: `http://localhost:${PORT}`,
    containerAccessUrl: `${PROXY_TARGET_SCHEME}://${PROXY_TARGET_HOST}:${PROXY_TARGET_PORT}`,
    proxyManagerKind: PROXY_MANAGER_KIND
  };
}

function getCurrentOpenClawToken() {
  return settings.openclaw.token || OPENCLAW_AUTH_TOKEN_ENV;
}

function buildOpenClawCandidates() {
  const urls = [];
  const addUrl = (urlValue) => {
    const value = String(urlValue || "").trim();
    if (!value || urls.includes(value)) {
      return;
    }
    if (!value.startsWith("ws://") && !value.startsWith("wss://")) {
      return;
    }
    urls.push(value);
  };

  addUrl(settings.openclaw.url);
  addUrl(ENV_OPENCLAW_WS_URL);

  for (const item of settings.openclaw.candidates || []) {
    addUrl(item);
  }
  for (const item of ENV_OPENCLAW_WS_CANDIDATES) {
    addUrl(item);
  }

  const discoveryResults = settings.discovery?.openclaw?.results || [];
  for (const result of discoveryResults) {
    if (result && result.reachable) {
      addUrl(result.url);
    }
  }

  if (ENV_OPENCLAW_HOST) {
    addUrl(`ws://${ENV_OPENCLAW_HOST}:${ENV_OPENCLAW_PORT}${ENV_OPENCLAW_PATH}`);
  }

  if (urls.length === 0) {
    addUrl(`ws://openclaw:${ENV_OPENCLAW_PORT}${ENV_OPENCLAW_PATH}`);
    addUrl(`ws://host.docker.internal:${ENV_OPENCLAW_PORT}${ENV_OPENCLAW_PATH}`);
    addUrl(`ws://127.0.0.1:${ENV_OPENCLAW_PORT}${ENV_OPENCLAW_PATH}`);
    addUrl(`ws://localhost:${ENV_OPENCLAW_PORT}${ENV_OPENCLAW_PATH}`);
  }

  return urls;
}

function serializeAgents() {
  return Array.from(state.agents.values()).sort((a, b) => {
    return a.name.localeCompare(b.name);
  });
}

function getPublicConfig(requestHeaders = {}) {
  const token = getCurrentOpenClawToken();
  const candidates = buildOpenClawCandidates();
  return {
    openclaw: {
      configuredUrl: settings.openclaw.url || "",
      activeUrl: state.openclawTargetUrl,
      connected: state.openclawConnected,
      lastError: state.openclawLastError || "",
      autoDiscover: settings.openclaw.autoDiscover !== false,
      hasToken: Boolean(token),
      tokenPreview: maskToken(token),
      candidates,
      lastDiscovery: settings.discovery.openclaw
    },
    proxy: {
      managerKind: PROXY_MANAGER_KIND,
      autoRegister: PROXY_AUTO_REGISTER,
      managerUrl: PROXY_MANAGER_URL || "",
      publicDomain: PROXY_PUBLIC_DOMAIN || "",
      target: `${PROXY_TARGET_SCHEME}://${PROXY_TARGET_HOST}:${PROXY_TARGET_PORT}`,
      lastAction: state.proxyLastAction
    },
    docker: {
      automationEnabled: DOCKER_AUTOMATION_ENABLED,
      autoPairOnStartup: DOCKER_AUTOMATION_AUTO_PAIR_ON_STARTUP,
      containerName: OPENCLAW_DOCKER_CONTAINER_NAME || "",
      containerMatch: OPENCLAW_DOCKER_CONTAINER_MATCH || "",
      networkPreference: OPENCLAW_DOCKER_NETWORK || "(auto detect)",
      wsUrlOverride: OPENCLAW_DOCKER_WS_URL || "",
      gatewayPort: OPENCLAW_DOCKER_GATEWAY_PORT,
      probeImage: OPENCLAW_DOCKER_PROBE_IMAGE || "",
      autoApprove: OPENCLAW_DOCKER_AUTO_APPROVE,
      lastAction: state.dockerLastAction
    },
    proxyContext: getProxyContext(requestHeaders)
  };
}

function sendConfig(socket, requestHeaders = {}) {
  sendJson(socket, {
    type: "config",
    payload: getPublicConfig(requestHeaders)
  });
}

function broadcastConfig() {
  broadcast({
    type: "config",
    payload: getPublicConfig({})
  });
}

function sendSystemMessage(text) {
  broadcast({
    type: "system",
    payload: {
      message: text,
      openclawConnected: state.openclawConnected,
      openclawTargetUrl: state.openclawTargetUrl,
      timestamp: toIsoNow()
    }
  });
}

function upsertAgent(agent) {
  if (!agent || typeof agent !== "object") {
    return;
  }
  const id = String(agent.id || "").trim();
  if (!id) {
    return;
  }
  const existing = state.agents.get(id) || {};
  state.agents.set(id, {
    id,
    name: String(agent.name || existing.name || id),
    status: String(agent.status || existing.status || "unknown"),
    description: String(agent.description || existing.description || ""),
    lastSeen: String(agent.lastSeen || toIsoNow())
  });
}

function handleOpenClawMessage(rawMessage) {
  const message = safeParse(rawMessage);
  if (!message) {
    broadcast({
      type: "raw",
      payload: {
        source: "openclaw",
        value: rawMessage.toString()
      }
    });
    return;
  }

  const type = message.type || "unknown";
  const payload = message.payload || {};

  if (type === "agent_list" && Array.isArray(payload.agents)) {
    state.agents.clear();
    for (const agent of payload.agents) {
      upsertAgent(agent);
    }
    broadcast({
      type: "agent_list",
      payload: {
        agents: serializeAgents()
      }
    });
    return;
  }

  if (type === "agent_update") {
    upsertAgent(payload.agent || payload);
    broadcast({
      type: "agent_list",
      payload: {
        agents: serializeAgents()
      }
    });
    return;
  }

  if (type === "chat") {
    const chatPayload = {
      agentId: String(payload.agentId || "openclaw"),
      agentName: String(payload.agentName || payload.agentId || "OpenClaw"),
      text: String(payload.text || ""),
      source: "openclaw",
      timestamp: String(payload.timestamp || toIsoNow())
    };
    upsertAgent({
      id: chatPayload.agentId,
      name: chatPayload.agentName,
      status: "online",
      lastSeen: chatPayload.timestamp
    });
    broadcast({
      type: "chat",
      payload: chatPayload
    });
    return;
  }

  broadcast({
    type,
    payload
  });
}

function getConnectionCandidates() {
  const candidates = buildOpenClawCandidates();
  state.openclawCandidatesCache = candidates;
  return candidates;
}

function pickNextOpenClawUrl(candidates) {
  if (candidates.length === 0) {
    return "";
  }
  if (settings.openclaw.url) {
    return settings.openclaw.url;
  }
  const index = state.openclawAttempt % candidates.length;
  state.openclawAttempt += 1;
  return candidates[index];
}

function scheduleReconnect() {
  const candidates = getConnectionCandidates();
  if (candidates.length === 0) {
    return;
  }
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    connectToOpenClaw();
  }, OPENCLAW_RECONNECT_MS);
}

function connectToOpenClaw() {
  const candidates = getConnectionCandidates();
  if (candidates.length === 0) {
    log("No OpenClaw URL candidates found; hub started in local-only mode.");
    return;
  }

  const hasLiveSocket =
    state.openclawSocket &&
    (state.openclawSocket.readyState === WebSocket.OPEN ||
      state.openclawSocket.readyState === WebSocket.CONNECTING);
  if (hasLiveSocket) {
    return;
  }

  const targetUrl = pickNextOpenClawUrl(candidates);
  if (!targetUrl) {
    log("No OpenClaw target URL selected.");
    return;
  }
  state.openclawTargetUrl = targetUrl;

  const headers = {};
  const token = getCurrentOpenClawToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  log("Connecting to OpenClaw:", targetUrl);
  const ws = new WebSocket(targetUrl, { headers });
  state.openclawSocket = ws;

  ws.on("open", () => {
    state.openclawConnected = true;
    state.openclawLastError = "";
    state.openclawAttempt = 0;
    log("Connected to OpenClaw:", targetUrl);
    sendSystemMessage(`Hub connected to OpenClaw (${targetUrl})`);
    broadcastConfig();
    sendJson(ws, {
      type: "hub_hello",
      payload: {
        hubId: HUB_ID,
        timestamp: toIsoNow()
      }
    });
    sendJson(ws, {
      type: "request_agents",
      payload: {
        hubId: HUB_ID
      }
    });
  });

  ws.on("message", (raw) => {
    handleOpenClawMessage(raw);
  });

  ws.on("close", (code, reason) => {
    state.openclawConnected = false;
    state.openclawSocket = null;
    const reasonText = reason ? reason.toString() : "";
    const errorDetail = state.openclawLastError || reasonText;

    if (state.openclawManualClose) {
      state.openclawManualClose = false;
      log("OpenClaw socket closed for reconfigure.");
      connectToOpenClaw();
      return;
    }

    sendSystemMessage(
      errorDetail
        ? `OpenClaw disconnected (code ${code}): ${errorDetail}`
        : `OpenClaw disconnected (code ${code})`
    );
    broadcastConfig();
    log(
      "OpenClaw closed:",
      `${code} ${reasonText || state.openclawLastError} (${targetUrl})`
    );
    scheduleReconnect();
  });

  ws.on("error", (error) => {
    state.openclawLastError = String(error?.message || "unknown OpenClaw error");
    log("OpenClaw error:", error.message);
  });
}

function reconnectToOpenClaw(reason) {
  log("Reconnecting OpenClaw:", reason);
  clearTimeout(state.reconnectTimer);
  if (state.openclawSocket) {
    state.openclawManualClose = true;
    try {
      state.openclawSocket.close(1000, "reconfigure");
    } catch (_error) {
      state.openclawSocket = null;
      connectToOpenClaw();
    }
    return;
  }
  connectToOpenClaw();
}

async function probeOpenClawUrl(url, token) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let socket = null;
    let timeoutId = null;
    let messageWaitId = null;

    const done = (reachable, reason) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(messageWaitId);
      if (socket) {
        try {
          socket.terminate();
        } catch (_error) {
          // no-op
        }
      }
      resolve({
        url,
        reachable,
        latencyMs: Date.now() - start,
        reason: String(reason || "")
      });
    };

    try {
      const headers = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      socket = new WebSocket(url, {
        headers,
        handshakeTimeout: OPENCLAW_DISCOVERY_TIMEOUT_MS
      });
    } catch (error) {
      done(false, error.message);
      return;
    }

    timeoutId = setTimeout(() => {
      done(false, "timeout");
    }, OPENCLAW_DISCOVERY_TIMEOUT_MS + 300);

    socket.on("open", () => {
      try {
        socket.send(
          JSON.stringify({
            type: "request_agents",
            payload: { source: "hub-discovery" }
          })
        );
      } catch (_error) {
        // no-op
      }

      messageWaitId = setTimeout(() => {
        done(true, "connected");
      }, 260);
    });

    socket.on("message", (raw) => {
      const message = safeParse(raw);
      const detail = message && message.type ? `connected (${message.type})` : "connected";
      done(true, detail);
    });

    socket.on("close", (code) => {
      if (!settled) {
        done(code === 1000, `closed (${code})`);
      }
    });

    socket.on("error", (error) => {
      done(false, error.message);
    });
  });
}

async function runOpenClawDiscovery(options = {}) {
  const autoApply = options.autoApply !== false;
  const trigger = options.trigger || "manual";
  const candidates = getConnectionCandidates();
  const token = getCurrentOpenClawToken();
  if (candidates.length === 0) {
    const result = {
      scannedAt: toIsoNow(),
      bestUrl: "",
      reachableCount: 0,
      results: [],
      trigger
    };
    settings.discovery.openclaw = result;
    saveSettings();
    broadcastConfig();
    return result;
  }

  const probes = await Promise.all(candidates.map((url) => probeOpenClawUrl(url, token)));
  probes.sort((a, b) => {
    if (a.reachable !== b.reachable) {
      return a.reachable ? -1 : 1;
    }
    return a.latencyMs - b.latencyMs;
  });

  const best = probes.find((item) => item.reachable) || null;
  const result = {
    scannedAt: toIsoNow(),
    bestUrl: best ? best.url : "",
    reachableCount: probes.filter((item) => item.reachable).length,
    results: probes,
    trigger
  };

  settings.discovery.openclaw = result;
  settings.openclaw.candidates = candidates;
  if (best && autoApply) {
    settings.openclaw.url = best.url;
  }
  saveSettings();
  broadcastConfig();

  if (best && autoApply) {
    reconnectToOpenClaw("discovery apply");
  }

  return result;
}

async function proxyFetchJson(baseUrl, apiPath, options = {}) {
  const url = `${baseUrl}${apiPath}`;
  const headers = {
    "content-type": "application/json"
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch (_error) {
    parsed = null;
  }
  if (!response.ok) {
    const errorMsg = parsed && parsed.message ? parsed.message : `${response.status} ${response.statusText}`;
    throw new Error(`Proxy API ${apiPath} gagal: ${errorMsg}`);
  }
  return parsed;
}

async function autoSetupProxy(options = {}) {
  const trigger = options.trigger || "manual";
  const startedAt = toIsoNow();

  const saveAndBroadcast = (result) => {
    state.proxyLastAction = result;
    settings.proxy.lastAction = result;
    saveSettings();
    broadcastConfig();
  };

  if (PROXY_MANAGER_KIND !== "npm") {
    const skipped = {
      ok: false,
      status: "skipped",
      message: "Proxy manager automation aktif hanya untuk PROXY_MANAGER_KIND=npm.",
      trigger,
      startedAt,
      finishedAt: toIsoNow()
    };
    saveAndBroadcast(skipped);
    return skipped;
  }

  if (!PROXY_MANAGER_URL || !PROXY_MANAGER_EMAIL || !PROXY_MANAGER_PASSWORD || !PROXY_PUBLIC_DOMAIN) {
    const skipped = {
      ok: false,
      status: "skipped",
      message:
        "Isi PROXY_MANAGER_URL, PROXY_MANAGER_EMAIL, PROXY_MANAGER_PASSWORD, dan PROXY_PUBLIC_DOMAIN dulu.",
      trigger,
      startedAt,
      finishedAt: toIsoNow()
    };
    saveAndBroadcast(skipped);
    return skipped;
  }

  const baseUrl = PROXY_MANAGER_URL.replace(/\/+$/, "");
  const domainNames = PROXY_PUBLIC_DOMAIN.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  try {
    const tokenResult = await proxyFetchJson(baseUrl, "/api/tokens", {
      method: "POST",
      body: {
        identity: PROXY_MANAGER_EMAIL,
        secret: PROXY_MANAGER_PASSWORD
      }
    });
    const apiToken = tokenResult && tokenResult.token ? tokenResult.token : "";
    if (!apiToken) {
      throw new Error("Token auth dari proxy manager kosong.");
    }

    const existingHosts = await proxyFetchJson(baseUrl, "/api/nginx/proxy-hosts", {
      token: apiToken
    });
    const existing = Array.isArray(existingHosts)
      ? existingHosts.find((item) => {
          const names = Array.isArray(item.domain_names) ? item.domain_names : [];
          return domainNames.some((domain) => names.includes(domain));
        })
      : null;

    const payload = {
      domain_names: domainNames,
      forward_scheme: PROXY_TARGET_SCHEME,
      forward_host: PROXY_TARGET_HOST,
      forward_port: PROXY_TARGET_PORT,
      access_list_id: 0,
      certificate_id: 0,
      ssl_forced: false,
      caching_enabled: false,
      block_exploits: true,
      advanced_config: "",
      meta: {
        letsencrypt_agree: false,
        dns_challenge: false
      },
      allow_websocket_upgrade: true,
      http2_support: false,
      hsts_enabled: false,
      hsts_subdomains: false
    };

    let action = "created";
    if (existing && existing.id) {
      await proxyFetchJson(baseUrl, `/api/nginx/proxy-hosts/${existing.id}`, {
        method: "PUT",
        token: apiToken,
        body: {
          ...existing,
          ...payload
        }
      });
      action = "updated";
    } else {
      await proxyFetchJson(baseUrl, "/api/nginx/proxy-hosts", {
        method: "POST",
        token: apiToken,
        body: payload
      });
    }

    const ok = {
      ok: true,
      status: "success",
      action,
      managerUrl: baseUrl,
      publicDomains: domainNames,
      target: `${PROXY_TARGET_SCHEME}://${PROXY_TARGET_HOST}:${PROXY_TARGET_PORT}`,
      trigger,
      startedAt,
      finishedAt: toIsoNow()
    };
    saveAndBroadcast(ok);
    sendSystemMessage(`Proxy manager ${action} route for ${domainNames.join(", ")}`);
    return ok;
  } catch (error) {
    const failed = {
      ok: false,
      status: "error",
      message: error.message,
      trigger,
      startedAt,
      finishedAt: toIsoNow()
    };
    saveAndBroadcast(failed);
    sendSystemMessage(`Proxy auto setup gagal: ${error.message}`);
    return failed;
  }
}

function truncateText(value, maxLength = 1000) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...<truncated>`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timeoutMs = Number(options.timeoutMs || DOCKER_COMMAND_TIMEOUT_MS);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId = null;

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env
    });

    const done = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      done(new Error(`Run command gagal: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      const result = {
        code: Number(code),
        signal: signal || "",
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        elapsedMs
      };
      if (code !== 0) {
        const argText = Array.isArray(args) ? args.join(" ") : "";
        const stderrText = truncateText(result.stderr || "(empty)");
        const stdoutText = truncateText(result.stdout || "(empty)");
        done(
          new Error(
            `Command "${command} ${argText}" exit ${code}. stderr: ${stderrText}; stdout: ${stdoutText}`
          )
        );
        return;
      }
      done(null, result);
    });

    timeoutId = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_error) {
        // no-op
      }
      done(new Error(`Command timeout setelah ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}

async function runDockerCommand(args, options = {}) {
  return runProcess(DOCKER_BIN, args, options);
}

function parseDockerPsOutput(stdout) {
  const rows = [];
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length < 4) {
      continue;
    }
    const [id, image, names, ...statusParts] = parts;
    rows.push({
      id: String(id || "").trim(),
      image: String(image || "").trim(),
      names: String(names || "").trim(),
      status: String(statusParts.join("|") || "").trim()
    });
  }
  return rows;
}

function isProxyLikeOpenClawContainer(row) {
  const text = `${String(row?.names || "")} ${String(row?.image || "")}`.toLowerCase();
  return (
    text.includes("loopback-proxy") ||
    text.includes("gateway-proxy") ||
    text.includes("-proxy-")
  );
}

function scoreOpenClawContainer(row) {
  const name = String(row?.names || "").toLowerCase();
  const image = String(row?.image || "").toLowerCase();
  const status = String(row?.status || "").toLowerCase();
  let score = 0;

  if (/openclaw.*-openclaw-\d+$/.test(name)) {
    score += 80;
  }
  if (name.endsWith("-openclaw-1")) {
    score += 40;
  }
  if (name === "openclaw") {
    score += 35;
  }
  if (name.includes("-openclaw-")) {
    score += 20;
  }
  if (image.includes("hvps-openclaw")) {
    score += 25;
  }
  if (status.includes("up")) {
    score += 10;
  }
  if (isProxyLikeOpenClawContainer(row)) {
    score -= 200;
  }

  return score;
}

function selectOpenClawContainer(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Tidak ada container berjalan di Docker daemon.");
  }

  if (OPENCLAW_DOCKER_CONTAINER_NAME) {
    const exact = rows.find((row) => row.names === OPENCLAW_DOCKER_CONTAINER_NAME);
    if (exact) {
      return exact;
    }
    throw new Error(
      `Container OPENCLAW_DOCKER_CONTAINER_NAME=${OPENCLAW_DOCKER_CONTAINER_NAME} tidak ditemukan.`
    );
  }

  const matchText = OPENCLAW_DOCKER_CONTAINER_MATCH;
  const matched = rows.filter((row) => {
    const nameLower = row.names.toLowerCase();
    const imageLower = row.image.toLowerCase();
    return nameLower.includes(matchText) || imageLower.includes(matchText);
  });

  if (matched.length === 0) {
    throw new Error(
      `Container OpenClaw tidak ketemu. Coba set OPENCLAW_DOCKER_CONTAINER_NAME atau OPENCLAW_DOCKER_CONTAINER_MATCH.`
    );
  }

  const primary = matched.filter((row) => !isProxyLikeOpenClawContainer(row));
  const pool = primary.length > 0 ? primary : matched;
  pool.sort((a, b) => {
    const scoreDiff = scoreOpenClawContainer(b) - scoreOpenClawContainer(a);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return a.names.localeCompare(b.names);
  });
  return pool[0];
}

function buildOpenClawDockerWsUrl(containerName) {
  if (OPENCLAW_DOCKER_WS_URL) {
    return sanitizeOpenClawUrl(OPENCLAW_DOCKER_WS_URL);
  }
  return `ws://${containerName}:${OPENCLAW_DOCKER_GATEWAY_PORT}`;
}

async function inspectContainerNetworks(containerName) {
  const result = await runDockerCommand(["inspect", containerName], {
    timeoutMs: DOCKER_COMMAND_TIMEOUT_MS
  });
  const parsed = safeParse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Gagal baca network untuk container ${containerName}.`);
  }
  const networks = parsed[0]?.NetworkSettings?.Networks;
  if (!networks || typeof networks !== "object") {
    throw new Error(`Container ${containerName} tidak punya NetworkSettings.Networks.`);
  }
  return Object.keys(networks);
}

function pickContainerNetwork(networkNames) {
  const names = Array.isArray(networkNames) ? networkNames : [];
  if (names.length === 0) {
    return "";
  }
  if (OPENCLAW_DOCKER_NETWORK) {
    if (names.includes(OPENCLAW_DOCKER_NETWORK)) {
      return OPENCLAW_DOCKER_NETWORK;
    }
    throw new Error(
      `OPENCLAW_DOCKER_NETWORK=${OPENCLAW_DOCKER_NETWORK} tidak ada di network container target.`
    );
  }
  const preferred = names.find((name) => {
    const normalized = name.toLowerCase();
    return normalized !== "bridge" && normalized !== "host" && normalized !== "none";
  });
  return preferred || names[0];
}

function isLegacyOpenClawUrl(urlValue) {
  const value = String(urlValue || "").trim().toLowerCase();
  if (!value) {
    return true;
  }
  return (
    value.includes(":8787/ws/openclaw") ||
    value.includes("loopback-proxy") ||
    value === "ws://openclaw:8787/ws/openclaw"
  );
}

async function tryConnectHubToNetwork(networkName) {
  const targetNetwork = String(networkName || "").trim();
  if (!targetNetwork) {
    return {
      attempted: false,
      message: "network kosong"
    };
  }
  const selfId = String(process.env.HOSTNAME || "").trim() || "hub-trial";
  try {
    await runDockerCommand(["network", "connect", targetNetwork, selfId], {
      timeoutMs: DOCKER_COMMAND_TIMEOUT_MS
    });
    return {
      attempted: true,
      connected: true,
      container: selfId
    };
  } catch (error) {
    const msg = String(error.message || "");
    if (
      msg.toLowerCase().includes("already exists") ||
      msg.toLowerCase().includes("already connected")
    ) {
      return {
        attempted: true,
        connected: true,
        container: selfId,
        alreadyConnected: true
      };
    }
    return {
      attempted: true,
      connected: false,
      container: selfId,
      message: msg
    };
  }
}

async function discoverOpenClawDockerUrl(options = {}) {
  const trigger = String(options.trigger || "manual-discovery");
  const startedAt = toIsoNow();
  const force = options.force === true;
  const reconnect = options.reconnect !== false;

  if (!DOCKER_AUTOMATION_ENABLED) {
    const skipped = {
      ok: false,
      status: "skipped",
      trigger,
      startedAt,
      finishedAt: toIsoNow(),
      message: "Docker automation disabled. Set DOCKER_AUTOMATION_ENABLED=true."
    };
    saveDockerAction(skipped);
    return skipped;
  }

  try {
    const psResult = await runDockerCommand(
      [
        "ps",
        "--no-trunc",
        "--format",
        "{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}"
      ],
      { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }
    );
    const rows = parseDockerPsOutput(psResult.stdout);
    const targetContainer = selectOpenClawContainer(rows);
    const networksFound = await inspectContainerNetworks(targetContainer.names);
    const selectedNetwork = pickContainerNetwork(networksFound);
    const wsUrl = buildOpenClawDockerWsUrl(targetContainer.names);
    const networkConnect = await tryConnectHubToNetwork(selectedNetwork);

    const previousUrl = settings.openclaw.url;
    const shouldUpdate =
      force ||
      !previousUrl ||
      isLegacyOpenClawUrl(previousUrl) ||
      previousUrl.includes("loopback-proxy");
    if (shouldUpdate && wsUrl) {
      settings.openclaw.url = wsUrl;
      saveSettings();
    }
    if (reconnect && (settings.openclaw.url === wsUrl || shouldUpdate)) {
      reconnectToOpenClaw("docker url discovery");
    }

    const result = {
      ok: true,
      status: "detected",
      trigger,
      startedAt,
      finishedAt: toIsoNow(),
      container: targetContainer,
      networksFound,
      networkUsed: selectedNetwork,
      wsUrl,
      updated: shouldUpdate,
      networkConnect
    };
    saveDockerAction(result);
    if (shouldUpdate) {
      sendSystemMessage(`OpenClaw URL auto-detected: ${wsUrl}`);
    }
    return result;
  } catch (error) {
    const failed = {
      ok: false,
      status: "error",
      trigger,
      startedAt,
      finishedAt: toIsoNow(),
      message: error.message
    };
    saveDockerAction(failed);
    return failed;
  }
}

function saveDockerAction(result) {
  state.dockerLastAction = result;
  settings.docker.lastAction = result;
  saveSettings();
  broadcastConfig();
}

async function runOpenClawDockerPairing(options = {}) {
  const trigger = options.trigger || "manual";
  const startedAt = toIsoNow();

  if (!DOCKER_AUTOMATION_ENABLED) {
    const skipped = {
      ok: false,
      status: "skipped",
      trigger,
      startedAt,
      finishedAt: toIsoNow(),
      message: "Docker automation disabled. Set DOCKER_AUTOMATION_ENABLED=true."
    };
    saveDockerAction(skipped);
    return skipped;
  }

  const token = getCurrentOpenClawToken();
  if (!token) {
    const skipped = {
      ok: false,
      status: "skipped",
      trigger,
      startedAt,
      finishedAt: toIsoNow(),
      message: "OpenClaw token belum ada. Simpan token dulu dari UI."
    };
    saveDockerAction(skipped);
    return skipped;
  }

  try {
    const psResult = await runDockerCommand(
      [
        "ps",
        "--no-trunc",
        "--format",
        "{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}"
      ],
      { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }
    );
    const rows = parseDockerPsOutput(psResult.stdout);
    const targetContainer = selectOpenClawContainer(rows);
    const networksFound = await inspectContainerNetworks(targetContainer.names);
    const selectedNetwork = pickContainerNetwork(networksFound);
    if (!selectedNetwork) {
      throw new Error(`Container ${targetContainer.names} tidak punya network yang usable.`);
    }
    const networkConnect = await tryConnectHubToNetwork(selectedNetwork);
    const wsUrl = buildOpenClawDockerWsUrl(targetContainer.names);

    const probeContainerName = `hub-openclaw-probe-${Date.now()}`;
    const probeArgs = [
      "run",
      "--rm",
      "--name",
      probeContainerName,
      "--network",
      selectedNetwork
    ];

    if (OPENCLAW_DOCKER_ALLOW_INSECURE_PRIVATE_WS) {
      probeArgs.push("-e", "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1");
    }
    if (OPENCLAW_DOCKER_STATE_VOLUME) {
      probeArgs.push("-v", `${OPENCLAW_DOCKER_STATE_VOLUME}:/data/.openclaw`);
    }

    probeArgs.push(
      "--entrypoint",
      "openclaw",
      OPENCLAW_DOCKER_PROBE_IMAGE,
      "gateway",
      "probe",
      "--url",
      wsUrl,
      "--token",
      token,
      "--timeout",
      String(OPENCLAW_DOCKER_PROBE_TIMEOUT_MS),
      "--json"
    );

    const probeResult = await runDockerCommand(probeArgs, {
      timeoutMs: Math.max(OPENCLAW_DOCKER_PROBE_TIMEOUT_MS + 4000, DOCKER_COMMAND_TIMEOUT_MS)
    });

    let approveResult = null;
    if (OPENCLAW_DOCKER_AUTO_APPROVE) {
      approveResult = await runDockerCommand(
        [
          "exec",
          targetContainer.names,
          "openclaw",
          "devices",
          "approve",
          "--latest",
          "--json"
        ],
        { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }
      );
    }

    settings.openclaw.url = wsUrl;
    saveSettings();
    reconnectToOpenClaw("docker auto pairing");

    const ok = {
      ok: true,
      status: "success",
      trigger,
      startedAt,
      finishedAt: toIsoNow(),
      container: targetContainer,
      networksFound,
      networkUsed: selectedNetwork,
      networkConnect,
      wsUrl,
      probe: {
        stdout: truncateText(probeResult.stdout, 1600),
        stderr: truncateText(probeResult.stderr, 800)
      },
      approve: approveResult
        ? {
            stdout: truncateText(approveResult.stdout, 1600),
            stderr: truncateText(approveResult.stderr, 800)
          }
        : null
    };
    saveDockerAction(ok);
    sendSystemMessage(`Docker pairing sukses. OpenClaw: ${targetContainer.names}`);
    return ok;
  } catch (error) {
    const failed = {
      ok: false,
      status: "error",
      trigger,
      startedAt,
      finishedAt: toIsoNow(),
      message: error.message
    };
    saveDockerAction(failed);
    sendSystemMessage(`Docker pairing gagal: ${error.message}`);
    return failed;
  }
}

function forwardChatToOpenClaw(localMessage, clientId) {
  const text = String(localMessage.text || "").trim();
  if (!text) {
    return { ok: false, reason: "Pesan kosong." };
  }

  const payload = {
    agentId: String(localMessage.agentId || ""),
    text,
    clientId,
    timestamp: toIsoNow()
  };

  if (!state.openclawConnected || !state.openclawSocket) {
    return { ok: false, reason: "OpenClaw belum terkoneksi." };
  }

  const sent = sendJson(state.openclawSocket, {
    type: "chat",
    payload
  });
  if (!sent) {
    return { ok: false, reason: "Gagal kirim chat ke OpenClaw." };
  }

  broadcast({
    type: "chat",
    payload: {
      agentId: payload.agentId || "local",
      agentName: payload.agentId || "You",
      text: payload.text,
      source: "local",
      timestamp: payload.timestamp
    }
  });

  return { ok: true };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hubId: HUB_ID,
    openclawConnected: state.openclawConnected,
    openclawTargetUrl: state.openclawTargetUrl,
    openclawCandidates: getConnectionCandidates(),
    localClients: state.localClients.size,
    agents: serializeAgents().length,
    config: getPublicConfig(req.headers),
    timestamp: toIsoNow()
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    config: getPublicConfig(req.headers)
  });
});

app.post("/api/discovery/openclaw", async (req, res) => {
  const autoApply = req.body?.autoApply !== false;
  const result = await runOpenClawDiscovery({
    autoApply,
    trigger: "api"
  });
  res.json({
    ok: true,
    result,
    config: getPublicConfig(req.headers)
  });
});

app.post("/api/config/openclaw", async (req, res) => {
  const body = req.body || {};
  const previousUrl = settings.openclaw.url;
  const previousToken = settings.openclaw.token;
  const requestedAutoPair = body.autoPair === true;
  let tokenProvided = false;

  if (Object.prototype.hasOwnProperty.call(body, "url")) {
    settings.openclaw.url = sanitizeOpenClawUrl(body.url);
  }
  if (Object.prototype.hasOwnProperty.call(body, "autoDiscover")) {
    settings.openclaw.autoDiscover = Boolean(body.autoDiscover);
  }
  if (Object.prototype.hasOwnProperty.call(body, "clearToken") && body.clearToken === true) {
    settings.openclaw.token = "";
  }
  if (Object.prototype.hasOwnProperty.call(body, "token")) {
    const incomingToken = String(body.token || "").trim();
    if (incomingToken) {
      settings.openclaw.token = incomingToken;
      tokenProvided = true;
    }
  }

  saveSettings();
  broadcastConfig();

  let dockerDiscoveryResult = null;
  const shouldTryDockerUrlDiscovery =
    DOCKER_AUTOMATION_ENABLED &&
    (requestedAutoPair ||
      tokenProvided ||
      !settings.openclaw.url ||
      isLegacyOpenClawUrl(settings.openclaw.url));
  if (shouldTryDockerUrlDiscovery) {
    dockerDiscoveryResult = await discoverOpenClawDockerUrl({
      trigger: "config-save",
      force: !settings.openclaw.url || isLegacyOpenClawUrl(settings.openclaw.url),
      reconnect: false
    });
  }

  let dockerPairResult = null;
  const hasTokenAfterSave = Boolean(getCurrentOpenClawToken());
  const shouldTryDockerPair =
    DOCKER_AUTOMATION_ENABLED &&
    hasTokenAfterSave &&
    (requestedAutoPair || tokenProvided || !settings.openclaw.url);
  if (shouldTryDockerPair) {
    dockerPairResult = await runOpenClawDockerPairing({
      trigger: "config-save"
    });
  }

  if (!settings.openclaw.url && settings.openclaw.autoDiscover !== false) {
    await runOpenClawDiscovery({
      autoApply: true,
      trigger: "config-openclaw-empty-url"
    });
  }

  const urlChanged = previousUrl !== settings.openclaw.url;
  const tokenChanged = previousToken !== settings.openclaw.token;
  if ((urlChanged || tokenChanged) && !(dockerPairResult && dockerPairResult.ok)) {
    reconnectToOpenClaw("openclaw config updated");
  }

  res.json({
    ok: true,
    config: getPublicConfig(req.headers),
    dockerDiscovery: dockerDiscoveryResult,
    dockerPair: dockerPairResult
  });
});

app.post("/api/proxy/auto-setup", async (req, res) => {
  const result = await autoSetupProxy({
    trigger: "api"
  });
  const statusCode = result.ok ? 200 : result.status === "skipped" ? 200 : 500;
  res.status(statusCode).json({
    ok: result.ok,
    result,
    config: getPublicConfig(req.headers)
  });
});

app.get("/api/proxy/discovery", (req, res) => {
  res.json({
    ok: true,
    proxy: getProxyContext(req.headers),
    config: getPublicConfig(req.headers)
  });
});

app.post("/api/docker/auto-pair", async (req, res) => {
  const result = await runOpenClawDockerPairing({
    trigger: "api"
  });
  const statusCode = result.ok ? 200 : result.status === "skipped" ? 200 : 500;
  res.status(statusCode).json({
    ok: result.ok,
    result,
    config: getPublicConfig(req.headers)
  });
});

app.post("/api/docker/discover-url", async (req, res) => {
  const force = req.body?.force === true;
  const reconnect = req.body?.reconnect !== false;
  const result = await discoverOpenClawDockerUrl({
    trigger: "api-discover-url",
    force,
    reconnect
  });
  const statusCode = result.ok ? 200 : result.status === "skipped" ? 200 : 500;
  res.status(statusCode).json({
    ok: result.ok,
    result,
    config: getPublicConfig(req.headers)
  });
});

const server = http.createServer(app);
const localWss = new WebSocket.Server({ server, path: "/ws/local" });

localWss.on("connection", (socket, request) => {
  const clientId = `local-${crypto.randomBytes(3).toString("hex")}`;
  state.localClients.add(socket);
  log("Local client connected:", clientId);

  sendJson(socket, {
    type: "system",
    payload: {
      message: "Connected to Hub",
      clientId,
      openclawConnected: state.openclawConnected,
      openclawTargetUrl: state.openclawTargetUrl,
      timestamp: toIsoNow()
    }
  });
  sendConfig(socket, request.headers || {});
  sendJson(socket, {
    type: "agent_list",
    payload: {
      agents: serializeAgents()
    }
  });

  socket.on("message", (raw) => {
    const message = safeParse(raw);
    if (!message) {
      sendJson(socket, {
        type: "error",
        payload: {
          message: "Invalid JSON message."
        }
      });
      return;
    }

    if (message.type === "request_agents") {
      sendJson(socket, {
        type: "agent_list",
        payload: {
          agents: serializeAgents()
        }
      });
      return;
    }

    if (message.type === "request_config") {
      sendConfig(socket, request.headers || {});
      return;
    }

    if (message.type === "ping") {
      sendJson(socket, {
        type: "pong",
        payload: {
          timestamp: toIsoNow()
        }
      });
      return;
    }

    if (message.type === "chat") {
      const result = forwardChatToOpenClaw(message, clientId);
      if (!result.ok) {
        sendJson(socket, {
          type: "error",
          payload: {
            message: result.reason
          }
        });
      }
      return;
    }

    sendJson(socket, {
      type: "error",
      payload: {
        message: `Unsupported message type: ${String(message.type)}`
      }
    });
  });

  socket.on("close", () => {
    state.localClients.delete(socket);
    log("Local client disconnected:", clientId);
  });

  socket.on("error", (error) => {
    log("Local socket error:", `${clientId} ${error.message}`);
  });
});

async function startupFlow() {
  if (DOCKER_AUTOMATION_ENABLED) {
    log("Running startup Docker URL discovery...");
    await discoverOpenClawDockerUrl({
      trigger: "startup",
      force: isLegacyOpenClawUrl(settings.openclaw.url),
      reconnect: false
    });
  }

  if (DOCKER_AUTOMATION_ENABLED && DOCKER_AUTOMATION_AUTO_PAIR_ON_STARTUP) {
    log("Running startup Docker auto-pair...");
    await runOpenClawDockerPairing({
      trigger: "startup"
    });
  }

  if (settings.openclaw.autoDiscover !== false && !settings.openclaw.url) {
    log("Running startup discovery for OpenClaw...");
    await runOpenClawDiscovery({
      autoApply: true,
      trigger: "startup"
    });
  }

  connectToOpenClaw();

  if (PROXY_AUTO_REGISTER) {
    log("Running proxy auto-setup...");
    await autoSetupProxy({ trigger: "startup" });
  }
}

server.listen(PORT, "0.0.0.0", () => {
  log(`Hub listening on http://0.0.0.0:${PORT}`);
  startupFlow().catch((error) => {
    log("Startup flow error:", error.message);
    connectToOpenClaw();
  });
});

function shutdown() {
  clearTimeout(state.reconnectTimer);
  if (state.openclawSocket) {
    try {
      state.openclawSocket.close();
    } catch (_error) {
      // no-op
    }
  }
  for (const client of state.localClients) {
    try {
      client.close();
    } catch (_error) {
      // no-op
    }
  }
  server.close(() => {
    log("Hub stopped");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
