const STORAGE_KEY_HUB_URL = "hub_public_url";
const STORAGE_KEY_USE_TUNNEL = "hub_use_ssh_tunnel";
const STORAGE_KEY_SSH_USER = "hub_ssh_user";
const STORAGE_KEY_SSH_PORT = "hub_ssh_port";

const connectionBadge = document.getElementById("connectionBadge");
const hubUrlInput = document.getElementById("hubUrlInput");
const hubConnectBtn = document.getElementById("hubConnectBtn");
const hubConnectHint = document.getElementById("hubConnectHint");
const useSshTunnelCheckbox = document.getElementById("useSshTunnelCheckbox");
const sshUserInput = document.getElementById("sshUserInput");
const sshPortInput = document.getElementById("sshPortInput");
const sshPasswordInput = document.getElementById("sshPasswordInput");
const disconnectTunnelBtn = document.getElementById("disconnectTunnelBtn");

const agentsListEl = document.getElementById("agentsList");
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const refreshAgentsBtn = document.getElementById("refreshAgentsBtn");

const discoverOpenclawBtn = document.getElementById("discoverOpenclawBtn");
const saveConnectionBtn = document.getElementById("saveConnectionBtn");
const clearTokenBtn = document.getElementById("clearTokenBtn");
const openclawUrlInput = document.getElementById("openclawUrlInput");
const openclawTokenInput = document.getElementById("openclawTokenInput");
const openclawSummary = document.getElementById("openclawSummary");
const discoveryListEl = document.getElementById("discoveryList");
const dockerPairBtn = document.getElementById("dockerPairBtn");
const dockerSummary = document.getElementById("dockerSummary");

const state = {
  hubBaseUrl: "",
  socket: null,
  manualWsClose: false,
  reconnectTimer: null,
  autoDockerUrlDiscoveryTried: false,
  selectedAgentId: null,
  agentsById: new Map(),
  config: null
};

function nowTime() {
  return new Date().toLocaleTimeString();
}

