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
const OPENCLAW_WS_HEARTBEAT_MS = Math.max(
  0,
  Number(process.env.OPENCLAW_WS_HEARTBEAT_MS || 0)
);
const OPENCLAW_TRANSPORT = String(process.env.OPENCLAW_TRANSPORT || "http-api")
  .trim()
  .toLowerCase();
const OPENCLAW_HTTP_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.OPENCLAW_HTTP_TIMEOUT_MS || 10000)
);
const OPENCLAW_HTTP_CHAT_TIMEOUT_MS = Math.max(
  OPENCLAW_HTTP_TIMEOUT_MS,
  Number(process.env.OPENCLAW_HTTP_CHAT_TIMEOUT_MS || 60000)
);
const OPENCLAW_HTTP_POLL_MS = Math.max(
  0,
  Number(process.env.OPENCLAW_HTTP_POLL_MS || 12000)
);
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
const ENV_OPENCLAW_PORT = Number(process.env.OPENCLAW_PORT || 18789);
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
const DOCKER_COMMAND_TIMEOUT_MS = Number(process.env.DOCKER_COMMAND_TIMEOUT_MS || 20000);
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
  process.env.OPENCLAW_DOCKER_GATEWAY_PORT || 18789
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
  openclawConnectedAt: 0,
  openclawAttempt: 0,
  openclawManualCloseSocket: null,
  openclawHeartbeat: null,
  openclawHttpPollTimer: null,
  openclawHttpConnectInFlight: false,
  openclawHttpPollInFlight: false,
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

