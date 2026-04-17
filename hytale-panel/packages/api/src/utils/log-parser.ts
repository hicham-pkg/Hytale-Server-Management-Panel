import { CRASH_PATTERNS, type Severity } from '@hytale-panel/shared';

export interface DetectedEvent {
  severity: Severity;
  pattern: string;
  summary: string;
  rawLog: string;
}

const SHORT_ISO_TIMESTAMP_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;
const RECENT_CRASH_LOOKBACK_MS = 60 * 60 * 1000;
const RESTART_LOOP_WINDOW_MS = 10 * 60 * 1000;

interface TimestampedLogLine {
  line: string;
  timestamp: Date | null;
}

function timestampLogLines(logLines: string[]): TimestampedLogLine[] {
  let currentTimestamp: Date | null = null;

  return logLines.map((line) => {
    const match = line.match(SHORT_ISO_TIMESTAMP_REGEX);
    if (match) {
      const parsed = new Date(match[1]);
      if (!Number.isNaN(parsed.getTime())) {
        currentTimestamp = parsed;
      }
    }

    return {
      line,
      timestamp: currentTimestamp,
    };
  });
}

function filterRecentLogLines(logLines: string[], now: Date, lookbackMs: number): TimestampedLogLine[] {
  const cutoff = now.getTime() - lookbackMs;

  return timestampLogLines(logLines).filter(
    (entry) => entry.timestamp !== null && entry.timestamp.getTime() >= cutoff
  );
}

/**
 * Parse log lines for crash/error patterns.
 */
export function detectCrashEvents(logLines: string[], now = new Date()): DetectedEvent[] {
  const events: DetectedEvent[] = [];
  const recentLines = filterRecentLogLines(logLines, now, RECENT_CRASH_LOOKBACK_MS).map((entry) => entry.line);
  const fullText = recentLines.join('\n');

  for (const { pattern, severity, summary } of CRASH_PATTERNS) {
    const lowerText = fullText.toLowerCase();
    const lowerPattern = pattern.toLowerCase();

    if (lowerText.includes(lowerPattern)) {
      // Find the relevant log lines
      const relevantLines = recentLines.filter((line) =>
        line.toLowerCase().includes(lowerPattern)
      );

      events.push({
        severity,
        pattern,
        summary,
        rawLog: relevantLines.slice(0, 10).join('\n'),
      });
    }
  }

  return events;
}

/**
 * Detect restart loops: more than 3 service starts in 10 minutes.
 */
export function detectRestartLoop(logLines: string[], now = new Date()): DetectedEvent | null {
  const startPattern = /Started Hytale|hytale-tmux\.service.*start/i;
  const timestamps = filterRecentLogLines(logLines, now, RECENT_CRASH_LOOKBACK_MS)
    .filter((entry) => startPattern.test(entry.line) && entry.timestamp !== null)
    .map((entry) => entry.timestamp as Date);

  if (timestamps.length < 3) return null;

  // Check if 3+ starts within the recent rolling 10-minute window.
  for (let start = 0; start < timestamps.length; start++) {
    let end = start;
    while (
      end + 1 < timestamps.length &&
      timestamps[end + 1].getTime() - timestamps[start].getTime() <= RESTART_LOOP_WINDOW_MS
    ) {
      end += 1;
    }

    const restartCount = end - start + 1;
    if (restartCount >= 3) {
      const triggeringWindow = timestamps.slice(start, end + 1);
      return {
        severity: 'warning',
        pattern: 'restart_loop',
        summary: `Restart loop detected: ${restartCount} restarts within the last 10 minutes`,
        rawLog: `Timestamps: ${triggeringWindow.map((t) => t.toISOString()).join(', ')}`,
      };
    }
  }

  return null;
}
