#!/usr/bin/env bash
#
# Proxmox LXC installation script for Caddy Proxy Manager
#
# Prerequisites:
#   - Proxmox LXC container (or any Debian/Ubuntu host)
#   - Node.js 20+ or Bun runtime
#   - Caddy server installed and running
#   - Git
#
# Usage:
#   chmod +x install.sh
#   sudo ./install.sh [--caddy-config /etc/caddy/Caddyfile]
#
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────

CPM_USER="${CPM_USER:-cpm}"
CPM_GROUP="${CPM_GROUP:-cpm}"
CPM_HOME="${CPM_HOME:-/opt/cpm}"
CPM_DATA="${CPM_DATA:-/var/lib/cpm}"
CPM_ENV_DIR="${CPM_ENV_DIR:-/etc/cpm}"
CPM_LOG_DIR="${CPM_LOG_DIR:-/var/log/cpm}"
CADDY_CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"
REPO_URL="${REPO_URL:-https://github.com/your-fork/caddy-proxy-manager.git}"
BRANCH="${BRANCH:-main}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Pre-flight checks ─────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (sudo)."
fi

echo ""
info "=== Caddy Proxy Manager — Proxmox Installation ==="
echo ""

# ── Step 1: Create system user ────────────────────────────────────────────

if id "$CPM_USER" &>/dev/null 2>&1; then
  info "User $CPM_USER already exists, skipping creation."
else
  info "Creating system user $CPM_USER..."
  groupadd --system "$CPM_GROUP" 2>/dev/null || true
  useradd --system --gid "$CPM_GROUP" --home-dir "$CPM_HOME" --shell /usr/sbin/nologin "$CPM_USER"
  info "Created user $CPM_USER."
fi

# ── Step 2: Create directories ─────────────────────────────────────────────

info "Creating directories..."
mkdir -p "$CPM_HOME"
mkdir -p "$CPM_DATA"
mkdir -p "$CPM_ENV_DIR"
mkdir -p "$CPM_LOG_DIR"
mkdir -p "$CPM_DATA/certs"

# ── Step 3: Clone / update source ─────────────────────────────────────────

if [[ -d "$CPM_HOME/.git" ]]; then
  info "Updating existing repository..."
  cd "$CPM_HOME"
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
else
  info "Cloning repository..."
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$CPM_HOME"
fi

cd "$CPM_HOME"

# ── Step 4: Install dependencies ───────────────────────────────────────────

info "Installing dependencies..."
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Step 5: Build ──────────────────────────────────────────────────────────

info "Building application..."
NODE_ENV=production npm run build

# ── Step 6: Copy environment file ──────────────────────────────────────────

ENV_FILE="$CPM_ENV_DIR/cpm.env"
if [[ -f "$ENV_FILE" ]]; then
  warn "Environment file $ENV_FILE already exists — not overwriting."
  warn "Review and update it manually if needed."
else
  info "Copying environment template..."
  cp deploy/proxmox/cpm.env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  chown "$CPM_USER:$CPM_GROUP" "$ENV_FILE"
  info ""
  info "${YELLOW}!!! IMPORTANT !!!${NC}"
  info "Edit $ENV_FILE and set your secure values:"
  info "  - SESSION_SECRET"
  info "  - ADMIN_USERNAME / ADMIN_PASSWORD"
  info "  - BASE_URL"
  info ""
fi

# ── Step 7: Set ownership ──────────────────────────────────────────────────

info "Setting ownership..."
chown -R "$CPM_USER:$CPM_GROUP" "$CPM_HOME"
chown -R "$CPM_USER:$CPM_GROUP" "$CPM_DATA"
chown -R "$CPM_USER:$CPM_GROUP" "$CPM_LOG_DIR"
chmod 755 "$CPM_HOME"
chmod 750 "$CPM_DATA"
chmod 750 "$CPM_LOG_DIR"

# ── Step 8: Install systemd service ────────────────────────────────────────

SERVICE_FILE="/etc/systemd/system/cpm.service"
if [[ -f "$SERVICE_FILE" ]]; then
  warn "Systemd service already exists at $SERVICE_FILE"
  warn "Restarting service to apply any changes..."
else
  info "Installing systemd service..."
  cp deploy/proxmox/cpm.service "$SERVICE_FILE"
  chmod 644 "$SERVICE_FILE"
fi

systemctl daemon-reload
systemctl enable cpm.service

# ── Step 9: Verify Caddy installation ──────────────────────────────────────

if command -v caddy &>/dev/null; then
  CADDY_VER=$(caddy version 2>/dev/null || echo "unknown")
  info "Caddy is installed: $CADDY_VER"
else
  warn "Caddy does not appear to be installed."
  warn "Install it: https://caddyserver.com/docs/install"
  warn "Then configure $CADDY_CONFIG with CPM integration."
fi

# ── Done ───────────────────────────────────────────────────────────────────

echo ""
info "${GREEN}=== Installation Complete ===${NC}"
echo ""
info "Next steps:"
info "  1. Edit $ENV_FILE with your secure credentials"
info "  2. Configure your Caddyfile at $CADDY_CONFIG"
info "  3. Start CPM: sudo systemctl start cpm.service"
info "  4. Check logs: sudo journalctl -u cpm.service -f"
echo ""
info "For Caddyfile integration docs, see:"
info "  $CPM_HOME/docs/proxmox-deployment.md"
echo ""
