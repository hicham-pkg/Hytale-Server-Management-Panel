'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/api-client';

interface ServerStatus {
  running: boolean;
  pid: number | null;
  uptime: string | null;
  lastRestart: string | null;
  playerCount: number | null;
  serviceName: string;
  error?: string;
}

export function useServerStatus(pollInterval = 10000) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    const res = await apiGet<ServerStatus>('/api/server/status');
    if (res.success && res.data) {
      setStatus(res.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, pollInterval);
    return () => clearInterval(interval);
  }, [fetchStatus, pollInterval]);

  return { status, loading, refetch: fetchStatus };
}