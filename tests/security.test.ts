import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelperClient } from '../src/main/helper/HelperClient';
import { HelperServer } from '../src/main/helper/HelperServer';
import { sanitizeConfigForRoot, sha256File, validateOpenVpnArgs } from '../src/main/helper/policy';
import type { HelperConfig } from '../src/main/helper/protocol';
import { routingArgs } from '../src/main/network/routingPolicy';
import type { DnsSettings, PlatformNetworkService } from '../src/main/platform/PlatformNetworkService';
import { CredentialStore, type SecretCipher } from '../src/main/security/CredentialStore';
import { buildOpenVpnArgs, OpenVpnDriver } from '../src/main/vpn/OpenVpnDriver';
import type { DriverContext, VpnDriver } from '../src/main/vpn/VpnDriver';
import { VpnManager } from '../src/main/vpn/VpnManager';
import { VpnProcessManager } from '../src/main/vpn/VpnProcessManager';
import { vpnError } from '../src/shared/errors';
import { VpnErrorCode, type SecretInput, type VpnProfile } from '../src/shared/types';
import { alive, createLab, labProfile, waitFor, type Lab } from './helpers/openvpnLab';

// ---------------------------------------------------------------------------
describe('CredentialStore', () => {
  // XOR "encryption" stands in for safeStorage (Keychain/DPAPI) in tests.
  const cipher = (opts: { available?: boolean; weak?: boolean } = {}): SecretCipher => ({
    isEncryptionAvailable: () => opts.available ?? true,
    isWeak: () => opts.weak ?? false,
    encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
  });

  it('stores only ciphertext, per profile and realm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mov-cred-'));
    const store = new CredentialStore(dir, cipher());
    await store.set('p1', 'Auth', { username: 'alice', password: 'hunter2' });
    await store.set('p1', 'Private Key', { password: 'keypass' });
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toMatch(/hunter2|keypass|alice/);
    expect(await store.get('p1', 'Auth')).toEqual({ username: 'alice', password: 'hunter2' });
    expect(await store.get('p2', 'Auth')).toBeUndefined();
    await store.remove('p1', 'Auth');
    expect(await store.get('p1', 'Auth')).toBeUndefined();
    expect(await store.has('p1')).toBe(true);
    await store.remove('p1');
    expect(await store.has('p1')).toBe(false);
  });

  it('refuses to "store securely" without real OS secure storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mov-cred-'));
    for (const c of [cipher({ available: false }), cipher({ weak: true })]) {
      const store = new CredentialStore(dir, c);
      expect(store.available).toBe(false);
      await expect(store.set('p', 'Auth', { password: 'x' })).rejects.toThrow(/not available/);
    }
  });
});

