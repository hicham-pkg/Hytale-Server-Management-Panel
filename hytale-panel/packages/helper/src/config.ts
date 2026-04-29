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
  modsPath: AbsolutePathSchema.default('/opt/hytale/mods'),
  disabledModsPath: AbsolutePathSchema.default('/opt/hytale/mods-disabled'),
  modUploadStagingPath: AbsolutePathSchema.default('/opt/hytale-panel-data/mod-upload-staging'),
  modBackupPath: AbsolutePathSchema.default('/opt/hytale/mod-backups'),
  modBackupRetention: z.coerce.number().int().min(1).max(100).default(10),
  serviceName: ServiceNameSchema.default('hytale-tmux.service'),
  tmuxSession: TmuxSessionSchema.default('hytale'),
  tmuxSocketPath: SocketPathSchema.default('/opt/hytale/run/hytale.tmux.sock'),
  whitelistPath: JsonFilePathSchema.default('/opt/hytale/Server/whitelist.json'),
  bansPath: JsonFilePathSchema.default('/opt/hytale/Server/bans.json'),
  hytaleSaveRoot: AbsolutePathSchema.optional(),
  worldsPath: AbsolutePathSchema.default('/opt/hytale/Server/worlds'),
  // Panel updater (V2). Defaults match install.sh / docker-compose.yml.
  panelUpdateJobsDir: AbsolutePathSchema.default('/opt/hytale-panel-data/update-jobs'),
  panelUpdateBackupRoot: AbsolutePathSchema.default('/opt/hytale-panel-backups'),
  panelUpdateRepo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .default('hicham-pkg/Hytale-Server-Management-Panel'),
  // Master kill switch. true (default) = admin can click "Update Panel"
  // manually. false = button hidden/disabled and panelUpdate.start RPCs are
  // rejected. There is no scheduled / unattended auto-install path —
  // installs are admin-click-driven only.
  panelUpdateInstallEnabled: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'true')
    .default('true'),
  panelUpdateMaxDownloadMb: z.coerce.number().int().min(1).max(2048).default(300),
  panelUpdateBackupRetention: z.coerce.number().int().min(2).max(50).default(5),
  githubUpdateToken: z.string().min(1).optional(),
});

export type HelperConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): HelperConfig {
  return ConfigSchema.parse({
    socketPath: process.env.HELPER_SOCKET_PATH,
    hmacSecret: process.env.HELPER_HMAC_SECRET,
    hytaleRoot: process.env.HYTALE_ROOT,
    backupPath: process.env.BACKUP_PATH,
    modsPath: process.env.MODS_PATH,
    disabledModsPath: process.env.DISABLED_MODS_PATH,
    modUploadStagingPath: process.env.MOD_UPLOAD_STAGING_PATH,
    modBackupPath: process.env.MOD_BACKUP_PATH,
    modBackupRetention: process.env.MOD_BACKUP_RETENTION,
    serviceName: process.env.HYTALE_SERVICE_NAME,
    tmuxSession: process.env.TMUX_SESSION,
    tmuxSocketPath: process.env.TMUX_SOCKET_PATH,
    whitelistPath: process.env.WHITELIST_PATH,
    bansPath: process.env.BANS_PATH,
    hytaleSaveRoot: process.env.HYTALE_SAVE_ROOT || process.env.HYTALE_UNIVERSE_DIR,
    worldsPath: process.env.WORLDS_PATH,
    panelUpdateJobsDir: process.env.PANEL_UPDATE_JOBS_DIR,
    panelUpdateBackupRoot: process.env.PANEL_UPDATE_BACKUP_ROOT,
    panelUpdateRepo: process.env.PANEL_UPDATE_REPO,
    panelUpdateInstallEnabled: process.env.PANEL_UPDATE_INSTALL_ENABLED,
    panelUpdateMaxDownloadMb: process.env.PANEL_UPDATE_MAX_DOWNLOAD_MB,
    panelUpdateBackupRetention: process.env.PANEL_UPDATE_BACKUP_RETENTION,
    githubUpdateToken: process.env.GITHUB_UPDATE_TOKEN || undefined,
  });
}
