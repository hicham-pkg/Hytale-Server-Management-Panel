import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const wrapperPath = new URL('../../systemd/hytale-helper-journalctl', import.meta.url).pathname;

function runWrapper(args: string[]) {
  return execFileSync('/usr/bin/env', ['bash', wrapperPath, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

describe('hytale-helper-journalctl wrapper', () => {
  it('rejects arbitrary journalctl flags before execing journalctl', () => {
    expect(() =>
      runWrapper([
        '-u',
        'hytale-tmux.service',
        '--no-pager',
        '-o',
        'short-iso',
        '-n',
        '50',
        '--file',
        '/var/log/journal/system.journal',
      ])
    ).toThrow();
  });

  it('rejects non-panel units', () => {
    expect(() =>
      runWrapper([
        '-u',
        'ssh.service',
        '--no-pager',
        '-o',
        'short-iso',
        '-n',
        '50',
      ])
    ).toThrow();
  });

  it('rejects non-ISO since values', () => {
    expect(() =>
      runWrapper([
        '-u',
        'hytale-tmux.service',
        '--no-pager',
        '-o',
        'short-iso',
        '-n',
        '50',
        '--since',
        '--directory=/var/log/journal',
      ])
    ).toThrow();
  });
});
