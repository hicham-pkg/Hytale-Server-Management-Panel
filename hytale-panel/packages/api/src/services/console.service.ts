import { callHelper } from './helper-client';
import { sanitizeLogLines } from '../utils/sanitize';

export async function sendConsoleCommand(
  command: string
): Promise<{ success: boolean; message: string }> {
  const result = await callHelper('server.sendCommand', { command });
  const data = result.data as { message: string } | undefined;
  return { success: result.success, message: data?.message ?? result.error ?? 'Unknown error' };
}

export async function captureConsoleOutput(
  lines: number = 50
): Promise<{ success: boolean; lines: string[]; error?: string }> {
  const result = await callHelper('console.capturePane', { lines });
  if (!result.success) {
    return { success: false, lines: [], error: result.error };
  }
  const data = result.data as { lines: string[] };
  return { success: true, lines: sanitizeLogLines(data.lines) };
}

export async function readLogs(
  lineCount: number = 100,
  since?: string
): Promise<{ success: boolean; lines: string[]; error?: string }> {
  const params: Record<string, unknown> = { lines: lineCount };
  if (since) params.since = since;

  const result = await callHelper('logs.read', params);
  if (!result.success) {
    return { success: false, lines: [], error: result.error };
  }
  const data = result.data as { lines: string[] };
  return { success: true, lines: sanitizeLogLines(data.lines) };
}