# Hub Trial

Hub backend runs on VPS (Docker), while UI runs locally on laptop (`localhost`) and connects to Hub public URL.

Flow:
`Local UI (laptop) -> Hub VPS -> OpenClaw`

## What Is Included

- Hub WebSocket bridge to OpenClaw
- OpenClaw discovery + saved token/config
- Docker auto-pair flow:
  - detect OpenClaw container
  - run `openclaw gateway probe`
  - run `openclaw devices approve --latest`
- Local UI app for users:
  - paste VPS IP / Hub URL
  - one-click `Connect` to auto-create SSH tunnel
  - input token
  - see discovered agents
  - chat

## Project Structure

```text
.
|- src/
|  |- server.js
|  |- mock-openclaw.js
|  `- local-ui-server.js
|- public/           (UI served by Hub container)
|- local-ui/         (separate UI app for laptop localhost)
|- data/
|  `- .gitkeep
|- Dockerfile
|- docker-compose.yml
`- .env.example
```

## 1) Run Hub on VPS

```bash
git clone https://github.com/arieladhidevara/hub-trial.git
cd hub-trial
./scripts/install-hub.sh
```

Notes:
- `.env` is optional.
- `docker-compose.yml` mounts:
  - `hub_data:/app/data` (persistent settings)
  - `/var/run/docker.sock:/var/run/docker.sock` (required for Docker auto-pair)

## 2) Run Local UI on Laptop (`localhost`)

Clone same repo on laptop:

```bash
git clone https://github.com/arieladhidevara/hub-trial.git
cd hub-trial
npm install
npm run local-ui
```

Open:
`http://127.0.0.1:5173`

In UI:
1. Paste VPS IP/host
2. Click `Connect`
3. Fill OpenClaw token
4. Leave OpenClaw URL empty (auto Docker pair), then click `Save + Connect`
5. Chat

If URL is empty on save, Hub auto-tries Docker pairing.
Default fallback candidate now uses `ws://<host>:43136` (empty path), matching Hostinger OpenClaw gateway defaults.

## SSH Tunnel Mode (recommended)
Local UI now can run SSH tunnel internally on `Connect`:
- UI calls local API `/api/tunnel/connect`
- local server spawns:
  `ssh -N -L 18080:127.0.0.1:8080 user@host`
- then UI connects to `http://127.0.0.1:18080`

Requirements:
- `ssh` binary installed on laptop
- SSH key or SSH password (can be filled in Local UI).
- If password flow fails on your setup, run manual `ssh` once to accept host key, then retry.

## How Hub Detects Container / Network

When Docker auto-pair runs:
1. `docker ps` -> pick container matching `openclaw` (or exact name if configured)
2. `docker inspect` -> detect container networks
3. choose network automatically (or use configured network)
4. run probe + approve commands
5. save WS URL and reconnect

## Useful Endpoints

- `GET /health`
- `GET /api/config`
- `POST /api/discovery/openclaw`
- `POST /api/config/openclaw`
- `POST /api/docker/auto-pair`
- `POST /api/proxy/auto-setup`

## Key Environment Overrides (Optional)

```env
HUB_ALLOWED_ORIGINS=*

DOCKER_AUTOMATION_ENABLED=true
DOCKER_AUTOMATION_AUTO_PAIR_ON_STARTUP=true
OPENCLAW_DOCKER_CONTAINER_NAME=
OPENCLAW_DOCKER_CONTAINER_MATCH=openclaw
OPENCLAW_DOCKER_NETWORK=
OPENCLAW_DOCKER_WS_URL=
OPENCLAW_DOCKER_GATEWAY_PORT=43136
OPENCLAW_DOCKER_PROBE_IMAGE=ghcr.io/hostinger/hvps-openclaw:latest
OPENCLAW_DOCKER_STATE_VOLUME=hub_openclaw_state
OPENCLAW_DOCKER_AUTO_APPROVE=true
```

## Security Note

`/var/run/docker.sock` gives high privilege to Hub container. Use only on VPS you control.
