import { describe, expect, it } from 'vitest';
import { detectCrashEvents, detectRestartLoop } from '../../packages/api/src/utils/log-parser';

describe('crash log parser rolling windows', () => {
  it('does not report an old restart loop as a fresh warning', () => {
    const now = new Date('2026-03-29T12:00:00');
    const lines = [
      '2026-03-26T10:00:00 Started Hytale',
      '2026-03-26T10:04:00 Started Hytale',
      '2026-03-26T10:08:00 Started Hytale',
    ];

    expect(detectRestartLoop(lines, now)).toBeNull();
  });

  it('reports a recent restart loop inside the rolling window only', () => {
    const now = new Date('2026-03-29T12:10:00');
    const lines = [
      '2026-03-29T12:00:30 Started Hytale',
      '2026-03-29T12:04:00 Started Hytale',
      '2026-03-29T12:09:30 Started Hytale',
    ];

    const event = detectRestartLoop(lines, now);

    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      severity: 'warning',
      pattern: 'restart_loop',
      summary: 'Restart loop detected: 3 restarts within the last 10 minutes',
    });
    expect(event?.rawLog).toContain('Timestamps:');
  });

  it('ignores old error lines when generating new crash events', () => {
    const now = new Date('2026-03-29T12:00:00');
    const lines = [
      '2026-03-27T09:00:00 Exception in worker thread',
      '2026-03-27T09:00:01 java.lang.IllegalStateException: old failure',
    ];

    expect(detectCrashEvents(lines, now)).toEqual([]);
  });

  it('still detects recent multiline exception logs', () => {
    const now = new Date('2026-03-29T12:00:00');
    const lines = [
      '2026-03-29T11:45:00 Exception in worker thread',
      'java.lang.IllegalStateException: recent failure',
      '2026-03-29T11:45:01 Error while loading world chunk',
    ];

    expect(detectCrashEvents(lines, now)).toEqual([
      {
        severity: 'error',
        pattern: 'Exception',
        summary: 'Unhandled exception detected',
        rawLog: '2026-03-29T11:45:00 Exception in worker thread\njava.lang.IllegalStateException: recent failure',
      },
      {
        severity: 'warning',
        pattern: 'Error',
        summary: 'Error message in logs',
        rawLog: '2026-03-29T11:45:01 Error while loading world chunk',
      },
    ]);
  });
});
