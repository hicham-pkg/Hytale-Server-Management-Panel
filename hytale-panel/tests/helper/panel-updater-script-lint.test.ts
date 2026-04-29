import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Static lint over the host-side updater wrapper + runner script.
 *
 * These two files run as root via systemd and sudoers. They are the trust
 * boundary for everything the dashboard's "Update Panel" button does. This
 * test makes load-bearing properties grep-checkable so a future PR can't
 * accidentally weaken them.
 */

const WRAPPER_PATH = path.resolve(__dirname, '../../systemd/hytale-panel-updater-trigger');
const RUNNER_PATH = path.resolve(__dirname, '../../scripts/hytale-panel-updater.sh');
const UNIT_PATH = path.resolve(__dirname, '../../systemd/hytale-panel-updater@.service');
const SUDOERS_PATH = path.resolve(__dirname, '../../systemd/hytale-helper.sudoers');

describe('hytale-panel-updater-trigger (root-owned wrapper)', () => {
  const src = fs.readFileSync(WRAPPER_PATH, 'utf8');

  it('uses set -euo pipefail', () => {
    expect(src).toMatch(/^set -euo pipefail$/m);
  });

  it('validates the job id matches a strict v4 UUID regex before invoking systemctl', () => {
    expect(src).toMatch(/UUID_REGEX=.*\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-4\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}/);
    // The validation must short-circuit BEFORE any exec.
    const uuidIdx = src.indexOf('UUID_REGEX');
    const execIdx = src.indexOf('exec /usr/bin/systemctl');
    expect(uuidIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(uuidIdx);
  });

  it('only invokes systemctl with start / stop / is-active verbs (no wildcard)', () => {
    expect(src).toMatch(/exec \/usr\/bin\/systemctl start --no-block "\$UNIT"/);
    expect(src).toMatch(/exec \/usr\/bin\/systemctl stop "\$UNIT"/);
    expect(src).toMatch(/exec \/usr\/bin\/systemctl is-active --quiet "\$UNIT"/);
    // No exec line that takes the action verb from a variable.
    expect(src).not.toMatch(/exec \/usr\/bin\/systemctl "\$ACTION"/);
  });

  it('rejects unknown actions explicitly', () => {
    expect(src).toMatch(/case "\$ACTION" in/);
    expect(src).toMatch(/\*\)\s*usage/m);
  });

  it('uses the templated unit name format with the validated job id', () => {
    expect(src).toMatch(/UNIT="hytale-panel-updater@\$\{JOB_ID\}\.service"/);
  });
});