function mergeUniqueUrls(existing, additions) {
  const merged = Array.isArray(existing) ? existing.slice() : [];
  for (const item of Array.isArray(additions) ? additions : []) {
    const value = String(item || "").trim();
    if (!value || merged.includes(value)) {
      continue;
    }
    merged.push(value);
  }
  return merged;
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
      transport: OPENCLAW_TRANSPORT,
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

function clearOpenClawHttpPoll() {
  if (!state.openclawHttpPollTimer) {
    return;
  }
  clearInterval(state.openclawHttpPollTimer);
  state.openclawHttpPollTimer = null;
}

function wsUrlToHttpBaseUrl(wsUrl) {
  const parsed = new URL(sanitizeOpenClawUrl(wsUrl));
  const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${parsed.host}`;
}

function parseJsonEventStreamFrames(rawBody) {
  const rawText = String(rawBody || "");
  if (!rawText) {
    return [];
  }
  const events = [];
  const lines = rawText.split(/\r?\n/);
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") {
      return;
    }
    const parsed = safeParse(data);
    if (parsed && typeof parsed === "object") {
      events.push(parsed);
    }
  };

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith(":")) {
      continue;
    }
    if (dataLines.length > 0) {
      dataLines.push(line.trim());
    }
  }
  flush();
  return events;
}

async function openClawFetchJson(targetWsUrl, apiPath, options = {}) {
  const token = getCurrentOpenClawToken();
  if (!token) {
    throw new Error("OpenClaw token belum ada.");
  }

  const baseUrl = wsUrlToHttpBaseUrl(targetWsUrl);
  const pathValue = String(apiPath || "").trim();
  const normalizedPath = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const url = `${baseUrl}${normalizedPath}`;
  const method = String(options.method || "GET").toUpperCase();
  const timeoutMs = Number(options.timeoutMs || OPENCLAW_HTTP_TIMEOUT_MS);
  const allowNonJson = options.allowNonJson === true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const extraHeaders = options.headers && typeof options.headers === "object" ? options.headers : {};
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: allowNonJson ? "application/json, text/event-stream" : "application/json",
        "content-type": "application/json",
        ...extraHeaders
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_error) {
      parsed = null;
    }
    if (!parsed && raw && allowNonJson) {
      const events = parseJsonEventStreamFrames(raw);
      if (events.length > 0) {
        parsed = {
          __sseEvents: events
        };
      } else {
        parsed = {
          __rawText: raw
        };
      }
    }
    if (!parsed && raw && !allowNonJson && response.ok) {
      throw new Error(
        `OpenClaw API ${normalizedPath} response bukan JSON: ${truncateText(raw, 300)}`
      );
    }
    if (!response.ok) {
      const detail =
        parsed?.error?.message ||
        parsed?.message ||
        parsed?.detail ||
        (raw ? truncateText(raw, 300) : "") ||
        `${response.status} ${response.statusText}`;
      const error = new Error(`OpenClaw API ${normalizedPath} gagal: ${detail}`);
      error.statusCode = response.status;
      throw error;
    }
    return parsed || {};
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`OpenClaw API ${normalizedPath} timeout setelah ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractModelsFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  if (Array.isArray(payload.models)) {
    return payload.models;
  }
  if (Array.isArray(payload.result?.models)) {
    return payload.result.models;
  }
  return [];
}

function publishAgentList() {
  broadcast({
    type: "agent_list",
    payload: {
      agents: serializeAgents()
    }
  });
}

async function refreshOpenClawAgentsViaHttp(targetUrl) {
  const payload = await openClawFetchJson(targetUrl, "/v1/models", {
    method: "GET",
    timeoutMs: OPENCLAW_HTTP_TIMEOUT_MS
  });
  const models = extractModelsFromPayload(payload);
  if (models.length === 0) {
    return [];
  }

  state.agents.clear();
  for (const model of models) {
    const id = String(model?.id || model?.name || "").trim();
    if (!id) {
      continue;
    }
    upsertAgent({
      id,
      name: String(model?.name || id),
      status: "online",
      description: String(model?.description || "")
    });
  }
  publishAgentList();
  return models;
}

function startOpenClawHttpPoll(targetUrl) {
  clearOpenClawHttpPoll();
  if (OPENCLAW_HTTP_POLL_MS <= 0) {
    return;
  }
  state.openclawHttpPollTimer = setInterval(async () => {
    if (state.openclawHttpPollInFlight) {
      return;
    }
    if (!state.openclawConnected || state.openclawTargetUrl !== targetUrl) {
      return;
    }
    state.openclawHttpPollInFlight = true;
    try {
      await refreshOpenClawAgentsViaHttp(targetUrl);
    } catch (error) {
      const message = String(error?.message || "unknown OpenClaw HTTP error");
      state.openclawConnected = false;
      state.openclawConnectedAt = 0;
      state.openclawLastError = message;
      clearOpenClawHttpPoll();
      broadcastConfig();
      log("OpenClaw HTTP poll failed:", `${targetUrl} ${message}`);
      sendSystemMessage(`OpenClaw disconnected: ${message}`);
      scheduleReconnect();
    } finally {
      state.openclawHttpPollInFlight = false;
    }
  }, OPENCLAW_HTTP_POLL_MS);
}

async function connectToOpenClawViaHttp(targetUrl) {
  if (state.openclawHttpConnectInFlight) {
    return;
  }
  state.openclawHttpConnectInFlight = true;
  const previouslyConnected = state.openclawConnected && state.openclawTargetUrl === targetUrl;
  try {
    await refreshOpenClawAgentsViaHttp(targetUrl);
    state.openclawConnected = true;
    state.openclawConnectedAt = Date.now();
    state.openclawLastError = "";
    state.openclawAttempt = 0;
    if (!previouslyConnected) {
      log("Connected to OpenClaw over HTTP API:", targetUrl);
      sendSystemMessage(`Hub connected to OpenClaw (${targetUrl})`);
    }
    broadcastConfig();
    startOpenClawHttpPoll(targetUrl);
  } catch (error) {
    const message = String(error?.message || "unknown OpenClaw HTTP error");
    const wasConnected = state.openclawConnected;
    state.openclawConnected = false;
    state.openclawConnectedAt = 0;
    state.openclawLastError = message;
    clearOpenClawHttpPoll();
    broadcastConfig();
    log("OpenClaw HTTP connect failed:", `${targetUrl} ${message}`);
    if (wasConnected) {
      sendSystemMessage(`OpenClaw disconnected: ${message}`);
    }
    scheduleReconnect();
  } finally {
    state.openclawHttpConnectInFlight = false;
  }
}

function extractTextFromContentPart(part) {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (part.text && typeof part.text === "object" && typeof part.text.value === "string") {
    return part.text.value;
  }
  if (typeof part.output_text === "string") {
    return part.output_text;
  }
  if (typeof part.delta === "string") {
    return part.delta;
  }
  if (typeof part.value === "string") {
    return part.value;
  }
  return "";
}

function extractTextFromContentValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const textValue = value.map((part) => extractTextFromContentPart(part)).join("").trim();
    if (textValue) {
      return textValue;
    }
  }
  if (value && typeof value === "object") {
    const textValue = extractTextFromContentPart(value).trim();
    if (textValue) {
      return textValue;
    }
  }
  return "";
}

