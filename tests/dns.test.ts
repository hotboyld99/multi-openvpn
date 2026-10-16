import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DnsManager, planDns, type DnsRequest } from '../src/main/network/DnsManager';
import { MacNetworkService, parseScutilDict } from '../src/main/platform/macos/MacNetworkService';
import { validateDns, type DnsSettings, type PlatformNetworkService } from '../src/main/platform/PlatformNetworkService';
import { classifyLine, dnsFromOptions } from '../src/main/vpn/LogClassifier';

describe('pushed DNS parsing', () => {
  it('reads dhcp-option and OpenVPN 2.6 dns options', () => {
    expect(dnsFromOptions(['dhcp-option DNS 10.8.0.1', 'dhcp-option DNS 10.8.0.2', 'dhcp-option DOMAIN Corp.Example.com.', 'dhcp-option DNS6 fd00::53'])).toEqual({
      servers: ['10.8.0.1', '10.8.0.2', 'fd00::53'],
      domains: ['corp.example.com'],
    });
    expect(dnsFromOptions(['dns server 0 address 10.9.0.1 10.9.0.2', 'dns search-domains a.local b.local'])).toEqual({
      servers: ['10.9.0.1', '10.9.0.2'],
      domains: ['a.local', 'b.local'],
    });
  });

  it('extracts DNS from a PUSH_REPLY log line', () => {
    const line = "PUSH: Received control message: 'PUSH_REPLY,route 10.8.0.0 255.255.255.0,dhcp-option DNS 10.8.0.1,dhcp-option DOMAIN corp.local,route-gateway 10.8.0.1,topology subnet,ifconfig 10.8.0.6 255.255.255.0'";
    expect(classifyLine(line).dns).toEqual({ servers: ['10.8.0.1'], domains: ['corp.local'] });
    expect(classifyLine("PUSH: Received control message: 'PUSH_REPLY,route-gateway 10.8.0.1'").dns).toBeUndefined();
  });
});

const req = (over: Partial<DnsRequest> = {}): DnsRequest => ({
  connectionId: randomUUID(),
  label: 'VPN',
  mode: 'vpn',
  pushed: { servers: ['10.8.0.1'], domains: [] },
  ownsDefaultRoute: false,
  ...over,
});

describe('planDns', () => {
  it('split DNS when the VPN has domains and does not own the default route', () => {
    expect(planDns(req({ pushed: { servers: ['10.8.0.1'], domains: ['corp.local'] } }))).toMatchObject({ scope: 'split', applied: true });
  });

  it('global DNS without domains or when the VPN owns the default route', () => {
    expect(planDns(req())).toMatchObject({ scope: 'global', applied: true });
    expect(planDns(req({ ownsDefaultRoute: true, pushed: { servers: ['10.8.0.1'], domains: ['corp.local'] } }))).toMatchObject({ scope: 'global' });
  });

  it('a second global DNS is a conflict and is not applied', () => {
    const plan = planDns(req({ label: 'Office' }), { connectionId: randomUUID(), label: 'Singapore', servers: ['10.9.0.1'] });
    expect(plan).toMatchObject({ scope: 'global', applied: false });
    expect(plan.warning).toContain('Singapore');
  });

  it('system mode and missing servers change nothing; custom uses the profile servers globally', () => {
    expect(planDns(req({ mode: 'system' }))).toMatchObject({ scope: 'none', applied: false });
    expect(planDns(req({ pushed: { servers: [], domains: ['x.local'] } }))).toMatchObject({ scope: 'none' });
    expect(planDns(req({ mode: 'custom', customServers: ['1.1.1.1', '8.8.8.8'], pushed: { servers: ['10.8.0.1'], domains: ['corp.local'] } }))).toEqual({
      mode: 'custom',
      scope: 'global',
      servers: ['1.1.1.1', '8.8.8.8'],
      domains: [],
      applied: true,
    });
  });
});

class FakePlatform implements PlatformNetworkService {
  dns = new Map<string, DnsSettings>();
  calls: string[] = [];
  fail = false;
  async getRoutes() {
    return [];
  }
  async addRoute() {}
  async removeRoute() {}
  async getCurrentDns() {
    return [...this.dns.values()].find((d) => d.scope === 'global')?.servers ?? ['192.168.1.1'];
  }
  async setDns(id: string, d: DnsSettings) {
    this.calls.push(`set ${id.slice(0, 4)} ${d.scope}`);
    if (this.fail) throw new Error('Permission denied');
    this.dns.set(id, d);
  }
  async restoreDns(id: string) {
    this.calls.push(`restore ${id.slice(0, 4)}`);
    this.dns.delete(id);
  }
  async restoreAllDns(keep: string[]) {
    this.calls.push(`restoreAll ${keep.length}`);
    for (const id of this.dns.keys()) if (!keep.includes(id)) this.dns.delete(id);
  }
}

