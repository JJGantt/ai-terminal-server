#!/usr/bin/env bash
# Run this on the Pi after cloning the repo.
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="ai-terminal-server"
INSTALL_DIR="/home/jaredgantt/ai-terminal-server"

echo "==> Installing dependencies..."
cd "$REPO_DIR"
npm install

echo "==> Building TypeScript..."
npm run build

echo "==> Linking install dir..."
if [ "$REPO_DIR" != "$INSTALL_DIR" ]; then
  ln -sfn "$REPO_DIR" "$INSTALL_DIR"
fi

echo "==> Installing systemd service..."
sudo cp "$REPO_DIR/systemd/$SERVICE_NAME.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "==> Done. Status:"
sudo systemctl status "$SERVICE_NAME" --no-pager
