import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeRoutes, leftoverRoutes } from '../src/main/network/RouteManager';
import { cidrToRoute, normalizeNetstatV4, parseIpJsonRoutes, parseNetstatRoutes, parseWindowsRoutes } from '../src/main/network/routeParsers';
import { decideDefaultRoute, directivesToStrip, resolveCustomRoutes, routingArgs } from '../src/main/network/routingPolicy';
import { OpenVpnDriver, writeRuntimeConfig } from '../src/main/vpn/OpenVpnDriver';
import type { DriverContext, VpnDriver } from '../src/main/vpn/VpnDriver';
import { RouteConflictError, VpnManager } from '../src/main/vpn/VpnManager';
import { VpnProcessManager } from '../src/main/vpn/VpnProcessManager';
import type { VpnConnection, VpnProfile } from '../src/shared/types';
import { createLab, labProfile, waitFor, type Lab } from './helpers/openvpnLab';

const NETSTAT = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            172.20.16.1        UGScg                 en0
0/1                10.8.0.5           UGSc                utun5
1.52.30.70/32      172.27.105.1       UGSc                utun4
10.1.3/24          172.27.105.1       UGSc                utun4
127                127.0.0.1          UCS                   lo0
128.0/1            10.8.0.5           UGSc                utun5
169.254            link#4             UCS                   en0      !
172.20.16.1        a0:63:91:1:2:3     UHLWIir               en0   1188
203.0.113.7/32     172.20.16.1        UGSc                  en0

