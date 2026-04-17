'use client';

import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/shared/status-badge';
import { useServerStatus } from '@/hooks/use-server-status';
import { useAuth } from '@/hooks/use-auth';
import { WsClient } from '@/lib/ws-client';
import { Send } from 'lucide-react';

export default function ConsolePage() {
  const { user } = useAuth();
  const { status } = useServerStatus(5000);
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [connected, setConnected] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const outputRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const ws = new WsClient('/ws/console');

    ws.on('open', () => setConnected(true));
    ws.on('close', () => setConnected(false));
    ws.on('log', (msg: { lines: string[] }) => {
      setLines((prev) => {
        const next = [...prev, ...msg.lines];
        return next.slice(-500); // Keep last 500 lines
      });
    });
    ws.on('commandResult', (msg: { success: boolean; message: string }) => {
      setLines((prev) => [...prev, `> ${msg.message}`]);
    });
    ws.on('error', (msg: { message?: string }) => {
      if (msg.message) setLines((prev) => [...prev, `[ERROR] ${msg.message}`]);
    });

    ws.connect();
    wsRef.current = ws;

    return () => {
      ws.disconnect();
    };
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const handleSend = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!command.trim() || !wsRef.current) return;

      wsRef.current.send({ type: 'command', data: command.trim() });
      setCommandHistory((prev) => [command.trim(), ...prev.slice(0, 49)]);
      setHistoryIdx(-1);
      setCommand('');
    },
    [command]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIdx < commandHistory.length - 1) {
        const newIdx = historyIdx + 1;
        setHistoryIdx(newIdx);
        setCommand(commandHistory[newIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx > 0) {
        const newIdx = historyIdx - 1;
        setHistoryIdx(newIdx);
        setCommand(commandHistory[newIdx]);
      } else {
        setHistoryIdx(-1);
        setCommand('');
      }
    }
  };

  const isAdmin = user?.role === 'admin';

  return (
    <AppShell>
      <div className="flex h-full flex-col space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Live Console</h1>
            <p className="text-muted-foreground">View server output and send commands</p>
          </div>
          <div className="flex items-center gap-3">
            {status && <StatusBadge running={status.running} />}
            <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
            <span className="text-xs text-muted-foreground">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>

        <Card className="flex flex-1 flex-col overflow-hidden">
          <CardContent className="flex flex-1 flex-col p-0">
            <div
              ref={outputRef}
              className="console-output flex-1 overflow-y-auto bg-black/50 p-4"
              style={{ minHeight: '400px', maxHeight: 'calc(100vh - 300px)' }}
            >
              {lines.length === 0 ? (
                <p className="text-muted-foreground">Waiting for console output...</p>
              ) : (
                lines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all text-gray-300">
                    {line}
                  </div>
                ))
              )}
            </div>

            {isAdmin && (
              <form onSubmit={handleSend} className="flex border-t p-3 gap-2">
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a command..."
                  className="font-mono text-sm"
                  disabled={!connected}
                />
                <Button type="submit" size="icon" disabled={!connected || !command.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}