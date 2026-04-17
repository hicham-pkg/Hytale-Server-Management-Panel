import { BackupsTab } from './Management';
import { Archive } from 'lucide-react';

export default function BackupsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white flex items-center gap-2">
        <Archive className="h-6 w-6 text-indigo-400" />
        Backups
      </h1>
      <BackupsTab />
    </div>
  );
}