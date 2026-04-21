# Hytale Server Management Panel — Architecture Document

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Implementation Approach](#2-implementation-approach)
3. [Component Architecture](#3-component-architecture)
4. [Trust & Privilege Boundaries](#4-trust--privilege-boundaries)
5. [Privilege Separation Model](#5-privilege-separation-model)
6. [Systemd+tmux vs Systemd-Only Tradeoff Analysis](#6-systemdtmux-vs-systemd-only-tradeoff-analysis)
7. [Helper Service vs Sudoers Tradeoff Analysis](#7-helper-service-vs-sudoers-tradeoff-analysis)
8. [Threat Model](#8-threat-model)
9. [Risk Register](#9-risk-register)
10. [Allowed & Forbidden Operations](#10-allowed--forbidden-operations)
11. [Data Flow Description](#11-data-flow-description)
12. [User & UI Interaction Patterns](#12-user--ui-interaction-patterns)
13. [Database Design](#13-database-design)
14. [API Design](#14-api-design)
15. [WebSocket Design](#15-websocket-design)
16. [Operational Assumptions](#16-operational-assumptions)
17. [Implementation Plan & File Structure](#17-implementation-plan--file-structure)
18. [Unclear Aspects & Assumptions](#18-unclear-aspects--assumptions)

---

## 1. Executive Summary

This document describes the architecture for a self-hosted, production-grade web panel to manage a personal Hytale game server running on Ubuntu. The panel prioritizes **security and reliability** over visual polish. It uses a **privilege-separated architecture** with four trust zones: browser, API backend, local privileged helper, and host OS.

> Current-state note: this document includes some historical design sections.
> Treat route contracts and runtime behavior in `README.md` plus `packages/*/src`
> as the source of truth. In particular, the legacy `/api/settings` runtime
> settings endpoint is now deprecated (`410 Gone`) and operational settings are
> environment-driven.

**Key architectural decisions:**
- **systemd + tmux** for game server management (enables live console I/O)
- **Local-only privileged helper service** (not sudoers) for host operations
- **Docker Compose** for panel services (API + frontend + PostgreSQL)
- **WebSocket** for real-time log streaming and console interaction
- **Argon2** password hashing, admin-required TOTP 2FA, strict session management

---

## 2. Implementation Approach

### Difficult/Critical Requirements

1. **Live console command sending** — Hytale has no known RCON protocol. The game server's stdin must be written to directly. Pure systemd does not expose stdin. Solution: wrap the server in a tmux session managed by a custom systemd unit.
2. **Privilege separation** — The panel backend must not run as root, yet it needs to control systemd services and read journalctl. Solution: a dedicated local-only helper service running as root with a strict systemd sandbox, HMAC-authenticated Unix socket, and allowlisted host operations only.
3. **Backup/restore safety** — Restoring while the server is running could corrupt worlds. Solution: enforce server-stopped precondition and automatic safety snapshots.
4. **Security of WebSocket** — Must authenticate WS connections with the same session tokens as HTTP, and rate-limit.
5. **Path traversal prevention** — Backup restore/delete/list operations must be confined to allowlisted directories.

### Technology Choices

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | Next.js 14 (App Router) + React 18 + Tailwind CSS + shadcn/ui | Modern, typed, SSR for initial load, great DX |
| Backend API | Fastify 4 + TypeScript | Fast, schema-validated, plugin ecosystem, low overhead |
| Database | PostgreSQL 16 | Reliable, ACID, good for audit logs and sessions |
| ORM | Drizzle ORM | Type-safe, lightweight, migration support |
| Realtime | Fastify WebSocket (@fastify/websocket) | Native integration, same auth middleware |
| Auth | Argon2 (argon2 npm), TOTP (otpauth npm) | Industry-standard password hashing, RFC 6238 TOTP |
| Validation | Zod | Runtime + compile-time type safety |
| Helper Service | Node.js + Fastify (minimal) | Same language, Unix socket only, tiny surface area |
| Containerization | Docker Compose | Panel services only; Hytale stays on host |
| Background Jobs | node-cron (in-process) | Crash detection + session cleanup without external cron |

---

## 3. Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROWSER (Trust Zone 0)                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Next.js Frontend (SSR + CSR)                                 │  │
│  │  - Dashboard, Console, Whitelist, Bans, Backups, Settings     │  │
│  │  - WebSocket client for live logs/console                     │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS (reverse proxy)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   DOCKER NETWORK (Trust Zone 1)                     │
│                                                                     │
│  ┌─────────────────────┐    ┌──────────────────────┐               │
│  │  Next.js Container   │    │  PostgreSQL 16        │               │
│  │  (Port 3000)         │    │  (Port 5432, internal)│               │
│  └─────────┬───────────┘    └──────────┬───────────┘               │
│            │                           │                            │
│  ┌─────────▼───────────────────────────▼───────────┐               │
│  │  Fastify API Server (Port 4000)                  │               │
│  │  - REST endpoints                                │               │
│  │  - WebSocket /ws/console                          │               │
│  │  - Session management                            │               │
│  │  - Audit logging                                 │               │
│  │  - Zod validation on all inputs                  │               │
│  └─────────────────────┬───────────────────────────┘               │
└────────────────────────┼────────────────────────────────────────────┘
                         │ Unix Domain Socket
                         │ /run/hytale-helper/hytale-helper.sock
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     HOST OS (Trust Zone 2)                           │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  hytale-helper.service (Privileged Helper)                   │   │
│  │  - Runs as root with primary group 'hytale-panel'           │   │
│  │  - Supplementary group 'hytale' for game file access        │   │
│  │  - Listens ONLY on Unix socket                               │   │
│  │  - Allowlisted operations only                               │   │
│  │  - HMAC-signed requests                                      │   │
│  │  - Manages: systemctl, journalctl, tmux, file ops            │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                              │                                      │
│  ┌──────────────────────────▼──────────────────────────────────┐   │
│  │  hytale-tmux.service (Trust Zone 3 — Game Server)            │   │
│  │  - Runs Hytale server inside tmux session 'hytale'           │   │
│  │  - User: hytale                                              │   │
│  │  - WorkingDirectory: /opt/hytale                             │   │
│  │  - stdin/stdout accessible via tmux send-keys / capture-pane │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Files: /opt/hytale/Server/whitelist.json                          │
│  Files: /opt/hytale/Server/bans.json                               │
│  Backups: /opt/hytale-backups/                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Next.js Frontend** | UI rendering, form validation, WebSocket client, no direct host access |
| **Fastify API** | Authentication, authorization, session management, audit logging, input validation, proxies requests to helper |
| **PostgreSQL** | Users, sessions, audit logs, backup metadata, crash history, settings |
| **Privileged Helper** | Executes allowlisted host operations, reads/writes game files, manages tmux/systemd |
| **hytale-tmux.service** | Runs the actual Hytale game server inside a tmux session |

---

## 4. Trust & Privilege Boundaries

### Trust Zones

| Zone | Trust Level | Components | Privileges |
|------|------------|------------|------------|
| **Zone 0** — Browser | Untrusted | Next.js client, user browser | None; all actions require authenticated API calls |
| **Zone 1** — Docker Network | Low trust | Fastify API, Next.js SSR, PostgreSQL | Network access to DB and helper socket; no root, no host filesystem (except mounted socket and backup volume) |
| **Zone 2** — Host Helper | Medium trust | hytale-helper.service | Can run specific systemctl/journalctl/tmux commands; read/write specific paths under /opt/hytale and /opt/hytale-backups |
| **Zone 3** — Game Server | Isolated | hytale-tmux.service | Runs as 'hytale' user; only game server process |

### Boundary Crossings

| From → To | Mechanism | Authentication | Validation |
|-----------|-----------|---------------|------------|
| Browser → API | HTTPS (via reverse proxy) | Session cookie (HttpOnly, Secure, SameSite=Strict) | Zod schemas on all inputs |
| Browser → API WS | WSS (via reverse proxy) | Session token in first message or cookie | Message schema validation |
| API → PostgreSQL | TCP (Docker internal) | PostgreSQL credentials | Parameterized queries (Drizzle ORM) |
| API → Helper | Unix Domain Socket | HMAC-SHA256 signed requests with shared secret + timestamp | Allowlisted operation enum + Zod validation |
| Helper → systemd | subprocess (systemctl) | Helper runs as local-only root with a systemd sandbox | Hardcoded command templates, no string interpolation |
| Helper → tmux | subprocess (tmux send-keys) | Helper is member of 'hytale' group | Command sanitization, character allowlist |
| Helper → filesystem | Node.js fs | Helper user has group read/write on /opt/hytale | Path allowlist, realpath resolution, no symlink following |

---

## 5. Privilege Separation Model

### Recommended: Local-Only Helper Service with Allowlisted API

**Architecture:**

```
[Fastify API Container]
       │
       │  Unix Socket: /run/hytale-helper/hytale-helper.sock
       │  Protocol: JSON-RPC over HTTP
       │  Auth: HMAC-SHA256(shared_secret, timestamp + operation + params)
       ▼
[hytale-helper service]
       │
       ├── systemctl start/stop/restart/status hytale-tmux.service
       ├── journalctl -u hytale-tmux.service (read-only, bounded)
       ├── tmux -S /opt/hytale/run/hytale.tmux.sock send-keys -t hytale "command" Enter
       ├── tmux -S /opt/hytale/run/hytale.tmux.sock capture-pane -t hytale -p (read output)
       ├── read /opt/hytale/Server/whitelist.json
       ├── write /opt/hytale/Server/whitelist.json (validated JSON only)
       ├── read /opt/hytale/Server/bans.json
       ├── write /opt/hytale/Server/bans.json (validated JSON only)
       ├── create backup (tar.gz /opt/hytale/Server/worlds/ → /opt/hytale-backups/)
       ├── list backups in /opt/hytale-backups/
       ├── restore backup (with server-stopped precondition)
       └── read system stats (cpu, memory, disk via /proc and df)
```

**User/Group Model:**

| User | Purpose | Groups |
|------|---------|--------|
| `hytale` | Runs the game server | `hytale` |
| `root` | Runs the helper service | Primary: `hytale-panel`, supplementary: `hytale` |
| API container user `1000:1000` | Runs the API container | Supplementary numeric group `PANEL_SOCKET_GID` for socket access only |

The shipped helper now runs as local-only `root` and executes the same narrow allowlisted operations directly. The legacy `hytale-helper.sudoers` file is kept in the repo only as a migration reference for older installs and is no longer installed by default.

---

## 6. Systemd+tmux vs Systemd-Only Tradeoff Analysis

### The Problem

Hytale (like many game servers) reads commands from stdin. A pure systemd service with `Type=simple` does not expose stdin to external processes. There is no known RCON-style protocol for Hytale.

### Option A: Systemd Only

| Aspect | Assessment |
|--------|-----------|
| **Start/Stop/Restart** | ✅ Works perfectly via `systemctl` |
| **Status/Logs** | ✅ Works via `systemctl status` and `journalctl` |
| **Send console commands** | ❌ **Not possible** — stdin is /dev/null |
| **Read console output** | ✅ Via journalctl (stdout/stderr captured) |
| **Complexity** | ✅ Simple, standard |
| **Reliability** | ✅ systemd handles restarts, watchdog |

### Option B: Systemd + tmux (RECOMMENDED)

| Aspect | Assessment |
|--------|-----------|
| **Start/Stop/Restart** | ✅ systemctl manages the tmux wrapper |
| **Status/Logs** | ✅ journalctl + tmux capture-pane |
| **Send console commands** | ✅ `tmux -S /opt/hytale/run/hytale.tmux.sock send-keys -t hytale "command" Enter` |
| **Read console output** | ✅ `tmux -S /opt/hytale/run/hytale.tmux.sock capture-pane -t hytale -p` for recent buffer |
| **Complexity** | ⚠️ Slightly more complex; tmux session management |
| **Reliability** | ✅ systemd still manages lifecycle; tmux is battle-tested |

### Decision: **Systemd + tmux**

**Rationale:** Without console command support, the panel loses ~40% of its value (no whitelist commands, no ban commands, no save command, no live console interaction). The tmux approach is well-proven in game server management (used by LinuxGSM, Pterodactyl, AMP, etc.).

**Migration path from existing setup:**

1. Create new service `hytale-tmux.service` that wraps the game server in tmux
2. Disable old `hytale.service`
3. Enable `hytale-tmux.service`
4. The panel manages `hytale-tmux.service` exclusively

**New systemd unit (`hytale-tmux.service`):**

```ini
[Unit]
Description=Hytale Game Server (tmux)
After=network.target

[Service]
Type=forking
User=hytale
Group=hytale
WorkingDirectory=/opt/hytale
UMask=007
ExecStartPre=/usr/bin/install -d -m 0770 /opt/hytale/run
ExecStart=/usr/bin/tmux -S /opt/hytale/run/hytale.tmux.sock new-session -d -s hytale '/opt/hytale/start.sh'
ExecStop=/bin/bash -lc '/usr/bin/tmux -S /opt/hytale/run/hytale.tmux.sock has-session -t hytale 2>/dev/null || exit 0; /usr/bin/tmux -S /opt/hytale/run/hytale.tmux.sock send-keys -t hytale "save" Enter; sleep 5; /usr/bin/tmux -S /opt/hytale/run/hytale.tmux.sock kill-session -t hytale'
RemainAfterExit=yes
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## 7. Helper Service vs Sudoers Tradeoff Analysis

### Option A: Sudoers Rules (legacy alternative)

| Aspect | Assessment |
|--------|-----------|
| **Setup** | ✅ Simple on paper, but fragile in practice |
| **Attack surface** | ❌ Docker container with sudo access to host is dangerous |
| **Auditability** | ⚠️ Harder to audit; sudo logs exist but scattered |
| **Extensibility** | ❌ Every new operation = new privileged rule to maintain |
| **Input validation** | ❌ Must be done in shell; error-prone |
| **Container escape risk** | ❌ Granting sudo from container to host is a significant escalation vector |

### Option B: Local Helper Service (RECOMMENDED)

| Aspect | Assessment |
|--------|-----------|
| **Setup** | ⚠️ More initial work — separate service |
| **Attack surface** | ✅ Unix socket only; no network exposure; HMAC auth |
| **Auditability** | ✅ All operations logged in helper + forwarded to API audit log |
| **Extensibility** | ✅ Add new operations to the allowlist enum |
| **Input validation** | ✅ Full Zod validation in TypeScript before any execution |
| **Container escape risk** | ✅ Container only accesses a Unix socket; no sudo, no host shell |

### Decision: **Helper Service**

The helper service provides a clean, auditable, validatable boundary between the containerized panel and the host OS. The Docker container never gets sudo or shell access to the host.

---

## 8. Threat Model

### 8.1 Command Injection

| Vector | Mitigation |
|--------|-----------|
| Console commands sent to tmux | Character allowlist: `[a-zA-Z0-9 _\-\.@:\/]`; max length 200; no shell metacharacters (`; | & $ \` ( ) { } < > ! #`) |
| systemctl commands | Hardcoded templates; service name is a config constant, never user input |
| Backup filenames | Generated server-side (timestamp-based UUID); user never controls filenames |
| journalctl arguments | Hardcoded flags; only `--since`, `--until`, `-n` with validated integer values |

### 8.2 Path Traversal

| Vector | Mitigation |
|--------|-----------|
| Backup restore path | `path.resolve()` + verify result stays inside the backup root; reject symlinks/path traversal |
| Whitelist/ban file path | Hardcoded in config; never derived from user input |
| Backup ID lookup/delete | IDs are validated and resolved against known backup metadata/files only |

### 8.3 CSRF

| Vector | Mitigation |
|--------|-----------|
| State-changing POST/PUT/DELETE | SameSite=Strict cookies; CSRF token in custom header (`X-CSRF-Token`) validated server-side |
| WebSocket | Session cookie validated on connect and on privileged messages; origin header validation |

### 8.4 Session Theft

| Vector | Mitigation |
|--------|-----------|
| Cookie theft via XSS | HttpOnly, Secure, SameSite=Strict; strict output escaping and no `dangerouslySetInnerHTML`; baseline CSP headers on web responses |
| Session fixation | Regenerate session ID on login |
| Session hijacking | Short expiry (4h default absolute + role-based idle timeout); session rotation on TOTP completion |

### 8.5 Brute Force

| Vector | Mitigation |
|--------|-----------|
| Login endpoint | Rate limit: 5 attempts per 15 minutes per IP; account lockout after 10 failed attempts (30-minute cooldown) |
| TOTP verification | Rate limit: 3 attempts per minute |
| API endpoints | Global rate limit: 100 req/min per session |

### 8.6 WebSocket Auth Bypass

| Vector | Mitigation |
|--------|-----------|
| Unauthenticated WS connection | Require valid session cookie on upgrade; validate in `@fastify/websocket` preHandler |
| WS message spoofing | All WS messages validated with Zod; operation allowlist |
| WS connection flooding | Max 3 concurrent WS connections per session; message rate limit 10/sec |

### 8.7 Privilege Escalation

| Vector | Mitigation |
|--------|-----------|
| API → Helper | HMAC-signed requests; helper validates signature + timestamp (±30s window) |
| Helper → root | Local-only root helper with a systemd sandbox and allowlisted direct execution |
| Docker escape | Container runs as non-root; no `--privileged`; only Unix socket mounted |
| Role bypass | Server-side role check on every endpoint; no client-side-only authorization |

### 8.8 Backup/Restore Abuse

| Vector | Mitigation |
|--------|-----------|
| Restore while server running | Helper checks server status before restore; rejects if running |
| Restore malicious backup | Backups are tar.gz created by the system; restore validates tar contents (no absolute paths, no symlinks, no files outside target) |
| Backup path escape | Backup directory is hardcoded; all paths resolved and checked |
| Backup deletion | Requires admin role + confirmation; audit logged |

### 8.9 Malicious File Contents

| Vector | Mitigation |
|--------|-----------|
| Whitelist.json injection | Parse with JSON.parse; validate schema with Zod; reject if invalid |
| Log injection / XSS | All log output HTML-escaped before rendering; use React's default escaping; no `dangerouslySetInnerHTML`; baseline CSP headers on web responses |
| Config file tampering | Helper validates all file writes against schemas before writing |

### 8.10 Log Injection / XSS

| Vector | Mitigation |
|--------|-----------|
| Malicious player names in logs | HTML-escape all log lines; render as plain text in `<pre>` elements |
| ANSI escape codes | Strip ANSI codes before sending to frontend |
| Script injection via log content | No `dangerouslySetInnerHTML`; strict log sanitization + React escaping; CSP is baseline (currently includes `'unsafe-inline'` for Next.js runtime compatibility) |

### 8.11 Reverse Proxy Trust

| Vector | Mitigation |
|--------|-----------|
| IP spoofing via X-Forwarded-For | Fastify `trustProxy` is explicitly configured via `TRUST_PROXY` (default: local/private proxy hops only) |
| Missing HTTPS | Panel designed to run behind TLS-terminating proxy; HSTS header set |
| Direct access bypass | Panel binds to 127.0.0.1 or Docker internal network only |

### 8.12 Unsafe Admin Actions

| Vector | Mitigation |
|--------|-----------|
| Accidental server stop | Confirmation dialog + re-authentication for destructive actions |
| Restore wrong backup | Two-step confirmation; auto-creates safety snapshot before restore |
| Delete all backups | Not supported in v1; only individual deletion with confirmation |

### 8.13 Local Helper Abuse

| Vector | Mitigation |
|--------|-----------|
| Unauthorized socket access | Socket permissions: `srw-rw---- hytale-helper:hytale-panel`; only the API container process with the shared socket GID can connect |
| Replay attacks | HMAC includes timestamp; ±30s window; nonce tracking |
| Helper compromise | Helper has minimal privileges; no network access; logs all operations |

---

## 9. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Residual Risk |
|----|------|-----------|--------|------------|---------------|
| R1 | Command injection via console | Medium | Critical | Character allowlist, length limit | Low — allowlist may block legitimate commands |
| R2 | Path traversal in backup ops | Low | Critical | Path resolution + prefix check + no symlinks | Very Low |
| R3 | Session theft | Low | High | HttpOnly/Secure/SameSite cookies, CSP | Low |
| R4 | Brute force login | Medium | Medium | Rate limiting + account lockout | Low |
| R5 | Helper service compromise | Very Low | Critical | Minimal privileges, Unix socket only, HMAC auth | Very Low |
| R6 | Backup restore corruption | Low | High | Server-stopped precondition, safety snapshot | Low |
| R7 | XSS via log content | Medium | Medium | HTML escaping, CSP, no innerHTML | Very Low |
| R8 | Docker container escape | Very Low | Critical | Non-root container, no privileged mode | Very Low |
| R9 | Hytale server crash undetected | Medium | Medium | Crash pattern detection, health polling | Low |
| R10 | TOTP secret theft | Very Low | High | Encrypted storage, shown once on setup | Very Low |
| R11 | Denial of service via WS flood | Medium | Low | Connection limits, message rate limits | Low |
| R12 | Stale session after admin removal | Low | Medium | Session invalidation on user change | Very Low |

---

## 10. Allowed & Forbidden Operations

### Allowed Operations (Helper Service Allowlist)

| Operation | Parameters | Constraints |
|-----------|-----------|-------------|
| `server.start` | none | Only if server is not running |
| `server.stop` | none | Only if server is running |
| `server.restart` | none | Always allowed |
| `server.status` | none | Read-only |
| `server.sendCommand` | `command: string` | Allowlisted characters only; max 200 chars |
| `logs.read` | `lines: number, since?: string` | lines ≤ 1000; since must be valid ISO date |
| `console.capturePane` | `lines: number` | lines ≤ 500 |
| `whitelist.read` | none | Read-only |
| `whitelist.write` | `enabled: boolean, list: string[]` | Zod-validated whitelist object fields |
| `bans.read` | none | Read-only |
| `bans.write` | `entries: BanEntry[]` | Zod-validated JSON array |
| `backup.create` | `label?: string` | Label alphanumeric+dash, max 50 chars |
| `backup.list` | none | Read-only |
| `backup.restore` | `backupId: string` | Server must be stopped; safety snapshot first |
| `backup.delete` | `backupId: string` | UUID format validation |
| `stats.system` | none | Read-only (CPU, RAM, disk) |
| `stats.process` | none | Read-only (Hytale process stats) |

### Forbidden Operations (Explicitly Blocked)

| Operation | Reason |
|-----------|--------|
| Raw shell command execution | Command injection risk |
| Arbitrary file read/write | Path traversal risk |
| Network configuration changes | Out of scope; privilege escalation |
| User management on host OS | Out of scope; privilege escalation |
| Package installation | Out of scope; privilege escalation |
| Docker management | Out of scope; privilege escalation |
| Arbitrary systemctl commands | Only hytale-tmux.service allowed |
| Arbitrary journalctl queries | Only hytale-tmux.service allowed |
| Direct database access from frontend | All queries go through API |
| File upload to game server | Not needed; attack surface |
| Backup to arbitrary paths | Only /opt/hytale-backups/ |

---

## 11. Data Flow Description

### 11.1 Authentication Flow

```
Browser → POST /api/auth/login {username, password}
  → Fastify validates with Zod
  → Query PostgreSQL for user
  → Verify password with Argon2
  → Check account lockout status
  → If 2FA enabled: return {requires2FA: true}
    → Browser → POST /api/auth/verify-totp {code}
    → Verify TOTP code
  → Create session in PostgreSQL
  → Set HttpOnly cookie with session ID
  → Log to audit_logs table
  → Return {success: true, user: {id, username, role}}
```

### 11.2 Server Control Flow

```
Browser → POST /api/server/restart
  → Fastify validates session + role (admin required)
  → Fastify validates CSRF token
  → Fastify calls Helper via Unix socket:
    HMAC-signed request: {op: "server.restart", ts: now, nonce: uuid}
  → Helper validates HMAC + timestamp + nonce
  → Helper executes: sudo systemctl restart hytale-tmux.service
  → Helper returns {success: true, message: "..."}
  → Fastify logs to audit_logs
  → Fastify returns result to browser
```

### 11.3 Live Console Flow

```
Browser → WS upgrade /ws/console
  → Fastify validates session cookie in upgrade handler
  → Connection established

Browser → WS message: {type: "subscribe"}
  → Fastify starts polling Helper for tmux capture-pane output
  → Helper runs: tmux -S /opt/hytale/run/hytale.tmux.sock capture-pane -t hytale -p -S -50
  → Returns last 50 lines
  → Fastify diffs with previous capture, sends new lines to browser

Browser → WS message: {type: "command", data: "whitelist add Player1"}
  → Fastify validates command against allowlist regex
  → Fastify calls Helper: {op: "server.sendCommand", params: {command: "whitelist add Player1"}}
  → Helper validates characters, runs: tmux -S /opt/hytale/run/hytale.tmux.sock send-keys -t hytale 'whitelist add Player1' Enter
  → Helper returns {success: true}
  → Fastify logs to audit_logs
  → Next capture-pane poll picks up command output
```

### 11.4 Backup Flow

```
Browser → POST /api/backups/create {label: "before-update"}
  → Fastify validates session + role
  → Fastify enqueues a backup job in PostgreSQL backup_jobs
  → Fastify returns 202 Accepted with job id/status
  → In-process worker claims one queued job (globally serialized with DB advisory lock)
  → Worker calls Helper: {op: "backup.create", params: {label, operationId}}
  → Helper persists durable operation state (running → terminal)
  → Worker finalizes API job state/result
  → Browser polls /api/backups/jobs/:id until terminal status
```

### 11.5 Crash Detection Flow

```
node-cron job (every 5 minutes):
  → API calls Helper: {op: "logs.read", params: {lines: 500, since: lastCheck}}
  → Helper runs: journalctl -u hytale-tmux.service --since "5 min ago" --no-pager -o json
  → Returns structured log entries
  → API parses for crash patterns:
    - "world crashed" → severity: critical
    - "no default world configured" → severity: error
    - "Out of memory" / "Killed process" → severity: critical
    - Rapid restart detection (>3 starts in 10 min) → severity: warning
    - "async chunk" / "entity" warnings → severity: warning
  → Stores detected events in crash_events table
  → Updates dashboard warning state
```

---

## 12. User & UI Interaction Patterns

### Primary Interactions

1. **Login** — Admin enters username + password → optional TOTP → redirected to dashboard
2. **Dashboard check** — View server status, uptime, resource usage, recent warnings at a glance
3. **Start/Stop/Restart** — Click button → confirmation modal → action executes → result shown with audit entry
4. **Live console** — View scrolling log output → type command in input → press Enter → see result in log stream
5. **Whitelist management** — View player list → add player name → confirm → see updated list
6. **Ban management** — View ban list → add/remove ban → confirm → see updated list
7. **Create backup** — Click "Create Backup" → optional label → job queued → UI tracks queued/running/succeeded/failed
8. **Restore backup** — Select backup → warning modal → confirm → restore job queued and polled to terminal state
9. **View crash history** — Browse timeline of detected issues with severity and human-readable summaries
10. **Settings** — Manage users and 2FA setup; runtime paths/security values remain env-driven
11. **Audit log** — Browse chronological log of all admin actions with filters

### UI Navigation Flow

```
[Login] → [Dashboard]
              ├── [Server Controls] (inline on dashboard)
              ├── [Live Console]
              ├── [Whitelist Management]
              ├── [Ban Management]
              ├── [Backups]
              │     ├── [Create Backup]
              │     └── [Restore Backup] → [Confirmation]
              ├── [Crash History]
              ├── [Audit Log]
              └── [Settings]
                    ├── [User Management]
                    └── [2FA Setup]
```

---

## 13. Database Design

### Tables

**users**
| Column | Type | Constraints |
|--------|------|------------|
| id | UUID | PK, default gen_random_uuid() |
| username | VARCHAR(50) | UNIQUE, NOT NULL |
| password_hash | VARCHAR(255) | NOT NULL |
| role | VARCHAR(20) | NOT NULL, CHECK (role IN ('admin', 'readonly')) |
| totp_secret | VARCHAR(255) | NULLABLE, encrypted |
| totp_enabled | BOOLEAN | DEFAULT false |
| failed_login_attempts | INTEGER | DEFAULT 0 |
| locked_until | TIMESTAMP | NULLABLE |
| created_at | TIMESTAMP | DEFAULT now() |
| updated_at | TIMESTAMP | DEFAULT now() |

**sessions**
| Column | Type | Constraints |
|--------|------|------------|
| id | UUID | PK |
| user_id | UUID | FK → users.id, NOT NULL |
| ip_address | VARCHAR(45) | NOT NULL |
| user_agent | VARCHAR(500) | |
| expires_at | TIMESTAMP | NOT NULL |
| created_at | TIMESTAMP | DEFAULT now() |

**audit_logs**
| Column | Type | Constraints |
|--------|------|------------|
| id | UUID | PK |
| user_id | UUID | FK → users.id, NULLABLE |
| action | VARCHAR(100) | NOT NULL |
| target | VARCHAR(200) | |
| details | JSONB | |
| ip_address | VARCHAR(45) | |
| success | BOOLEAN | NOT NULL |
| created_at | TIMESTAMP | DEFAULT now() |

**backup_metadata**
| Column | Type | Constraints |
|--------|------|------------|
| id | UUID | PK |
| filename | VARCHAR(255) | NOT NULL |
| label | VARCHAR(50) | |
| size_bytes | BIGINT | NOT NULL |
| sha256 | VARCHAR(64) | NOT NULL |
| created_by | UUID | FK → users.id |
| created_at | TIMESTAMP | DEFAULT now() |

**crash_events**
| Column | Type | Constraints |
|--------|------|------------|
| id | UUID | PK |
| severity | VARCHAR(20) | NOT NULL, CHECK (severity IN ('info', 'warning', 'error', 'critical')) |
| pattern | VARCHAR(100) | NOT NULL |
| summary | TEXT | NOT NULL |
| raw_log | TEXT | |
| detected_at | TIMESTAMP | DEFAULT now() |

**settings (legacy)**
| Column | Type | Constraints |
|--------|------|------------|
| key | VARCHAR(100) | PK |
| value | JSONB | NOT NULL |
| updated_at | TIMESTAMP | DEFAULT now() |
| updated_by | UUID | FK → users.id |

### Indexes

- `sessions(user_id)` — for session lookup/cleanup
- `sessions(expires_at)` — for expired session cleanup
- `audit_logs(created_at)` — for time-range queries
- `audit_logs(user_id, created_at)` — for per-user audit
- `crash_events(detected_at)` — for timeline view
- `crash_events(severity)` — for filtering
- `backup_metadata(created_at)` — for listing

---

## 14. API Design

### Authentication Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/login | None | Login with username/password |
| POST | /api/auth/verify-totp | Partial | Verify TOTP code after password |
| POST | /api/auth/logout | Session | Destroy session |
| GET | /api/auth/me | Session | Get current user info |
| POST | /api/auth/setup-totp | Admin | Generate TOTP secret + QR |
| POST | /api/auth/confirm-totp | Admin | Confirm TOTP setup with code |

### Server Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/server/status | Session | Get server status, PID, uptime |
| POST | /api/server/start | Admin | Start the server |
| POST | /api/server/stop | Admin | Stop the server |
| POST | /api/server/restart | Admin | Restart the server |

### Console Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| WS | /ws/console | Session | Live console log stream + command input |
| GET | /api/console/history | Session | Get recent console output |

### Whitelist Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/whitelist | Session | Get whitelist status and entries |
| POST | /api/whitelist/add | Admin | Add player to whitelist |
| POST | /api/whitelist/remove | Admin | Remove player from whitelist |
| POST | /api/whitelist/toggle | Admin | Enable/disable whitelist |

### Ban Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/bans | Session | Get ban list |
| POST | /api/bans/add | Admin | Add ban |
| POST | /api/bans/remove | Admin | Remove ban |

### Backup Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/backups | Session | List backups |
| POST | /api/backups/create | Admin | Enqueue create backup job (`202`) |
| POST | /api/backups/:id/restore | Admin | Enqueue restore backup job (`202`) |
| DELETE | /api/backups/:id | Admin | Delete backup |
| GET | /api/backups/jobs/:id | Session | Get backup job status |
| GET | /api/backups/jobs | Session | List recent backup jobs |

### System Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/stats/system | Session | CPU, RAM, disk usage |
| GET | /api/stats/process | Session | Hytale process stats |

### Crash History Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/crashes | Session | List crash events |
| GET | /api/crashes/:id | Session | Get crash event detail |

### Audit Log Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/audit-logs | Admin | List audit logs (paginated) |
| GET | /api/audit-logs/export | Admin | Export audit logs as JSON |

### Settings Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/settings | Admin | Deprecated (`410 Gone`) |
| PUT | /api/settings | Admin | Deprecated (`410 Gone`) |

### User Management Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/users | Admin | List users |
| POST | /api/users | Admin | Create user |
| PUT | /api/users/:id | Admin | Update user |
| DELETE | /api/users/:id | Admin | Delete user |

---

## 15. WebSocket Design

### Connection Lifecycle

1. Client initiates WS upgrade to `/ws/console`
2. Server validates session cookie in upgrade handler
3. Server validates Origin header
4. Connection established; server sends `{type: "connected", serverStatus: "..."}`
5. Client sends `{type: "subscribe"}` to start receiving log updates
6. Server polls tmux capture-pane every 500ms, diffs output, sends new lines
7. Client can send `{type: "command", data: "..."}` (admin only)
8. Server validates command, forwards to helper, logs to audit
9. Heartbeat: server sends `{type: "ping"}` every 30s; client responds `{type: "pong"}`
10. Connection closes on session expiry, explicit close, or timeout

### Message Types (Client → Server)

```typescript
type ClientMessage =
  | { type: "subscribe" }
  | { type: "command"; data: string }
  | { type: "pong" }
```

### Message Types (Server → Client)

```typescript
type ServerMessage =
  | { type: "connected"; serverStatus: string }
  | { type: "log"; lines: string[]; timestamp: string }
  | { type: "commandResult"; success: boolean; message: string }
  | { type: "statusChange"; status: string }
  | { type: "ping" }
  | { type: "error"; message: string }
```

---

## 16. Operational Assumptions

1. **Hytale server** is installed at `/opt/hytale` with a `start.sh` script
2. **Ubuntu 22.04+** with systemd, tmux, and journalctl available
3. **Docker and Docker Compose** are installed on the host
4. **Reverse proxy** (nginx/Caddy/Cloudflare Tunnel) handles TLS termination
5. **Single VPS** — no clustering or multi-node needed
6. **Small admin team** — 1-3 users maximum
7. **Hytale server** reads commands from stdin (like most game servers)
8. **Whitelist** is stored in `/opt/hytale/Server/whitelist.json` as `{ "enabled": boolean, "list": string[] }`
9. **Bans** are stored in `/opt/hytale/Server/bans.json` (if exists; graceful fallback)
10. **Backups** are stored in `/opt/hytale-backups/` as tar.gz archives
11. **No RCON** protocol available for Hytale (stdin/stdout via tmux is the approach)
12. **Player count** detection depends on Hytale log format (best-effort parsing)

---

## 17. Implementation Plan & File Structure

### Phase 1: Foundation
1. Project scaffolding (monorepo with packages)
2. Database schema and migrations
3. Helper service with allowlisted operations
4. Authentication system

### Phase 2: Core Features
5. Server control (start/stop/restart/status)
6. Live console (WebSocket + tmux integration)
7. Dashboard with system stats

### Phase 3: Management Features
8. Whitelist management
9. Ban management
10. Backup/restore system
11. Crash detection

### Phase 4: Polish & Security
12. Audit logging
13. Settings page
14. Security hardening (CSP, rate limiting, etc.)
15. Tests
16. Docker Compose + install script
17. Documentation

### File Structure

```
hytale-panel/
├── docker-compose.yml
├── .env.example
├── README.md
├── SECURITY.md
├── LICENSE
├── install.sh                          # Ubuntu setup script
│
├── docs/
│   ├── architecture.md                 # This document
│   ├── threat-model.md
│   └── setup-guide.md
│
├── systemd/
│   ├── hytale-tmux.service             # Game server tmux wrapper
│   ├── hytale-helper.service           # Privileged helper service
│   └── hytale-helper.sudoers           # Legacy reference only; not installed by default
│
├── packages/
│   ├── shared/                         # Shared types and schemas
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── schemas/
│   │       │   ├── auth.ts             # Zod schemas for auth
│   │       │   ├── server.ts           # Zod schemas for server ops
│   │       │   ├── whitelist.ts        # Zod schemas for whitelist
│   │       │   ├── bans.ts             # Zod schemas for bans
│   │       │   ├── backup.ts           # Zod schemas for backups
│   │       │   ├── console.ts          # Zod schemas for console messages
│   │       │   └── settings.ts         # Zod schemas for settings
│   │       ├── types/
│   │       │   ├── api.ts              # API request/response types
│   │       │   ├── ws.ts               # WebSocket message types
│   │       │   ├── helper.ts           # Helper protocol types
│   │       │   └── models.ts           # Domain model types
│   │       └── constants.ts            # Shared constants
│   │
│   ├── helper/                         # Privileged helper service
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts                # Entry point
│   │       ├── server.ts               # Fastify on Unix socket
│   │       ├── auth.ts                 # HMAC validation
│   │       ├── handlers/
│   │       │   ├── server-control.ts   # systemctl operations
│   │       │   ├── console.ts          # tmux send-keys / capture-pane
│   │       │   ├── logs.ts             # journalctl reading
│   │       │   ├── files.ts            # whitelist/ban file ops
│   │       │   ├── backup.ts           # backup create/restore/list
│   │       │   └── stats.ts            # system stats
│   │       ├── utils/
│   │       │   ├── command.ts          # Safe command execution
│   │       │   ├── path-guard.ts       # Path traversal prevention
│   │       │   └── sanitize.ts         # Input sanitization
│   │       └── config.ts              # Helper configuration
│   │
│   ├── api/                            # Fastify backend API
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts                # Entry point
│   │       ├── app.ts                  # Fastify app setup
│   │       ├── config.ts               # Environment config
│   │       ├── db/
│   │       │   ├── index.ts            # Drizzle client
│   │       │   ├── schema.ts           # Drizzle schema definitions
│   │       │   ├── migrate.ts          # Migration runner
│   │       │   └── migrations/         # SQL migration files
│   │       │       └── 0001_initial.sql
│   │       ├── plugins/
│   │       │   ├── auth.ts             # Auth plugin (session validation)
│   │       │   ├── csrf.ts             # CSRF protection plugin
│   │       │   ├── rate-limit.ts       # Rate limiting plugin
│   │       │   ├── security-headers.ts # Security headers plugin
│   │       │   └── websocket.ts        # WebSocket plugin setup
│   │       ├── services/
│   │       │   ├── auth.service.ts     # Auth logic (Argon2, TOTP, sessions)
│   │       │   ├── helper-client.ts    # Client for helper service (Unix socket + HMAC)
│   │       │   ├── server.service.ts   # Server control service
│   │       │   ├── console.service.ts  # Console/log streaming service
│   │       │   ├── whitelist.service.ts# Whitelist management
│   │       │   ├── ban.service.ts      # Ban management
│   │       │   ├── backup.service.ts   # Backup operations called by job worker
│   │       │   ├── backup-job.service.ts # Durable backup/restore job queue + worker
│   │       │   ├── crash.service.ts    # Crash detection/parsing
│   │       │   ├── stats.service.ts    # System stats
│   │       │   ├── audit.service.ts    # Audit logging
│   │       ├── routes/
│   │       │   ├── auth.routes.ts
│   │       │   ├── server.routes.ts
│   │       │   ├── console.routes.ts
│   │       │   ├── whitelist.routes.ts
│   │       │   ├── ban.routes.ts
│   │       │   ├── backup.routes.ts
│   │       │   ├── backup-jobs.routes.ts
│   │       │   ├── crash.routes.ts
│   │       │   ├── stats.routes.ts
│   │       │   ├── audit.routes.ts
│   │       │   ├── settings.routes.ts
│   │       │   └── user.routes.ts
│   │       ├── ws/
│   │       │   └── console.ws.ts       # WebSocket handler for console
│   │       ├── jobs/
│   │       │   ├── crash-detector.ts   # Periodic crash log scanning
│   │       │   ├── session-cleanup.ts  # Expired session cleanup
│   │       ├── middleware/
│   │       │   ├── require-auth.ts     # Authentication guard
│   │       │   └── require-role.ts     # Role-based access guard
│   │       └── utils/
│   │           ├── crypto.ts           # Argon2, HMAC utilities
│   │           ├── log-parser.ts       # Crash pattern matching
│   │           └── sanitize.ts         # Output sanitization
│   │
│   ├── web/                            # Next.js frontend
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── postcss.config.js
│   │   ├── Dockerfile
│   │   ├── components.json             # shadcn/ui config
│   │   ├── public/
│   │   │   └── favicon.ico
│   │   └── src/
│   │       ├── app/
│   │       │   ├── layout.tsx          # Root layout (dark theme)
│   │       │   ├── page.tsx            # Redirect to /dashboard
│   │       │   ├── login/
│   │       │   │   └── page.tsx        # Login page
│   │       │   ├── dashboard/
│   │       │   │   └── page.tsx        # Dashboard
│   │       │   ├── console/
│   │       │   │   └── page.tsx        # Live console
│   │       │   ├── whitelist/
│   │       │   │   └── page.tsx        # Whitelist management
│   │       │   ├── bans/
│   │       │   │   └── page.tsx        # Ban management
│   │       │   ├── backups/
│   │       │   │   └── page.tsx        # Backup management
│   │       │   ├── crashes/
│   │       │   │   └── page.tsx        # Crash history
│   │       │   ├── audit/
│   │       │   │   └── page.tsx        # Audit log
│   │       │   └── settings/
│   │       │       └── page.tsx        # Settings
│   │       ├── components/
│   │       │   ├── ui/                 # shadcn/ui components
│   │       │   ├── layout/
│   │       │   │   ├── sidebar.tsx     # Navigation sidebar
│   │       │   │   ├── header.tsx      # Top header bar
│   │       │   │   └── app-shell.tsx   # Main layout wrapper
│   │       │   ├── dashboard/
│   │       │   │   ├── server-status-card.tsx
│   │       │   │   ├── system-stats-card.tsx
│   │       │   │   ├── server-controls.tsx
│   │       │   │   ├── recent-warnings.tsx
│   │       │   │   └── quick-actions.tsx
│   │       │   ├── console/
│   │       │   │   ├── console-output.tsx
│   │       │   │   ├── command-input.tsx
│   │       │   │   └── command-history.tsx
│   │       │   ├── whitelist/
│   │       │   │   ├── player-list.tsx
│   │       │   │   └── add-player-form.tsx
│   │       │   ├── bans/
│   │       │   │   ├── ban-list.tsx
│   │       │   │   └── add-ban-form.tsx
│   │       │   ├── backups/
│   │       │   │   ├── backup-list.tsx
│   │       │   │   ├── create-backup-dialog.tsx
│   │       │   │   └── restore-backup-dialog.tsx
│   │       │   ├── crashes/
│   │       │   │   ├── crash-timeline.tsx
│   │       │   │   └── crash-detail.tsx
│   │       │   └── shared/
│   │       │       ├── confirm-dialog.tsx
│   │       │       ├── loading-spinner.tsx
│   │       │       ├── error-banner.tsx
│   │       │       └── status-badge.tsx
│   │       ├── hooks/
│   │       │   ├── use-auth.ts
│   │       │   ├── use-websocket.ts
│   │       │   ├── use-server-status.ts
│   │       │   └── use-api.ts
│   │       ├── lib/
│   │       │   ├── api-client.ts       # Fetch wrapper with CSRF
│   │       │   ├── ws-client.ts        # WebSocket client
│   │       │   └── utils.ts            # Utility functions
│   │       └── styles/
│   │           └── globals.css         # Tailwind + custom styles
│   │
│   └── scripts/
│       ├── seed.ts                     # Create first admin user
│       └── generate-helper-secret.ts   # Generate HMAC shared secret
│
├── tests/
│   ├── api/
│   │   ├── auth.test.ts                # Auth flow tests
│   │   ├── server-control.test.ts      # Server control tests
│   │   ├── backup.test.ts              # Backup safety tests
│   │   └── input-validation.test.ts    # Zod validation tests
│   ├── helper/
│   │   ├── hmac-auth.test.ts           # HMAC validation tests
│   │   ├── command-sanitize.test.ts    # Command sanitization tests
│   │   └── path-guard.test.ts          # Path traversal prevention tests
│   └── e2e/
│       └── login.spec.ts              # Playwright login flow test
│
└── nginx/
    └── hytale-panel.conf               # Example nginx reverse proxy config
```

---

## 18. Unclear Aspects & Assumptions

### Uncertain

1. **Hytale console command format** — We assume commands like `whitelist add <player>`, `ban <player>`, `save` work via stdin. If Hytale uses a different command syntax, the command templates in the whitelist/ban services will need updating. The architecture supports this via configuration.

2. **Hytale log format** — Crash pattern detection relies on parsing log output. The exact log format of Hytale is not fully documented. The crash detector uses regex patterns that may need tuning after observing real logs.

3. **Player count detection** — Depends on whether Hytale logs player join/leave events in a parseable format. Implemented as best-effort with a "unknown" fallback.

4. **Ban file location and format** — Assumed to be `/opt/hytale/Server/bans.json`. If Hytale stores bans differently, the ban service will need adjustment.

5. **Whitelist toggle command** — Assumed `whitelist on` / `whitelist off` commands exist. If not, the toggle will edit the config file and require a server restart.

### Assumptions Made

1. The Hytale server binary accepts stdin commands when run interactively (standard for game servers)
2. The server outputs to stdout/stderr which systemd captures to journal
3. Ubuntu 22.04+ with systemd 249+ is the target OS
4. Docker Engine 24+ and Docker Compose v2 are available
5. The admin will set up a reverse proxy (nginx/Caddy) or Cloudflare Tunnel for TLS
6. The `/opt/hytale/start.sh` script exists and launches the Hytale server
7. Maximum 3 concurrent admin users
8. Backup size is manageable (< 10GB per backup for world data)