describe('DnsManager', () => {
  it('one global owner; split DNS coexists; restore frees the global slot', async () => {
    const platform = new FakePlatform();
    const m = new DnsManager(platform);
    const a = req({ label: 'Singapore', ownsDefaultRoute: true });
    const b = req({ label: 'Staging' });
    const c = req({ label: 'Dev', pushed: { servers: ['10.20.0.53'], domains: ['dev.internal'] } });

    expect(await m.setDns(a)).toMatchObject({ scope: 'global', applied: true });
    expect(await m.setDns(b)).toMatchObject({ scope: 'global', applied: false });
    expect(await m.setDns(c)).toMatchObject({ scope: 'split', applied: true });
    expect([...platform.dns.keys()].sort()).toEqual([a.connectionId, c.connectionId].sort());
    expect(m.globalOwner()?.label).toBe('Singapore');

    await m.restore(a.connectionId);
    expect(platform.dns.has(a.connectionId)).toBe(false);
    expect(m.globalOwner()).toBeUndefined();
    expect(await m.setDns(b)).toMatchObject({ scope: 'global', applied: true }); // B can have it now
  });

  it('re-applying for the same connection restores first (no stacking)', async () => {
    const platform = new FakePlatform();
    const m = new DnsManager(platform);
    const a = req();
    await m.setDns(a);
    await m.setDns(a);
    expect(platform.calls).toEqual([`set ${a.connectionId.slice(0, 4)} global`, `restore ${a.connectionId.slice(0, 4)}`, `set ${a.connectionId.slice(0, 4)} global`]);
  });

  it('a platform failure is reported, rolled back, and does not take the global slot', async () => {
    const platform = new FakePlatform();
    platform.fail = true;
    const m = new DnsManager(platform);
    const state = await m.setDns(req());
    expect(state.applied).toBe(false);
    expect(state.warning).toMatch(/Permission denied/);
    expect(platform.calls.at(-1)).toMatch(/^restore/);
    expect(m.globalOwner()).toBeUndefined();
  });

  it('recover() undoes everything a crashed run left', async () => {
    const platform = new FakePlatform();
    platform.dns.set(randomUUID(), { servers: ['10.8.0.1'], domains: [], scope: 'global' });
    await new DnsManager(platform).recover();
    expect(platform.dns.size).toBe(0);
  });
});

describe('DNS values are validated before reaching system commands', () => {
  const id = randomUUID();
  it('rejects anything that is not an IP / domain / interface name', () => {
    expect(() => validateDns(id, { servers: ['10.8.0.1'], domains: ['corp.local'], scope: 'split' })).not.toThrow();
    expect(() => validateDns(id, { servers: ['10.8.0.1\nremove State:/Network/Global/IPv4'], domains: [], scope: 'global' })).toThrow(/servers/);
    expect(() => validateDns(id, { servers: ['10.8.0.1'], domains: ['corp.local\nd.init'], scope: 'split' })).toThrow(/domains/);
    expect(() => validateDns(id, { servers: ['10.8.0.1'], domains: [], scope: 'global', interfaceName: "x'; Remove-Item C:\\" })).toThrow(/interface/);
    expect(() => validateDns('../etc', { servers: ['10.8.0.1'], domains: [], scope: 'global' })).toThrow(/connection id/);
  });
});

describe('macOS scutil', () => {
  it('parses scutil dictionaries', () => {
    const out = `<dictionary> {\n  DomainName : corp.local\n  SearchDomains : <array> {\n    0 : corp.local\n  }\n  ServerAddresses : <array> {\n    0 : 1.1.1.1\n    1 : 1.0.0.1\n  }\n}\n`;
    expect(parseScutilDict(out)).toEqual({ ServerAddresses: ['1.1.1.1', '1.0.0.1'], SearchDomains: ['corp.local'], DomainName: 'corp.local' });
    expect(parseScutilDict('  No such key\n')).toBeNull();
  });

  it.runIf(process.platform === 'darwin' && process.getuid?.() !== 0)('without root, setDns fails loudly and leaves no backup behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mov-dns-'));
    const mac = new MacNetworkService(dir);
    const current = await mac.getCurrentDns();
    expect(Array.isArray(current)).toBe(true);
    const id = randomUUID();
    await expect(mac.setDns(id, { servers: ['10.99.0.53'], domains: ['test.invalid'], scope: 'split' })).rejects.toThrow(/Permission denied|not updated/);
    // The manager rolls back; restoreDns must then clear the recorded backup.
    await mac.restoreDns(id);
    expect(JSON.parse(readFileSync(join(dir, 'dns-backup.json'), 'utf8'))).toEqual({});
    expect(await mac.getCurrentDns()).toEqual(current);
  });
});
