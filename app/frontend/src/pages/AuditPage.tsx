import { AuditTab } from './Management';
import { ClipboardList } from 'lucide-react';

export default function AuditPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white flex items-center gap-2">
        <ClipboardList className="h-6 w-6 text-indigo-400" />
        Audit Log
      </h1>
      <AuditTab />
    </div>
  );
}