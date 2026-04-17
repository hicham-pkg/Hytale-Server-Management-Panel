export type ServerWsMessage =
  | { type: 'connected'; serverStatus: string }
  | { type: 'log'; lines: string[]; timestamp: string }
  | { type: 'commandResult'; success: boolean; message: string }
  | { type: 'statusChange'; status: string }
  | { type: 'ping' }
  | { type: 'error'; message: string };