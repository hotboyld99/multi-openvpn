import { parseNetstatRoutes, type RouteEntry } from '../../network/routeParsers';
import { run, StateFile, validateDns, type DnsSettings, type PlatformNetworkService, type RouteSpec } from '../PlatformNetworkService';

const routeArgs = (r: RouteSpec): string[] => {
  const host = r.destination.endsWith('/32') || r.destination.endsWith('/128');
  const dest = host ? r.destination.replace(/\/\d+$/, '') : r.destination;
  const family = r.destination.includes(':') ? ['-inet6'] : [];
  const target = r.gateway ? [r.gateway] : r.interface ? ['-interface', r.interface] : [];
  return [...family, host ? '-host' : '-net', dest, ...target];
};

const SCUTIL = '/usr/sbin/scutil';

/**
 * scutil exits 0 even when a command fails ("  Permission denied"), so its output must be
 * checked. "No such key" is only fine for remove/show.
 */
async function scutil(script: string, allowMissing = false): Promise<string> {
  const out = await run(SCUTIL, [], script);
  const err = /^\s*(Permission denied|No such key|.*failed.*|.*error.*)$/im.exec(out);
  if (err && !(allowMissing && /No such key/.test(err[1]))) throw new Error(`scutil: ${err[1].trim()}`);
  return out;
}

/** Applies a dictionary and reads it back: the only reliable way to know scutil really changed it. */
async function setAndVerify(key: string, commands: string, servers: string[]): Promise<void> {
  await scutil(commands);
  const back = parseScutilDict(await scutil(`show ${key}\n`, true));
  if (!servers.every((s) => back?.ServerAddresses?.includes(s))) throw new Error(`scutil: ${key} was not updated`);
}
const KEY_PREFIX = 'State:/Network/Service/multi-openvpn-';

interface DnsDict {
  ServerAddresses?: string[];
  SearchDomains?: string[];
  DomainName?: string;
}

/** What was changed for a connection: our own supplemental key, or an override of the primary service's DNS. */
interface DnsBackup {
  key: string;
  /** For a global override: the primary service's DNS before we changed it (null = there was none). */
  original?: DnsDict | null;
}

/** Parses the arrays/strings we care about from `scutil` "show" output. */
export function parseScutilDict(out: string): DnsDict | null {
  if (!out.includes('<dictionary>')) return null;
  const dict: DnsDict = {};
  const arr = (name: string): string[] | undefined => {
    const m = new RegExp(`${name} : <array> \\{([^}]*)\\}`).exec(out);
    return m ? [...m[1].matchAll(/\d+ : (\S+)/g)].map((x) => x[1]) : undefined;
  };
  dict.ServerAddresses = arr('ServerAddresses');
  dict.SearchDomains = arr('SearchDomains');
  dict.DomainName = /DomainName : (\S+)/.exec(out)?.[1];
  return dict;
}

function dictCommands(key: string, d: DnsDict & { SupplementalMatchDomains?: string[] }): string {
  const lines = ['d.init'];
  if (d.ServerAddresses?.length) lines.push(`d.add ServerAddresses * ${d.ServerAddresses.join(' ')}`);
  if (d.SearchDomains?.length) lines.push(`d.add SearchDomains * ${d.SearchDomains.join(' ')}`);
  if (d.SupplementalMatchDomains?.length) lines.push(`d.add SupplementalMatchDomains * ${d.SupplementalMatchDomains.join(' ')}`);
  if (d.DomainName) lines.push(`d.add DomainName ${d.DomainName}`);
  lines.push(`set ${key}`);
  return `${lines.join('\n')}\n`;
}

/**
 * macOS: routes via netstat/route, DNS via the System Configuration dynamic store.
 *  - split DNS: our own State:/Network/Service/multi-openvpn-<id>/DNS key with
 *    SupplementalMatchDomains → a scoped resolver; several VPNs never conflict.
 *  - global DNS: override State:/Network/Service/<primary>/DNS, keeping a backup on disk.
 */
export class MacNetworkService implements PlatformNetworkService {
  private readonly backups: StateFile<DnsBackup>;

