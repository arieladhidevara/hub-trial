const path = require("path");
const http = require("http");
const express = require("express");
const { spawn } = require("child_process");

const PORT = Number(process.env.LOCAL_UI_PORT || 5173);
const AUTO_OPEN = String(process.env.LOCAL_UI_AUTO_OPEN || "true")
  .trim()
  .toLowerCase() !== "false";
const DEFAULT_LOCAL_TUNNEL_PORT = Number(process.env.LOCAL_UI_TUNNEL_LOCAL_PORT || 18080);
const DEFAULT_REMOTE_HUB_PORT = Number(process.env.LOCAL_UI_TUNNEL_REMOTE_PORT || 8080);
const TUNNEL_HEALTH_TIMEOUT_MS = Number(
  process.env.LOCAL_UI_TUNNEL_HEALTH_TIMEOUT_MS || 6000
);

const tunnelState = {
  process: null,
  active: false,
  host: "",
  user: "",
  sshPort: 22,
  localPort: DEFAULT_LOCAL_TUNNEL_PORT,
  remotePort: DEFAULT_REMOTE_HUB_PORT,
  startedAt: "",
  lastError: "",
  lastExit: null
};

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "..", "local-ui")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "local-ui",
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/tunnel/status", (_req, res) => {
  res.json({
    ok: true,
    tunnel: getTunnelPublicState()
  });
});

app.post("/api/tunnel/connect", async (req, res) => {
  const body = req.body || {};
  const host = String(body.host || "").trim();
  const user = String(body.user || "root").trim() || "root";
  const password = String(body.password || "");
  const sshPort = Number(body.sshPort || 22);
  const localPort = Number(body.localPort || DEFAULT_LOCAL_TUNNEL_PORT);
  const remotePort = Number(body.remotePort || DEFAULT_REMOTE_HUB_PORT);

  if (!host) {
    res.status(400).json({
      ok: false,
      message: "host wajib diisi."
    });
    return;
  }
  if (!Number.isInteger(sshPort) || sshPort <= 0) {
    res.status(400).json({
      ok: false,
      message: "sshPort tidak valid."
    });
    return;
  }
  if (!Number.isInteger(localPort) || localPort <= 0) {
    res.status(400).json({
      ok: false,
      message: "localPort tidak valid."
    });
    return;
  }
  if (!Number.isInteger(remotePort) || remotePort <= 0) {
    res.status(400).json({
      ok: false,
      message: "remotePort tidak valid."
    });
    return;
  }

  try {
    const state = await startTunnel({
      host,
      user,
      password,
      sshPort,
      localPort,
      remotePort
    });
    res.json({
      ok: true,
      tunnel: state
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
      tunnel: getTunnelPublicState()
    });
  }
});

app.post("/api/tunnel/disconnect", (_req, res) => {
  stopTunnel("manual disconnect");
  res.json({
    ok: true,
    tunnel: getTunnelPublicState()
  });
});

app.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`${new Date().toISOString()} Local UI listening on ${url}`);
  if (AUTO_OPEN) {
    openBrowser(url);
  }
});

process.on("SIGINT", () => {
  stopTunnel("local-ui server shutdown");
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopTunnel("local-ui server shutdown");
  process.exit(0);
});

function getTunnelPublicState() {
  return {
    active: tunnelState.active,
    host: tunnelState.host,
    user: tunnelState.user,
    sshPort: tunnelState.sshPort,
    localPort: tunnelState.localPort,
    remotePort: tunnelState.remotePort,
    startedAt: tunnelState.startedAt,
    lastError: tunnelState.lastError,
    lastExit: tunnelState.lastExit
  };
}

function resetTunnelState() {
  tunnelState.process = null;
  tunnelState.active = false;
  tunnelState.host = "";
  tunnelState.user = "";
  tunnelState.startedAt = "";
  tunnelState.lastExit = null;
}

function stopTunnel(reason) {
  if (!tunnelState.process) {
    return;
  }
  try {
    tunnelState.process.kill("SIGTERM");
  } catch (_error) {
    // no-op
  }
  tunnelState.lastError = reason ? String(reason) : tunnelState.lastError;
  resetTunnelState();
}

function markTunnelExit(code, signal) {
  tunnelState.lastExit = {
    code: Number(code),
    signal: String(signal || ""),
    at: new Date().toISOString()
  };
  tunnelState.active = false;
  tunnelState.process = null;
}

