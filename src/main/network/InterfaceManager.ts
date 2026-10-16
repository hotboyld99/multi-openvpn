import type { NetworkInterfaceInfo as OsInterfaceInfo } from 'node:os';
import { isLive, type NetworkInterfaceInfo, type VpnConnection } from '../../shared/types';

// macOS utun/tun/tap/ppp/ipsec, Linux tun/wg, Windows adapter names for TAP-Windows / Wintun / DCO.
const TUNNEL_NAME = /^(utun|tun|tap|ppp|ipsec|wg)\d*$|tap-windows|wintun|openvpn|data channel offload|ovpn-dco/i;

/**
 * Builds the interface list and attributes each tunnel to the connection that owns it,
 * by interface name (from openvpn) or by the address openvpn assigned. Never assumes a
 * fixed name like utun4.
 */
export function describeInterfaces(
  os: NodeJS.Dict<OsInterfaceInfo[]>,
  connections: VpnConnection[],
  opts: { simulateMissing?: boolean } = {},
): NetworkInterfaceInfo[] {
  const live = connections.filter((c) => isLive(c.status));
  const result: NetworkInterfaceInfo[] = [];

  for (const [name, addrs = []] of Object.entries(os)) {
    const owner = live.find(
      (c) => c.interfaceName === name || (c.assignedIp && addrs.some((a) => a.address === c.assignedIp)),
    );
    const internal = addrs.length > 0 && addrs.every((a) => a.internal);
    const mac = addrs.find((a) => a.mac && a.mac !== '00:00:00:00:00:00')?.mac;
    result.push({
      name,
      kind: owner ? 'vpn' : internal ? 'loopback' : TUNNEL_NAME.test(name) ? 'tunnel' : mac ? 'physical' : 'other',
      mac,
      addresses: addrs.map((a) => ({ address: a.address, family: a.family, cidr: a.cidr })),
      connectionId: owner?.id,
      profileId: owner?.profileId,
    });
  }

  // Mock connections have no real interface; show them so the page is usable in VPN_MOCK_MODE.
  if (opts.simulateMissing) {
    for (const c of live) {
      if (!c.interfaceName || result.some((r) => r.connectionId === c.id)) continue;
      result.push({
        name: c.interfaceName,
        kind: 'vpn',
        addresses: c.assignedIp ? [{ address: c.assignedIp, family: 'IPv4', cidr: `${c.assignedIp}/24` }] : [],
        connectionId: c.id,
        profileId: c.profileId,
        simulated: true,
      });
    }
  }

  const order = { vpn: 0, physical: 1, tunnel: 2, other: 3, loopback: 4 } as const;
  return result.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true }));
}
