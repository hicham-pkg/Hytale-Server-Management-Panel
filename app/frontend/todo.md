# Hytale Server Panel - Frontend Development Plan

## Design Guidelines

### Design References
- Dark admin panel inspired by Vercel Dashboard, Grafana, Portainer
- Style: Dark Mode + Terminal Aesthetic + Modern Admin

### Color Palette
- Background: #0a0a0f (Deep dark)
- Surface: #12121a (Cards/panels)
- Surface Hover: #1a1a2e
- Border: #2a2a3e
- Primary: #6366f1 (Indigo - actions)
- Success: #22c55e (Green - running/online)
- Danger: #ef4444 (Red - destructive)
- Warning: #f59e0b (Amber - warnings)
- Text Primary: #f1f5f9
- Text Secondary: #94a3b8
- Console BG: #0d1117

### Typography
- Font: Inter (system fallback)
- Headings: font-semibold
- Body: font-normal text-sm
- Console: JetBrains Mono / monospace

### Key Component Styles
- Cards: bg-[#12121a] border border-[#2a2a3e] rounded-lg
- Buttons: rounded-md with loading spinners
- Console: monospace font, dark terminal background
- Status badges: colored dots with text

## Files to Create (8 file limit)

1. **src/lib/api.ts** - API client with all endpoint methods, CSRF handling, auth
2. **src/lib/auth-context.tsx** - Auth context provider, user state, role checks
3. **src/components/layout.tsx** - App shell with sidebar navigation, mobile responsive
4. **src/pages/Login.tsx** - Login page with TOTP step
5. **src/pages/Dashboard.tsx** - Server status, system stats, quick actions
6. **src/pages/Console.tsx** - WebSocket live console with command input
7. **src/pages/Management.tsx** - Whitelist, Bans, Backups, Crashes, Audit, Settings (tabbed)
8. **src/App.tsx** - Router setup with auth guards

## API Endpoints to Connect

### Auth
- POST /api/auth/login
- POST /api/auth/verify-totp
- POST /api/auth/logout
- GET /api/auth/me
- POST /api/auth/setup-totp
- POST /api/auth/confirm-totp

### Server
- GET /api/server/status
- POST /api/server/start
- POST /api/server/stop
- POST /api/server/restart

### Console
- GET /api/console/history?lines=N
- GET /api/console/logs?lines=N&since=
- WS /ws/console

### Whitelist
- GET /api/whitelist
- POST /api/whitelist/add
- POST /api/whitelist/remove
- POST /api/whitelist/toggle

### Bans
- GET /api/bans
- POST /api/bans/add
- POST /api/bans/remove

### Backups
- GET /api/backups
- POST /api/backups/create
- POST /api/backups/:id/restore
- DELETE /api/backups/:id

### Crashes
- GET /api/crashes?page=&limit=
- GET /api/crashes/:id

### Audit
- GET /api/audit-logs?page=&limit=&userId=&action=&since=&until=
- GET /api/audit-logs/export

### Stats
- GET /api/stats/system
- GET /api/stats/process

### Settings
- GET /api/settings
- PUT /api/settings

### Users
- GET /api/users
- POST /api/users
- PUT /api/users/:id
- DELETE /api/users/:id