function extractTextFromOutputItems(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const textValue = extractTextFromContentValue(item?.content);
    if (textValue) {
      return textValue;
    }
  }
  return "";
}

function isLikelyHtmlDocument(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }
  const start = text.slice(0, 400).toLowerCase();
  return (
    start.startsWith("<!doctype html") ||
    start.startsWith("<html") ||
    (start.includes("<html") && start.includes("<body"))
  );
}

function isOpenClawStartupPayload(payload) {
  const raw = String(payload?.__rawText || "").toLowerCase();
  if (!raw) {
    return false;
  }
  return (
    raw.includes("<title>openclaw</title>") &&
    (raw.includes("starting openclaw") || raw.includes("please wait while we set up your environment"))
  );
}

function extractChatTextFromObject(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  if (typeof payload?.response?.output_text === "string" && payload.response.output_text.trim()) {
    return payload.response.output_text.trim();
  }
  const choiceMessageText = extractTextFromContentValue(payload?.choices?.[0]?.message?.content);
  if (choiceMessageText) {
    return choiceMessageText;
  }
  const choiceDeltaText = extractTextFromContentValue(payload?.choices?.[0]?.delta?.content);
  if (choiceDeltaText) {
    return choiceDeltaText;
  }
  if (typeof payload?.delta === "string" && payload.delta.trim()) {
    return payload.delta.trim();
  }
  const outputText = extractTextFromOutputItems(payload.output);
  if (outputText) {
    return outputText;
  }
  const responseOutputText = extractTextFromOutputItems(payload?.response?.output);
  if (responseOutputText) {
    return responseOutputText;
  }
  const messageText = extractTextFromContentValue(payload?.message?.content);
  if (messageText) {
    return messageText;
  }
  return "";
}

function extractChatTextFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const directText = extractChatTextFromObject(payload);
  if (directText) {
    return directText;
  }

  const events = Array.isArray(payload.__sseEvents) ? payload.__sseEvents : [];
  if (events.length > 0) {
    let deltaText = "";
    let fullText = "";
    for (const event of events) {
      const eventType = String(event?.type || "").toLowerCase();
      if (eventType.includes("delta")) {
        const deltaPart = extractTextFromContentValue(
          event?.delta || event?.choices?.[0]?.delta?.content
        );
        if (deltaPart) {
          deltaText += deltaPart;
        }
      }
      const eventText = extractChatTextFromObject(event);
      if (eventText) {
        fullText = eventText;
      }
    }
    const mergedText = (deltaText || fullText).trim();
    if (mergedText) {
      return mergedText;
    }
  }

  if (typeof payload.__rawText === "string" && payload.__rawText.trim()) {
    const rawText = payload.__rawText.trim();
    if (isLikelyHtmlDocument(rawText)) {
      return "";
    }
    return rawText;
  }
  return "";
}

function describeOpenClawPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const details = [];
  if (typeof payload.id === "string" && payload.id) {
    details.push(`id=${payload.id}`);
  }
  if (typeof payload.status === "string" && payload.status) {
    details.push(`status=${payload.status}`);
  }
  if (typeof payload.type === "string" && payload.type) {
    details.push(`type=${payload.type}`);
  }
  if (Array.isArray(payload.choices)) {
    details.push(`choices=${payload.choices.length}`);
  }
  if (Array.isArray(payload.output)) {
    details.push(`output=${payload.output.length}`);
  }
  if (Array.isArray(payload.__sseEvents)) {
    details.push(`sseEvents=${payload.__sseEvents.length}`);
  }
  if (typeof payload.__rawText === "string" && payload.__rawText.trim()) {
    const compact = payload.__rawText.replace(/\s+/g, " ").trim();
    details.push(`raw=${truncateText(compact, 160)}`);
  }
  if (details.length === 0) {
    const keys = Object.keys(payload).slice(0, 8);
    if (keys.length > 0) {
      details.push(`keys=${keys.join(",")}`);
    }
  }
  return details.join(", ");
}

async function resolveOpenClawModel(targetUrl, preferredId) {
  const preferred = String(preferredId || "").trim();
  if (preferred) {
    return preferred;
  }
  const current = String(serializeAgents()[0]?.id || "").trim();
  if (current) {
    return current;
  }
  try {
    await refreshOpenClawAgentsViaHttp(targetUrl);
  } catch (_error) {
    // Ignore refresh failure here; caller will return user-facing error.
  }
  return String(serializeAgents()[0]?.id || "").trim();
}

async function sendChatViaHttp(targetUrl, payload) {
  const requestedAgentId = String(payload.agentId || "").trim();
  const model = await resolveOpenClawModel(targetUrl, requestedAgentId);
  const userText = String(payload.text || "").trim();
  if (!userText) {
    throw new Error("Pesan kosong.");
  }
  if (!model) {
    throw new Error("Agent OpenClaw belum ketemu. Coba refresh daftar agent dulu.");
  }
  const requestHeaders = {};
  const targetAgentId = requestedAgentId || model;
  if (targetAgentId) {
    requestHeaders["x-openclaw-agent-id"] = targetAgentId;
  }
  let completionError = null;
  try {
    const completion = await openClawFetchJson(targetUrl, "/v1/chat/completions", {
      method: "POST",
      headers: requestHeaders,
      body: {
        model,
        messages: [
          {
            role: "user",
            content: userText
          }
        ],
        stream: false
      },
      timeoutMs: OPENCLAW_HTTP_CHAT_TIMEOUT_MS,
      allowNonJson: true
    });
    const text = extractChatTextFromPayload(completion);
    if (!text) {
      if (isOpenClawStartupPayload(completion)) {
        throw new Error("OpenClaw masih starting. Coba lagi dalam 10-30 detik.");
      }
      const info = describeOpenClawPayload(completion);
      throw new Error(
        info ? `OpenClaw response kosong (${info}).` : "OpenClaw response kosong."
      );
    }
    return {
      model,
      text
    };
  } catch (error) {
    completionError = error;
  }

  try {
    const fallback = await openClawFetchJson(targetUrl, "/v1/responses", {
      method: "POST",
      headers: requestHeaders,
      body: {
        model,
        input: userText
      },
      timeoutMs: OPENCLAW_HTTP_CHAT_TIMEOUT_MS,
      allowNonJson: true
    });
    const text = extractChatTextFromPayload(fallback);
    if (!text) {
      if (isOpenClawStartupPayload(fallback)) {
        throw new Error("OpenClaw masih starting. Coba lagi dalam 10-30 detik.");
      }
      const info = describeOpenClawPayload(fallback);
      throw new Error(
        info ? `OpenClaw response kosong (${info}).` : "OpenClaw response kosong."
      );
    }
    return {
      model,
      text
    };
  } catch (fallbackError) {
    const firstMessage = completionError
      ? `chat.completions: ${String(completionError?.message || "failed")}`
      : "";
    const secondMessage = `responses: ${String(fallbackError?.message || "failed")}`;
    throw new Error([firstMessage, secondMessage].filter(Boolean).join(" | "));
  }
}

