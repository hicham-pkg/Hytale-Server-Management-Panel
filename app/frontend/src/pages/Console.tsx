import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { createConsoleWs } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { Terminal, Send, Trash2, Wifi, WifiOff, AlertTriangle } from 'lucide-react';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default function ConsolePage() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();

  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [connected, setConnected] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  const scrollToBottom = useCallback(() => {
    if (autoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [lines, scrollToBottom]);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        ws = createConsoleWs();
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          ws.send(JSON.stringify({ type: 'subscribe' }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
              case 'log':
                if (msg.lines?.length) {
                  setLines((prev) => [...prev.slice(-2000), ...msg.lines]);
                }
                break;
              case 'commandResult':
                if (!msg.success) {
                  toast({
                    title: 'Command Error',
                    description: msg.message,
                    variant: 'destructive',
                  });
                }
                break;
              case 'error':
                toast({
                  title: 'WebSocket Error',
                  description: msg.message,
                  variant: 'destructive',
                });
                break;
              case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
            }
          } catch {
            // Ignore malformed messages
          }
        };

        ws.onclose = () => {
          setConnected(false);
          wsRef.current = null;
          reconnectTimer = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
          setConnected(false);
        };
      } catch {
        reconnectTimer = setTimeout(connect, 3000);
      }
    };

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [toast]);

  const sendCommand = () => {
    if (!command.trim() || !wsRef.current || !isAdmin) return;

    wsRef.current.send(
      JSON.stringify({ type: 'command', data: command.trim() })
    );

    setCommandHistory((prev) => [command.trim(), ...prev.slice(0, 49)]);
    setHistoryIdx(-1);
    setCommand('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      sendCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIdx = Math.min(historyIdx + 1, commandHistory.length - 1);
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

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    autoScroll.current = atBottom;
  };

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Terminal className="h-6 w-6 text-indigo-400" />
          Live Console
        </h1>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              connected
                ? 'border-green-500/30 text-green-400'
                : 'border-red-500/30 text-red-400'
            }
          >
            {connected ? (
              <Wifi className="h-3 w-3 mr-1" />
            ) : (
              <WifiOff className="h-3 w-3 mr-1" />
            )}
            {connected ? 'Connected' : 'Disconnected'}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLines([])}
            className="text-slate-400 hover:text-white"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Clear
          </Button>
        </div>
      </div>

      {/* Warning banner */}
      <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-500/10 px-3 py-2 rounded-md">
        <AlertTriangle className="h-3 w-3 flex-shrink-0" />
        <span>
          This console sends commands directly to the game server via tmux. No shell access is provided.
          {!isAdmin && ' You have read-only access.'}
        </span>
      </div>

      {/* Console Output */}
      <Card className="bg-[#0d1117] border-[#2a2a3e] flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-5 text-green-300/90"
        >
          {lines.length === 0 ? (
            <p className="text-slate-600 italic">Waiting for console output...</p>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className="whitespace-pre-wrap break-all hover:bg-white/5"
                dangerouslySetInnerHTML={{ __html: escapeHtml(line) }}
              />
            ))
          )}
        </div>

        {/* Command Input */}
        {isAdmin && (
          <div className="border-t border-[#2a2a3e] p-3 flex gap-2">
            <div className="flex items-center text-slate-500 text-sm font-mono mr-1">
              &gt;
            </div>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a game command..."
              disabled={!connected}
              className="bg-transparent border-none text-green-300 font-mono text-sm placeholder:text-slate-600 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Button
              size="sm"
              onClick={sendCommand}
              disabled={!connected || !command.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Send className="h-3 w-3" />
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}