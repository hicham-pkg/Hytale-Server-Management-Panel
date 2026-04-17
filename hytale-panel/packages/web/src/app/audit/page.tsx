'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiGet } from '@/lib/api-client';
import { formatDate } from '@/lib/utils';
import { ScrollText, Download } from 'lucide-react';

interface AuditLog {
  id: string;
  userId: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  success: boolean;
  createdAt: string;
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const fetchLogs = async (p: number) => {
    setLoading(true);
    const res = await apiGet<{ logs: AuditLog[]; total: number }>(`/api/audit-logs?page=${p}&limit=50`);
    if (res.success && res.data) {
      setLogs(res.data.logs);
      setTotal(res.data.total);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchLogs(page);
  }, [page]);

  const handleExport = () => {
    window.open('/api/audit-logs/export', '_blank');
  };

  const totalPages = Math.ceil(total / 50);

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Audit Log</h1>
            <p className="text-muted-foreground">All administrative actions ({total} total)</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="mr-1 h-4 w-4" />
            Export JSON
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="h-4 w-4" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No audit logs yet</p>
            ) : (
              <>
                <div className="space-y-2">
                  {logs.map((log) => (
                    <div key={log.id} className="flex items-center justify-between rounded-md border px-4 py-3 text-sm">
                      <div className="flex items-center gap-3">
                        <Badge variant={log.success ? 'success' : 'error'} className="text-xs">
                          {log.success ? 'OK' : 'FAIL'}
                        </Badge>
                        <span className="font-mono">{log.action}</span>
                        {log.target && <span className="text-muted-foreground">→ {log.target}</span>}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        {log.ipAddress && <span>{log.ipAddress}</span>}
                        <span>{formatDate(log.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                {totalPages > 1 && (
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      Previous
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      Page {page} of {totalPages}
                    </span>
                    <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}