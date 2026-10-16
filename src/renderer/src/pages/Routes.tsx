import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Route, TriangleAlert } from 'lucide-react';
import { isLive, type RouteInfo } from '../../../shared/types';
import { Button, Card, EmptyState, PageHeader, Pill } from '../components/ui';
import { cn } from '../lib/format';
import { run, useStore } from '../store';

/** OS route table with each route attributed to the VPN that owns it. */
export function Routes() {
  const profiles = useStore((s) => s.profiles);
  const connections = useStore((s) => s.connections);
  const [routes, setRoutes] = useState<RouteInfo[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'system' | string>('all');
  const [family, setFamily] = useState<'IPv4' | 'IPv6'>('IPv4');

  const refresh = useCallback(async () => {
    const r = await run(() => window.vpn.network.getRoutes());
    if (r) setRoutes(r);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, connections]);
  useEffect(() => {
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  const name = (profileId?: string): string => profiles.find((p) => p.id === profileId)?.name ?? 'VPN';
  const vpnFilters = Object.values(connections)
    .filter((c) => isLive(c.status))
    .map((c) => ({ id: c.id, label: name(c.profileId) }));

  const shown = useMemo(() => {
    const list = (routes ?? []).filter((r) => r.family === family);
    const filtered = filter === 'all' ? list : filter === 'system' ? list.filter((r) => !r.connectionId) : list.filter((r) => r.connectionId === filter);
    // VPN-owned and default routes first: they are what matters when several VPNs are up.
    return [...filtered].sort((a, b) => Number(!!b.connectionId) - Number(!!a.connectionId) || Number(b.isDefault) - Number(a.isDefault));
  }, [routes, filter, family]);

  const conflicts = (routes ?? []).filter((r) => r.conflict).length;
  const chip = (value: string, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setFilter(value)}
      className={cn('rounded-full border px-2.5 py-0.5 text-xs', filter === value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-foreground')}
    >
      {label}
    </button>
  );

  return (
    <div>
      <PageHeader
        title="Routes"
        subtitle="Which network goes through which VPN"
        actions={
          <Button onClick={refresh}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />
      <div className="flex flex-col gap-3 px-6 pb-8">
        {conflicts > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2.5 text-xs text-red-600 dark:text-red-400">
            <TriangleAlert className="h-4 w-4" /> {conflicts} route{conflicts === 1 ? ' is' : 's are'} installed by more than one VPN. Only one of them is used.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {chip('all', 'All')}
          {chip('system', 'System')}
          {vpnFilters.map((v) => chip(v.id, v.label))}
          <div className="ml-auto inline-flex rounded-md border border-border p-0.5 text-xs">
            {(['IPv4', 'IPv6'] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFamily(f)} className={cn('rounded px-2 py-0.5', family === f ? 'bg-surface-2 font-medium' : 'text-muted')}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {routes === null ? (
          <div className="text-muted">Loading…</div>
        ) : shown.length === 0 ? (
          <EmptyState icon={<Route className="h-8 w-8" />} title="No routes match this filter" />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border text-muted">
                <tr>
                  {['Destination', 'Gateway', 'Interface', 'Source'].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="selectable divide-y divide-border">
                {shown.map((r, i) => (
                  <tr key={`${r.destination}-${r.interface}-${i}`} className={cn(r.connectionId && 'bg-accent/5', r.conflict && 'bg-red-500/10')}>
                    <td className={cn('border-l-2 px-3 py-1.5 font-mono', r.connectionId ? 'border-accent' : 'border-transparent')}>
                      {r.destination === '0.0.0.0/0' || r.destination === '::/0' ? 'default' : r.destination}
                      {r.isDefault && <Pill className="ml-2">default</Pill>}
                    </td>
                    <td className="px-3 py-1.5 font-mono">{r.gateway || 'on-link'}</td>
                    <td className="px-3 py-1.5 font-mono">{r.interface}</td>
                    <td className="px-3 py-1.5">
                      {r.connectionId ? <span className="font-medium text-accent">{name(r.profileId)}</span> : <span className="text-muted">System</span>}
                      {r.simulated && <Pill className="ml-2">mock</Pill>}
                      {r.conflict && <Pill className="ml-2 border-red-500/40 text-red-500">conflict</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}
