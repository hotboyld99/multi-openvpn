import { parseWindowsRoutes, type RouteEntry } from '../../network/routeParsers';
import { run, StateFile, validateDns, type DnsSettings, type PlatformNetworkService, type RouteSpec } from '../PlatformNetworkService';

const ps = (script: string): Promise<string> => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

/** PowerShell single-quoted literal; values are validated CIDR/IP/interface aliases anyway. */
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const list = (xs: string[]): string => `@(${xs.map(q).join(',')})`;
const comment = (connectionId: string): string => `multi-openvpn-${connectionId}`;

interface DnsBackup {
  interfaceName?: string;
  global: boolean;
}

/**
 * Windows: routes via Get/New/Remove-NetRoute; DNS per adapter (global) and NRPT rules
 * tagged with the connection id (split), so restore removes exactly ours.
 */
export class WindowsNetworkService implements PlatformNetworkService {
  private readonly backups: StateFile<DnsBackup>;

  constructor(stateDir: string) {
    this.backups = new StateFile(stateDir, 'dns-backup.json');
  }

  async getRoutes(): Promise<RouteEntry[]> {
    return parseWindowsRoutes(
      await ps('Get-NetRoute | Select-Object DestinationPrefix,NextHop,InterfaceAlias,RouteMetric,AddressFamily | ConvertTo-Json -Compress'),
    );
  }

  async addRoute(r: RouteSpec): Promise<void> {
    const parts = [`New-NetRoute -DestinationPrefix ${q(r.destination)} -PolicyStore ActiveStore`];
    if (r.interface) parts.push(`-InterfaceAlias ${q(r.interface)}`);
    if (r.gateway) parts.push(`-NextHop ${q(r.gateway)}`);
    await ps(parts.join(' '));
  }

  async removeRoute(r: RouteSpec): Promise<void> {
    const parts = [`Remove-NetRoute -DestinationPrefix ${q(r.destination)} -Confirm:$false`];
    if (r.interface) parts.push(`-InterfaceAlias ${q(r.interface)}`);
    if (r.gateway) parts.push(`-NextHop ${q(r.gateway)}`);
    await ps(parts.join(' '));
  }

  async getCurrentDns(): Promise<string[]> {
    const out = await ps('(Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses }).ServerAddresses -join ","');
    return [...new Set(out.trim().split(',').filter(Boolean))];
  }

  async setDns(connectionId: string, dns: DnsSettings): Promise<void> {
    validateDns(connectionId, dns);
    await this.restoreDns(connectionId);
    const all = this.backups.read();
    all[connectionId] = { interfaceName: dns.interfaceName, global: dns.scope === 'global' };
    this.backups.write(all);
    if (dns.scope === 'global') {
      if (!dns.interfaceName) throw new Error('Tunnel interface unknown');
      await ps(`Set-DnsClientServerAddress -InterfaceAlias ${q(dns.interfaceName)} -ServerAddresses ${list(dns.servers)}`);
    }
    for (const d of dns.domains) {
      await ps(`Add-DnsClientNrptRule -Namespace ${q(`.${d}`)} -NameServers ${list(dns.servers)} -Comment ${q(comment(connectionId))}`);
    }
    await ps('Clear-DnsClientCache').catch(() => undefined);
  }

  async restoreDns(connectionId: string): Promise<void> {
    const all = this.backups.read();
    const b = all[connectionId];
    if (!b) return;
    await ps(`Get-DnsClientNrptRule | Where-Object Comment -eq ${q(comment(connectionId))} | Remove-DnsClientNrptRule -Force`);
    if (b.global && b.interfaceName) {
      // The adapter usually disappears with the tunnel; resetting a missing one is fine to fail.
      await ps(`Set-DnsClientServerAddress -InterfaceAlias ${q(b.interfaceName)} -ResetServerAddresses`).catch(() => undefined);
    }
    delete all[connectionId];
    this.backups.write(all);
    await ps('Clear-DnsClientCache').catch(() => undefined);
  }

  async restoreAllDns(keep: string[]): Promise<void> {
    for (const id of Object.keys(this.backups.read())) if (!keep.includes(id)) await this.restoreDns(id).catch(() => undefined);
    const keepList = list(keep.map(comment));
    await ps(
      `Get-DnsClientNrptRule | Where-Object { $_.Comment -like 'multi-openvpn-*' -and ${keepList} -notcontains $_.Comment } | Remove-DnsClientNrptRule -Force`,
    ).catch(() => undefined);
  }
}
