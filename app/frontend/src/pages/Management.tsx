import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { whitelist, bans, backups, crashes, auditLogs, settings, users } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Shield,
  Ban,
  Archive,
  AlertTriangle,
  ClipboardList,
  Settings,
  Plus,
  Trash2,
  RotateCcw,
  Download,
  Loader2,
  RefreshCw,
  Eye,
  UserPlus,
} from 'lucide-react';

// ─── Whitelist Tab ───
function WhitelistTab() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState<{ enabled: boolean; entries: { name: string }[] } | null>(null);
  const [newPlayer, setNewPlayer] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetch_ = useCallback(async () => {
    const res = await whitelist.list();
    if (res.data) setData(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);

  const addPlayer = async () => {
    if (!newPlayer.trim()) return;
    setActionLoading(true);
    const res = await whitelist.add(newPlayer.trim());
    toast({ title: res.success ? 'Added' : 'Error', description: res.data?.message || res.error, variant: res.success ? 'default' : 'destructive' });
    setNewPlayer('');
    setActionLoading(false);
    fetch_();
  };

  const removePlayer = async (name: string) => {
    const res = await whitelist.remove(name);
    toast({ title: res.success ? 'Removed' : 'Error', description: res.data?.message || res.error, variant: res.success ? 'default' : 'destructive' });
    fetch_();
  };

  const toggleEnabled = async (enabled: boolean) => {
    const res = await whitelist.toggle(enabled);
    toast({ title: res.success ? 'Updated' : 'Error', description: res.data?.message || res.error, variant: res.success ? 'default' : 'destructive' });
    fetch_();
  };

  if (loading) return <Loader2 className="h-6 w-6 animate-spin text-indigo-400 mx-auto mt-8" />;

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Label className="text-slate-300">Whitelist Enabled</Label>
            <Switch checked={data?.enabled ?? false} onCheckedChange={toggleEnabled} />
          </div>
          <div className="flex gap-2">
            <Input value={newPlayer} onChange={(e) => setNewPlayer(e.target.value)} placeholder="Player name" className="w-40 bg-[#0a0a0f] border-[#2a2a3e] text-white text-sm" onKeyDown={(e) => e.key === 'Enter' && addPlayer()} />
            <Button size="sm" onClick={addPlayer} disabled={actionLoading || !newPlayer.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {actionLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
              Add
            </Button>
          </div>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="border-[#2a2a3e] hover:bg-transparent">
            <TableHead className="text-slate-400">Player</TableHead>
            {isAdmin && <TableHead className="text-slate-400 w-20">Action</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data?.entries.length === 0 && (
            <TableRow className="border-[#2a2a3e]"><TableCell colSpan={2} className="text-center text-slate-500 py-8">No players whitelisted</TableCell></TableRow>
          )}
          {data?.entries.map((e) => (
            <TableRow key={e.name} className="border-[#2a2a3e] hover:bg-[#1a1a2e]">
              <TableCell className="text-white font-mono text-sm">{e.name}</TableCell>
              {isAdmin && (
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => removePlayer(e.name)} className="text-red-400 hover:text-red-300 hover:bg-red-500/10 h-7 w-7">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Bans Tab ───
function BansTab() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState<{ entries: { name: string; reason?: string }[] } | null>(null);
  const [newName, setNewName] = useState('');
  const [newReason, setNewReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetch_ = useCallback(async () => {
    const res = await bans.list();
    if (res.data) setData(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);

  const addBan = async () => {
    if (!newName.trim()) return;
    setActionLoading(true);
    const res = await bans.add(newName.trim(), newReason.trim() || undefined);
    toast({ title: res.success ? 'Banned' : 'Error', description: res.data?.message || res.error, variant: res.success ? 'default' : 'destructive' });
    setNewName(''); setNewReason('');
    setActionLoading(false);
    fetch_();
  };

  const removeBan = async (name: string) => {
    const res = await bans.remove(name);
    toast({ title: res.success ? 'Unbanned' : 'Error', description: res.data?.message || res.error, variant: res.success ? 'default' : 'destructive' });
    fetch_();
  };

  if (loading) return <Loader2 className="h-6 w-6 animate-spin text-indigo-400 mx-auto mt-8" />;

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex gap-2 flex-wrap">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Player name" className="w-36 bg-[#0a0a0f] border-[#2a2a3e] text-white text-sm" />
          <Input value={newReason} onChange={(e) => setNewReason(e.target.value)} placeholder="Reason (optional)" className="w-48 bg-[#0a0a0f] border-[#2a2a3e] text-white text-sm" />
          <Button size="sm" onClick={addBan} disabled={actionLoading || !newName.trim()} className="bg-red-600 hover:bg-red-700 text-white">
            {actionLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3 mr-1" />}
            Ban
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="border-[#2a2a3e] hover:bg-transparent">
            <TableHead className="text-slate-400">Player</TableHead>
            <TableHead className="text-slate-400">Reason</TableHead>
            {isAdmin && <TableHead className="text-slate-400 w-20">Action</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data?.entries.length === 0 && (
            <TableRow className="border-[#2a2a3e]"><TableCell colSpan={3} className="text-center text-slate-500 py-8">No bans</TableCell></TableRow>
          )}
          {data?.entries.map((e) => (
            <TableRow key={e.name} className="border-[#2a2a3e] hover:bg-[#1a1a2e]">
              <TableCell className="text-white font-mono text-sm">{e.name}</TableCell>
              <TableCell className="text-slate-400 text-sm">{e.reason || '—'}</TableCell>
              {isAdmin && (
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => removeBan(e.name)} className="text-green-400 hover:text-green-300 hover:bg-green-500/10 h-7 w-7">
                    <RotateCcw className="h-3 w-3" />
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Backups Tab ───
function BackupsTab() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState<{ id: string; filename: string; label: string | null; sizeBytes: number; sha256: string; createdAt: string }[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    const res = await backups.list();
    if (res.data) setData(res.data.backups);
    setLoading(false);
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);

  const createBackup = async () => {
    setActionLoading('create');
    const res = await backups.create(newLabel.trim() || undefined);
    toast({ title: res.success ? 'Backup Created' : 'Error', description: res.success ? `Created ${res.data?.backup?.filename}` : res.error, variant: res.success ? 'default' : 'destructive' });
    setNewLabel('');
    setActionLoading(null);
    fetch_();
  };

  const restoreBackup = async (id: string) => {
    setActionLoading(`restore-${id}`);
    const res = await backups.restore(id);
    toast({ title: res.success ? 'Restored' : 'Error', description: res.data?.message || res.error, variant: res.success ? 'default' : 'destructive' });
    setActionLoading(null);
    fetch_();
  };

  const deleteBackup = async (id: string) => {
    setActionLoading(`delete-${id}`);
    const res = await backups.delete(id);
    toast({ title: res.success ? 'Deleted' : 'Error', variant: res.success ? 'default' : 'destructive' });
    setActionLoading(null);
    fetch_();
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  if (loading) return <Loader2 className="h-6 w-6 animate-spin text-indigo-400 mx-auto mt-8" />;

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex gap-2">
          <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Backup label (optional)" className="w-56 bg-[#0a0a0f] border-[#2a2a3e] text-white text-sm" />
          <Button size="sm" onClick={createBackup} disabled={actionLoading === 'create'} className="bg-indigo-600 hover:bg-indigo-700 text-white">
            {actionLoading === 'create' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Archive className="h-3 w-3 mr-1" />}
            Create Backup
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="border-[#2a2a3e] hover:bg-transparent">
            <TableHead className="text-slate-400">Filename</TableHead>
            <TableHead className="text-slate-400">Label</TableHead>
            <TableHead className="text-slate-400">Size</TableHead>
            <TableHead className="text-slate-400">Created</TableHead>
            {isAdmin && <TableHead className="text-slate-400 w-32">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 && (
            <TableRow className="border-[#2a2a3e]"><TableCell colSpan={5} className="text-center text-slate-500 py-8">No backups</TableCell></TableRow>
          )}
          {data.map((b) => (
            <TableRow key={b.id} className="border-[#2a2a3e] hover:bg-[#1a1a2e]">
              <TableCell className="text-white font-mono text-xs">{b.filename}</TableCell>
              <TableCell className="text-slate-400 text-sm">{b.label || '—'}</TableCell>
              <TableCell className="text-slate-400 text-sm">{formatSize(b.sizeBytes)}</TableCell>
              <TableCell className="text-slate-400 text-sm">{new Date(b.createdAt).toLocaleString()}</TableCell>
              {isAdmin && (
                <TableCell className="flex gap-1">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 h-7 w-7" disabled={!!actionLoading}>
                        {actionLoading === `restore-${b.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="bg-[#12121a] border-[#2a2a3e]">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-white flex items-center gap-2">
                          <AlertTriangle className="h-5 w-5 text-amber-400" />
                          Restore Backup?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-slate-400">
                          This will restore <strong className="text-white">{b.filename}</strong>. The server must be stopped. A safety snapshot will be created before restoring. This action cannot be easily undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="bg-[#1a1a2e] border-[#2a2a3e] text-slate-300">Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => restoreBackup(b.id)} className="bg-amber-600 hover:bg-amber-700 text-white">Restore</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-red-400 hover:text-red-300 hover:bg-red-500/10 h-7 w-7" disabled={!!actionLoading}>
                        {actionLoading === `delete-${b.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="bg-[#12121a] border-[#2a2a3e]">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-white">Delete Backup?</AlertDialogTitle>
                        <AlertDialogDescription className="text-slate-400">
                          Permanently delete <strong className="text-white">{b.filename}</strong>? This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="bg-[#1a1a2e] border-[#2a2a3e] text-slate-300">Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => deleteBackup(b.id)} className="bg-red-600 hover:bg-red-700 text-white">Delete</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Crashes Tab ───
function CrashesTab() {
  const [data, setData] = useState<{ id: string; severity: string; summary: string; rawLog: string | null; detectedAt: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedRaw, setSelectedRaw] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    const res = await crashes.list(page, 20);
    if (res.data) { setData(res.data.events); setTotal(res.data.total); }
    setLoading(false);
  }, [page]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const severityColor = (s: string) => {
    switch (s) {
      case 'critical': return 'bg-red-500/15 text-red-400 border-red-500/30';
      case 'error': return 'bg-orange-500/15 text-orange-400 border-orange-500/30';
      case 'warning': return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
      default: return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    }
  };

  if (loading) return <Loader2 className="h-6 w-6 animate-spin text-indigo-400 mx-auto mt-8" />;

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow className="border-[#2a2a3e] hover:bg-transparent">
            <TableHead className="text-slate-400 w-24">Severity</TableHead>
            <TableHead className="text-slate-400">Summary</TableHead>
            <TableHead className="text-slate-400 w-44">Detected</TableHead>
            <TableHead className="text-slate-400 w-16">Log</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 && (
            <TableRow className="border-[#2a2a3e]"><TableCell colSpan={4} className="text-center text-slate-500 py-8">No crash events</TableCell></TableRow>
          )}
          {data.map((e) => (
            <TableRow key={e.id} className="border-[#2a2a3e] hover:bg-[#1a1a2e]">
              <TableCell><Badge variant="outline" className={severityColor(e.severity)}>{e.severity}</Badge></TableCell>
              <TableCell className="text-white text-sm">{e.summary}</TableCell>
              <TableCell className="text-slate-400 text-sm">{new Date(e.detectedAt).toLocaleString()}</TableCell>
              <TableCell>
                {e.rawLog && (
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-slate-400 hover:text-white h-7 w-7" onClick={() => setSelectedRaw(e.rawLog)}>
                        <Eye className="h-3 w-3" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="bg-[#12121a] border-[#2a2a3e] max-w-2xl max-h-[80vh]">
                      <DialogHeader>
                        <DialogTitle className="text-white">Raw Log</DialogTitle>
                      </DialogHeader>
                      <ScrollArea className="max-h-[60vh]">
                        <pre className="text-xs text-green-300/80 font-mono whitespace-pre-wrap p-4 bg-[#0d1117] rounded">{selectedRaw}</pre>
                      </ScrollArea>
                    </DialogContent>
                  </Dialog>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {total > 20 && (
        <div className="flex justify-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)} className="border-[#2a2a3e] text-slate-300">Previous</Button>
          <span className="text-sm text-slate-400 flex items-center px-2">Page {page} of {Math.ceil(total / 20)}</span>
          <Button size="sm" variant="outline" disabled={page >= Math.ceil(total / 20)} onClick={() => setPage(page + 1)} className="border-[#2a2a3e] text-slate-300">Next</Button>
        </div>
      )}
    </div>
  );
}

// ─── Audit Log Tab ───
function AuditTab() {
  const [data, setData] = useState<{ id: string; action: string; target: string | null; ipAddress: string | null; success: boolean; createdAt: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    const res = await auditLogs.list({ page, limit: 30, action: actionFilter || undefined });
    if (res.data) { setData(res.data.logs); setTotal(res.data.total); }
    setLoading(false);
  }, [page, actionFilter]);

  useEffect(() => { fetch_(); }, [fetch_]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <Input value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1); }} placeholder="Filter by action..." className="w-48 bg-[#0a0a0f] border-[#2a2a3e] text-white text-sm" />
        <a href={auditLogs.exportUrl} target="_blank" rel="noopener noreferrer">
          <Button size="sm" variant="outline" className="border-[#2a2a3e] text-slate-300">
            <Download className="h-3 w-3 mr-1" />Export
          </Button>
        </a>
      </div>
      {loading ? <Loader2 className="h-6 w-6 animate-spin text-indigo-400 mx-auto mt-8" /> : (
        <Table>
          <TableHeader>
            <TableRow className="border-[#2a2a3e] hover:bg-transparent">
              <TableHead className="text-slate-400">Action</TableHead>
              <TableHead className="text-slate-400">Target</TableHead>
              <TableHead className="text-slate-400 w-20">Status</TableHead>
              <TableHead className="text-slate-400">IP</TableHead>
              <TableHead className="text-slate-400 w-44">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 && (
              <TableRow className="border-[#2a2a3e]"><TableCell colSpan={5} className="text-center text-slate-500 py-8">No audit logs</TableCell></TableRow>
            )}
            {data.map((l) => (
              <TableRow key={l.id} className="border-[#2a2a3e] hover:bg-[#1a1a2e]">
                <TableCell className="text-white font-mono text-xs">{l.action}</TableCell>
                <TableCell className="text-slate-400 text-sm truncate max-w-[200px]">{l.target || '—'}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={l.success ? 'border-green-500/30 text-green-400' : 'border-red-500/30 text-red-400'}>
                    {l.success ? 'OK' : 'FAIL'}
                  </Badge>
                </TableCell>
                <TableCell className="text-slate-500 font-mono text-xs">{l.ipAddress || '—'}</TableCell>
                <TableCell className="text-slate-400 text-sm">{new Date(l.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {total > 30 && (
        <div className="flex justify-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)} className="border-[#2a2a3e] text-slate-300">Previous</Button>
          <span className="text-sm text-slate-400 flex items-center px-2">Page {page} of {Math.ceil(total / 30)}</span>
          <Button size="sm" variant="outline" disabled={page >= Math.ceil(total / 30)} onClick={() => setPage(page + 1)} className="border-[#2a2a3e] text-slate-300">Next</Button>
        </div>
      )}
    </div>
  );
}

// ─── Settings Tab ───
function SettingsTab() {
  const { toast } = useToast();
  const [data, setData] = useState<Record<string, unknown>>({});
  const [userList, setUserList] = useState<{ id: string; username: string; role: string; totpEnabled: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('readonly');
  const [createLoading, setCreateLoading] = useState(false);

  const fetch_ = useCallback(async () => {
    const [settingsRes, usersRes] = await Promise.all([settings.get(), users.list()]);
    if (settingsRes.data) setData(settingsRes.data);
    if (usersRes.data) setUserList(usersRes.data.users);
    setLoading(false);
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);

  const saveSettings = async () => {
    setSaving(true);
    const res = await settings.update(data);
    toast({ title: res.success ? 'Saved' : 'Error', description: res.success ? 'Settings updated' : res.error, variant: res.success ? 'default' : 'destructive' });
    setSaving(false);
  };

  const createUser = async () => {
    if (!newUsername.trim() || !newPassword.trim()) return;
    setCreateLoading(true);
    const res = await users.create(newUsername.trim(), newPassword, newRole);
    toast({ title: res.success ? 'User Created' : 'Error', description: res.success ? `Created ${newUsername}` : res.error, variant: res.success ? 'default' : 'destructive' });
    setNewUsername(''); setNewPassword(''); setNewRole('readonly');
    setCreateLoading(false);
    fetch_();
  };

  const deleteUser = async (id: string) => {
    const res = await users.delete(id);
    toast({ title: res.success ? 'Deleted' : 'Error', description: res.error, variant: res.success ? 'default' : 'destructive' });
    fetch_();
  };

  if (loading) return <Loader2 className="h-6 w-6 animate-spin text-indigo-400 mx-auto mt-8" />;

  return (
    <div className="space-y-6">
      {/* User Management */}
      <Card className="bg-[#0e0e16] border-[#2a2a3e]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base">User Management</CardTitle>
          <CardDescription className="text-slate-500">Manage panel users and roles</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="Username" className="w-36 bg-[#0a0a0f] border-[#2a2a3e] text-white text-sm" />
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Password" className="w-36 bg-[#0a0a0f] border-[#2a2a3e] text-white text-sm" />
            <Select value={newRole} onValueChange={setNewRole}>
              <SelectTrigger className="w-28 bg-[#0a0a0f] border-[#2a2a3e] text-white text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#12121a] border-[#2a2a3e]">
                <SelectItem value="admin" className="text-white">Admin</SelectItem>
                <SelectItem value="readonly" className="text-white">Readonly</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={createUser} disabled={createLoading || !newUsername.trim() || !newPassword.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {createLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <UserPlus className="h-3 w-3 mr-1" />}
              Create
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="border-[#2a2a3e] hover:bg-transparent">
                <TableHead className="text-slate-400">Username</TableHead>
                <TableHead className="text-slate-400">Role</TableHead>
                <TableHead className="text-slate-400">2FA</TableHead>
                <TableHead className="text-slate-400 w-20">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {userList.map((u) => (
                <TableRow key={u.id} className="border-[#2a2a3e] hover:bg-[#1a1a2e]">
                  <TableCell className="text-white text-sm">{u.username}</TableCell>
                  <TableCell><Badge variant="outline" className={u.role === 'admin' ? 'border-indigo-500/50 text-indigo-400' : 'border-slate-600 text-slate-400'}>{u.role}</Badge></TableCell>
                  <TableCell><Badge variant="outline" className={u.totpEnabled ? 'border-green-500/30 text-green-400' : 'border-slate-700 text-slate-500'}>{u.totpEnabled ? 'Enabled' : 'Off'}</Badge></TableCell>
                  <TableCell>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-red-400 hover:text-red-300 hover:bg-red-500/10 h-7 w-7">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="bg-[#12121a] border-[#2a2a3e]">
                        <AlertDialogHeader>
                          <AlertDialogTitle className="text-white">Delete User?</AlertDialogTitle>
                          <AlertDialogDescription className="text-slate-400">Permanently delete <strong className="text-white">{u.username}</strong>?</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="bg-[#1a1a2e] border-[#2a2a3e] text-slate-300">Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteUser(u.id)} className="bg-red-600 hover:bg-red-700 text-white">Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Exported Page Components ───
export { WhitelistTab, BansTab, BackupsTab, CrashesTab, AuditTab, SettingsTab };