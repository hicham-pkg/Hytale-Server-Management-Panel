import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import {
  LayoutDashboard,
  Terminal,
  Shield,
  Ban,
  Archive,
  AlertTriangle,
  ClipboardList,
  Settings,
  LogOut,
  Menu,
  Server,
} from 'lucide-react';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/console', label: 'Console', icon: Terminal },
  { path: '/whitelist', label: 'Whitelist', icon: Shield },
  { path: '/bans', label: 'Bans', icon: Ban },
  { path: '/backups', label: 'Backups', icon: Archive },
  { path: '/crashes', label: 'Crashes', icon: AlertTriangle },
  { path: '/audit', label: 'Audit Log', icon: ClipboardList, adminOnly: true },
  { path: '/settings', label: 'Settings', icon: Settings, adminOnly: true },
];

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const { user, isAdmin, logout } = useAuth();

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-4 border-b border-[#2a2a3e]">
        <div className="flex items-center gap-2">
          <Server className="h-6 w-6 text-indigo-400" />
          <span className="font-bold text-lg text-white">Hytale Panel</span>
        </div>
      </div>

      {/* Nav Items */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems
          .filter((item) => !item.adminOnly || isAdmin)
          .map((item) => {
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={onNavigate}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${
                  active
                    ? 'bg-indigo-500/15 text-indigo-400 font-medium'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#1a1a2e]'
                }`}
              >
                <item.icon className="h-4 w-4 flex-shrink-0" />
                {item.label}
              </Link>
            );
          })}
      </nav>

      {/* User */}
      <div className="p-4 border-t border-[#2a2a3e]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-8 w-8 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
              <span className="text-indigo-400 text-xs font-bold">
                {user?.username?.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm text-white truncate">{user?.username}</p>
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 ${
                  isAdmin ? 'border-indigo-500/50 text-indigo-400' : 'border-slate-600 text-slate-400'
                }`}
              >
                {user?.role}
              </Badge>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={logout}
            className="text-slate-400 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-screen bg-[#0a0a0f] text-slate-200">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-60 flex-col border-r border-[#2a2a3e] bg-[#0e0e16]">
        <NavContent />
      </aside>

      {/* Mobile Header + Sheet */}
      <div className="flex flex-col flex-1 min-w-0">
        <header className="md:hidden flex items-center justify-between p-3 border-b border-[#2a2a3e] bg-[#0e0e16]">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-indigo-400" />
            <span className="font-bold text-white">Hytale Panel</span>
          </div>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="text-slate-400">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-60 p-0 bg-[#0e0e16] border-[#2a2a3e]">
              <NavContent onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
        </header>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}