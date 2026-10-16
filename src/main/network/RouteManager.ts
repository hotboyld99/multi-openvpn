import { isLive, type RouteInfo, type VpnConnection } from '../../shared/types';
import type { PlatformNetworkService } from '../platform/PlatformNetworkService';
import { isDefaultDestination, type RouteEntry } from './routeParsers';

/**
 * Attributes OS routes to the VPN connection that owns them (by interface), and flags
 * destinations installed by more than one VPN.
 */
export function attributeRoutes(routes: RouteEntry[], connections: VpnConnection[]): RouteInfo[] {
  const live = connections.filter((c) => isLive(c.status) && c.interfaceName);
  const out: RouteInfo[] = routes.map((r) => {
    const owner = live.find((c) => c.interfaceName === r.interface);
    return {
      destination: r.destination,
      gateway: r.gateway,
      interface: r.interface,
      family: r.family,
      isDefault: isDefaultDestination(r.destination),
      connectionId: owner?.id,
      profileId: owner?.profileId,
    };
  });
  const owners = new Map<string, Set<string>>();
  for (const r of out) if (r.connectionId) owners.set(r.destination, (owners.get(r.destination) ?? new Set()).add(r.connectionId));
  for (const r of out) if (r.connectionId && (owners.get(r.destination)?.size ?? 0) > 1) r.conflict = true;
  return out;
}

/** Routes a mock connection would have, so the inspector is usable in VPN_MOCK_MODE. */
export function simulatedRoutes(connections: VpnConnection[]): RouteEntry[] {
  return connections
    .filter((c) => c.status === 'CONNECTED' && c.interfaceName && c.gateway && c.assignedIp)
    .flatMap((c) => {
      const [a, b] = c.assignedIp!.split('.');
      const routes: RouteEntry[] = [{ destination: `${a}.${b}.0.0/16`, gateway: c.gateway!, interface: c.interfaceName!, family: 'IPv4' }];
      if (c.ownsDefaultRoute) {
        routes.push(
          { destination: '0.0.0.0/1', gateway: c.gateway!, interface: c.interfaceName!, family: 'IPv4' },
          { destination: '128.0.0.0/1', gateway: c.gateway!, interface: c.interfaceName!, family: 'IPv4' },
        );
      }
      for (const r of c.appliedRoutes ?? []) routes.push({ destination: r, gateway: c.gateway!, interface: c.interfaceName!, family: 'IPv4' });
      return routes;
    });
}

/**
 * Routes a dead connection left behind: openvpn adds a host route to its server via the
 * physical gateway when it redirects the default route; if openvpn is killed that route stays.
 * Routes on the tunnel interface itself disappear with the interface and are not returned.
 */
export function leftoverRoutes(ended: VpnConnection, routes: RouteEntry[], live: VpnConnection[]): RouteEntry[] {
  if (!ended.remote) return [];
  const sharedRemote = live.some((c) => c.id !== ended.id && isLive(c.status) && c.remote === ended.remote);
  if (sharedRemote) return [];
  const tunnelIfs = new Set(live.map((c) => c.interfaceName).filter(Boolean));
  return routes.filter((r) => r.destination === `${ended.remote}/32` && r.interface !== ended.interfaceName && !tunnelIfs.has(r.interface));
}

export class RouteManager {
  constructor(
    private readonly platform: PlatformNetworkService,
    private readonly opts: { simulate?: boolean } = {},
  ) {}

  async list(connections: VpnConnection[]): Promise<RouteInfo[]> {
    const os = await this.platform.getRoutes();
    if (!this.opts.simulate) return attributeRoutes(os, connections);
    const sim = simulatedRoutes(connections);
    return attributeRoutes([...sim, ...os], connections).map((r, i) => (i < sim.length ? { ...r, simulated: true } : r));
  }

  /** Called when a connection's process ended without a graceful openvpn shutdown. */
  async cleanupAfterCrash(ended: VpnConnection, live: VpnConnection[]): Promise<RouteEntry[]> {
    if (this.opts.simulate || !ended.ownsDefaultRoute) return [];
    const stale = leftoverRoutes(ended, await this.platform.getRoutes(), live);
    for (const r of stale) await this.platform.removeRoute({ destination: r.destination, gateway: r.gateway || undefined });
    return stale;
  }
}
