'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SeverityBadge } from '@/components/shared/status-badge';
import { apiGet, apiPost } from '@/lib/api-client';
import { formatDate } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';

interface CrashEvent {
  id: string;
  severity: string;
  pattern: string;
  summary: string;
  rawLog: string | null;
  detectedAt: string;
  status: 'active' | 'historical' | 'archived';
  archivedAt: string | null;
  archivedBy: string | null;
}

export default function CrashesPage() {
  const { user } = useAuth();
  const [events, setEvents] = useState<CrashEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadEvents = async () => {
    setLoading(true);
    const res = await apiGet<{ events: CrashEvent[]; total: number }>('/api/crashes?limit=100&status=all');
    if (res.success && res.data) {
      setEvents(res.data.events);
      setLoadError(null);
    } else {
      setEvents([]);
      setLoadError(res.error ?? 'Failed to load crash events');
    }
    setLoading(false);
  };

  useEffect(() => {
    void loadEvents();
  }, []);

  const isAdmin = user?.role === 'admin';
  const historicalCount = events.filter((event) => event.status === 'historical').length;

  const archiveEvent = async (eventId: string) => {
    setActionLoading(eventId);
    setActionMessage(null);
    try {
      const result = await apiPost<{ archived: boolean; alreadyArchived: boolean }>(`/api/crashes/${eventId}/archive`, {});
      setActionMessage(
        result.success
          ? result.data?.alreadyArchived
            ? 'Event was already archived.'
            : 'Event archived.'
          : result.error ?? 'Failed to archive event.'
      );
      if (result.success) {
        await loadEvents();
      }
    } finally {
      setActionLoading(null);
    }
  };

  const archiveHistorical = async () => {
    setActionLoading('archive-historical');
    setActionMessage(null);
    try {
      const result = await apiPost<{ archivedCount: number }>('/api/crashes/archive-historical', {});
      setActionMessage(
        result.success
          ? result.data?.archivedCount
            ? `Archived ${result.data.archivedCount} historical event${result.data.archivedCount === 1 ? '' : 's'}.`
            : 'No historical events needed archiving.'
          : result.error ?? 'Failed to archive historical events.'
      );
      if (result.success) {
        await loadEvents();
      }
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusVariant = (status: CrashEvent['status']) => {
    if (status === 'active') return 'warning';
    if (status === 'historical') return 'secondary';
    return 'outline';
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Crash History</h1>
          <p className="text-muted-foreground">Detected issues, historical incidents, and archived events</p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4" />
                  Events ({events.length})
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Active events affect current health. Older events are kept as historical records until you archive them.
                </p>
              </div>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionLoading !== null || historicalCount === 0}
                  onClick={() => void archiveHistorical()}
                >
                  Archive Historical
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {actionMessage && (
              <div className="mb-4 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                {actionMessage}
              </div>
            )}
            {loadError && (
              <div className="mb-4 rounded-md border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
                {loadError}
              </div>
            )}
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : loadError ? (
              <p className="text-sm text-muted-foreground">Crash history is unavailable right now.</p>
            ) : events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No crash events detected. The server is running smoothly.</p>
            ) : (
              <div className="space-y-2">
                {events.map((event) => (
                  <div
                    key={event.id}
                    className="rounded-md border p-4 cursor-pointer hover:bg-accent/50 transition-colors"
                    onClick={() => setExpandedId(expandedId === event.id ? null : event.id)}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <SeverityBadge severity={event.severity} />
                        <Badge variant={getStatusVariant(event.status)}>{event.status}</Badge>
                        <span className="text-sm font-medium">{event.summary}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{formatDate(event.detectedAt)}</span>
                        {isAdmin && event.status !== 'archived' && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={actionLoading !== null}
                            onClick={(clickEvent) => {
                              clickEvent.preventDefault();
                              clickEvent.stopPropagation();
                              void archiveEvent(event.id);
                            }}
                          >
                            Archive
                          </Button>
                        )}
                      </div>
                    </div>
                    {event.status === 'historical' && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Historical incident. It is kept for reference but should not be treated as current health.
                      </p>
                    )}
                    {event.status === 'archived' && event.archivedAt && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Archived on {formatDate(event.archivedAt)}.
                      </p>
                    )}
                    {expandedId === event.id && event.rawLog && (
                      <pre className="mt-3 rounded bg-black/50 p-3 text-xs text-gray-400 overflow-x-auto whitespace-pre-wrap">
                        {event.rawLog}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