function normalizeHubBaseUrl(raw, defaultPort = 8080) {
  let value = String(raw || "").trim();
  if (!value) {
    return "";
  }
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new Error("Hub URL tidak valid.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Hub URL harus pakai http:// atau https://");
  }
  if (!parsed.port) {
    parsed.port = String(defaultPort);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function parseSshTarget(raw) {
  const input = String(raw || "").trim();
  if (!input) {
    throw new Error("Isi VPS IP/host dulu.");
  }

  if (/^https?:\/\//i.test(input)) {
    const parsed = new URL(input);
    return {
      host: parsed.hostname,
      userFromInput: "",
      sshPortFromInput: null
    };
  }

  let userFromInput = "";
  let hostPart = input;
  if (hostPart.includes("@")) {
    const idx = hostPart.lastIndexOf("@");
    userFromInput = hostPart.slice(0, idx).trim();
    hostPart = hostPart.slice(idx + 1).trim();
  }

  if (!hostPart) {
    throw new Error("Host SSH tidak valid.");
  }

  let sshPortFromInput = null;
  if (hostPart.includes(":") && !hostPart.includes("]")) {
    const idx = hostPart.lastIndexOf(":");
    const maybePort = hostPart.slice(idx + 1).trim();
    if (/^\d+$/.test(maybePort)) {
      sshPortFromInput = Number(maybePort);
      hostPart = hostPart.slice(0, idx).trim();
    }
  }

  if (!hostPart) {
    throw new Error("Host SSH tidak valid.");
  }

  return {
    host: hostPart,
    userFromInput,
    sshPortFromInput
  };
}

function buildWsUrl(hubBaseUrl) {
  const parsed = new URL(hubBaseUrl);
  const wsProto = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${parsed.host}/ws/local`;
}

function apiUrl(path) {
  return `${state.hubBaseUrl}${path}`;
}

function setBadge(text, type) {
  connectionBadge.textContent = text;
  connectionBadge.className = "badge";
  if (type === "ok") {
    connectionBadge.classList.add("badge-ok");
  } else {
    connectionBadge.classList.add("badge-warn");
  }
}

function messageNode(kind, title, text, timestamp = nowTime()) {
  const row = document.createElement("article");
  row.className = `message message-${kind}`;

  const head = document.createElement("p");
  head.className = "message-head";
  head.textContent = `${title} - ${timestamp}`;

  const body = document.createElement("p");
  body.className = "message-text";
  body.textContent = text;

  row.appendChild(head);
  row.appendChild(body);
  return row;
}

function appendSystem(text) {
  messagesEl.appendChild(messageNode("system", "System", text));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendError(text) {
  messagesEl.appendChild(messageNode("error", "Error", text));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendChat(payload) {
  const date = payload.timestamp ? new Date(payload.timestamp) : new Date();
  const who =
    payload.source === "local" ? "You" : payload.agentName || payload.agentId || "OpenClaw";
  const kind = payload.source === "local" ? "local" : "openclaw";
  messagesEl.appendChild(
    messageNode(kind, who, String(payload.text || ""), date.toLocaleTimeString())
  );
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sendMessage(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    appendError("Hub WS belum connected.");
    return;
  }
  state.socket.send(JSON.stringify(message));
}

async function localApiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.message || `${response.status}`;
    throw new Error(message);
  }
  return payload || {};
}

async function hubApiRequest(path, options = {}) {
  if (!state.hubBaseUrl) {
    throw new Error("Hub belum dipilih.");
  }
  const response = await fetch(apiUrl(path), {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.result?.message || payload?.message || `${response.status}`;
    throw new Error(message);
  }
  return payload || {};
}

function renderAgents() {
  const agents = Array.from(state.agentsById.values());
  agentsListEl.innerHTML = "";

  if (agents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "agent-card";
    empty.innerHTML =
      '<p class="agent-title">No agents yet</p><p class="agent-meta">Hub belum dapet daftar agent dari OpenClaw.</p>';
    agentsListEl.appendChild(empty);
    return;
  }

  if (!state.selectedAgentId || !state.agentsById.has(state.selectedAgentId)) {
    state.selectedAgentId = agents[0].id;
  }

  for (const agent of agents) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "agent-card";
    if (agent.id === state.selectedAgentId) {
      card.classList.add("active");
    }
    card.innerHTML = `
      <p class="agent-title">${escapeHtml(agent.name || agent.id)}</p>
      <p class="agent-meta">${escapeHtml(agent.id)} - ${escapeHtml(agent.status || "unknown")}</p>
      <p class="agent-meta">${escapeHtml(agent.description || "-")}</p>
    `;
    card.addEventListener("click", () => {
      state.selectedAgentId = agent.id;
      chatInput.placeholder = `Message for ${agent.name || agent.id}...`;
      renderAgents();
      chatInput.focus();
    });
    agentsListEl.appendChild(card);
  }
}

function renderDiscovery(results = []) {
  discoveryListEl.innerHTML = "";
  if (!Array.isArray(results) || results.length === 0) {
    discoveryListEl.textContent = "Belum ada hasil discovery.";
    return;
  }

  for (const item of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `discovery-item ${item.reachable ? "is-ok" : "is-bad"}`;
    button.innerHTML = `
      <span class="discovery-url">${escapeHtml(item.url || "-")}</span>
      <span class="discovery-meta">
        ${item.reachable ? "reachable" : "unreachable"} - ${escapeHtml(
      String(item.reason || "")
    )} - ${escapeHtml(String(item.latencyMs || 0))}ms
      </span>
    `;
    button.addEventListener("click", () => {
      openclawUrlInput.value = item.url || "";
      openclawUrlInput.focus();
    });
    discoveryListEl.appendChild(button);
  }
}

function renderDockerSummary(configDocker = {}) {
  const enabled = configDocker?.automationEnabled ? "enabled" : "disabled";
  const status = configDocker?.lastAction?.status || "idle";
  const networkPref = configDocker?.networkPreference || "-";
  const networkUsed = configDocker?.lastAction?.networkUsed || "-";
  const message = configDocker?.lastAction?.message
    ? ` | msg: ${configDocker.lastAction.message}`
    : "";
  dockerSummary.textContent = `automation=${enabled} | status=${status} | network_pref=${networkPref} | network_used=${networkUsed}${message}`;
}

function renderConfig(config) {
  state.config = config;
  const openclaw = config?.openclaw || {};

  if (openclaw.connected) {
    setBadge("Hub + OpenClaw Connected", "ok");
  } else if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    setBadge("Hub Connected (OpenClaw Offline)", "warn");
  }

  if (!openclawUrlInput.matches(":focus")) {
    openclawUrlInput.value = openclaw.configuredUrl || "";
  }

  const tokenInfo = openclaw.hasToken
    ? `token saved (${openclaw.tokenPreview || "***"})`
    : "token belum diset";
  const activeUrl = openclaw.activeUrl ? `active: ${openclaw.activeUrl}` : "active: -";
  const configuredUrl = openclaw.configuredUrl
    ? `configured: ${openclaw.configuredUrl}`
    : "configured: auto";
  const errorInfo = openclaw.lastError ? `last_error: ${openclaw.lastError}` : "last_error: -";
  openclawSummary.textContent = `${configuredUrl} | ${activeUrl} | ${tokenInfo} | ${errorInfo}`;

  renderDiscovery(openclaw.lastDiscovery?.results || []);
  renderDockerSummary(config?.docker || {});
}

function renderTunnelStatus(tunnel) {
  if (!tunnel) {
    return;
  }
  if (tunnel.active) {
    hubConnectHint.textContent = `SSH tunnel active: ${tunnel.user}@${tunnel.host}:${tunnel.sshPort} -> localhost:${tunnel.localPort}`;
  } else if (tunnel.lastError) {
    hubConnectHint.textContent = `Tunnel inactive. Last error: ${tunnel.lastError}`;
  } else {
    hubConnectHint.textContent =
      "Paste VPS IP/host, isi SSH user/password (atau pakai SSH key), lalu Connect.";
  }
}

async function refreshTunnelStatus() {
  try {
    const response = await localApiRequest("/api/tunnel/status");
    renderTunnelStatus(response.tunnel);
  } catch (_error) {
    // ignore local status refresh errors
  }
}

async function loadConfig() {
  try {
    const response = await hubApiRequest("/api/config");
    renderConfig(response.config || {});
  } catch (error) {
    appendError(`Load config gagal: ${error.message}`);
  }
}

async function autoDiscoverDockerUrl() {
  if (!state.hubBaseUrl || state.autoDockerUrlDiscoveryTried) {
    return;
  }
  state.autoDockerUrlDiscoveryTried = true;
  try {
    const response = await hubApiRequest("/api/docker/discover-url", {
      method: "POST",
      body: {
        force: false,
        reconnect: true
      }
    });
    renderConfig(response.config || {});
    const wsUrl = response.result?.wsUrl || "";
    if (wsUrl) {
      appendSystem(`OpenClaw URL auto-detected: ${wsUrl}`);
    }
  } catch (error) {
    appendError(`Auto detect OpenClaw URL gagal: ${error.message}`);
  }
}

async function discoverOpenClaw() {
  discoverOpenclawBtn.disabled = true;
  discoverOpenclawBtn.textContent = "Scanning...";
  try {
    const response = await hubApiRequest("/api/discovery/openclaw", {
      method: "POST",
      body: {
        autoApply: false
      }
    });
    renderConfig(response.config || {});
    const best = response.result?.bestUrl || "";
    appendSystem(best ? `Discovery selesai. Best URL: ${best}` : "Discovery selesai. Belum ada URL reachable.");
  } catch (error) {
    appendError(`Discovery gagal: ${error.message}`);
  } finally {
    discoverOpenclawBtn.disabled = false;
    discoverOpenclawBtn.textContent = "Auto Discover";
  }
}

async function saveOpenClawConfig() {
  const url = openclawUrlInput.value.trim();
  const token = openclawTokenInput.value.trim();
  saveConnectionBtn.disabled = true;
  saveConnectionBtn.textContent = "Saving...";
  try {
    const payload = {
      url
    };
    if (token) {
      payload.token = token;
    }
    if (!url) {
      payload.autoPair = true;
    }
    if (token) {
      payload.autoPair = true;
    }
    const response = await hubApiRequest("/api/config/openclaw", {
      method: "POST",
      body: payload
    });
    renderConfig(response.config || {});
    openclawTokenInput.value = "";
    const dockerPair = response.dockerPair || null;
    if (dockerPair && dockerPair.ok === false) {
      appendError(`OpenClaw config tersimpan, tapi auto-pair gagal: ${dockerPair.message || dockerPair.status}`);
    } else if (dockerPair && dockerPair.ok) {
      appendSystem(
        dockerPair.wsUrl
          ? `OpenClaw settings tersimpan. Auto-pair sukses ke ${dockerPair.wsUrl}.`
          : "OpenClaw settings tersimpan. Auto-pair sukses."
      );
    } else {
      appendSystem("OpenClaw settings berhasil disimpan.");
    }
    sendMessage({ type: "request_agents" });
  } catch (error) {
    appendError(`Save config gagal: ${error.message}`);
  } finally {
    saveConnectionBtn.disabled = false;
    saveConnectionBtn.textContent = "Save + Connect";
  }
}

async function clearOpenClawToken() {
  clearTokenBtn.disabled = true;
  clearTokenBtn.textContent = "Clearing...";
  try {
    const response = await hubApiRequest("/api/config/openclaw", {
      method: "POST",
      body: {
        clearToken: true
      }
    });
    renderConfig(response.config || {});
    openclawTokenInput.value = "";
    appendSystem("Saved token dihapus.");
  } catch (error) {
    appendError(`Clear token gagal: ${error.message}`);
  } finally {
    clearTokenBtn.disabled = false;
    clearTokenBtn.textContent = "Clear Token";
  }
}

async function runDockerAutoPair() {
  dockerPairBtn.disabled = true;
  dockerPairBtn.textContent = "Pairing...";
  try {
    const response = await hubApiRequest("/api/docker/auto-pair", {
      method: "POST",
      body: {}
    });
    renderConfig(response.config || {});
    const status = response.result?.status || "unknown";
    const wsUrl = response.result?.wsUrl || "";
    appendSystem(
      wsUrl
        ? `Docker auto-pair ${status}. WS target: ${wsUrl}`
        : `Docker auto-pair selesai: ${status}`
    );
    if (wsUrl) {
      openclawUrlInput.value = wsUrl;
    }
    sendMessage({ type: "request_agents" });
  } catch (error) {
    appendError(`Docker auto-pair gagal: ${error.message}`);
    await loadConfig();
  } finally {
    dockerPairBtn.disabled = false;
    dockerPairBtn.textContent = "Auto Pair Docker OpenClaw";
  }
}

function disconnectSocket() {
  if (!state.socket) {
    return;
  }
  state.manualWsClose = true;
  try {
    state.socket.close();
  } catch (_error) {
    // no-op
  }
  state.socket = null;
}

function connectWebSocket() {
  if (!state.hubBaseUrl) {
    return;
  }
  clearTimeout(state.reconnectTimer);
  disconnectSocket();
  state.autoDockerUrlDiscoveryTried = false;

  const socket = new WebSocket(buildWsUrl(state.hubBaseUrl));
  state.socket = socket;
  setBadge("Connecting...", "warn");

  socket.addEventListener("open", () => {
    setBadge("Hub Connected", "ok");
    appendSystem(`Connected to ${state.hubBaseUrl}`);
    sendMessage({ type: "request_agents" });
    sendMessage({ type: "request_config" });
    loadConfig();
    autoDiscoverDockerUrl();
  });

  socket.addEventListener("message", (event) => {
    let message = null;
    try {
      message = JSON.parse(event.data);
    } catch (_error) {
      appendError("Invalid JSON from Hub.");
      return;
    }

    if (message.type === "system") {
      const detail = message.payload?.message || "System update";
      appendSystem(detail);
      if (message.payload?.openclawConnected === true) {
        setBadge("Hub + OpenClaw Connected", "ok");
      } else if (message.payload?.openclawConnected === false) {
        setBadge("Hub Connected (OpenClaw Offline)", "warn");
      }
      return;
    }

    if (message.type === "config") {
      renderConfig(message.payload || {});
      return;
    }

    if (message.type === "agent_list") {
      const agents = message.payload?.agents || [];
      state.agentsById.clear();
      for (const agent of agents) {
        state.agentsById.set(agent.id, agent);
      }
      renderAgents();
      return;
    }

    if (message.type === "chat") {
      appendChat(message.payload || {});
      return;
    }

    if (message.type === "error") {
      appendError(message.payload?.message || "Unknown hub error.");
    }
  });

  socket.addEventListener("close", () => {
    if (state.manualWsClose) {
      state.manualWsClose = false;
      return;
    }
    setBadge("Disconnected, reconnecting...", "warn");
    appendSystem("WS disconnected. Reconnecting in 2s...");
    state.reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, 2000);
  });

  socket.addEventListener("error", () => {
    appendError("WS connection error.");
  });
}

function persistConnectionForm() {
  localStorage.setItem(STORAGE_KEY_HUB_URL, hubUrlInput.value.trim());
  localStorage.setItem(
    STORAGE_KEY_USE_TUNNEL,
    useSshTunnelCheckbox.checked ? "true" : "false"
  );
  localStorage.setItem(STORAGE_KEY_SSH_USER, sshUserInput.value.trim() || "root");
  localStorage.setItem(STORAGE_KEY_SSH_PORT, sshPortInput.value.trim() || "22");
}

function toggleTunnelFields() {
  const enabled = useSshTunnelCheckbox.checked;
  sshUserInput.disabled = !enabled;
  sshPortInput.disabled = !enabled;
  sshPasswordInput.disabled = !enabled;
  disconnectTunnelBtn.disabled = !enabled;
}

async function connectHub() {
  persistConnectionForm();
  hubConnectBtn.disabled = true;
  hubConnectBtn.textContent = "Connecting...";
  try {
    if (useSshTunnelCheckbox.checked) {
      const parsed = parseSshTarget(hubUrlInput.value);
      const userInput = sshUserInput.value.trim();
      const user = userInput || parsed.userFromInput || "root";
      const sshPortFromField = Number(sshPortInput.value || 22);
      const sshPassword = sshPasswordInput.value;
      const sshPort =
        Number.isInteger(sshPortFromField) && sshPortFromField > 0
          ? sshPortFromField
          : parsed.sshPortFromInput || 22;

      const tunnelResponse = await localApiRequest("/api/tunnel/connect", {
        method: "POST",
        body: {
          host: parsed.host,
          user,
          sshPort,
          password: sshPassword,
          localPort: 18080,
          remotePort: 8080
        }
      });
      renderTunnelStatus(tunnelResponse.tunnel);
      state.hubBaseUrl = "http://127.0.0.1:18080";
      hubUrlInput.value = parsed.host;
      appendSystem("SSH tunnel established.");
    } else {
      state.hubBaseUrl = normalizeHubBaseUrl(hubUrlInput.value, 8080);
      hubConnectHint.textContent = `Connected target: ${state.hubBaseUrl}`;
    }

    connectWebSocket();
  } catch (error) {
    appendError(`Connect gagal: ${error.message}`);
    setBadge("Disconnected", "warn");
    await refreshTunnelStatus();
  } finally {
    hubConnectBtn.disabled = false;
    hubConnectBtn.textContent = "Connect";
  }
}

async function disconnectTunnel() {
  try {
    const response = await localApiRequest("/api/tunnel/disconnect", {
      method: "POST",
      body: {}
    });
    renderTunnelStatus(response.tunnel);
    appendSystem("SSH tunnel disconnected.");
  } catch (error) {
    appendError(`Disconnect tunnel gagal: ${error.message}`);
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }
  if (!state.selectedAgentId) {
    appendError("Pilih agent dulu.");
    return;
  }
  sendMessage({
    type: "chat",
    agentId: state.selectedAgentId,
    text
  });
  chatInput.value = "";
  chatInput.focus();
});

refreshAgentsBtn.addEventListener("click", () => {
  sendMessage({ type: "request_agents" });
});
discoverOpenclawBtn.addEventListener("click", discoverOpenClaw);
saveConnectionBtn.addEventListener("click", saveOpenClawConfig);
clearTokenBtn.addEventListener("click", clearOpenClawToken);
dockerPairBtn.addEventListener("click", runDockerAutoPair);
hubConnectBtn.addEventListener("click", connectHub);
disconnectTunnelBtn.addEventListener("click", disconnectTunnel);
useSshTunnelCheckbox.addEventListener("change", () => {
  toggleTunnelFields();
  persistConnectionForm();
});
sshUserInput.addEventListener("change", persistConnectionForm);
sshPortInput.addEventListener("change", persistConnectionForm);
hubUrlInput.addEventListener("change", persistConnectionForm);
hubUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    connectHub();
  }
});

async function init() {
  const savedUrl = localStorage.getItem(STORAGE_KEY_HUB_URL) || "";
  const savedUseTunnel = localStorage.getItem(STORAGE_KEY_USE_TUNNEL);
  const savedSshUser = localStorage.getItem(STORAGE_KEY_SSH_USER) || "root";
  const savedSshPort = localStorage.getItem(STORAGE_KEY_SSH_PORT) || "22";

  hubUrlInput.value = savedUrl;
  if (savedUseTunnel !== null) {
    useSshTunnelCheckbox.checked = savedUseTunnel === "true";
  }
  sshUserInput.value = savedSshUser;
  sshPortInput.value = savedSshPort;
  toggleTunnelFields();
  setBadge("Disconnected", "warn");
  await refreshTunnelStatus();

  if (savedUrl) {
    connectHub();
  }
}

init();
