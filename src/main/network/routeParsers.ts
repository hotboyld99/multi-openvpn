// Pure parsers for OS route tables and small CIDR helpers. No I/O.

export interface RouteEntry {
  destination: string; // CIDR, normalized ("0.0.0.0/0", "10.8.0.0/24", "::/0")
  gateway: string; // IP, "link#4", or "" for on-link
  interface: string;
  family: 'IPv4' | 'IPv6';
  metric?: number;
  flags?: string;
}

const MAC = /^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/i;

/** macOS netstat abbreviates networks: "10.8/16" → 10.8.0.0/16, "127" → 127.0.0.0/8, "0/1" → 0.0.0.0/1. */
export function normalizeNetstatV4(dest: string, flags: string): string {
  if (dest === 'default') return '0.0.0.0/0';
  const [base, mask] = dest.split('/');
  const parts = base.split('.');
  const bits = mask !== undefined ? Number(mask) : flags.includes('H') ? 32 : parts.length * 8;
  while (parts.length < 4) parts.push('0');
  return `${parts.join('.')}/${bits}`;
}

function normalizeNetstatV6(dest: string, flags: string): string {
  if (dest === 'default') return '::/0';
  if (dest.includes('/')) return dest;
  return `${dest}/${flags.includes('H') ? 128 : 64}`;
}

/** `netstat -rn` (macOS/BSD), both Internet and Internet6 sections. */
export function parseNetstatRoutes(output: string): RouteEntry[] {
  const routes: RouteEntry[] = [];
  let family: 'IPv4' | 'IPv6' | null = null;
  for (const line of output.split('\n')) {
    if (/^Internet:/.test(line)) family = 'IPv4';
    else if (/^Internet6:/.test(line)) family = 'IPv6';
    if (!family || /^(Internet|Destination|Routing)/.test(line) || !line.trim()) continue;
    const [dest, gateway, flags = '', netif] = line.trim().split(/\s+/);
    if (!dest || !netif || MAC.test(gateway)) continue; // skip ARP/NDP cache entries
    routes.push({
      destination: family === 'IPv4' ? normalizeNetstatV4(dest, flags) : normalizeNetstatV6(dest, flags),
      gateway: gateway.startsWith('link#') ? '' : gateway,
      interface: netif,
      family,
      flags,
    });
  }
  return routes;
}

/** `Get-NetRoute | Select DestinationPrefix,NextHop,InterfaceAlias,RouteMetric,AddressFamily | ConvertTo-Json`. */
export function parseWindowsRoutes(json: string): RouteEntry[] {
  if (!json.trim()) return [];
  const raw = JSON.parse(json) as unknown;
  const rows = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
  return rows.map((r) => {
    const af = r.AddressFamily;
    const family = af === 23 || af === 'IPv6' || String(r.DestinationPrefix).includes(':') ? 'IPv6' : 'IPv4';
    const hop = String(r.NextHop ?? '');
    return {
      destination: String(r.DestinationPrefix),
      gateway: hop === '0.0.0.0' || hop === '::' ? '' : hop,
      interface: String(r.InterfaceAlias ?? ''),
      family,
      metric: typeof r.RouteMetric === 'number' ? r.RouteMetric : undefined,
    };
  });
}

/** `ip -j route show` / `ip -j -6 route show` (Linux). */
export function parseIpJsonRoutes(json: string, family: 'IPv4' | 'IPv6'): RouteEntry[] {
  if (!json.trim()) return [];
  return (JSON.parse(json) as Record<string, unknown>[]).map((r) => {
    const dst = String(r.dst);
    return {
      destination: dst === 'default' ? (family === 'IPv4' ? '0.0.0.0/0' : '::/0') : dst.includes('/') ? dst : `${dst}/${family === 'IPv4' ? 32 : 128}`,
      gateway: String(r.gateway ?? ''),
      interface: String(r.dev ?? ''),
      family,
      metric: typeof r.metric === 'number' ? r.metric : undefined,
    };
  });
}

/** Default route, or the halves openvpn installs for redirect-gateway def1. */
export const isDefaultDestination = (cidr: string): boolean =>
  ['0.0.0.0/0', '0.0.0.0/1', '128.0.0.0/1', '::/0', '::/1', '8000::/1', '::/3', '2000::/4', '3000::/4', 'fc00::/7'].includes(cidr);

export function prefixToNetmask(bits: number): string {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((s) => (mask >>> s) & 255).join('.');
}

/** "10.20.0.0/16" → { network: "10.20.0.0", netmask: "255.255.0.0" }; host bits are cleared. */
export function cidrToRoute(cidr: string): { network: string; netmask: string } {
  const [ip, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  const n = ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (n & mask) >>> 0;
  return { network: [24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.'), netmask: prefixToNetmask(bits) };
}
