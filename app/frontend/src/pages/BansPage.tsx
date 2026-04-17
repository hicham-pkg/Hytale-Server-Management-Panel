import { BansTab } from './Management';
import { Ban } from 'lucide-react';

export default function BansPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white flex items-center gap-2">
        <Ban className="h-6 w-6 text-indigo-400" />
        Ban Management
      </h1>
      <BansTab />
    </div>
  );
}