describe('VpnManager with remembered credentials', () => {
  class Fake implements VpnDriver {
    constructor(readonly ctx: DriverContext) {}
    async start() {}
    async stop() {
      this.ctx.emit({ type: 'exit', code: 0, signal: null });
    }
  }
  const profile: VpnProfile = {
    id: randomUUID(), name: 'p', configPath: 'x', configFileName: 'x', hasSavedPassword: true, autoConnect: false,
    reconnect: false, routingMode: 'config', dnsMode: 'vpn', createdAt: 0, updatedAt: 0,
  };
  function setup(stored?: SecretInput) {
    const drivers: Fake[] = [];
    const manager = new VpnManager({
      getProfile: () => profile,
      createDriver: (ctx) => {
        const d = new Fake(ctx);
        drivers.push(d);
        return d;
      },
      getStoredSecret: async () => stored,
    });
    const events: string[] = [];
    manager.on('credentialsVerified', (_p, realm, s) => events.push(`verified ${realm} ${s.password}`));
    manager.on('credentialsRejected', (_p, realm) => events.push(`rejected ${realm}`));
    return { manager, drivers, events };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('uses the stored secret without prompting; a rejection makes it forgotten', async () => {
    const { manager, drivers, events } = setup({ username: 'alice', password: 'old' });
    const id = manager.connect(profile.id);
    await tick();
    expect(await drivers[0].ctx.requestSecret({ realm: 'Auth', needsUsername: true })).toEqual({ username: 'alice', password: 'old' });
    expect(manager.get(id)!.authRequest).toBeUndefined();
    drivers[0].ctx.emit({ type: 'error', error: vpnError(VpnErrorCode.AUTH_FAILED) });
    await tick();
    expect(events).toEqual(['rejected Auth']);
  });

  it('a typed secret marked "remember" is saved only after the tunnel comes up', async () => {
    const { manager, drivers, events } = setup();
    const id = manager.connect(profile.id);
    await tick();
    const answer = drivers[0].ctx.requestSecret({ realm: 'Auth', needsUsername: true });
    await tick();
    manager.submitSecret(id, { username: 'bob', password: 'right' }, true);
    await answer;
    expect(events).toEqual([]);
    drivers[0].ctx.emit({ type: 'state', state: 'CONNECTED' });
    expect(events).toEqual(['verified Auth right']);
  });

  it('a wrong typed secret is never saved', async () => {
    const { manager, drivers, events } = setup();
    const id = manager.connect(profile.id);
    await tick();
    const answer = drivers[0].ctx.requestSecret({ realm: 'Auth', needsUsername: true });
    await tick();
    manager.submitSecret(id, { username: 'bob', password: 'wrong' }, true);
    await answer;
    drivers[0].ctx.emit({ type: 'error', error: vpnError(VpnErrorCode.AUTH_FAILED) });
    await tick();
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('helper policy: command line', () => {
  const root = mkdtempSync(join(tmpdir(), 'mov-pol-'));
  const profiles = join(root, 'profiles');
  const temp = join(root, 'temp');
  mkdirSync(join(profiles, 'p1'), { recursive: true });
  mkdirSync(join(temp, 'w1'), { recursive: true });
  writeFileSync(join(profiles, 'p1', 'config.ovpn'), 'client\n');
  writeFileSync(join(temp, 'w1', 'runtime.ovpn'), 'client\n');
  writeFileSync(join(temp, 'w1', 'management.pw'), 'x\n');
  const roots = [profiles, temp];
  const good = () =>
    buildOpenVpnArgs({
      configPath: join(temp, 'w1', 'runtime.ovpn'),
      cwd: join(profiles, 'p1'),
      managementPort: 25101,
      managementPasswordFile: join(temp, 'w1', 'management.pw'),
      extra: [
        ...routingArgs({ defaultRoute: 'skip', mode: 'custom', pulls: true, routes: { v4: [{ network: '10.20.0.0', netmask: '255.255.0.0', source: '' }], v6: [{ cidr: 'fd00::/64', source: '' }], failed: [] } }),
        '--pull-filter', 'ignore', 'dns ',
      ],
    });

  it('accepts exactly what the app builds', () => {
    const v = validateOpenVpnArgs(good(), roots);
    expect(v.cd).toBe(join(profiles, 'p1'));
    expect(v.managementPort).toBe(25101);
    expect(v.extra).toContain('--route');
  });

  it.each([
    ['an extra option', [...good(), '--up', '/tmp/evil.sh']],
    ['script-security', [...good(), '--script-security', '2']],
    ['a plugin', [...good(), '--plugin', '/tmp/evil.so']],
    ['a config outside the roots', good().map((a) => (a.endsWith('runtime.ovpn') ? '/etc/openvpn/x.conf' : a))],
    ['a path escaping with ..', good().map((a) => (a.endsWith('runtime.ovpn') ? join(temp, '..', '..', 'x.ovpn') : a))],
    ['management on all interfaces', good().map((a) => (a === '127.0.0.1' ? '0.0.0.0' : a))],
    ['a privileged management port', good().map((a) => (a === '25101' ? '80' : a))],
    ['a pull filter with a newline', [...good(), '--pull-filter', 'ignore', 'x\nup']],
    ['a malformed route', [...good(), '--route', '10.0.0.0;id', '255.0.0.0']],
    ['a truncated option', [...good(), '--route', '10.0.0.0']],
  ])('rejects %s', (_name, args) => {
    expect(() => validateOpenVpnArgs(args as string[], roots)).toThrow();
  });

  it('rejects a symlink inside an allowed root that points outside it', () => {
    const link = join(temp, 'w1', 'link.ovpn');
    symlinkSync('/etc/hosts', link);
    expect(() => validateOpenVpnArgs(good().map((a) => (a.endsWith('runtime.ovpn') ? link : a)), roots)).toThrow(/outside/);
  });
});

describe('helper policy: config sanitizing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mov-san-'));
  writeFileSync(join(dir, 'ca.crt'), 'CA');
  symlinkSync('/etc/hosts', join(dir, 'evil.crt'));

  it('removes file writers and script hooks, keeps the rest', () => {
    const out = sanitizeConfigForRoot('client\nremote x\nca ca.crt\nstatus /etc/sudoers\nlog /etc/passwd\nscript-security 2\nup ./x.sh\nwritepid /etc/x\n', dir);
    expect(out).toContain('ca ca.crt');
    expect(out).not.toMatch(/^(status|log|script-security|up|writepid) /m);
  });

  it.each([
    ['plugin', 'client\nplugin /tmp/evil.so\n', /plugin/],
    ['nested config', 'client\nconfig /etc/other.conf\n', /config/],
    ['iproute', 'client\niproute /tmp/evil\n', /iproute/],
    ['absolute file reference', 'client\nca /etc/shadow\n', /inside the profile folder/],
    ['parent file reference', 'client\nca ../x.crt\n', /inside the profile folder/],
    ['symlink escaping the profile', 'client\ncert evil.crt\n', /escapes/],
  ])('refuses %s', (_n, text, err) => {
    expect(() => sanitizeConfigForRoot(text, dir)).toThrow(err);
  });
});

// ---------------------------------------------------------------------------
// Helper server + client end to end. Runs unprivileged here (the lab needs no root), which
// exercises everything except the privilege itself.

class FakePlatform implements PlatformNetworkService {
  dns = new Map<string, DnsSettings>();
  async getRoutes() {
    return [];
  }
  async addRoute() {}
  async removeRoute() {}
  async getCurrentDns() {
    return [];
  }
  async setDns(id: string, d: DnsSettings) {
    this.dns.set(id, d);
  }
  async restoreDns(id: string) {
    this.dns.delete(id);
  }
  async restoreAllDns() {
    this.dns.clear();
  }
}

let lab: Lab | null = null;
beforeAll(async () => {
  lab = await createLab();
}, 30_000);
afterAll(() => lab?.cleanup());
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function startHelper(extra: Partial<HelperConfig> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'mov-helper-'));
  const roots = [join(lab!.dir), join(base, 'temp')];
  const cfg: HelperConfig = {
    token: 'a'.repeat(64),
    socketPath: join(base, 's.sock'),
    allowedRoots: roots,
    allowedBinaries: [{ path: lab!.binary.path, sha256: await sha256File(lab!.binary.path) }],
    runDir: join(base, 'run'),
    stateDir: join(base, 'state'),
    ...extra,
  };
  const platform = new FakePlatform();
  const server = new HelperServer(cfg, platform);
  await server.listen();
  cleanups.push(() => server.close());
  return { cfg, platform, base };
}

