#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[hub] Building and starting container..."
docker compose up -d --build

echo "[hub] Waiting health check..."
ok=0
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:8080/health" >/tmp/hub_health.json 2>/dev/null; then
    ok=1
    break
  fi
  sleep 1
done

if [[ "$ok" -ne 1 ]]; then
  echo "[hub] ERROR: Hub health check failed."
  echo "[hub] Logs:"
  docker compose logs --tail=120 hub || true
  exit 1
fi

echo "HUB BERHASIL"
echo "[hub] Health payload:"
cat /tmp/hub_health.json
echo

VPS_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "${VPS_IP:-}" ]]; then
  VPS_IP="YOUR_VPS_IP"
fi

echo "[hub] VPS IP (copy this): $VPS_IP"
echo
echo "[next] On laptop, open SSH tunnel:"
echo "ssh -N -L 18080:127.0.0.1:8080 root@$VPS_IP"
echo
echo "[next] Then run local UI on laptop:"
echo "npm install && npm run local-ui"
echo
echo "[next] In Local UI, paste Hub URL:"
echo "http://127.0.0.1:18080"
