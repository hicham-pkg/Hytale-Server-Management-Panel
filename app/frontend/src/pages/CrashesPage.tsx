import { CrashesTab } from './Management';
import { AlertTriangle } from 'lucide-react';

export default function CrashesPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white flex items-center gap-2">
        <AlertTriangle className="h-6 w-6 text-indigo-400" />
        Crash History
      </h1>
      <CrashesTab />
    </div>
  );
}