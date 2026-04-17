# Hytale Panel — File Structure

```
hytale-panel/
├── docker-compose.yml                  # Panel services (API, Web, PostgreSQL)
├── .env.example                        # Environment variable template
├── README.md                           # Setup instructions
├── SECURITY.md                         # Security notes & threat model
├── LICENSE
├── install.sh                          # Ubuntu setup script
│
├── docs/
│   ├── architecture.md                 # Full architecture document
│   ├── system_design.md                # System design summary
│   ├── file_tree.md                    # This file
│   ├── architect.plantuml              # Component architecture diagram
│   ├── class_diagram.plantuml          # Class & interface diagram
│   ├── sequence_diagram.plantuml       # Key sequence diagrams
│   ├── er_diagram.plantuml             # Database ER diagram
│   └── ui_navigation.plantuml          # UI navigation state machine
│
├── systemd/
│   ├── hytale-tmux.service             # Game server tmux wrapper unit
│   ├── hytale-helper.service           # Privileged helper service unit (root, local-only socket)
│   └── hytale-helper.sudoers           # Legacy reference only; not installed by default
│
├── packages/
│   ├── shared/                         # Shared types, schemas, constants
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                # Re-exports
│   │       ├── constants.ts            # Shared constants (limits, patterns)
│   │       ├── schemas/
│   │       │   ├── auth.ts             # Login, TOTP, session schemas
│   │       │   ├── server.ts           # Server status, control schemas
│   │       │   ├── whitelist.ts        # Whitelist entry schemas
│   │       │   ├── bans.ts             # Ban entry schemas
│   │       │   ├── backup.ts           # Backup metadata schemas
│   │       │   ├── console.ts          # WS message schemas
│   │       │   └── settings.ts         # Settings schemas
│   │       └── types/
│   │           ├── api.ts              # API request/response types
│   │           ├── ws.ts               # WebSocket message types
│   │           ├── helper.ts           # Helper protocol types
│   │           └── models.ts           # Domain model types
│   │
│   ├── helper/                         # Privileged helper service (runs on host)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                # Entry point
│   │       ├── server.ts               # Fastify on Unix socket
│   │       ├── auth.ts                 # HMAC request validation
│   │       ├── config.ts               # Helper configuration
│   │       ├── handlers/
│   │       │   ├── server-control.ts   # systemctl start/stop/restart/status
│   │       │   ├── console.ts          # tmux send-keys / capture-pane
│   │       │   ├── logs.ts             # journalctl log reading
│   │       │   ├── files.ts            # whitelist.json / bans.json I/O
│   │       │   ├── backup.ts           # tar create/restore/list/delete
│   │       │   └── stats.ts            # CPU/RAM/disk via /proc and df
│   │       └── utils/
│   │           ├── command.ts          # Safe child_process.execFile wrapper
│   │           ├── path-guard.ts       # Path traversal prevention
│   │           └── sanitize.ts         # Input sanitization utilities
│   │
│   ├── api/                            # Fastify backend API (Docker container)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts                # Entry point
│   │       ├── app.ts                  # Fastify app setup & plugin registration
│   │       ├── config.ts               # Environment config with Zod validation
│   │       ├── db/
│   │       │   ├── index.ts            # Drizzle client initialization
│   │       │   ├── schema.ts           # Drizzle table definitions
│   │       │   ├── migrate.ts          # Migration runner
│   │       │   └── migrations/
│   │       │       └── 0001_initial.sql # Initial schema migration
│   │       ├── plugins/
│   │       │   ├── auth.ts             # Session validation plugin
│   │       │   ├── csrf.ts             # CSRF protection plugin
│   │       │   ├── rate-limit.ts       # Rate limiting configuration
│   │       │   ├── security-headers.ts # CSP, HSTS, X-Frame-Options, etc.
│   │       │   └── websocket.ts        # WebSocket plugin setup
│   │       ├── services/
│   │       │   ├── auth.service.ts     # Login, TOTP, sessions, lockout
│   │       │   ├── helper-client.ts    # Unix socket client with HMAC signing
│   │       │   ├── server.service.ts   # Server start/stop/restart/status
│   │       │   ├── console.service.ts  # Console streaming & command sending
│   │       │   ├── whitelist.service.ts# Whitelist CRUD
│   │       │   ├── ban.service.ts      # Ban CRUD
│   │       │   ├── backup.service.ts   # Backup create/list/restore/delete
│   │       │   ├── crash.service.ts    # Crash pattern detection
│   │       │   ├── stats.service.ts    # System & process stats
│   │       │   ├── audit.service.ts    # Audit log recording & querying
│   │       │   └── settings.service.ts # Settings CRUD
│   │       ├── routes/
│   │       │   ├── auth.routes.ts      # /api/auth/*
│   │       │   ├── server.routes.ts    # /api/server/*
│   │       │   ├── console.routes.ts   # /api/console/*
│   │       │   ├── whitelist.routes.ts # /api/whitelist/*
│   │       │   ├── ban.routes.ts       # /api/bans/*
│   │       │   ├── backup.routes.ts    # /api/backups/*
│   │       │   ├── crash.routes.ts     # /api/crashes/*
│   │       │   ├── stats.routes.ts     # /api/stats/*
│   │       │   ├── audit.routes.ts     # /api/audit-logs/*
│   │       │   ├── settings.routes.ts  # /api/settings/*
│   │       │   └── user.routes.ts      # /api/users/*
│   │       ├── ws/
│   │       │   ├── console.ws.ts       # WebSocket handler: live console
│   │       │   └── logs.ws.ts          # WebSocket handler: log streaming
│   │       ├── jobs/
│   │       │   ├── crash-detector.ts   # Periodic crash log scanning (node-cron)
│   │       │   ├── session-cleanup.ts  # Expired session cleanup (node-cron)
│   │       ├── middleware/
│   │       │   ├── require-auth.ts     # Authentication guard preHandler
│   │       │   └── require-role.ts     # Role-based access guard preHandler
│   │       └── utils/
│   │           ├── crypto.ts           # Argon2, HMAC, random token utilities
│   │           ├── log-parser.ts       # Crash pattern regex matching
│   │           └── sanitize.ts         # HTML escape, ANSI strip for output
│   │
│   ├── web/                            # Next.js frontend (Docker container)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── postcss.config.js
│   │   ├── Dockerfile
│   │   ├── components.json            # shadcn/ui configuration
│   │   ├── public/
│   │   │   └── favicon.ico
│   │   └── src/
│   │       ├── app/
│   │       │   ├── layout.tsx          # Root layout (dark theme, font)
│   │       │   ├── page.tsx            # Redirect to /dashboard
│   │       │   ├── login/
│   │       │   │   └── page.tsx        # Login page
│   │       │   ├── dashboard/
│   │       │   │   └── page.tsx        # Dashboard page
│   │       │   ├── console/
│   │       │   │   └── page.tsx        # Live console page
│   │       │   ├── whitelist/
│   │       │   │   └── page.tsx        # Whitelist management page
│   │       │   ├── bans/
│   │       │   │   └── page.tsx        # Ban management page
│   │       │   ├── backups/
│   │       │   │   └── page.tsx        # Backup management page
│   │       │   ├── crashes/
│   │       │   │   └── page.tsx        # Crash history page
│   │       │   ├── audit/
│   │       │   │   └── page.tsx        # Audit log page
│   │       │   └── settings/
│   │       │       └── page.tsx        # Settings page
│   │       ├── components/
│   │       │   ├── ui/                 # shadcn/ui base components
│   │       │   │   ├── button.tsx
│   │       │   │   ├── card.tsx
│   │       │   │   ├── dialog.tsx
│   │       │   │   ├── input.tsx
│   │       │   │   ├── badge.tsx
│   │       │   │   ├── table.tsx
│   │       │   │   ├── toast.tsx
│   │       │   │   ├── dropdown-menu.tsx
│   │       │   │   ├── alert.tsx
│   │       │   │   └── ...             # Other shadcn/ui components as needed
│   │       │   ├── layout/
│   │       │   │   ├── sidebar.tsx     # Navigation sidebar
│   │       │   │   ├── header.tsx      # Top header with user menu
│   │       │   │   └── app-shell.tsx   # Main layout wrapper (sidebar + content)
│   │       │   ├── dashboard/
│   │       │   │   ├── server-status-card.tsx
│   │       │   │   ├── system-stats-card.tsx
│   │       │   │   ├── server-controls.tsx
│   │       │   │   ├── recent-warnings.tsx
│   │       │   │   └── quick-actions.tsx
│   │       │   ├── console/
│   │       │   │   ├── console-output.tsx   # Scrolling log display
│   │       │   │   ├── command-input.tsx     # Command input with send
│   │       │   │   └── command-history.tsx   # Previous commands dropdown
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
│   │       │       ├── confirm-dialog.tsx    # Reusable confirmation modal
│   │       │       ├── loading-spinner.tsx
│   │       │       ├── error-banner.tsx
│   │       │       └── status-badge.tsx      # Online/offline/warning badge
│   │       ├── hooks/
│   │       │   ├── use-auth.ts         # Auth state & login/logout
│   │       │   ├── use-websocket.ts    # WebSocket connection management
│   │       │   ├── use-server-status.ts # Polling server status
│   │       │   └── use-api.ts          # Fetch wrapper hook
│   │       ├── lib/
│   │       │   ├── api-client.ts       # Fetch wrapper with CSRF token
│   │       │   ├── ws-client.ts        # WebSocket client class
│   │       │   └── utils.ts            # Formatting, date, etc.
│   │       └── styles/
│   │           └── globals.css         # Tailwind imports + custom styles
│   │
│   └── scripts/
│       ├── seed.ts                     # Create first admin user interactively
│       └── generate-helper-secret.ts   # Generate HMAC shared secret
│
├── tests/
│   ├── api/
│   │   ├── auth.test.ts                # Auth flow: login, lockout, 2FA
│   │   ├── server-control.test.ts      # Server control with mocked helper
│   │   ├── backup.test.ts              # Backup safety: running server rejection
│   │   └── input-validation.test.ts    # Zod schema validation edge cases
│   ├── helper/
│   │   ├── hmac-auth.test.ts           # HMAC signature validation
│   │   ├── command-sanitize.test.ts    # Console command sanitization
│   │   └── path-guard.test.ts          # Path traversal prevention
│   └── e2e/
│       └── login.spec.ts              # Playwright login flow test
│
└── nginx/
    └── hytale-panel.conf               # Example nginx reverse proxy config
```