describe('privileged helper (server + client)', () => {
  it('rejects a wrong token', async (ctx) => {
    if (!lab) return ctx.skip();
    const { cfg } = await startHelper();
    await expect(HelperClient.connect(cfg.socketPath, 'b'.repeat(64))).rejects.toThrow(/Unauthorized|disconnected/);
  });

  it('runs a real connection through the helper; disconnecting the app stops openvpn and restores DNS', async (ctx) => {
    if (!lab) return ctx.skip();
    const { cfg, platform, base } = await startHelper();
    const client = await HelperClient.connect(cfg.socketPath, cfg.token);
    const port = await lab.startServer();
    const profile = labProfile('via-helper', lab.clientConfig('via-helper', port));
    const processes = new VpnProcessManager(join(base, 'temp'));
    const manager = new VpnManager({
      getProfile: () => profile,
      createDriver: (c) => new OpenVpnDriver(c, { processes, binary: () => lab!.binary, launcher: client.launcher, stopTimeoutMs: 3_000 }),
    });
    cleanups.push(() => manager.disconnectAll());
    const id = manager.connect(profile.id);
    await waitFor(manager, id, 'CONNECTED');
    const pid = manager.get(id)!.pid!;
    expect(alive(pid)).toBe(true);
    // the copy openvpn runs is the helper's sanitized one, with scripts disabled
    const { execSync } = await import('node:child_process');
    const cmd = execSync(`ps -o command= -p ${pid}`).toString();
    expect(cmd).toContain(cfg.runDir);
    expect(cmd).toContain('--script-security 1');

    await client.platform(platform).setDns(id, { servers: ['10.8.0.53'], domains: ['corp.local'], scope: 'split' });
    expect(platform.dns.has(id)).toBe(true);

    client.close(); // app quits or crashes
    await waitFor(manager, id, ['ERROR', 'DISCONNECTED']);
    const t0 = Date.now();
    while (alive(pid) && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
    while (platform.dns.size && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 50));
    expect(platform.dns.size).toBe(0);
  }, 30_000);

  it('refuses an unapproved binary and configs that load code', async (ctx) => {
    if (!lab) return ctx.skip();
    const { cfg, base } = await startHelper({ allowedBinaries: [{ path: lab.binary.path, sha256: '0'.repeat(64) }] });
    const client = await HelperClient.connect(cfg.socketPath, cfg.token);
    cleanups.push(() => client.close());
    const port = await lab.startServer();
    const processes = new VpnProcessManager(join(base, 'temp'));
    const run = async (profile: VpnProfile) => {
      const manager = new VpnManager({
        getProfile: () => profile,
        createDriver: (c) => new OpenVpnDriver(c, { processes, binary: () => lab!.binary, launcher: client.launcher, stopTimeoutMs: 3_000 }),
      });
      const id = manager.connect(profile.id);
      await waitFor(manager, id, 'ERROR');
      return manager.getLogs(id).map((l) => l.message).join('\n');
    };
    expect(await run(labProfile('hash', lab.clientConfig('hash', port)))).toMatch(/not approved/);

    const ok = await startHelper();
    const client2 = await HelperClient.connect(ok.cfg.socketPath, ok.cfg.token);
    cleanups.push(() => client2.close());
    const pm2 = new VpnProcessManager(join(ok.base, 'temp'));
    const evil = labProfile('plugin', lab.clientConfig('plugin', port, ['plugin /tmp/evil.so']));
    const manager = new VpnManager({
      getProfile: () => evil,
      createDriver: (c) => new OpenVpnDriver(c, { processes: pm2, binary: () => lab!.binary, launcher: client2.launcher }),
    });
    const id = manager.connect(evil.id);
    await waitFor(manager, id, 'ERROR');
    expect(manager.getLogs(id).map((l) => l.message).join('\n')).toMatch(/Directive not allowed.*plugin/);
  }, 30_000);
});
