import { z } from 'zod';

const AbsolutePathSchema = z.string().startsWith('/').max(500);
const SocketPathSchema = AbsolutePathSchema.refine((value) => value.endsWith('.sock'), {
  message: 'Expected a Unix socket path ending in .sock',
});
const JsonFilePathSchema = AbsolutePathSchema.refine((value) => value.endsWith('.json'), {
  message: 'Expected a JSON file path',
});
const ServiceNameSchema = z.string().regex(/^[A-Za-z0-9_.@-]+\.service$/);
const TmuxSessionSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

const ConfigSchema = z.object({
  socketPath: SocketPathSchema.default('/opt/hytale-panel/run/hytale-helper.sock'),
  hmacSecret: z.string().min(32),
  hytaleRoot: AbsolutePathSchema.default('/opt/hytale'),
  backupPath: AbsolutePathSchema.default('/opt/hytale-backups'),
  serviceName: ServiceNameSchema.default('hytale-tmux.service'),
  tmuxSession: TmuxSessionSchema.default('hytale'),
  tmuxSocketPath: SocketPathSchema.default('/opt/hytale/run/hytale.tmux.sock'),
  whitelistPath: JsonFilePathSchema.default('/opt/hytale/Server/whitelist.json'),
  bansPath: JsonFilePathSchema.default('/opt/hytale/Server/bans.json'),
  worldsPath: AbsolutePathSchema.default('/opt/hytale/Server/worlds'),
});

export type HelperConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): HelperConfig {
  return ConfigSchema.parse({
    socketPath: process.env.HELPER_SOCKET_PATH,
    hmacSecret: process.env.HELPER_HMAC_SECRET,
    hytaleRoot: process.env.HYTALE_ROOT,
    backupPath: process.env.BACKUP_PATH,
    serviceName: process.env.HYTALE_SERVICE_NAME,
    tmuxSession: process.env.TMUX_SESSION,
    tmuxSocketPath: process.env.TMUX_SOCKET_PATH,
    whitelistPath: process.env.WHITELIST_PATH,
    bansPath: process.env.BANS_PATH,
    worldsPath: process.env.WORLDS_PATH,
  });
}
