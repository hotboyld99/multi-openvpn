import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { trayMenuTemplate, trayTooltip } from '../src/main/trayMenu';
import type { VpnConnection, VpnProfile, VpnStatus } from '../src/shared/types';

const profile = (name: string): VpnProfile => ({
  id: randomUUID(), name, configPath: 'x', configFileName: 'x', hasSavedPassword: false, autoConnect: false,
  reconnect: true, routingMode: 'config', dnsMode: 'vpn', createdAt: 0, updatedAt: 0,
});
const conn = (p: VpnProfile, status: VpnStatus): VpnConnection => ({
  id: randomUUID(), profileId: p.id, status, startedAt: 0, bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0, reconnectCount: 0,
});

describe('tray menu', () => {
  const office = profile('Office VPN');
  const dev = profile('Development');
  const sg = profile('Singapore');
  const actions = { open: vi.fn(), openDashboard: vi.fn(), toggle: vi.fn(), disconnectAll: vi.fn(), quit: vi.fn() };
  const conns = [conn(office, 'CONNECTED'), conn(dev, 'CONNECTED'), conn(sg, 'DISCONNECTED')];

  it('matches the spec layout, active VPNs first, with their status', () => {
    const menu = trayMenuTemplate([sg, office, dev], conns, actions, 'darwin');
    expect(menu.map((m) => m.type ?? m.label)).toEqual([
      'Open VPN Manager', 'separator', '●  Development', '●  Office VPN', '○  Singapore', 'separator', 'Disconnect All (2)', 'Open Dashboard', 'separator', 'Quit',
    ]);
    expect(menu[3].sublabel).toBe('Connected');
    expect(menu[4].sublabel).toBe('Disconnected');
  });

  it('puts the status in the label on Windows (no sublabels there)', () => {
    expect(trayMenuTemplate([sg], [conns[2]], actions, 'win32')[2].label).toBe('○  Singapore  (Disconnected)');
  });

  it('clicking a profile toggles it; Disconnect All is disabled when nothing runs', () => {
    const menu = trayMenuTemplate([office, sg], conns, actions, 'darwin');
    (menu[2].click as () => void)();
    expect(actions.toggle).toHaveBeenLastCalledWith(office.id, conns[0].id); // connected → disconnect
    (menu[3].click as () => void)();
    expect(actions.toggle).toHaveBeenLastCalledWith(sg.id, undefined); // disconnected → connect
    const idle = trayMenuTemplate([sg], [conns[2]], actions, 'darwin');
    expect(idle.find((m) => m.label === 'Disconnect All')?.enabled).toBe(false);
  });

  it('tooltip counts connected VPNs', () => {
    expect(trayTooltip(conns)).toBe('Multi OpenVPN — 2 connected');
    expect(trayTooltip([])).toBe('Multi OpenVPN');
  });
});
