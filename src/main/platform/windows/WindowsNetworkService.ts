import { parseWindowsRoutes, type RouteEntry } from '../../network/routeParsers';
import { run, type PlatformNetworkService, type RouteSpec } from '../PlatformNetworkService';

const ps = (script: string): Promise<string> => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

/** PowerShell single-quoted literal; values are validated CIDR/IP/interface aliases anyway. */
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export class WindowsNetworkService implements PlatformNetworkService {
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
}
