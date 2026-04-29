import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DASHBOARD_PATH = path.resolve(__dirname, '../../packages/web/src/app/dashboard/page.tsx');

describe('dashboard updater UI copy and theme', () => {
  const src = fs.readFileSync(DASHBOARD_PATH, 'utf8');

  it('uses concise update copy without the old maintainer-warning paragraph', () => {
    expect(src).toContain('Update available: {updateStatus.latestVersion}');
    expect(src).toContain('This will update the panel, rebuild API/Web, and restart the panel helper.');
    expect(src).toContain('Your Hytale game server is not restarted by panel updates.');
    expect(src).toContain('Downloaded from the configured GitHub Release. SHA256 asset pinning is not enabled yet.');
    expect(src).not.toContain('verify the maintainer');
    expect(src).not.toContain('you trust controls');
  });

  it('keeps update progress and failure panels on the dark dashboard theme', () => {
    expect(src).toContain('bg-slate-950/50');
    expect(src).toContain('border-slate-700');
    expect(src).toContain('bg-slate-950/60');
    expect(src).toContain('border-red-900/60');
    expect(src).not.toContain('border-slate-200 bg-slate-50');
    expect(src).not.toContain('border-amber-200 bg-amber-50');
  });

  it('clears stale updater logs when the latest job changes or disappears', () => {
    expect(src).toContain('const updateJobIdRef = useRef<string | null>(null);');
    expect(src).toContain('if (updateJobIdRef.current !== nextJobId)');
    expect(src).toContain("setUpdateLogs('');");
    expect(src).toContain('setUpdateJob(null);');
  });

  it('fetches terminal job logs and shows an unavailable state on log fetch failure', () => {
    expect(src).toContain('Fetch log tail for running and terminal jobs');
    expect(src).toContain('setUpdateLogsUnavailable(true);');
    expect(src).toContain('Update logs unavailable.');
  });
});
