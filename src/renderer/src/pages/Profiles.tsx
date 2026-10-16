import { useMemo, useState } from 'react';
import { Copy, Download, Ellipsis, Eye, FileCode, FileText, FileUp, Pencil, Power, RefreshCw, Rocket, Search, Settings2, Trash2, Unplug } from 'lucide-react';
import { isLive, type VpnProfile } from '../../../shared/types';
import { ErrorPanel } from '../components/ConnectionCard';
import { Button, Card, EmptyState, Input, Menu, PageHeader, Pill, StatusBadge } from '../components/ui';
import { cn, timeAgo } from '../lib/format';
import { connectionOf, connectProfile, connectProfiles, openConfig, openProfileSettings, run, startImport, useNow, useStore } from '../store';

function ProfileRow({ profile, selected, onSelect }: { profile: VpnProfile; selected: boolean; onSelect: (v: boolean) => void }) {
  const connections = useStore((s) => s.connections);
  const now = useNow(30_000);
  const conn = connectionOf(connections, profile.id);
  const live = !!conn && isLive(conn.status);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);

  const saveName = async (): Promise<void> => {
    setEditing(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile.name) return setName(profile.name);
    await run(() => window.vpn.profiles.update(profile.id, { name: trimmed }));
  };

  const remove = async (): Promise<void> => {
    const msg = live ? `"${profile.name}" is connected. Disconnect and delete it?` : `Delete profile "${profile.name}"?`;
    if (confirm(msg)) await run(() => window.vpn.profiles.remove(profile.id));
  };

  return (
    <Card className={cn('flex flex-col gap-2 px-4 py-3', selected && 'border-accent/60')}>
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--accent)]"
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
          aria-label={`Select ${profile.name}`}
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveName();
                if (e.key === 'Escape') {
                  setName(profile.name);
                  setEditing(false);
                }
              }}
              className="h-7 w-72"
            />
          ) : (
            <div className="truncate font-semibold">{profile.name}</div>
          )}
          <div className="flex items-center gap-1.5 truncate text-xs text-muted">
            {profile.configFileName}
            {profile.routingMode === 'custom' && <Pill>split tunnel</Pill>}
            {profile.routingMode === 'config' && profile.ignoreRedirectGateway && <Pill>no default route</Pill>}
          </div>
        </div>

        <div className="w-44 text-right text-xs">
          {conn && conn.status !== 'DISCONNECTED' ? (
            <StatusBadge status={conn.status} />
          ) : (
            <span className="text-muted">
              {profile.lastConnectedAt ? `Last connected ${timeAgo(profile.lastConnectedAt, now)}` : 'Never connected'}
            </span>
          )}
        </div>

        {live ? (
          <Button size="sm" variant="danger" disabled={conn.status === 'DISCONNECTING'} onClick={() => run(() => window.vpn.disconnect(conn.id))}>
            <Unplug className="h-3.5 w-3.5" /> Disconnect
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => connectProfile(profile.id)}>
            <Power className="h-3.5 w-3.5" /> Connect
          </Button>
        )}

        <Menu
          trigger={
            <Button size="icon" variant="ghost" aria-label="More actions">
              <Ellipsis className="h-4 w-4" />
            </Button>
          }
          items={[
            { label: 'Rename', icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => setEditing(true) },
            { label: 'Routing & DNS…', icon: <Settings2 className="h-3.5 w-3.5" />, onSelect: () => openProfileSettings(profile.id) },
            ...(profile.configPath.startsWith('mock://')
              ? []
              : [
                  { label: 'View config', icon: <Eye className="h-3.5 w-3.5" />, onSelect: () => openConfig(profile.id, false) },
                  { label: 'Edit config', icon: <FileCode className="h-3.5 w-3.5" />, onSelect: () => openConfig(profile.id, true) },
                  {
                    label: 'Export profile',
                    icon: <Download className="h-3.5 w-3.5" />,
                    onSelect: () => void run(() => window.vpn.profiles.exportConfig(profile.id)),
                  },
                ]),
            { label: 'Duplicate', icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => void run(() => window.vpn.profiles.duplicate(profile.id)) },
            {
              label: 'Auto reconnect',
              icon: <RefreshCw className="h-3.5 w-3.5" />,
              checked: profile.reconnect,
              onSelect: () => void run(() => window.vpn.profiles.update(profile.id, { reconnect: !profile.reconnect })),
            },
            {
              label: 'Connect on startup',
              icon: <Rocket className="h-3.5 w-3.5" />,
              checked: profile.autoConnect,
              onSelect: () => void run(() => window.vpn.profiles.update(profile.id, { autoConnect: !profile.autoConnect })),
            },
            { label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onSelect: () => void remove() },
          ]}
        />
      </div>
      {conn?.status === 'ERROR' && <ErrorPanel connection={conn} actions />}
    </Card>
  );
}

export function Profiles() {
  const profiles = useStore((s) => s.profiles);
  const connections = useStore((s) => s.connections);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? profiles.filter((p) => p.name.toLowerCase().includes(q) || p.configFileName.toLowerCase().includes(q)) : profiles;
  }, [profiles, query]);

  // Drop selections of profiles that were deleted.
  const selectedIds = profiles.filter((p) => selected.has(p.id)).map((p) => p.id);
  const anyLive = Object.values(connections).some((c) => isLive(c.status));
  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));

  const toggle = (id: string, on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const disconnectSelected = (): Promise<unknown> =>
    Promise.all(
      selectedIds
        .map((id) => connectionOf(connections, id))
        .filter((c) => c && isLive(c.status))
        .map((c) => run(() => window.vpn.disconnect(c!.id))),
    );

  return (
    <div>
      <PageHeader
        title="Profiles"
        subtitle={`${profiles.length} profile${profiles.length === 1 ? '' : 's'}`}
        actions={
          <>
            <Button variant="primary" onClick={async () => startImport((await run(() => window.vpn.profiles.pickFiles())) ?? [])}>
              <FileUp className="h-4 w-4" /> Import
            </Button>
            <Button variant="danger" disabled={!anyLive} onClick={() => run(() => window.vpn.disconnectAll())}>
              <Unplug className="h-4 w-4" /> Disconnect All
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-3 px-6 pb-8">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-muted" />
            <Input className="w-full pl-8" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={allVisibleSelected}
              onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((p) => p.id)) : new Set())}
            />
            Select all
          </label>
          <Button variant="primary" disabled={selectedIds.length === 0} onClick={() => connectProfiles(selectedIds)}>
            <Power className="h-4 w-4" /> Connect Selected{selectedIds.length > 0 && ` (${selectedIds.length})`}
          </Button>
          <Button disabled={selectedIds.length === 0} onClick={disconnectSelected}>
            Disconnect Selected
          </Button>
        </div>

        {profiles.length === 0 ? (
          <EmptyState icon={<FileText className="h-8 w-8" />} title="No profiles">
            Click Import or drop .ovpn / .conf files anywhere on this window. Several files can be imported at once.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon={<Search className="h-8 w-8" />} title={`No profile matches "${query}"`} />
        ) : (
          visible.map((p) => <ProfileRow key={p.id} profile={p} selected={selected.has(p.id)} onSelect={(v) => toggle(p.id, v)} />)
        )}
      </div>
    </div>
  );
}
