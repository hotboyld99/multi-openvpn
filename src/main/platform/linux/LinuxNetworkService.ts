import { parseIpJsonRoutes, type RouteEntry } from '../../network/routeParsers';
import { run, type PlatformNetworkService, type RouteSpec } from '../PlatformNetworkService';

const routeArgs = (op: 'add' | 'del', r: RouteSpec): string[] => [
  ...(r.destination.includes(':') ? ['-6'] : []),
  'route',
  op,
  r.destination,
  ...(r.gateway ? ['via', r.gateway] : []),
  ...(r.interface ? ['dev', r.interface] : []),
];

/** Linux support for the read side and route changes; DNS (resolvectl) is not implemented yet. */
export class LinuxNetworkService implements PlatformNetworkService {
  async getRoutes(): Promise<RouteEntry[]> {
    const [v4, v6] = await Promise.all([run('ip', ['-j', 'route', 'show']), run('ip', ['-j', '-6', 'route', 'show'])]);
    return [...parseIpJsonRoutes(v4, 'IPv4'), ...parseIpJsonRoutes(v6, 'IPv6')];
  }

  async addRoute(r: RouteSpec): Promise<void> {
    await run('ip', routeArgs('add', r));
  }

  async removeRoute(r: RouteSpec): Promise<void> {
    await run('ip', routeArgs('del', r));
  }
}
