import { Badge } from '@/components/ui/badge';

interface StatusBadgeProps {
  running: boolean;
}

export function StatusBadge({ running }: StatusBadgeProps) {
  return (
    <Badge variant={running ? 'success' : 'error'}>
      <span className={`mr-1.5 h-2 w-2 rounded-full ${running ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
      {running ? 'Online' : 'Offline'}
    </Badge>
  );
}

interface SeverityBadgeProps {
  severity: string;
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  const variant = {
    info: 'info' as const,
    warning: 'warning' as const,
    error: 'error' as const,
    critical: 'destructive' as const,
  }[severity] ?? 'secondary' as const;

  return <Badge variant={variant}>{severity}</Badge>;
}