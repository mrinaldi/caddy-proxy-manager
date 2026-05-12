# Proxmox LXC Deployment Guide

Deploy Caddy Proxy Manager (CPM) in a Proxmox LXC container alongside a
standard Caddy installation, with a custom Caddyfile that merges seamlessly
with CPM-managed proxy hosts.

---

## Overview

Unlike the default Docker Compose setup where CPM owns the entire Caddy config,
this deployment lets you maintain your own Caddyfile with custom sites, global
options, and advanced routing while CPM manages only its proxy host entries.

```
┌──────────────────────────────────────────┐
│         Proxmox LXC Container            │
│                                          │
│  ┌──────────┐      ┌──────────────────┐  │
│  │   CPM    │◄────►│  Caddy Admin API │  │
│  │ :3000    │ PATCH │  :2019           │  │
│  └──────────┘       └──────────────────┘  │
│                          │                │
│                     ┌────┴─────┐          │
│                     │ Caddyfile │          │
│                     │ (user's)  │          │
│                     └──────────┘          │
└──────────────────────────────────────────┘
```

**How it works:** CPM reads the current running Caddy config via `GET /config/`,
merges only its managed sections (proxy hosts, TLS, L4, logging) into it, and
applies the result. Your custom Caddyfile entries are preserved untouched.

---

## Prerequisites

- A Proxmox LXC container (or any Debian/Ubuntu server)
- Root access (sudo) during installation
- A public IP or domain pointing to the container (ports 80/443)
- Optional: a domain for the CPM dashboard itself

---

## Step 1: Install Caddy

Install Caddy directly on the container (not via Docker):

```bash
# Official Caddy installation
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Verify the installation:

```bash
caddy version
sudo systemctl status caddy
```

---

## Step 2: Configure Your Caddyfile

Edit `/etc/caddy/Caddyfile` to set up the admin API and any custom sites:

```caddyfile
{
  # Admin API — CPM communicates with Caddy here
  admin 127.0.0.1:2019 {
    origins localhost:2019 localhost
  }

  # Optional: persistent config so Caddy resumes after restart
  # persist_config
}

# ── CPM-managed proxy hosts ─────────────────────────────────────────────
# CPM owns the "cpm" server block on ports 80/443.
# Do NOT add http:// or https:// sites on port 80/443 here — CPM manages
# them. They will be merged in at runtime.

# ── Your custom sites (non-CPM) ─────────────────────────────────────────
# Add any sites CPM should NOT manage below.
#
# Example: serve CPM's own dashboard through Caddy with TLS
# cpm.example.com {
#     reverse_proxy localhost:3000
# }
#
# Example: a static site
# example.com {
#     root * /var/www/example
#     file_server
# }

# ── Default placeholder ──────────────────────────────────────────────────
# A catch-all to show CPM is running (optional)
http://localhost {
  respond "Caddy Proxy Manager is running — configure proxy hosts via the web interface" 200
}
```

Restart Caddy to apply:

```bash
sudo systemctl restart caddy
```

---

## Step 3: Install CPM

Use the automated installation script:

```bash
# Clone the repository
git clone https://github.com/your-fork/caddy-proxy-manager.git /tmp/cpm
cd /tmp/cpm

# Run the installer
sudo bash deploy/proxmox/install.sh
```

The script:

1. Creates a `cpm` system user
2. Clones the source to `/opt/cpm`
3. Installs dependencies and builds the Next.js standalone bundle
4. Copies the environment template to `/etc/cpm/cpm.env`
5. Installs the systemd service at `/etc/systemd/system/cpm.service`

---

## Step 4: Configure CPM

Edit the environment file:

```bash
sudo nano /etc/cpm/cpm.env
```

Set at minimum:

```env
SESSION_SECRET=$(openssl rand -base64 32)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Your-Str0ng-P@ssw0rd!
BASE_URL=http://localhost:3000
CADDY_API_URL=http://localhost:2019
CADDY_CONFIG_MODE=merge
FORWARD_AUTH_INTERNAL_URL=http://localhost:3000
DATABASE_URL=file:/var/lib/cpm/caddy-proxy-manager.db
```

> **`CADDY_CONFIG_MODE=merge` is critical** — without it, CPM will replace the
> entire Caddy config on every change, wiping out your custom Caddyfile entries.

---

## Step 5: Start CPM

```bash
sudo systemctl start cpm.service
sudo systemctl status cpm.service  # verify it's running
```

Check the logs:

```bash
sudo journalctl -u cpm.service -f
```

---

## Step 6: Access the Dashboard

If you configured Caddy to reverse-proxy CPM (e.g., `cpm.example.com` →
`localhost:3000`), access the dashboard at:

```
https://cpm.example.com/login
```

Otherwise, access it directly on port 3000:

```
http://your-container-ip:3000/login
```

---

## Verifying the Config Merge

After creating a proxy host in CPM, verify that your custom Caddyfile entries
survive by checking the running config:

```bash
curl -s http://localhost:2019/config/ | jq '.apps.http.servers | keys'
```

You should see at minimum two server keys:
- **`cpm`** — managed by CPM (proxy hosts)
- **`srv0`** (or similar) — from your Caddyfile (custom sites)

---

## Upgrading CPM

```bash
cd /opt/cpm
sudo -u cpm git pull
sudo -u cpm npm ci --omit=dev
sudo -u cpm NODE_ENV=production npm run build
sudo systemctl restart cpm.service
```

---

## Troubleshooting

### CPM won't start — "Unable to reach Caddy API"

```bash
# Verify Caddy is running
sudo systemctl status caddy

# Verify admin API is accessible
curl http://localhost:2019/config/

# Check CADDY_API_URL in /etc/cpm/cpm.env points to the right address
```

### Custom sites disappear after CPM saves a proxy host

```bash
# Check which config mode is active
grep CADDY_CONFIG_MODE /etc/cpm/cpm.env
# Must be set to "merge"
```

### Config merge fails silently

Enable verbose logging in CPM by checking the journal:

```bash
sudo journalctl -u cpm.service --since "10 minutes ago" | grep -i "caddy-merge"
```

---

## Architecture

```
File: /etc/caddy/Caddyfile          File: CPM buildCaddyDocument()
┌─────────────────────────┐         ┌──────────────────────────┐
│ Global options          │         │ apps.http.servers.cpm    │
│ Admin endpoint          │         │ apps.tls                 │
│ Custom server blocks    │         │ apps.layer4              │
│ Custom logging          │         │ apps.logging.logs        │
└─────────┬───────────────┘         └───────────┬──────────────┘
          │                                      │
          └──────────────┬───────────────────────┘
                         │
                    ┌────▼─────┐
                    │  MERGE   │  caddy-merge.ts
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ POST     │
                    │ /load    │
                    └──────────┘
```

CPM owns exactly four sections of the Caddy config. Everything else in your
Caddyfile is safe. Upstream updates to CPM that add new config sections can be
supported by extending the merge list in `caddy-merge.ts`.
