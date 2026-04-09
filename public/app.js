const connectionBadge = document.getElementById("connectionBadge");
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

const proxyAutoSetupBtn = document.getElementById("proxyAutoSetupBtn");
const proxySummary = document.getElementById("proxySummary");

const state = {
  socket: null,
  reconnectTimer: null,
  selectedAgentId: null,
  agentsById: new Map(),
  config: null
};

function nowTime() {
  return new Date().toLocaleTimeString();
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/local`;
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

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
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

function renderProxySummary(configProxy = {}, proxyContext = {}) {
  const status = configProxy?.lastAction?.status || "idle";
  const manager = configProxy?.managerKind || "none";
  const managerUrl = configProxy?.managerUrl || "-";
  const domain = configProxy?.publicDomain || "-";
  const baseUrl = proxyContext?.effectiveBaseUrl || "-";
  const actionMessage = configProxy?.lastAction?.message
    ? ` | msg: ${configProxy.lastAction.message}`
    : "";
  proxySummary.textContent = `mode=${manager} | status=${status} | manager=${managerUrl} | domain=${domain} | local-view=${baseUrl}${actionMessage}`;
}

function renderDockerSummary(configDocker = {}) {
  const enabled = configDocker?.automationEnabled ? "enabled" : "disabled";
  const status = configDocker?.lastAction?.status || "idle";
  const networkPref = configDocker?.networkPreference || "-";
  const networkUsed = configDocker?.lastAction?.networkUsed || "-";
  const probeImage = configDocker?.probeImage || "-";
  const message = configDocker?.lastAction?.message
    ? ` | msg: ${configDocker.lastAction.message}`
    : "";
  dockerSummary.textContent = `automation=${enabled} | status=${status} | network_pref=${networkPref} | network_used=${networkUsed} | image=${probeImage}${message}`;
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
  renderProxySummary(config?.proxy || {}, config?.proxyContext || {});
  renderDockerSummary(config?.docker || {});
}

async function loadConfig() {
  try {
    const response = await apiRequest("/api/config");
    renderConfig(response.config || {});
  } catch (error) {
    appendError(`Load config gagal: ${error.message}`);
  }
}

async function discoverOpenClaw() {
  discoverOpenclawBtn.disabled = true;
  discoverOpenclawBtn.textContent = "Scanning...";
  try {
    const response = await apiRequest("/api/discovery/openclaw", {
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
    const response = await apiRequest("/api/config/openclaw", {
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
    const response = await apiRequest("/api/config/openclaw", {
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

async function runProxyAutoSetup() {
  proxyAutoSetupBtn.disabled = true;
  proxyAutoSetupBtn.textContent = "Running...";
  try {
    const response = await apiRequest("/api/proxy/auto-setup", {
      method: "POST",
      body: {}
    });
    renderConfig(response.config || {});
    const status = response.result?.status || "unknown";
    appendSystem(`Proxy auto-setup selesai: ${status}`);
  } catch (error) {
    appendError(`Proxy auto-setup gagal: ${error.message}`);
    await loadConfig();
  } finally {
    proxyAutoSetupBtn.disabled = false;
    proxyAutoSetupBtn.textContent = "Auto Setup";
  }
}

async function runDockerAutoPair() {
  dockerPairBtn.disabled = true;
  dockerPairBtn.textContent = "Pairing...";
  try {
    const response = await apiRequest("/api/docker/auto-pair", {
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

function connect() {
  clearTimeout(state.reconnectTimer);
  setBadge("Connecting...", "warn");

  const socket = new WebSocket(wsUrl());
  state.socket = socket;

  socket.addEventListener("open", () => {
    setBadge("Hub Connected", "ok");
    appendSystem("Connected to Hub WS");
    sendMessage({ type: "request_agents" });
    sendMessage({ type: "request_config" });
    loadConfig();
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
      return;
    }
  });

  socket.addEventListener("close", () => {
    setBadge("Disconnected, reconnecting...", "warn");
    appendSystem("WS disconnected. Reconnecting in 2s...");
    state.reconnectTimer = setTimeout(() => {
      connect();
    }, 2000);
  });

  socket.addEventListener("error", () => {
    appendError("WS connection error.");
  });
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
proxyAutoSetupBtn.addEventListener("click", runProxyAutoSetup);
dockerPairBtn.addEventListener("click", runDockerAutoPair);

connect();
