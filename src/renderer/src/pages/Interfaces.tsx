import { useCallback, useEffect, useMemo, useState } from 'react';
import { Network, RefreshCw } from 'lucide-react';
import type { InterfaceKind, NetworkInterfaceInfo } from '../../../shared/types';
import { Button, Card, EmptyState, PageHeader, Pill } from '../components/ui';
import { cn } from '../lib/format';
import { run, useStore } from '../store';

const KIND_LABEL: Record<InterfaceKind, string> = {
  vpn: 'VPN',
  physical: 'Physical',
  tunnel: 'Tunnel (not managed)',
  loopback: 'Loopback',
  other: 'Other',
};

export function Interfaces() {
  const profiles = useStore((s) => s.profiles);
  const connections = useStore((s) => s.connections);
  const [items, setItems] = useState<NetworkInterfaceInfo[]>([]);
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async () => {
    const list = await run(() => window.vpn.network.getInterfaces());
    if (list) setItems(list);
  }, []);

  // Refresh whenever any connection changes (interfaces appear/disappear with tunnels) and every 5s.
  useEffect(() => {
    void refresh();
  }, [refresh, connections]);
  useEffect(() => {
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  const shown = useMemo(
    () => (showAll ? items : items.filter((i) => i.kind === 'vpn' || (i.kind === 'physical' && i.addresses.length > 0))),
    [items, showAll],
  );
  const profileName = (id?: string): string | undefined => profiles.find((p) => p.id === id)?.name;

  return (
    <div>
      <PageHeader
        title="Network Interfaces"
        subtitle="Each VPN is mapped to its own virtual interface"
        actions={
          <>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show all
            </label>
            <Button onClick={refresh}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 px-6 pb-8">
        {shown.length === 0 && (
          <div className="col-span-full">
            <EmptyState icon={<Network className="h-8 w-8" />} title="No interfaces" />
          </div>
        )}
        {shown.map((i) => (
          <Card key={i.name} className={cn('p-4', i.kind === 'vpn' && 'border-accent/50')}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono font-semibold">{i.name}</span>
              <div className="flex gap-1">
                {i.simulated && <Pill>mock</Pill>}
                <Pill className={cn(i.kind === 'vpn' && 'border-accent/40 text-accent')}>{KIND_LABEL[i.kind]}</Pill>
              </div>
            </div>
            <div className="selectable mt-2 flex flex-col gap-0.5 font-mono text-xs">
              {i.addresses.length === 0 && <span className="text-muted">no address</span>}
              {i.addresses.map((a) => (
                <span key={a.address} className={cn(a.family === 'IPv6' && 'text-muted')}>
                  {a.cidr ?? a.address}
                </span>
              ))}
            </div>
            {i.kind === 'vpn' && (
              <div className="mt-3 border-t border-border pt-2 text-xs">
                <span className="text-muted">VPN: </span>
                <span className="font-medium">{profileName(i.profileId) ?? '—'}</span>
              </div>
            )}
            {i.mac && i.kind === 'physical' && <div className="mt-2 font-mono text-[11px] text-muted">{i.mac}</div>}
          </Card>
        ))}
      </div>
    </div>
  );
}