function clearOpenClawHeartbeat() {
  if (!state.openclawHeartbeat) {
    return;
  }
  clearInterval(state.openclawHeartbeat);
  state.openclawHeartbeat = null;
}

function startOpenClawHeartbeat(socket, targetUrl) {
  clearOpenClawHeartbeat();
  if (!socket || OPENCLAW_WS_HEARTBEAT_MS <= 0) {
    return;
  }

  state.openclawHeartbeat = setInterval(() => {
    if (!state.openclawSocket || state.openclawSocket !== socket) {
      clearOpenClawHeartbeat();
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.ping();
    } catch (error) {
      state.openclawLastError = String(error?.message || "OpenClaw heartbeat error");
      log("OpenClaw heartbeat failed:", `${targetUrl} ${state.openclawLastError}`);
    }
  }, OPENCLAW_WS_HEARTBEAT_MS);
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
  const agentCollection = Array.isArray(payload.agents)
    ? payload.agents
    : Array.isArray(message.agents)
      ? message.agents
      : Array.isArray(payload)
        ? payload
        : null;

  if (
    ["agent_list", "agents", "agent.snapshot", "agents_snapshot"].includes(String(type)) &&
    Array.isArray(agentCollection)
  ) {
    state.agents.clear();
    for (const agent of agentCollection) {
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

  if (["agent_update", "agent", "presence"].includes(String(type))) {
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

  if (OPENCLAW_TRANSPORT !== "legacy-ws") {
    void connectToOpenClawViaHttp(targetUrl);
    return;
  }

  const headers = {};
  const token = getCurrentOpenClawToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  log("Connecting to OpenClaw:", targetUrl);
  const ws = new WebSocket(targetUrl, { headers });
  state.openclawSocket = ws;

  ws.on("open", () => {
    if (state.openclawSocket !== ws) {
      try {
        ws.close(1000, "stale-socket");
      } catch (_error) {
        // no-op
      }
      return;
    }
    state.openclawConnected = true;
    state.openclawLastError = "";
    state.openclawConnectedAt = Date.now();
    state.openclawAttempt = 0;
    startOpenClawHeartbeat(ws, targetUrl);
    log("Connected to OpenClaw:", targetUrl);
    sendSystemMessage(`Hub connected to OpenClaw (${targetUrl})`);
    broadcastConfig();
    sendJson(ws, {
      type: "request_agents"
    });
  });

  ws.on("message", (raw) => {
    if (state.openclawSocket !== ws) {
      return;
    }
    handleOpenClawMessage(raw);
  });

  ws.on("close", (code, reason) => {
    const reasonText = reason ? reason.toString() : "";
    const isCurrentSocket = state.openclawSocket === ws;
    const isManualReconfigureClose = state.openclawManualCloseSocket === ws;

    if (isManualReconfigureClose) {
      state.openclawManualCloseSocket = null;
      if (isCurrentSocket) {
        state.openclawConnected = false;
        state.openclawConnectedAt = 0;
        state.openclawSocket = null;
        clearOpenClawHeartbeat();
      }
      log("OpenClaw socket closed for reconfigure.");
      connectToOpenClaw();
      return;
    }

    if (!isCurrentSocket) {
      log("Ignoring stale OpenClaw close:", `${code} ${reasonText} (${targetUrl})`);
      return;
    }

    state.openclawConnected = false;
    const uptimeMs = state.openclawConnectedAt > 0 ? Date.now() - state.openclawConnectedAt : 0;
    state.openclawConnectedAt = 0;
    state.openclawSocket = null;
    clearOpenClawHeartbeat();
    const errorDetail = state.openclawLastError || reasonText;

    sendSystemMessage(
      errorDetail
        ? `OpenClaw disconnected (code ${code}): ${errorDetail}`
        : `OpenClaw disconnected (code ${code})`
    );
    broadcastConfig();
    log(
      "OpenClaw closed:",
      `${code} ${reasonText || state.openclawLastError} (${targetUrl}) uptime=${uptimeMs}ms`
    );
    scheduleReconnect();
  });

  ws.on("error", (error) => {
    if (state.openclawSocket !== ws) {
      return;
    }
    state.openclawLastError = String(error?.message || "unknown OpenClaw error");
    log("OpenClaw error:", error.message);
  });
}

function reconnectToOpenClaw(reason) {
  log("Reconnecting OpenClaw:", reason);
  clearTimeout(state.reconnectTimer);
  clearOpenClawHeartbeat();
  clearOpenClawHttpPoll();

  if (OPENCLAW_TRANSPORT !== "legacy-ws") {
    state.openclawConnected = false;
    state.openclawConnectedAt = 0;
    state.openclawSocket = null;
    connectToOpenClaw();
    return;
  }

  if (state.openclawSocket) {
    const closingSocket = state.openclawSocket;
    state.openclawManualCloseSocket = closingSocket;
    try {
      closingSocket.close(1000, "reconfigure");
    } catch (_error) {
      state.openclawManualCloseSocket = null;
      if (state.openclawSocket === closingSocket) {
        state.openclawConnected = false;
        state.openclawConnectedAt = 0;
        state.openclawSocket = null;
      }
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

async function probeOpenClawHttpUrl(url) {
  const start = Date.now();
  try {
    const payload = await openClawFetchJson(url, "/v1/models", {
      method: "GET",
      timeoutMs: Math.max(OPENCLAW_HTTP_TIMEOUT_MS, OPENCLAW_DISCOVERY_TIMEOUT_MS + 800)
    });
    const models = extractModelsFromPayload(payload);
    return {
      url,
      reachable: true,
      latencyMs: Date.now() - start,
      reason: models.length > 0 ? `reachable (models=${models.length})` : "reachable"
    };
  } catch (error) {
    return {
      url,
      reachable: false,
      latencyMs: Date.now() - start,
      reason: String(error?.message || "http probe failed")
    };
  }
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

  const probes =
    OPENCLAW_TRANSPORT === "legacy-ws"
      ? await Promise.all(candidates.map((url) => probeOpenClawUrl(url, token)))
      : await Promise.all(candidates.map((url) => probeOpenClawHttpUrl(url)));
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

function redactCommandArgs(args) {
  const sensitiveFlags = new Set([
    "--token",
    "--password",
    "--secret",
    "--api-key",
    "--auth-token",
    "--authorization"
  ]);
  const masked = [];
  let maskNext = false;
  for (const arg of Array.isArray(args) ? args : []) {
    const value = String(arg || "");
    if (maskNext) {
      masked.push("***");
      maskNext = false;
      continue;
    }
    const lower = value.toLowerCase();
    if (sensitiveFlags.has(lower)) {
      masked.push(value);
      maskNext = true;
      continue;
    }
    const separatorIndex = value.indexOf("=");
    if (separatorIndex > 0) {
      const key = value.slice(0, separatorIndex).toLowerCase();
      if (sensitiveFlags.has(key)) {
        masked.push(`${value.slice(0, separatorIndex)}=***`);
        continue;
      }
    }
    masked.push(value);
  }
  return masked;
}

function isNoPendingDeviceApproveError(error) {
  const text = String(error?.message || "").toLowerCase();
  return text.includes("no pending device pairing requests to approve");
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
        const argText = Array.isArray(args) ? redactCommandArgs(args).join(" ") : "";
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

function buildOpenClawDockerWsCandidates(containerName) {
  if (OPENCLAW_DOCKER_WS_URL) {
    return [sanitizeOpenClawUrl(OPENCLAW_DOCKER_WS_URL)];
  }
  const candidates = [];
  const addCandidate = (value) => {
    try {
      const sanitized = sanitizeOpenClawUrl(value);
      if (!candidates.includes(sanitized)) {
        candidates.push(sanitized);
      }
    } catch (_error) {
      // ignore invalid candidate
    }
  };

  addCandidate(`ws://${containerName}:${OPENCLAW_DOCKER_GATEWAY_PORT}`);
  addCandidate(`ws://${containerName}:${OPENCLAW_DOCKER_GATEWAY_PORT}/ws/openclaw`);

  return candidates;
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
    const wsCandidates = buildOpenClawDockerWsCandidates(targetContainer.names);
    const wsUrl = buildOpenClawDockerWsUrl(targetContainer.names);
    if (!wsCandidates.includes(wsUrl)) {
      wsCandidates.unshift(wsUrl);
    }
    const networkConnect = await tryConnectHubToNetwork(selectedNetwork);

    const previousUrl = settings.openclaw.url;
    const shouldUpdate =
      force ||
      !previousUrl ||
      isLegacyOpenClawUrl(previousUrl) ||
      previousUrl.includes("loopback-proxy");
    const mergedCandidates = mergeUniqueUrls(settings.openclaw.candidates, wsCandidates);
    const candidatesChanged =
      mergedCandidates.length !== (Array.isArray(settings.openclaw.candidates) ? settings.openclaw.candidates.length : 0);
    if (candidatesChanged) {
      settings.openclaw.candidates = mergedCandidates;
    }
    if (shouldUpdate && wsUrl) {
      settings.openclaw.url = wsUrl;
    }
    const effectiveUrl = settings.openclaw.url || wsUrl;
    const urlChanged = previousUrl !== effectiveUrl;
    if ((shouldUpdate && wsUrl) || candidatesChanged) {
      saveSettings();
    }
    if (reconnect && (urlChanged || !state.openclawConnected)) {
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
      updated: urlChanged,
      candidateUrls: wsCandidates,
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
    const wsCandidates = buildOpenClawDockerWsCandidates(targetContainer.names);
    const preferredWsUrl = buildOpenClawDockerWsUrl(targetContainer.names);
    if (!wsCandidates.includes(preferredWsUrl)) {
      wsCandidates.unshift(preferredWsUrl);
    }
    if (wsCandidates.length === 0) {
      throw new Error(`Tidak ada candidate OpenClaw WS URL untuk container ${targetContainer.names}.`);
    }

    const runGatewayProbe = async (targetWsUrl) => {
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
        targetWsUrl,
        "--token",
        token,
        "--timeout",
        String(OPENCLAW_DOCKER_PROBE_TIMEOUT_MS),
        "--json"
      );

      return runDockerCommand(probeArgs, {
        timeoutMs: Math.max(OPENCLAW_DOCKER_PROBE_TIMEOUT_MS + 4000, DOCKER_COMMAND_TIMEOUT_MS)
      });
    };

    const runDevicesApproveLatest = async () => {
      return runDockerCommand(
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
    };

    let approveResult = null;
    let probeResult = null;
    let wsUrl = "";
    const probeFailures = [];

    const tryProbeCandidates = async (stage) => {
      for (const candidateUrl of wsCandidates) {
        try {
          const result = await runGatewayProbe(candidateUrl);
          return {
            wsUrl: candidateUrl,
            probeResult: result
          };
        } catch (error) {
          probeFailures.push(
            `${stage} ${candidateUrl}: ${truncateText(String(error?.message || "probe failed"), 600)}`
          );
        }
      }
      return null;
    };

    const firstProbe = await tryProbeCandidates("probe");
    if (firstProbe) {
      wsUrl = firstProbe.wsUrl;
      probeResult = firstProbe.probeResult;
    } else if (OPENCLAW_DOCKER_AUTO_APPROVE) {
      try {
        approveResult = await runDevicesApproveLatest();
      } catch (error) {
        if (isNoPendingDeviceApproveError(error)) {
          approveResult = {
            stdout: "",
            stderr: "No pending device pairing requests to approve",
            elapsedMs: 0,
            skippedNoPending: true
          };
        } else {
          throw error;
        }
      }

      const secondProbe = await tryProbeCandidates("probe-after-approve");
      if (secondProbe) {
        wsUrl = secondProbe.wsUrl;
        probeResult = secondProbe.probeResult;
      }
    }

    if (!probeResult || !wsUrl) {
      const details = probeFailures.length ? ` Details: ${probeFailures.join(" | ")}` : "";
      throw new Error(`Gateway probe gagal untuk semua candidate URL.${details}`);
    }

    const previousUrl = settings.openclaw.url;
    settings.openclaw.url = wsUrl;
    settings.openclaw.candidates = mergeUniqueUrls(settings.openclaw.candidates, wsCandidates);
    saveSettings();
    const shouldReconnect =
      previousUrl !== wsUrl || !state.openclawConnected || state.openclawTargetUrl !== wsUrl;
    if (shouldReconnect) {
      reconnectToOpenClaw("docker auto pairing");
    }

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
        candidateUrls: wsCandidates,
        selectedUrl: wsUrl,
        stdout: truncateText(probeResult.stdout, 1600),
        stderr: truncateText(probeResult.stderr, 800)
      },
      approve: approveResult
        ? {
            skippedNoPending: approveResult.skippedNoPending === true,
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

async function forwardChatToOpenClaw(localMessage, clientId) {
  const text = String(localMessage.text || "").trim();
  if (!text) {
    return { ok: false, reason: "Pesan kosong." };
  }
  const fallbackAgentId = serializeAgents()[0]?.id || "";

  const payload = {
    agentId: String(localMessage.agentId || fallbackAgentId),
    text,
    clientId,
    timestamp: toIsoNow()
  };

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

  if (OPENCLAW_TRANSPORT !== "legacy-ws") {
    if (!state.openclawConnected || !state.openclawTargetUrl) {
      return { ok: false, reason: "OpenClaw belum terkoneksi." };
    }
    try {
      const response = await sendChatViaHttp(state.openclawTargetUrl, payload);
      const responseTimestamp = toIsoNow();
      const responseAgentId = String(response.model || payload.agentId || "openclaw");
      upsertAgent({
        id: responseAgentId,
        name: responseAgentId,
        status: "online",
        lastSeen: responseTimestamp
      });
      publishAgentList();
      broadcast({
        type: "chat",
        payload: {
          agentId: responseAgentId,
          agentName: responseAgentId,
          text: response.text,
          source: "openclaw",
          timestamp: responseTimestamp
        }
      });
      return { ok: true };
    } catch (error) {
      state.openclawLastError = String(error?.message || "OpenClaw HTTP chat error");
      broadcastConfig();
      const normalizedError = state.openclawLastError.toLowerCase();
      const isTransientChatError =
        normalizedError.includes("timeout") ||
        normalizedError.includes("masih starting") ||
        normalizedError.includes("starting openclaw") ||
        normalizedError.includes("response kosong");
      if (!isTransientChatError) {
        state.openclawConnected = false;
        state.openclawConnectedAt = 0;
        clearOpenClawHttpPoll();
        scheduleReconnect();
      }
      return { ok: false, reason: state.openclawLastError };
    }
  }

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

  socket.on("message", async (raw) => {
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
      if (OPENCLAW_TRANSPORT !== "legacy-ws" && state.openclawTargetUrl) {
        try {
          await refreshOpenClawAgentsViaHttp(state.openclawTargetUrl);
          state.openclawConnected = true;
          state.openclawConnectedAt = Date.now();
          state.openclawLastError = "";
          broadcastConfig();
        } catch (error) {
          state.openclawLastError = String(error?.message || "OpenClaw HTTP agent refresh error");
          state.openclawConnected = false;
          state.openclawConnectedAt = 0;
          clearOpenClawHttpPoll();
          broadcastConfig();
          scheduleReconnect();
        }
      }
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
      const result = await forwardChatToOpenClaw(message, clientId);
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
  clearOpenClawHeartbeat();
  clearOpenClawHttpPoll();
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