  constructor(stateDir: string) {
    this.backups = new StateFile(stateDir, 'dns-backup.json');
  }

  async getRoutes(): Promise<RouteEntry[]> {
    return parseNetstatRoutes(await run('/usr/sbin/netstat', ['-rn']));
  }

  async addRoute(r: RouteSpec): Promise<void> {
    await run('/sbin/route', ['-n', 'add', ...routeArgs(r)]);
  }

  async removeRoute(r: RouteSpec): Promise<void> {
    await run('/sbin/route', ['-n', 'delete', ...routeArgs(r)]);
  }

  async getCurrentDns(): Promise<string[]> {
    return parseScutilDict(await scutil('show State:/Network/Global/DNS\n', true))?.ServerAddresses ?? [];
  }

  async setDns(connectionId: string, dns: DnsSettings): Promise<void> {
    validateDns(connectionId, dns);
    await this.restoreDns(connectionId); // re-apply replaces, never stacks
    const all = this.backups.read();
    if (dns.scope === 'split') {
      const key = `${KEY_PREFIX}${connectionId}/DNS`;
      all[connectionId] = { key };
      this.backups.write(all); // record before changing, so a crash in between is still undone
      await this.applyOrForget(connectionId, key, null, () =>
        setAndVerify(key, dictCommands(key, { ServerAddresses: dns.servers, SupplementalMatchDomains: dns.domains }), dns.servers),
      );
    } else {
      const primary = /PrimaryService : (\S+)/.exec(await scutil('show State:/Network/Global/IPv4\n', true))?.[1];
      if (!primary || !/^[\w-]+$/.test(primary)) throw new Error('No primary network service');
      const key = `State:/Network/Service/${primary}/DNS`;
      const original = parseScutilDict(await scutil(`show ${key}\n`, true));
      all[connectionId] = { key, original };
      this.backups.write(all);
      await this.applyOrForget(connectionId, key, original, () =>
        setAndVerify(key, dictCommands(key, { ServerAddresses: dns.servers, SearchDomains: dns.domains.length ? dns.domains : undefined }), dns.servers),
      );
    }
    await this.flushCache();
  }

  async restoreDns(connectionId: string): Promise<void> {
    const all = this.backups.read();
    const b = all[connectionId];
    if (!b) return;
    if (b.original) await scutil(dictCommands(b.key, b.original));
    else await scutil(`remove ${b.key}\n`, true);
    delete all[connectionId];
    this.backups.write(all);
    await this.flushCache();
  }

  async restoreAllDns(keep: string[]): Promise<void> {
    for (const id of Object.keys(this.backups.read())) if (!keep.includes(id)) await this.restoreDns(id).catch(() => undefined);
    // Keys of ours without a backup entry (e.g. state file lost): remove them too.
    const listed = await scutil(`list ${KEY_PREFIX}.*\n`, true).catch(() => '');
    for (const m of listed.matchAll(/(State:\/Network\/Service\/multi-openvpn-([0-9a-f-]{36})\/DNS)/gi)) {
      if (!keep.includes(m[2])) await scutil(`remove ${m[1]}\n`, true).catch(() => undefined);
    }
  }

  /**
   * Runs a change; if it fails and the store is provably unchanged (e.g. permission denied),
   * forgets the backup entry so nothing is left to "restore" later.
   */
  private async applyOrForget(connectionId: string, key: string, original: DnsDict | null, apply: () => Promise<void>): Promise<void> {
    try {
      await apply();
    } catch (err) {
      const now = parseScutilDict(await scutil(`show ${key}\n`, true).catch(() => ''));
      if (JSON.stringify(now) === JSON.stringify(original)) {
        const all = this.backups.read();
        delete all[connectionId];
        this.backups.write(all);
      }
      throw err;
    }
  }

  private async flushCache(): Promise<void> {
    await run('/usr/bin/dscacheutil', ['-flushcache']).catch(() => undefined);
    await run('/usr/bin/killall', ['-HUP', 'mDNSResponder']).catch(() => undefined);
  }
}