Internet6:
Destination                             Gateway                                 Flags               Netif Expire
default                                 fe80::%utun0                            UGcIg               utun0
::1                                     ::1                                     UHL                   lo0
fd00::/64                               fd00::1                                 UGSc                utun5
`;

describe('route table parsers', () => {
  it('parses macOS netstat, normalizing abbreviated networks and skipping ARP entries', () => {
    const r = parseNetstatRoutes(NETSTAT);
    const v4 = r.filter((x) => x.family === 'IPv4').map((x) => `${x.destination} ${x.gateway || 'on-link'} ${x.interface}`);
    expect(v4).toEqual([
      '0.0.0.0/0 172.20.16.1 en0',
      '0.0.0.0/1 10.8.0.5 utun5',
      '1.52.30.70/32 172.27.105.1 utun4',
      '10.1.3.0/24 172.27.105.1 utun4',
      '127.0.0.0/8 127.0.0.1 lo0',
      '128.0.0.0/1 10.8.0.5 utun5',
      '169.254.0.0/16 on-link en0',
      '203.0.113.7/32 172.20.16.1 en0',
    ]);
    expect(r.filter((x) => x.family === 'IPv6').map((x) => x.destination)).toEqual(['::/0', '::1/128', 'fd00::/64']);
  });

  it('normalizes netstat destinations', () => {
    expect(normalizeNetstatV4('10.8/16', 'UGSc')).toBe('10.8.0.0/16');
    expect(normalizeNetstatV4('192.168.1', 'UCS')).toBe('192.168.1.0/24');
    expect(normalizeNetstatV4('10.8.0.1', 'UH')).toBe('10.8.0.1/32');
  });

  it('parses Windows Get-NetRoute JSON (array or single object)', () => {
    const json = JSON.stringify([
      { DestinationPrefix: '0.0.0.0/0', NextHop: '192.168.1.1', InterfaceAlias: 'Wi-Fi', RouteMetric: 0, AddressFamily: 2 },
      { DestinationPrefix: '10.8.0.0/24', NextHop: '0.0.0.0', InterfaceAlias: 'OpenVPN Wintun', RouteMetric: 256, AddressFamily: 2 },
      { DestinationPrefix: '::/0', NextHop: '::', InterfaceAlias: 'Wi-Fi', RouteMetric: 0, AddressFamily: 23 },
    ]);
    expect(parseWindowsRoutes(json)).toEqual([
      { destination: '0.0.0.0/0', gateway: '192.168.1.1', interface: 'Wi-Fi', family: 'IPv4', metric: 0 },
      { destination: '10.8.0.0/24', gateway: '', interface: 'OpenVPN Wintun', family: 'IPv4', metric: 256 },
      { destination: '::/0', gateway: '', interface: 'Wi-Fi', family: 'IPv6', metric: 0 },
    ]);
    expect(parseWindowsRoutes(JSON.stringify({ DestinationPrefix: '1.2.3.4/32', NextHop: '10.0.0.1', InterfaceAlias: 'X' }))).toHaveLength(1);
  });

  it('parses Linux ip -j route', () => {
    const json = JSON.stringify([
      { dst: 'default', gateway: '192.168.1.1', dev: 'wlan0', metric: 600 },
      { dst: '10.8.0.0/24', dev: 'tun0' },
      { dst: '10.8.0.1', dev: 'tun0' },
    ]);
    expect(parseIpJsonRoutes(json, 'IPv4').map((r) => r.destination)).toEqual(['0.0.0.0/0', '10.8.0.0/24', '10.8.0.1/32']);
  });

  it('converts CIDR to network/netmask, clearing host bits', () => {
    expect(cidrToRoute('10.20.0.0/16')).toEqual({ network: '10.20.0.0', netmask: '255.255.0.0' });
    expect(cidrToRoute('192.168.10.55/32')).toEqual({ network: '192.168.10.55', netmask: '255.255.255.255' });
    expect(cidrToRoute('172.16.20.9/24')).toEqual({ network: '172.16.20.0', netmask: '255.255.255.0' });
    expect(cidrToRoute('0.0.0.0/0')).toEqual({ network: '0.0.0.0', netmask: '0.0.0.0' });
  });
});

describe('routing policy', () => {
  const p = (x: Partial<VpnProfile> = {}) => ({ routingMode: 'config' as const, ...x });

  it('decides who may take the default route', () => {
    expect(decideDefaultRoute({ profile: p(), holderExists: false })).toEqual({ defaultRoute: 'take' });
    expect(decideDefaultRoute({ profile: p(), holderExists: true })).toEqual({ defaultRoute: 'skip' });
    expect(decideDefaultRoute({ profile: p({ wantsDefaultRoute: true }), holderExists: true })).toEqual({ conflict: true });
    expect(decideDefaultRoute({ profile: p({ pushesDefaultRoute: true }), holderExists: true })).toEqual({ conflict: true });
    expect(decideDefaultRoute({ profile: p({ wantsDefaultRoute: true }), holderExists: true, choice: 'take' })).toEqual({ defaultRoute: 'take' });
    expect(decideDefaultRoute({ profile: p({ wantsDefaultRoute: true, ignoreRedirectGateway: true }), holderExists: false })).toEqual({ defaultRoute: 'skip' });
    expect(decideDefaultRoute({ profile: p({ routingMode: 'custom' }), holderExists: false, choice: 'take' })).toEqual({ defaultRoute: 'skip' });
  });

  it('builds pull filters and routes; accept route-gateway comes before ignore route', () => {
    const routes = { v4: [{ network: '10.20.0.0', netmask: '255.255.0.0', source: '10.20.0.0/16' }], v6: [{ cidr: 'fd00:1::/64', source: 'fd00:1::/64' }], failed: [] };
    expect(routingArgs({ defaultRoute: 'skip', mode: 'config', pulls: true })).toEqual(['--pull-filter', 'ignore', 'redirect-gateway', '--pull-filter', 'ignore', 'redirect-private']);
    expect(routingArgs({ defaultRoute: 'take', mode: 'config', pulls: true })).toEqual([]);
    const custom = routingArgs({ defaultRoute: 'skip', mode: 'custom', pulls: true, routes });
    expect(custom.join(' ')).toBe(
      '--pull-filter accept route-gateway --pull-filter accept route-metric --pull-filter ignore route --pull-filter ignore redirect- --route 10.20.0.0 255.255.0.0 --route-ipv6 fd00:1::/64',
    );
    expect(routingArgs({ defaultRoute: 'skip', mode: 'custom', pulls: false, routes })).toEqual(['--route', '10.20.0.0', '255.255.0.0', '--route-ipv6', 'fd00:1::/64']);
    expect(directivesToStrip({ defaultRoute: 'skip', mode: 'config', pulls: true })).toEqual(['redirect-gateway', 'redirect-private']);
    expect(directivesToStrip({ defaultRoute: 'skip', mode: 'custom', pulls: true })).toContain('route');
  });

  it('resolves custom rules; hostnames resolve to host routes and failures are reported', async () => {
    const lookup = async (h: string) => {
      if (h === 'internal.company.com') return [{ address: '10.30.1.5', family: 4 }, { address: 'fd00::5', family: 6 }];
      throw new Error('ENOTFOUND');
    };
    const r = await resolveCustomRoutes(
      [
        { id: randomUUID(), type: 'cidr', value: '10.20.0.0/16' },
        { id: randomUUID(), type: 'ip', value: '192.168.1.100' },
        { id: randomUUID(), type: 'hostname', value: 'internal.company.com' },
        { id: randomUUID(), type: 'hostname', value: 'gone.company.com' },
      ],
      lookup,
    );
    expect(r.v4.map((x) => `${x.network}/${x.netmask}`)).toEqual(['10.20.0.0/255.255.0.0', '192.168.1.100/255.255.255.255', '10.30.1.5/255.255.255.255']);
    expect(r.v6.map((x) => x.cidr)).toEqual(['fd00::5/128']);
    expect(r.failed).toEqual([{ rule: 'gone.company.com', reason: 'ENOTFOUND' }]);
  });
});

const conn = (over: Partial<VpnConnection>): VpnConnection => ({
  id: randomUUID(),
  profileId: randomUUID(),
  status: 'CONNECTED',
  startedAt: 0,
  bytesIn: 0,
  bytesOut: 0,
  rateIn: 0,
  rateOut: 0,
  reconnectCount: 0,
  ...over,
});

describe('route attribution', () => {
  it('attributes routes by interface and flags destinations installed by two VPNs', () => {
    const a = conn({ interfaceName: 'utun4' });
    const b = conn({ interfaceName: 'utun5' });
    const routes = parseNetstatRoutes(NETSTAT).concat({ destination: '10.1.3.0/24', gateway: '10.8.0.5', interface: 'utun5', family: 'IPv4' });
    const info = attributeRoutes(routes, [a, b]);
    const by = (d: string, i: string) => info.find((r) => r.destination === d && r.interface === i)!;
    expect(by('0.0.0.0/0', 'en0').connectionId).toBeUndefined();
    expect(by('0.0.0.0/0', 'en0').isDefault).toBe(true);
    expect(by('0.0.0.0/1', 'utun5')).toMatchObject({ connectionId: b.id, isDefault: true });
    expect(by('1.52.30.70/32', 'utun4').connectionId).toBe(a.id);
    expect(by('1.52.30.70/32', 'utun4').conflict).toBeUndefined();
    expect(by('10.1.3.0/24', 'utun4').conflict).toBe(true);
    expect(by('10.1.3.0/24', 'utun5').conflict).toBe(true);
  });

  it('finds the server host route a crashed default-route VPN left on the physical interface', () => {
    const crashed = conn({ status: 'ERROR', interfaceName: 'utun5', remote: '203.0.113.7', ownsDefaultRoute: true });
    const routes = parseNetstatRoutes(NETSTAT);
    expect(leftoverRoutes(crashed, routes, [crashed]).map((r) => r.destination)).toEqual(['203.0.113.7/32']);
    // still needed by another live VPN to the same server: keep it
    const other = conn({ interfaceName: 'utun6', remote: '203.0.113.7' });
    expect(leftoverRoutes(crashed, routes, [crashed, other])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('VpnManager default-route ownership', () => {
  class Fake implements VpnDriver {
    constructor(readonly ctx: DriverContext) {}
    async start() {}
    async stop() {
      this.ctx.emit({ type: 'exit', code: 0, signal: null });
    }
  }
  const prof = (name: string, extra: Partial<VpnProfile> = {}): VpnProfile => ({
    id: randomUUID(),
    name,
    configPath: 'x',
    configFileName: 'x',
    hasSavedPassword: false,
    autoConnect: false,
    reconnect: false,
    routingMode: 'config',
    dnsMode: 'vpn',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  });
  function setup(profiles: VpnProfile[]) {
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const drivers: Fake[] = [];
    const manager = new VpnManager({
      getProfile: (id) => byId.get(id),
      createDriver: (ctx) => {
        const d = new Fake(ctx);
        drivers.push(d);
        return d;
      },
    });
    const last = (p: VpnProfile) => drivers.filter((d) => d.ctx.profile.id === p.id).at(-1)!;
    const up = (p: VpnProfile, pushed = false) => {
      if (pushed) last(p).ctx.emit({ type: 'netinfo', pushedDefaultRoute: true });
      last(p).ctx.emit({ type: 'state', state: 'CONNECTED' });
    };
    return { manager, last, up };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('the first VPN takes the default route; a second one that wants it is a conflict', async () => {
    const sg = prof('Singapore', { wantsDefaultRoute: true });
    const office = prof('Office', { wantsDefaultRoute: true });
    const { manager, last, up } = setup([sg, office]);
    const a = manager.connect(sg.id);
    await tick();
    expect(last(sg).ctx.routing.defaultRoute).toBe('take');
    up(sg);
    expect(manager.get(a)!.ownsDefaultRoute).toBe(true);

    expect(() => manager.connect(office.id)).toThrow(RouteConflictError);
    try {
      manager.connect(office.id);
    } catch (e) {
      expect(e).toMatchObject({ holderConnectionId: a, holderProfileId: sg.id });
    }
  });

  it('two VPNs started together cannot both take the default route', async () => {
    const x = prof('x');
    const y = prof('y');
    const { manager, last } = setup([x, y]);
    manager.connect(x.id);
    manager.connect(y.id);
    await tick();
    expect(last(x).ctx.routing.defaultRoute).toBe('take');
    expect(last(y).ctx.routing.defaultRoute).toBe('skip');
  });

  it('a holder that turns out not to redirect releases the reservation', async () => {
    const x = prof('x');
    const y = prof('y', { wantsDefaultRoute: true });
    const { manager, up } = setup([x, y]);
    const a = manager.connect(x.id);
    await tick();
    up(x); // no redirect-gateway pushed
    expect(manager.get(a)!.ownsDefaultRoute).toBe(false);
    expect(() => manager.connect(y.id)).not.toThrow();
  });

  it('a server-pushed redirect on a skipped VPN is ignored, reported and learned', async () => {
    const sg = prof('sg', { wantsDefaultRoute: true });
    const office = prof('office');
    const { manager, up } = setup([sg, office]);
    const learned: string[] = [];
    manager.on('pushesDefaultRoute', (id) => learned.push(id));
    manager.connect(sg.id);
    await tick();
    up(sg);
    const b = manager.connect(office.id);
    await tick();
    up(office, true);
    expect(manager.get(b)).toMatchObject({ defaultRoute: 'skip', ignoredDefaultRoute: true, ownsDefaultRoute: false });
    expect(learned).toEqual([office.id]);
  });

  it('keep connects without the default route; replace moves the current owner off it', async () => {
    const sg = prof('sg', { wantsDefaultRoute: true });
    const office = prof('office', { wantsDefaultRoute: true });
    const { manager, last, up } = setup([sg, office]);
    const a = manager.connect(sg.id);
    await tick();
    up(sg);

    const keep = manager.connect(office.id, { defaultRoute: 'skip' });
    await tick();
    expect(last(office).ctx.routing.defaultRoute).toBe('skip');
    await manager.disconnect(keep);

    manager.connect(office.id, { defaultRoute: 'take', replaceDefault: true });
    await tick();
    await tick();
    expect(last(office).ctx.routing.defaultRoute).toBe('take');
    expect(last(sg).ctx.routing.defaultRoute).toBe('skip'); // sg reconnected without it
    expect(manager.get(a)!.reconnectCount).toBe(1);
    up(office);
    up(sg);
    expect(manager.defaultRouteHolder()?.profileId).toBe(office.id);
  });
});

// ---------------------------------------------------------------------------
// Real openvpn: the runtime config drops redirect-gateway when the VPN must not take the default route.

let lab: Lab | null = null;
beforeAll(async () => {
  lab = await createLab();
}, 30_000);
afterAll(() => lab?.cleanup());
const managers: VpnManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disconnectAll()));
});

describe('runtime config', () => {
  it('comments out stripped directives (also inside <connection>) and leaves the profile untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mov-rt-'));
    const profileCfg = join(dir, 'config.ovpn');
    const text = 'client\nremote a 1194\nredirect-gateway def1\nroute 10.0.0.0 255.0.0.0\n<connection>\nremote b 1194\n</connection>\n';
    writeFileSync(profileCfg, text);
    const rt = await writeRuntimeConfig(profileCfg, dir, ['redirect-gateway', 'route']);
    const out = readFileSync(rt.path, 'utf8');
    expect(out).toContain('# [routing policy] redirect-gateway def1');
    expect(out).toContain('# [routing policy] route 10.0.0.0 255.0.0.0');
    expect(out).toContain('remote a 1194');
    expect(rt.pulls).toBe(true);
    expect(readFileSync(profileCfg, 'utf8')).toBe(text);
  });
});

describe('routing policy with real openvpn', () => {
  it('connects with redirect-gateway filtered out while the stored profile keeps it', async (ctx) => {
    if (!lab) return ctx.skip();
    const port = await lab.startServer();
    const cfgPath = lab.clientConfig('rg', port, ['redirect-gateway def1']);
    const profile = labProfile('rg', cfgPath, { wantsDefaultRoute: true });
    const processes = new VpnProcessManager(join(lab.dir, 'run-rg'));
    const manager = new VpnManager({
      getProfile: () => profile,
      createDriver: (c) => new OpenVpnDriver(c, { processes, binary: () => lab!.binary, stopTimeoutMs: 3_000 }),
    });
    managers.push(manager);
    const id = manager.connect(profile.id, { defaultRoute: 'skip' });
    await waitFor(manager, id, 'CONNECTED');
    expect(manager.getLogs(id).map((l) => l.message)).toContain('Routing policy: default route not taken');
    expect(manager.get(id)!.ownsDefaultRoute).toBe(false);
    expect(readFileSync(cfgPath, 'utf8')).toContain('\nredirect-gateway def1\n');
  }, 30_000);
});
