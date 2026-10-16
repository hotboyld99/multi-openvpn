import { useMemo } from 'react';
import { Cable, Power, RotateCw, ScrollText } from 'lucide-react';
import { isLive } from '../../../shared/types';
import { Button, Card, EmptyState, PageHeader, StatusBadge } from '../components/ui';
import { formatBytes, formatDuration } from '../lib/format';
import { navigate, run, useNow, useStore } from '../store';

/** Debug-oriented table: one row per connection with its process, port and interface. */
export function Connections() {
  const profiles = useStore((s) => s.profiles);
  const connections = useStore((s) => s.connections);
  const now = useNow();
  const rows = useMemo(() => Object.values(connections).sort((a, b) => a.startedAt - b.startedAt), [connections]);
  const name = (id: string): string => profiles.find((p) => p.id === id)?.name ?? '—';

  return (
    <div>
      <PageHeader title="Connections" subtitle="One OpenVPN process, management port and interface per connection" />
      <div className="px-6 pb-8">
        {rows.length === 0 ? (
          <EmptyState icon={<Cable className="h-8 w-8" />} title="No connections" />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border text-muted">
                <tr>
                  {['Profile', 'Status', 'PID', 'Mgmt port', 'Interface', 'VPN IP', 'Server', '↓', '↑', 'Duration', 'Reconnects', ''].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="selectable divide-y divide-border">
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{name(c.profileId)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-3 py-2 font-mono">{c.pid ?? '—'}</td>
                    <td className="px-3 py-2 font-mono">{c.managementPort ?? '—'}</td>
                    <td className="px-3 py-2 font-mono">{c.interfaceName ?? '—'}</td>
                    <td className="px-3 py-2 font-mono">{c.assignedIp ?? '—'}</td>
                    <td className="px-3 py-2 font-mono">{c.remote ?? '—'}</td>
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{formatBytes(c.bytesIn)}</td>
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{formatBytes(c.bytesOut)}</td>
                    <td className="px-3 py-2 font-mono">{c.connectedAt ? formatDuration(now - c.connectedAt) : '—'}</td>
                    <td className="px-3 py-2 font-mono">{c.reconnectCount}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" title="Logs" onClick={() => navigate('logs', c.id)}>
                          <ScrollText className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" title="Reconnect" onClick={() => run(() => window.vpn.reconnect(c.id))}>
                          <RotateCw className="h-3.5 w-3.5" />
                        </Button>
                        {isLive(c.status) ? (
                          <Button size="icon" variant="ghost" title="Disconnect" onClick={() => run(() => window.vpn.disconnect(c.id))}>
                            <Power className="h-3.5 w-3.5 text-red-500" />
                          </Button>
                        ) : (
                          <Button size="icon" variant="ghost" title="Connect" onClick={() => run(() => window.vpn.connect(c.profileId))}>
                            <Power className="h-3.5 w-3.5 text-emerald-500" />
                          </Button>
                        )}
                      </div>
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
