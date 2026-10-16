import { useMemo } from 'react';
import { FileText, Power, Unplug } from 'lucide-react';
import { isLive } from '../../../shared/types';
import { ConnectionCard } from '../components/ConnectionCard';
import { Button, Card, EmptyState, PageHeader, StatusBadge } from '../components/ui';
import { formatBytes, formatRate } from '../lib/format';
import { connectionOf, navigate, run, useStore } from '../store';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </Card>
  );
}

export function Dashboard() {
  const profiles = useStore((s) => s.profiles);
  const connections = useStore((s) => s.connections);

  const { shown, idle, totals } = useMemo(() => {
    const all = Object.values(connections);
    const live = all.filter((c) => isLive(c.status));
    // Cards: everything live, plus failed connections so the error stays visible.
    const shown = all.filter((c) => isLive(c.status) || c.status === 'ERROR');
    const shownProfiles = new Set(shown.map((c) => c.profileId));
    return {
      shown: shown.sort((a, b) => a.startedAt - b.startedAt),
      idle: profiles.filter((p) => !shownProfiles.has(p.id)),
      totals: {
        active: live.length,
        bytesIn: all.reduce((n, c) => n + c.bytesIn, 0),
        bytesOut: all.reduce((n, c) => n + c.bytesOut, 0),
        rateIn: live.reduce((n, c) => n + c.rateIn, 0),
        rateOut: live.reduce((n, c) => n + c.rateOut, 0),
      },
    };
  }, [connections, profiles]);

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`${totals.active} Active Connection${totals.active === 1 ? '' : 's'}`}
        actions={
          totals.active > 0 && (
            <Button variant="danger" onClick={() => run(() => window.vpn.disconnectAll())}>
              <Unplug className="h-4 w-4" /> Disconnect All
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-6 px-6 pb-8">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Active VPN" value={String(totals.active)} />
          <Stat label="Download" value={formatBytes(totals.bytesIn)} hint={formatRate(totals.rateIn)} />
          <Stat label="Upload" value={formatBytes(totals.bytesOut)} hint={formatRate(totals.rateOut)} />
        </div>

        {profiles.length === 0 ? (
          <EmptyState icon={<FileText className="h-8 w-8" />} title="No profiles yet">
            Import .ovpn files on the Profiles page, or drop them anywhere on this window.
          </EmptyState>
        ) : (
          <>
            {shown.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {shown.map((c) => (
                  <ConnectionCard key={c.id} connection={c} profile={profileById.get(c.profileId)} />
                ))}
              </div>
            )}

            {idle.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Profiles</h2>
                <Card className="divide-y divide-border">
                  {idle.map((p) => {
                    const c = connectionOf(connections, p.id);
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{p.name}</div>
                          <div className="truncate text-xs text-muted">{p.configFileName}</div>
                        </div>
                        <div className="flex items-center gap-4">
                          <StatusBadge status={c?.status ?? 'DISCONNECTED'} />
                          <Button size="sm" variant="primary" onClick={() => run(() => window.vpn.connect(p.id))}>
                            <Power className="h-3.5 w-3.5" /> Connect
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </Card>
                <button type="button" className="mt-2 text-xs text-accent hover:underline" onClick={() => navigate('profiles')}>
                  Manage profiles →
                </button>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
