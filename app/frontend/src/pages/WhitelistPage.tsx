import { WhitelistTab } from './Management';
import { Shield } from 'lucide-react';

export default function WhitelistPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white flex items-center gap-2">
        <Shield className="h-6 w-6 text-indigo-400" />
        Whitelist
      </h1>
      <WhitelistTab />
    </div>
  );
}