import { ArrowDown, ArrowUp, Power, RotateCw, ScrollText, TriangleAlert } from 'lucide-react';
import { isLive, type VpnConnection, type VpnProfile } from '../../../shared/types';
import { formatBytes, formatDuration, formatRate } from '../lib/format';
import { navigate, run, useNow, connectProfile } from '../store';
import { Button, Card, Pill, StatusBadge } from './ui';

function Row({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="selectable truncate font-mono text-xs">{value ?? '—'}</span>
    </div>
  );
}

/** `actions` adds Retry / View Logs (the card already has its own buttons). */
export function ErrorPanel({ connection, actions = false }: { connection: VpnConnection; actions?: boolean }) {
  const now = useNow();
  const { error } = connection;
  if (!error) return null;
  const retryIn = connection.nextRetryAt ? Math.max(0, Math.ceil((connection.nextRetryAt - now) / 1000)) : null;
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3">
      <div className="flex items-center gap-1.5 font-medium text-red-600 dark:text-red-400">
        <TriangleAlert className="h-3.5 w-3.5" />
        {error.title}
      </div>
      <p className="mt-1 text-xs text-muted">{error.message}</p>
      {connection.status === 'RECONNECTING' && retryIn !== null && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Retrying in {retryIn}s…</p>
      )}
      {actions && connection.status === 'ERROR' && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => run(() => window.vpn.reconnect(connection.id))}>
            <RotateCw className="h-3.5 w-3.5" /> {error.code === 'AUTH_FAILED' ? 'Retry / Edit Credentials' : 'Retry'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('logs', connection.id)}>
            <ScrollText className="h-3.5 w-3.5" /> View Logs
          </Button>
        </div>
      )}
    </div>
  );
}

export function ConnectionCard({ connection, profile }: { connection: VpnConnection; profile?: VpnProfile }) {
  const now = useNow();
  const live = isLive(connection.status);
  const busy = connection.status === 'DISCONNECTING';

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">{profile?.name ?? 'Unknown profile'}</div>
          <div className="mt-1">
            <StatusBadge status={connection.status} />
          </div>
        </div>
        {connection.pid && <span className="font-mono text-[11px] text-muted">PID {connection.pid}</span>}
      </div>

      {(connection.ownsDefaultRoute || connection.ignoredDefaultRoute || connection.appliedRoutes) && (
        <div className="flex flex-wrap gap-1">
          {connection.ownsDefaultRoute && <Pill className="border-accent/40 text-accent">Default route</Pill>}
          {connection.ignoredDefaultRoute && <Pill title="The server asked to route all traffic; another VPN owns the default route">Default route ignored</Pill>}
          {connection.appliedRoutes && <Pill title={connection.appliedRoutes.join('\n')}>Split tunnel · {connection.appliedRoutes.length} routes</Pill>}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Row label="VPN IP" value={connection.assignedIp} />
        <Row label="Interface" value={connection.interfaceName} />
        <Row label="Gateway" value={connection.gateway} />
        <Row label="Server" value={connection.remote} />
        <Row
          label="DNS"
          value={
            connection.dns?.applied
              ? `${connection.dns.servers.join(', ')} · ${connection.dns.scope === 'split' ? connection.dns.domains.join(', ') : 'global'}`
              : undefined
          }
        />
      </div>
      {connection.dns?.warning && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">{connection.dns.warning}</div>
      )}

      <div className="grid grid-cols-2 gap-2 rounded-md bg-surface-2 px-3 py-2">
        <div>
          <div className="flex items-center gap-1 text-xs text-muted">
            <ArrowDown className="h-3 w-3" /> {formatRate(connection.rateIn)}
          </div>
          <div className="font-mono text-sm">{formatBytes(connection.bytesIn)}</div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-xs text-muted">
            <ArrowUp className="h-3 w-3" /> {formatRate(connection.rateOut)}
          </div>
          <div className="font-mono text-sm">{formatBytes(connection.bytesOut)}</div>
        </div>
      </div>

      <div className="flex justify-between text-xs">
        <span className="text-muted">Connected</span>
        <span className="font-mono">{connection.connectedAt ? formatDuration(now - connection.connectedAt) : '—'}</span>
      </div>
      {connection.reconnectCount > 0 && (
        <div className="flex justify-between text-xs">
          <span className="text-muted">Reconnects</span>
          <span className="font-mono">{connection.reconnectCount}</span>
        </div>
      )}

      <ErrorPanel connection={connection} />

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={() => navigate('logs', connection.id)}>
          <ScrollText className="h-3.5 w-3.5" /> Logs
        </Button>
        <div className="flex gap-2">
          {(live || connection.status === 'ERROR') && (
            <Button size="sm" disabled={busy} onClick={() => run(() => window.vpn.reconnect(connection.id))}>
              <RotateCw className="h-3.5 w-3.5" /> {connection.status === 'ERROR' ? 'Retry' : 'Reconnect'}
            </Button>
          )}
          {live ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => run(() => window.vpn.disconnect(connection.id))}>
              <Power className="h-3.5 w-3.5" /> Disconnect
            </Button>
          ) : connection.status === 'ERROR' ? null : (
            <Button size="sm" variant="primary" onClick={() => connectProfile(connection.profileId)}>
              <Power className="h-3.5 w-3.5" /> Connect
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
