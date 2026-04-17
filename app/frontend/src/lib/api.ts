const API_BASE = import.meta.env.VITE_API_URL || '';

let csrfToken: string | null = null;

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data?: T; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method || '')) {
    headers['x-csrf-token'] = csrfToken;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
    csrfToken = null;
    if (!path.includes('/auth/login') && !path.includes('/auth/me')) {
      window.location.href = '/login';
    }
    return { success: false, error: 'Unauthorized' };
  }

  const json = await res.json();
  return json;
}

function get<T>(path: string) {
  return request<T>(path, { method: 'GET' });
}

function post<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

function put<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  });
}

function del<T>(path: string) {
  return request<T>(path, { method: 'DELETE' });
}

// ─── Auth ───
export const auth = {
  login: (username: string, password: string) =>
    post<{ requires2fa: boolean; user?: { id: string; username: string; role: string }; csrfToken?: string }>(
      '/api/auth/login',
      { username, password }
    ).then((r) => {
      if (r.data?.csrfToken) csrfToken = r.data.csrfToken;
      return r;
    }),

  verifyTotp: (code: string) =>
    post<{ user: { id: string; username: string; role: string }; csrfToken: string }>(
      '/api/auth/verify-totp',
      { code }
    ).then((r) => {
      if (r.data?.csrfToken) csrfToken = r.data.csrfToken;
      return r;
    }),

  logout: () => post('/api/auth/logout').then((r) => { csrfToken = null; return r; }),

  me: () =>
    get<{ user: { id: string; username: string; role: string; totpEnabled: boolean }; csrfToken: string }>(
      '/api/auth/me'
    ).then((r) => {
      if (r.data?.csrfToken) csrfToken = r.data.csrfToken;
      return r;
    }),

  setupTotp: () => post<{ secret: string; qrDataUrl: string }>('/api/auth/setup-totp'),
  confirmTotp: (code: string) => post('/api/auth/confirm-totp', { code }),
};

// ─── Server ───
export const server = {
  status: () =>
    get<{
      running: boolean;
      pid: number | null;
      uptime: string | null;
      lastRestart: string | null;
      playerCount: number | null;
      serviceName: string;
      error?: string;
    }>('/api/server/status'),

  start: () => post<{ message: string }>('/api/server/start'),
  stop: () => post<{ message: string }>('/api/server/stop'),
  restart: () => post<{ message: string }>('/api/server/restart'),
};

// ─── Stats ───
export const stats = {
  system: () =>
    get<{
      cpuUsagePercent: number;
      memoryUsedMb: number;
      memoryTotalMb: number;
      memoryUsagePercent: number;
      diskUsedGb: number;
      diskTotalGb: number;
      diskUsagePercent: number;
    }>('/api/stats/system'),

  process: () =>
    get<{
      pid: number | null;
      cpuPercent: number | null;
      memoryMb: number | null;
      uptime: string | null;
    }>('/api/stats/process'),
};

// ─── Console ───
export const console_ = {
  history: (lines = 50) => get<{ lines: string[] }>(`/api/console/history?lines=${lines}`),
  logs: (lines = 100, since?: string) =>
    get<{ lines: string[] }>(`/api/console/logs?lines=${lines}${since ? `&since=${since}` : ''}`),
};

// ─── Whitelist ───
export const whitelist = {
  list: () => get<{ enabled: boolean; entries: { name: string; addedAt?: string }[] }>('/api/whitelist'),
  add: (name: string) => post<{ message: string }>('/api/whitelist/add', { name }),
  remove: (name: string) => post<{ message: string }>('/api/whitelist/remove', { name }),
  toggle: (enabled: boolean) => post<{ message: string }>('/api/whitelist/toggle', { enabled }),
};

// ─── Bans ───
export const bans = {
  list: () => get<{ entries: { name: string; reason?: string; bannedAt?: string }[] }>('/api/bans'),
  add: (name: string, reason?: string) => post<{ message: string }>('/api/bans/add', { name, reason }),
  remove: (name: string) => post<{ message: string }>('/api/bans/remove', { name }),
};

// ─── Backups ───
export const backups = {
  list: () =>
    get<{
      backups: {
        id: string;
        filename: string;
        label: string | null;
        sizeBytes: number;
        sha256: string;
        createdBy: string | null;
        createdAt: string;
      }[];
    }>('/api/backups'),

  create: (label?: string) => post<{ backup: { id: string; filename: string; sha256: string } }>('/api/backups/create', { label }),
  restore: (id: string) => post<{ message: string; safetyBackup?: string }>(`/api/backups/${id}/restore`),
  delete: (id: string) => del(`/api/backups/${id}`),
};

// ─── Crashes ───
export const crashes = {
  list: (page = 1, limit = 50) =>
    get<{
      events: {
        id: string;
        severity: string;
        pattern: string;
        summary: string;
        rawLog: string | null;
        detectedAt: string;
      }[];
      total: number;
    }>(`/api/crashes?page=${page}&limit=${limit}`),

  get: (id: string) =>
    get<{
      id: string;
      severity: string;
      pattern: string;
      summary: string;
      rawLog: string | null;
      detectedAt: string;
    }>(`/api/crashes/${id}`),
};

// ─── Audit Logs ───
export const auditLogs = {
  list: (params: { page?: number; limit?: number; action?: string; since?: string; until?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    if (params.action) q.set('action', params.action);
    if (params.since) q.set('since', params.since);
    if (params.until) q.set('until', params.until);
    return get<{
      logs: {
        id: string;
        userId: string | null;
        action: string;
        target: string | null;
        details: Record<string, unknown> | null;
        ipAddress: string | null;
        success: boolean;
        createdAt: string;
      }[];
      total: number;
    }>(`/api/audit-logs?${q.toString()}`);
  },
  exportUrl: `${API_BASE}/api/audit-logs/export`,
};

// ─── Settings ───
export const settings = {
  get: () => get<Record<string, unknown>>('/api/settings'),
  update: (data: Record<string, unknown>) => put('/api/settings', data),
};

// ─── Users ───
export const users = {
  list: () =>
    get<{
      users: {
        id: string;
        username: string;
        role: string;
        totpEnabled: boolean;
        createdAt: string;
        updatedAt: string;
      }[];
    }>('/api/users'),

  create: (username: string, password: string, role: string) =>
    post<{ user: { id: string; username: string; role: string } }>('/api/users', { username, password, role }),

  update: (id: string, data: { role?: string; password?: string }) => put(`/api/users/${id}`, data),
  delete: (id: string) => del(`/api/users/${id}`),
};

// ─── WebSocket ───
export function createConsoleWs(): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = API_BASE ? new URL(API_BASE).host : window.location.host;
  return new WebSocket(`${proto}//${host}/ws/console`);
}