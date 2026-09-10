#!/usr/bin/env bash
# Installs the gateway as a systemd service on a Linux edge server.
# Run as root (or with sudo) from anywhere: bash install.sh
#
# What this does, in order:
#   1. Creates a dedicated, unprivileged `scaleops` user to run the service
#   2. Copies the gateway into /opt/scale-ops/gateway
#   3. Installs production dependencies
#   4. Installs and enables the systemd unit
#
# It does NOT start the service or create .env for you — you must copy
# .env.example to .env and fill in GATEWAY_API_KEY before starting, since
# that key is unique per deployment and this script has no way to know it.

set -euo pipefail

INSTALL_DIR="/opt/scale-ops/gateway"
SERVICE_USER="scaleops"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (sudo bash install.sh)." >&2
  exit 1
fi

if ! id "$SERVICE_USER" &>/dev/null; then
  echo "Creating service user '$SERVICE_USER'..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "Copying gateway to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
rsync -a --exclude node_modules --exclude .env --exclude pending-readings.jsonl \
  --exclude deploy "$SOURCE_DIR/" "$INSTALL_DIR/"

echo "Installing production dependencies..."
cd "$INSTALL_DIR"
npm ci --omit=dev

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo "Installing systemd unit..."
cp "$SOURCE_DIR/deploy/scale-ops-gateway.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable scale-ops-gateway

echo ""
echo "============================================================"
echo "Installed. Before starting the service:"
echo "  1. cp $INSTALL_DIR/.env.example $INSTALL_DIR/.env"
echo "  2. Edit $INSTALL_DIR/.env — set BACKEND_URL and GATEWAY_API_KEY"
echo "     (the key is printed by the backend on its first run, or"
echo "     generate one from the dashboard's Gateway Keys panel)"
echo "  3. systemctl start scale-ops-gateway"
echo "  4. systemctl status scale-ops-gateway"
echo "  5. journalctl -u scale-ops-gateway -f    (to tail logs)"
echo "  6. curl http://localhost:9090/healthz    (to check health)"
echo "============================================================"
