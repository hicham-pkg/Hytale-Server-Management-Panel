import { SettingsTab } from './Management';
import { Settings } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white flex items-center gap-2">
        <Settings className="h-6 w-6 text-indigo-400" />
        Settings
      </h1>
      <SettingsTab />
    </div>
  );
}