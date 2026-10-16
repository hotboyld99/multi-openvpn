import type { MenuItemConstructorOptions } from 'electron';
import { isLive, type VpnConnection, type VpnProfile, type VpnStatus } from '../shared/types';

export interface TrayActions {
  open(): void;
  openDashboard(): void;
  toggle(profileId: string, connectionId?: string): void;
  disconnectAll(): void;
  quit(): void;
}

const LABEL: Record<VpnStatus, string> = {
  CONNECTED: 'Connected',
  CONNECTING: 'Connecting',
  WAIT: 'Connecting',
  AUTH: 'Authenticating',
  GET_CONFIG: 'Connecting',
  ASSIGN_IP: 'Connecting',
  ADD_ROUTES: 'Connecting',
  RECONNECTING: 'Reconnecting',
  DISCONNECTING: 'Disconnecting',
  DISCONNECTED: 'Disconnected',
  ERROR: 'Error',
};

const dot = (s: VpnStatus): string => (s === 'CONNECTED' ? '●' : s === 'ERROR' ? '⚠' : s === 'DISCONNECTED' ? '○' : '◐');

const MAX_PROFILES = 12;

/** Tray menu as in the spec: open, one line per profile with its status, disconnect all, dashboard, quit. */
export function trayMenuTemplate(
  profiles: VpnProfile[],
  connections: VpnConnection[],
  actions: TrayActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const byProfile = new Map(connections.map((c) => [c.profileId, c]));
  // Active VPNs first, then the rest alphabetically.
  const sorted = [...profiles].sort((a, b) => {
    const la = isLive(byProfile.get(a.id)?.status ?? 'DISCONNECTED') ? 0 : 1;
    const lb = isLive(byProfile.get(b.id)?.status ?? 'DISCONNECTED') ? 0 : 1;
    return la - lb || a.name.localeCompare(b.name);
  });
  const items: MenuItemConstructorOptions[] = sorted.slice(0, MAX_PROFILES).map((p) => {
    const c = byProfile.get(p.id);
    const status = c?.status ?? 'DISCONNECTED';
    const live = isLive(status);
    return {
      label: platform === 'darwin' ? `${dot(status)}  ${p.name}` : `${dot(status)}  ${p.name}  (${LABEL[status]})`,
      sublabel: platform === 'darwin' ? LABEL[status] : undefined,
      toolTip: live ? 'Click to disconnect' : 'Click to connect',
      click: () => actions.toggle(p.id, live ? c?.id : undefined),
    };
  });
  if (profiles.length > MAX_PROFILES) items.push({ label: `${profiles.length - MAX_PROFILES} more…`, click: actions.open });
  if (profiles.length === 0) items.push({ label: 'No profiles', enabled: false });

  const active = connections.filter((c) => isLive(c.status)).length;
  return [
    { label: 'Open VPN Manager', click: actions.open },
    { type: 'separator' },
    ...items,
    { type: 'separator' },
    { label: active ? `Disconnect All (${active})` : 'Disconnect All', enabled: active > 0, click: actions.disconnectAll },
    { label: 'Open Dashboard', click: actions.openDashboard },
    { type: 'separator' },
    { label: 'Quit', click: actions.quit },
  ];
}

export const trayTooltip = (connections: VpnConnection[]): string => {
  const n = connections.filter((c) => c.status === 'CONNECTED').length;
  return n ? `Multi OpenVPN — ${n} connected` : 'Multi OpenVPN';
};
