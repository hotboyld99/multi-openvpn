import { parseNetstatRoutes, type RouteEntry } from '../../network/routeParsers';
import { run, type PlatformNetworkService, type RouteSpec } from '../PlatformNetworkService';

const routeArgs = (r: RouteSpec): string[] => {
  const host = r.destination.endsWith('/32') || r.destination.endsWith('/128');
  const dest = host ? r.destination.replace(/\/\d+$/, '') : r.destination;
  const family = r.destination.includes(':') ? ['-inet6'] : [];
  const target = r.gateway ? [r.gateway] : r.interface ? ['-interface', r.interface] : [];
  return [...family, host ? '-host' : '-net', dest, ...target];
};

export class MacNetworkService implements PlatformNetworkService {
  async getRoutes(): Promise<RouteEntry[]> {
    return parseNetstatRoutes(await run('/usr/sbin/netstat', ['-rn']));
  }

  async addRoute(r: RouteSpec): Promise<void> {
    await run('/sbin/route', ['-n', 'add', ...routeArgs(r)]);
  }

  async removeRoute(r: RouteSpec): Promise<void> {
    await run('/sbin/route', ['-n', 'delete', ...routeArgs(r)]);
  }
}
