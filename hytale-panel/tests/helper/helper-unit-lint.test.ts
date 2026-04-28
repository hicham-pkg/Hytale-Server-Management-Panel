import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Static lint over `systemd/hytale-helper.service`.
 *
 * The helper runs as a non-root user but invokes `sudo` for narrow systemctl
 * and journalctl calls. sudo is a setuid binary and silently fails with
 *   "sudo: The 'no new privileges' flag is set, which prevents sudo from
 *    running as root."
 * whenever the kernel `no_new_privs` (NNP) bit is set on the helper process
 * — which is what breaks the Mods Manager Restart button (and every other
 * sudoer call) when the unit is over-hardened.
 *
 * Per `systemd.exec(5)`, the directives below all carry the documented
 * caveat "If this option is used, NoNewPrivileges=yes is implied". Setting
 * `NoNewPrivileges=no` does NOT override the implication. The process runs
 * with NNP=1 regardless and sudo refuses to escalate.
 *
 * This test fails the build if any forbidden directive reappears in the
 * shipped unit so a well-meaning hardening PR cannot reintroduce the bug.
 */

const UNIT_PATH = path.resolve(__dirname, '../../systemd/hytale-helper.service');

// Directives that systemd documents as implicitly setting NoNewPrivileges=yes.
// Adding any of these will set NoNewPrivs:1 on the running process and break
// the sudoer-mediated systemctl/journalctl path.
const FORBIDDEN_DIRECTIVES = [
  'SystemCallFilter',
  'SystemCallArchitectures',
  'SystemCallLog',
  'RestrictNamespaces',
  'RestrictAddressFamilies',
  'PrivateDevices',
  'ProtectKernelTunables',
  'ProtectKernelModules',
  'ProtectKernelLogs',
  'ProtectClock',
  'ProtectHostname',
  'MemoryDenyWriteExecute',
  'RestrictRealtime',
  'RestrictSUIDSGID',
  'LockPersonality',
  'DynamicUser',
] as const;

function readActiveDirectives(): Map<string, string> {
  const raw = fs.readFileSync(UNIT_PATH, 'utf8');
  const out = new Map<string, string>();
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out.set(key, value);
  }
  return out;
}

describe('hytale-helper.service unit', () => {
  const directives = readActiveDirectives();

  it('runs as the non-root hytale-helper user', () => {
    expect(directives.get('User')).toBe('hytale-helper');
    expect(directives.get('Group')).toBe('hytale-panel');
    expect(directives.get('SupplementaryGroups')).toBe('hytale');
  });

  it('explicitly sets NoNewPrivileges=no so sudo escalation works', () => {
    expect(directives.get('NoNewPrivileges')).toBe('no');
  });

  it.each(FORBIDDEN_DIRECTIVES)(
    'does not set %s (implies NoNewPrivileges=yes and breaks sudo)',
    (directive) => {
      expect(
        directives.has(directive),
        `${directive} would force NoNewPrivs:1 on the running helper, ` +
          `breaking every sudoer-mediated call (Mods Manager Restart, ` +
          `server stop/restart, journalctl wrapper). See the comment block ` +
          `at the top of systemd/hytale-helper.service.`,
      ).toBe(false);
    },
  );

  it('keeps filesystem confinement that does NOT imply NNP', () => {
    expect(directives.get('ProtectSystem')).toBe('strict');
    expect(directives.get('ProtectHome')).toBe('true');
    expect(directives.get('PrivateTmp')).toBe('true');
    const rwp = directives.get('ReadWritePaths') ?? '';
    expect(rwp).toContain('/opt/hytale');
    expect(rwp).toContain('/opt/hytale-backups');
    expect(rwp).toContain('/opt/hytale-panel/run');
    // Mods Manager staging area must be writable for upload→install flow.
    expect(rwp).toContain('/opt/hytale-panel-data/mod-upload-staging');
  });

  it('keeps resource limits', () => {
    expect(directives.get('MemoryMax')).toBe('256M');
    expect(directives.get('LimitNOFILE')).toBe('1024');
  });

  it('inherits no ambient capabilities', () => {
    expect(directives.get('AmbientCapabilities')).toBe('');
  });
});
