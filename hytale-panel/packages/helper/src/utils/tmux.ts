import type { HelperConfig } from '../config';
import { safeExec } from './command';

export function buildTmuxArgs(config: HelperConfig, args: string[]): string[] {
  return ['-S', config.tmuxSocketPath, ...args];
}

export function tmuxExec(config: HelperConfig, args: string[]) {
  return safeExec('/usr/bin/tmux', buildTmuxArgs(config, args));
}
