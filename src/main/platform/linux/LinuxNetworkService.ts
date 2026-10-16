import { parseIpJsonRoutes, type RouteEntry } from '../../network/routeParsers';
import { run, StateFile, validateDns, type DnsSettings, type PlatformNetworkService, type RouteSpec } from '../PlatformNetworkService';

const routeArgs = (op: 'add' | 'del', r: RouteSpec): string[] => [
  ...(r.destination.includes(':') ? ['-6'] : []),
  'route',
  op,
  r.destination,
  ...(r.gateway ? ['via', r.gateway] : []),
  ...(r.interface ? ['dev', r.interface] : []),
];

/** Linux: iproute2 for routes, systemd-resolved (resolvectl) per-link DNS. */
export class LinuxNetworkService implements PlatformNetworkService {
  private readonly backups: StateFile<{ interfaceName: string }>;

  constructor(stateDir: string) {
    this.backups = new StateFile(stateDir, 'dns-backup.json');
  }

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

  async getCurrentDns(): Promise<string[]> {
    const out = await run('resolvectl', ['dns']).catch(() => '');
    return [...new Set([...out.matchAll(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+:[0-9a-f:]+)/gi)].map((m) => m[1]))];
  }

  async setDns(connectionId: string, dns: DnsSettings): Promise<void> {
    validateDns(connectionId, dns);
    if (!dns.interfaceName) throw new Error('Tunnel interface unknown');
    const all = this.backups.read();
    all[connectionId] = { interfaceName: dns.interfaceName };
    this.backups.write(all);
    await run('resolvectl', ['dns', dns.interfaceName, ...dns.servers]);
    // "~." makes this link the default route for DNS; "~corp.com" only routes that domain.
    const routing = dns.scope === 'global' ? ['~.', ...dns.domains] : dns.domains.map((d) => `~${d}`);
    await run('resolvectl', ['domain', dns.interfaceName, ...routing]);
  }

  async restoreDns(connectionId: string): Promise<void> {
    const all = this.backups.read();
    const b = all[connectionId];
    if (!b) return;
    await run('resolvectl', ['revert', b.interfaceName]).catch(() => undefined); // link may be gone already
    delete all[connectionId];
    this.backups.write(all);
  }

  async restoreAllDns(keep: string[]): Promise<void> {
    for (const id of Object.keys(this.backups.read())) if (!keep.includes(id)) await this.restoreDns(id);
  }
}