function startTunnel(config) {
  if (
    tunnelState.active &&
    tunnelState.host === config.host &&
    tunnelState.user === config.user &&
    tunnelState.sshPort === config.sshPort &&
    tunnelState.localPort === config.localPort &&
    tunnelState.remotePort === config.remotePort
  ) {
    return Promise.resolve(getTunnelPublicState());
  }

  stopTunnel("replaced by new tunnel");

  return new Promise((resolve, reject) => {
    const args = [
      "-N",
      "-L",
      `${config.localPort}:127.0.0.1:${config.remotePort}`,
      "-p",
      String(config.sshPort),
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${config.user}@${config.host}`
    ];
    const hasPassword = Boolean(String(config.password || "").length);
    if (hasPassword) {
      args.splice(
        args.length - 1,
        0,
        "-o",
        "BatchMode=no",
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=1"
      );
    } else {
      args.splice(args.length - 1, 0, "-o", "BatchMode=yes");
    }

    let settled = false;
    let stderr = "";
    let passwordSent = false;
    let passwordPromptSeen = false;
    const child = spawn("ssh", args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true
    });

    const fail = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch (_error) {
        // no-op
      }
      tunnelState.lastError = message;
      resetTunnelState();
      reject(new Error(message));
    };

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!hasPassword || passwordSent) {
        return;
      }
      if (/(password|passphrase).*:/i.test(text)) {
        passwordPromptSeen = true;
        passwordSent = true;
        try {
          child.stdin.write(`${config.password}\n`);
        } catch (_error) {
          // no-op
        }
      }
    });

    child.on("error", (error) => {
      fail(`Gagal jalankan ssh: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
      if (!settled) {
        const details = stderr.trim() || `ssh exit code ${code}`;
        fail(`SSH tunnel gagal: ${details}`);
        return;
      }
      markTunnelExit(code, signal);
    });

    setTimeout(() => {
      if (settled) {
        return;
      }

      waitForLocalHubHealth(config.localPort, TUNNEL_HEALTH_TIMEOUT_MS)
        .then(() => {
          if (settled) {
            return;
          }
          settled = true;
          tunnelState.process = child;
          tunnelState.active = true;
          tunnelState.host = config.host;
          tunnelState.user = config.user;
          tunnelState.sshPort = config.sshPort;
          tunnelState.localPort = config.localPort;
          tunnelState.remotePort = config.remotePort;
          tunnelState.startedAt = new Date().toISOString();
          tunnelState.lastError = "";
          resolve(getTunnelPublicState());
        })
        .catch((error) => {
          const sshDetails = stderr.trim();
          const missingPromptHint =
            hasPassword && !passwordPromptSeen
              ? " SSH password prompt tidak terdeteksi. Coba login manual sekali untuk trust host key, atau pakai SSH key."
              : "";
          const detailText = sshDetails ? ` SSH: ${sshDetails}` : "";
          fail(`${error.message}${detailText}${missingPromptHint}`);
        });
    }, 250);
  });
}

function waitForLocalHubHealth(localPort, timeoutMs) {
  const startedAt = Date.now();
  const intervalMs = 300;
  let lastError = "";

  return new Promise((resolve, reject) => {
    const tick = () => {
      requestLocalHubHealth(localPort, 1200)
        .then(() => {
          resolve();
        })
        .catch((error) => {
          lastError = error.message;
          if (Date.now() - startedAt >= timeoutMs) {
            reject(
              new Error(
                `SSH tunnel hidup tapi Hub tidak reachable di 127.0.0.1:${localPort}/health. Cek docker hub di VPS. Detail: ${lastError}`
              )
            );
            return;
          }
          setTimeout(tick, intervalMs);
        });
    };
    tick();
  });
}

function requestLocalHubHealth(localPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port: localPort,
        path: "/health",
        timeout: timeoutMs
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk.toString();
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(body || "{}");
            if (parsed && parsed.ok) {
              resolve();
              return;
            }
          } catch (_error) {
            // no-op
          }
          resolve();
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => {
      reject(error);
    });
  });
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      safeDetachedSpawn("cmd", ["/c", "start", "", url]);
      return;
    }
    if (process.platform === "darwin") {
      safeDetachedSpawn("open", [url]);
      return;
    }
    safeDetachedSpawn("xdg-open", [url]);
  } catch (_error) {
    // no-op: user still gets URL in console.
  }
}

function safeDetachedSpawn(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => {
    // no-op
  });
  child.unref();
}
