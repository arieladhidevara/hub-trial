const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const PORT = Number(process.env.MOCK_OPENCLAW_PORT || 8787);
const WS_PATH = process.env.MOCK_OPENCLAW_PATH || "/ws/openclaw";

const agents = [
  {
    id: "agent-alpha",
    name: "Agent Alpha",
    status: "online",
    description: "General assistant"
  },
  {
    id: "agent-beta",
    name: "Agent Beta",
    status: "online",
    description: "Reasoning and planning"
  },
  {
    id: "agent-gamma",
    name: "Agent Gamma",
    status: "idle",
    description: "Code and debugging"
  }
];

function safeParse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (_error) {
    return null;
  }
}

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function replyText(agentName, inputText) {
  const options = [
    `${agentName}: pesan diterima -> "${inputText}"`,
    `${agentName}: aku sudah proses input kamu, lanjutkan prompt berikutnya.`,
    `${agentName}: test WS bridge sukses, payload masuk dengan aman.`
  ];
  return options[Math.floor(Math.random() * options.length)];
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      service: "mock-openclaw",
      wsPath: WS_PATH,
      agents: agents.length,
      timestamp: new Date().toISOString()
    })
  );
});

const wss = new WebSocket.Server({ server, path: WS_PATH });

wss.on("connection", (socket) => {
  sendJson(socket, {
    type: "agent_list",
    payload: { agents }
  });

  socket.on("message", (raw) => {
    const message = safeParse(raw);
    if (!message) {
      sendJson(socket, {
        type: "error",
        payload: {
          message: "Invalid JSON."
        }
      });
      return;
    }

    if (message.type === "hub_hello" || message.type === "request_agents") {
      sendJson(socket, {
        type: "agent_list",
        payload: { agents }
      });
      return;
    }

    if (message.type === "chat") {
      const incoming = message.payload || {};
      const targetAgent =
        agents.find((agent) => agent.id === incoming.agentId) || agents[0];
      sendJson(socket, {
        type: "agent_update",
        payload: {
          agent: {
            ...targetAgent,
            status: "online",
            lastSeen: new Date().toISOString()
          }
        }
      });

      setTimeout(() => {
        sendJson(socket, {
          type: "chat",
          payload: {
            agentId: targetAgent.id,
            agentName: targetAgent.name,
            text: replyText(targetAgent.name, String(incoming.text || "")),
            timestamp: new Date().toISOString()
          }
        });
      }, 300);
      return;
    }

    sendJson(socket, {
      type: "error",
      payload: {
        message: `Unsupported message type: ${String(message.type)}`
      }
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `${new Date().toISOString()} Mock OpenClaw listening on ws://0.0.0.0:${PORT}${WS_PATH}`
  );
});