describe('hytale-panel-updater (runner script)', () => {
  const src = fs.readFileSync(RUNNER_PATH, 'utf8');

  it('uses set -uo pipefail', () => {
    expect(src).toMatch(/^set -uo pipefail$/m);
  });

  it('validates the job id is UUID v4 before doing anything', () => {
    expect(src).toMatch(/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-4\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}/);
  });

  it('rejects download URLs outside the configured GitHub repo allowlist', () => {
    // Function exists and the case statement enumerates allowed hosts.
    expect(src).toMatch(/validate_download_url\(\)/);
    expect(src).toMatch(/codeload\.github\.com\/\$\{repo\}\//);
    expect(src).not.toMatch(/api\.github\.com\/repos\/\$\{repo\}\//);
  });

  it('uses an exclusive flock-backed lock file and aborts if held', () => {
    expect(src).toMatch(/flock -n 9/);
  });

  it('extracts archives with --no-same-owner --no-same-permissions', () => {
    expect(src).toMatch(/--no-same-owner --no-same-permissions/);
  });

  it('rejects absolute or traversal symlinks before applying', () => {
    expect(src).toMatch(/absolute symlink/);
    expect(src).toMatch(/traversal symlink/);
  });

  it('rejects hardlinks (nlink>1) in the extracted tree', () => {
    expect(src).toMatch(/nlink="\$\(stat -c '%h' "\$f"/);
    expect(src).toMatch(/hardlink in archive/);
  });

  it('walks archive entries BEFORE extraction to reject absolute paths and traversal', () => {
    expect(src).toMatch(/tar -tzvf "\$archive"/);
    expect(src).toMatch(/unzip -Z1 "\$archive"/);
    // The pre-extraction loop must explicitly reject absolute and traversal entries.
    const preExtractIdx = src.indexOf('Pre-extraction entry validation');
    const extractIdx = src.indexOf('extract_dir="${STAGING_DIR}/extracted"');
    expect(preExtractIdx).toBeGreaterThan(-1);
    expect(extractIdx).toBeGreaterThan(preExtractIdx);
  });

  it('does not enable shell trace mode (would leak env / token)', () => {
    expect(src).not.toMatch(/^set\s+-x/m);
    expect(src).not.toMatch(/^set\s+-[a-w]*x[a-w]*/m);
  });

  it('never names sensitive env vars in interpolated shell commands', () => {
    // We never echo or printf the secret env vars. (Sourcing /opt/.../env is
    // OK; what's forbidden is the script writing the values to logs/output.)
    for (const name of [
      'GITHUB_UPDATE_TOKEN',
      'DB_PASSWORD',
      'SESSION_SECRET',
      'CSRF_SECRET',
      'HELPER_HMAC_SECRET',
    ]) {
      expect(src).not.toMatch(new RegExp(`echo[^\\n]*\\$\\{?${name}\\}?`));
      expect(src).not.toMatch(new RegExp(`printf[^\\n]*\\$\\{?${name}\\}?`));
      expect(src).not.toMatch(new RegExp(`tee[^\\n]*\\$\\{?${name}\\}?`));
    }
  });

  it('preserves curl exit status instead of reading the negated ! status', () => {
    expect(src).not.toMatch(/if\s+!\s+curl/);
    expect(src).toMatch(/curl "\$\{curl_args\[@\]\}" >"\$http_code_file" 2>>"\$LOG_FILE"/);
    expect(src).toMatch(/local curl_exit=\$\?/);
    expect(src).toMatch(/format_curl_download_error "\$curl_exit" "\$http_code"/);
    expect(src).not.toMatch(/curl failed \(exit \$\?\)/);
  });

  it('formats curl HTTP failures with the real HTTP status code', () => {
    const output = execFileSync('bash', [
      '-lc',
      `HYTALE_PANEL_UPDATER_LIB_ONLY=1; source ${JSON.stringify(RUNNER_PATH)}; format_curl_download_error 22 415`,
    ], { encoding: 'utf8' });
    expect(output).toBe('Download failed: GitHub returned HTTP 415');
  });

  it('formats non-HTTP curl failures with the real curl exit code', () => {
    const output = execFileSync('bash', [
      '-lc',
      `HYTALE_PANEL_UPDATER_LIB_ONLY=1; source ${JSON.stringify(RUNNER_PATH)}; format_curl_download_error 6 000`,
    ], { encoding: 'utf8' });
    expect(output).toBe('Download failed: curl exit 6');
  });

  it('rejects branch download URLs at the runner-script allowlist layer', () => {
    // The case statement must reject /refs/heads/ paths and /archive/<branch>.
    // We assert the positive matches require /refs/tags/ explicitly.
    expect(src).toMatch(/https:\/\/github\.com\/\$\{repo\}\/archive\/refs\/tags\//);
    expect(src).toMatch(/https:\/\/codeload\.github\.com\/\$\{repo\}\/tar\.gz\/refs\/tags\//);
    // Sanity: no naked /archive/* match.
    expect(src).not.toMatch(/https:\/\/github\.com\/\$\{repo\}\/archive\/\* \) return 0/);
  });

  it('rejects direct opaque GitHub object CDN URLs in V2', () => {
    expect(src).not.toMatch(/objects\.githubusercontent\.com\/\*/);
  });

  it('reports non-archive downloads clearly during validation', () => {
    expect(src).toMatch(/Downloaded response was not a valid archive/);
  });

  it('requires a known set of project files in the staged source', () => {
    for (const required of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'docker-compose.yml',
      'packages',
      'deploy',
      'scripts',
      'systemd',
    ]) {
      expect(src).toContain(`"${required}"`);
    }
  });

  it('preserves .env and helper/.env across apply and rollback', () => {
    // Apply step
    expect(src).toMatch(/--exclude='\.env'/);
    expect(src).toMatch(/--exclude='helper\/\.env'/);
  });

  it('caps download size and uses HTTPS-only download flags', () => {
    expect(src).toMatch(/--max-filesize "\$max_bytes"/);
    // Args live in an array passed to curl — match the array form, not a
    // single shell invocation line.
    expect(src).toMatch(/--silent --show-error --fail --location/);
  });

  it('uses array-form curl args (no shell interpolation of user input)', () => {
    // We pass the URL as the last positional in the args ARRAY, not concatenated.
    expect(src).toMatch(/curl_args\+=\("\$url"\)/);
    expect(src).not.toMatch(/curl .*\$\{url\}.*\$\{token\}/);
  });
});

describe('hytale-panel-updater@.service unit', () => {
  const src = fs.readFileSync(UNIT_PATH, 'utf8');
  it('uses User=root and Type=simple', () => {
    expect(src).toMatch(/^User=root$/m);
    expect(src).toMatch(/^Type=simple$/m);
  });
  it('exec line invokes the validating runner with the templated job id (%i)', () => {
    expect(src).toMatch(/^ExecStart=\/usr\/local\/lib\/hytale-panel\/hytale-panel-updater run %i$/m);
  });
  it('does not auto-restart on crash', () => {
    expect(src).toMatch(/^Restart=no$/m);
  });
});

describe('docker-compose update-jobs mount', () => {
  const compose = fs.readFileSync(
    path.resolve(__dirname, '../../docker-compose.yml'),
    'utf8',
  );

  it('mounts /opt/hytale-panel-data/update-jobs read-only into the API container', () => {
    expect(compose).toMatch(
      /-\s*\/opt\/hytale-panel-data\/update-jobs:\/opt\/hytale-panel-data\/update-jobs:ro/,
    );
    // Negative: must not appear with rw or with no flag (which defaults to rw).
    expect(compose).not.toMatch(
      /-\s*\/opt\/hytale-panel-data\/update-jobs:\/opt\/hytale-panel-data\/update-jobs:rw/,
    );
    expect(compose).not.toMatch(
      /-\s*\/opt\/hytale-panel-data\/update-jobs:\/opt\/hytale-panel-data\/update-jobs(\s|$)/m,
    );
  });

  it('does NOT mount /opt/hytale or /opt/hytale-panel into the API container', () => {
    // The api: service block — these would be a serious privilege regression.
    const apiBlock = compose.split('\n').slice(
      compose.split('\n').findIndex((l) => l.trim().startsWith('api:')),
      compose.split('\n').findIndex((l) => l.trim().startsWith('web:')),
    ).join('\n');
    expect(apiBlock).not.toMatch(/^\s*-\s*\/opt\/hytale:/m);
    expect(apiBlock).not.toMatch(/^\s*-\s*\/opt\/hytale-panel:/m);
  });
});

describe('sudoers entries for the updater wrapper', () => {
  const src = fs.readFileSync(SUDOERS_PATH, 'utf8');

  it('does NOT grant raw `systemctl` start/stop on hytale-panel-updater@*', () => {
    // The hytale-tmux.service sudoers lines are exact-arg, not wildcarded.
    // Specifically, no sudoers line should let helper run /usr/bin/systemctl
    // against the panel-updater unit name (with or without wildcard).
    expect(src).not.toMatch(/\/usr\/bin\/systemctl[^\n]*hytale-panel-updater@/);
  });

  it('does grant the validating wrapper for start/stop/is-active', () => {
    expect(src).toMatch(/hytale-panel-updater-trigger start \*/);
    expect(src).toMatch(/hytale-panel-updater-trigger stop \*/);
    expect(src).toMatch(/hytale-panel-updater-trigger is-active \*/);
  });
});
