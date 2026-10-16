import { useMemo } from 'react';
import { Cable, FileText, LayoutDashboard, Network, Route, ScrollText, Settings, ShieldCheck } from 'lucide-react';
import { isLive } from '../../../shared/types';
import { cn } from '../lib/format';
import { navigate, useStore, type Page } from '../store';

const NAV: { page: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { page: 'profiles', label: 'Profiles', icon: FileText },
  { page: 'connections', label: 'Connections', icon: Cable },
  { page: 'routes', label: 'Routes', icon: Route },
  { page: 'interfaces', label: 'Network Interfaces', icon: Network },
  { page: 'logs', label: 'Logs', icon: ScrollText },
  { page: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const page = useStore((s) => s.page);
  const appInfo = useStore((s) => s.appInfo);
  const connections = useStore((s) => s.connections);
  const active = useMemo(() => Object.values(connections).filter((c) => isLive(c.status)).length, [connections]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div className="drag flex h-14 items-end gap-2 px-4 pb-2 pt-8">
        <ShieldCheck className="h-4 w-4 text-accent" />
        <span className="font-semibold">OpenVPN Manager</span>
      </div>
      <nav className="flex flex-col gap-0.5 p-2">
        {NAV.map(({ page: p, label, icon: Icon }) => (
          <button
            key={p}
            type="button"
            onClick={() => navigate(p)}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
              page === p ? 'bg-surface-2 font-medium text-foreground' : 'text-muted hover:bg-surface-2 hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>
      <div className="mt-auto border-t border-border p-4 text-xs">
        <div className="font-medium">OpenVPN</div>
        <div className="text-muted">{appInfo?.openvpn ? `Version ${appInfo.openvpn.version ?? 'unknown'}` : 'Not detected'}</div>
        <div className="mt-2 text-muted">
          Active connections: <span className="font-medium text-foreground">{active}</span>
        </div>
        {appInfo?.mockMode && (
          <div className="mt-2 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            MOCK MODE
          </div>
        )}
      </div>
    </aside>
  );
}
