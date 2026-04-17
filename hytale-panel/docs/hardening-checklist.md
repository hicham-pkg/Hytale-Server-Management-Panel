# First-Run Hardening Checklist

Use this before exposing the panel beyond a trusted private network.

## Access Protection

- Keep `postgres`, `api`, and the helper socket private to the VPS.
- Publish only the reverse proxy on `80/443`.
- For first-run private testing, prefer an SSH tunnel to the localhost-bound web port.
- Put the panel behind one of these before wider testing:
  - Cloudflare Access
  - Tailscale / WireGuard / another private network
  - A strict reverse-proxy IP allowlist

## Authentication

- Create the initial admin account from the VPS.
- Complete TOTP enrollment on the first admin login.
- Do not give panel access to anyone who only has a password.
- Use separate readonly accounts for anyone who does not need server-control actions.

## Secrets

Rotate these after the first successful install:
- `SESSION_SECRET`
- `CSRF_SECRET`
- `HELPER_HMAC_SECRET`
- `DB_PASSWORD`

Rotate them again after:
- Restoring from an untrusted backup
- Copying `.env` files through an untrusted channel
- Any suspected compromise of the VPS, helper, or CI artifacts

## Containers and Helper

- Keep the API and web containers non-root.
- Keep the API container joined only to the helper socket group, not broader host groups.
- Keep the helper running via `systemd`, not inside Docker.
- Start `hytale-helper.service` before expecting socket-backed panel actions to work.
- Verify the shipped helper unit is active: `systemctl show -p User,Group,SupplementaryGroups,NoNewPrivileges hytale-helper.service`
- Use `.env` host-port overrides instead of editing Compose directly when the VPS already uses `3000`, `4000`, or `5432`.

## Sessions and Logs

- Expect admin sessions to idle out after `15` minutes.
- Expect readonly sessions to idle out after `60` minutes.
- Expect an absolute `4` hour maximum session lifetime.
- Forward Docker logs, helper journal logs, and exported audit logs to off-box storage if retention matters.

## Backups

- Keep local backups under `/opt/hytale-backups/`.
- Encrypt backups before copying them off the VPS.
- Test one full restore on a non-production world before trusting the workflow.

## Final Pre-Public Checklist

- `sudo systemctl status hytale-helper.service`
- `docker compose ps`
- `docker compose logs --tail=100 api`
- `journalctl -u hytale-helper.service --since "10 min ago"`
- `curl -I https://panel.yourdomain.com`
- `curl -s https://panel.yourdomain.com/api/health`
- Successful admin login with TOTP
- Successful readonly login
- Successful WebSocket console connection from the expected public origin
