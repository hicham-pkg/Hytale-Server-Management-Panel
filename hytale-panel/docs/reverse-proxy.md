# Reverse Proxy Guide — Hytale Server Management Panel

The panel API binds to `127.0.0.1:4000` and **must not** be exposed directly to the internet. The web frontend binds to `127.0.0.1:3000`. You need a reverse proxy for TLS termination and public access.

For first-run private testing, you can skip the reverse proxy entirely and SSH-tunnel the localhost-bound web port to your workstation.

Backup create/restore requests are now async (`202 Accepted` + job polling), so they should not require very large upstream request timeouts.

## Table of Contents

1. [Nginx](#nginx)
2. [Caddy](#caddy)
3. [Cloudflare Tunnel](#cloudflare-tunnel)
4. [Important Notes](#important-notes)

---

## Nginx

### Installation

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

### Configuration

Create `/etc/nginx/sites-available/hytale-panel`:

```nginx
# Hytale Panel — Nginx Reverse Proxy
# Replace panel.yourdomain.com with your actual domain.

limit_req_zone $binary_remote_addr zone=panel_login:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=panel_api:10m rate=60r/m;

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name panel.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name panel.yourdomain.com;
    server_tokens off;

    # TLS certificates (managed by certbot)
    ssl_certificate /etc/letsencrypt/live/panel.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.yourdomain.com/privkey.pem;

    # TLS hardening
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header X-Permitted-Cross-Domain-Policies "none" always;
    # CSP is emitted by the Next.js web app response layer.

    # Request size limit (for backup labels, etc.)
    client_max_body_size 1m;

    location = /api/auth/login {
        limit_req zone=panel_login burst=3 nodelay;
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /api/ {
        limit_req zone=panel_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 300s;
    }
}
```

`/api/backups/create` and `/api/backups/:id/restore` enqueue jobs immediately and return `202 Accepted`. Standard API timeouts (for example `120s`) are sufficient; long-running work is tracked through `/api/backups/jobs/:id`.

### Enable and Get Certificate

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/hytale-panel /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Get TLS certificate
sudo certbot --nginx -d panel.yourdomain.com

# Reload nginx
sudo systemctl reload nginx
```

### Auto-Renewal

Certbot sets up auto-renewal automatically. Verify:

```bash
sudo certbot renew --dry-run
```

---

## Caddy

Caddy automatically handles TLS certificates.

### Installation

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### Configuration

Edit `/etc/caddy/Caddyfile`:

```caddyfile
panel.yourdomain.com {
    # Automatic HTTPS with Let's Encrypt

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Resource-Policy "same-origin"
        X-Permitted-Cross-Domain-Policies "none"
    }

    @api path /api/* /ws/*
    handle @api {
        reverse_proxy 127.0.0.1:4000
    }

    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

### Start Caddy

```bash
sudo systemctl enable --now caddy
```

---

## Cloudflare Tunnel

Cloudflare Tunnel provides TLS without opening any ports on your VPS.

### Installation

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

### Setup

```bash
# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create hytale-panel

# Configure
cat > ~/.cloudflared/config.yml << EOF
tunnel: <TUNNEL-ID>
credentials-file: /root/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: panel.yourdomain.com
    path: /api/*
    service: http://127.0.0.1:4000
    originRequest:
      noTLSVerify: true
  - hostname: panel.yourdomain.com
    path: /ws/*
    service: http://127.0.0.1:4000
    originRequest:
      noTLSVerify: true
  - hostname: panel.yourdomain.com
    service: http://127.0.0.1:3000
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF

# Create DNS record
cloudflared tunnel route dns hytale-panel panel.yourdomain.com

# Run as service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### Notes for Cloudflare Tunnel

- Keep `TRUST_PROXY=loopback, linklocal, uniquelocal` (default)
- WebSocket support is automatic
- No need to open ports 80/443 on your firewall
- Cloudflare provides DDoS protection automatically
- Cloudflare Access is recommended if you want an identity gate in front of the panel. This repo does not configure Cloudflare Access for you.

## External Access Protection

The panel is safer if you add an outer access-control layer before first public exposure:
- Cloudflare Access for browser SSO/MFA
- Tailscale, WireGuard, or another private network
- Strict reverse-proxy IP allowlists when your admin IPs are stable

These protections are operational controls. They are not implemented automatically by the panel code.

---

## Important Notes

### Local-Only First Run

If you are testing privately before DNS/TLS is ready:

```bash
WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
ssh -L 43000:127.0.0.1:${WEB_HOST_PORT} your-user@your-vps
```

Then browse to `http://localhost:43000`.

If you want WebSocket-origin enforcement to match that private test, set:

```bash
CORS_ORIGIN=http://localhost:43000
WS_ALLOWED_ORIGINS=http://localhost:43000
```

The internal container routing still stays `web -> api:4000`; the SSH tunnel only changes how your browser reaches the web container.

### TRUST_PROXY Setting

The API uses `TRUST_PROXY` to determine which IP to trust for `X-Forwarded-For` headers. This affects:
- Rate limiting (per-IP)
- Audit log IP recording

| Setup | TRUST_PROXY Value |
|-------|------------------|
| Default (Docker + local proxy) | `loopback, linklocal, uniquelocal` |
| nginx on same host (strict override) | `127.0.0.1` |
| Caddy on same host (strict override) | `127.0.0.1` |
| Cloudflare Tunnel (strict override) | `127.0.0.1` |
| nginx on different host | `<nginx-server-ip>` |
| Behind Cloudflare (direct) | `173.245.48.0/20,103.21.244.0/22,...` (Cloudflare IP ranges) |

### WebSocket Requirements

The reverse proxy **must** support WebSocket upgrades for the live console to work:
- **nginx**: Requires `proxy_set_header Upgrade` and `Connection "upgrade"` headers
- **Caddy**: Automatic
- **Cloudflare Tunnel**: Automatic
- **Cloudflare Proxy (orange cloud)**: Enable WebSockets in Cloudflare dashboard → Network → WebSockets

### Port Exposure Summary

| Port | Should Be Open to Internet? | Purpose |
|------|-----------------------------|---------|
| 22 | Yes (or VPN only) | SSH access |
| 80 | Yes (redirect to 443) | HTTP redirect |
| 443 | Yes | HTTPS (panel) |
| 4000 | **NO** — 127.0.0.1 only | API (behind reverse proxy) |
| 5432 | **NO** — Docker internal | PostgreSQL |
| 25565 | Yes | Hytale game traffic |
