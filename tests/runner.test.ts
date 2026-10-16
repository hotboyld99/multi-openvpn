import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVpnBinaryManager, parseOpenVpnVersion } from '../src/main/vpn/OpenVpnBinaryManager';
import { buildOpenVpnArgs, OpenVpnDriver } from '../src/main/vpn/OpenVpnDriver';
import { VpnManager } from '../src/main/vpn/VpnManager';
import { VpnProcess } from '../src/main/vpn/VpnProcess';
import { VpnProcessManager } from '../src/main/vpn/VpnProcessManager';
import { VpnErrorCode, type VpnProfile } from '../src/shared/types';
import { alive, createLab, labProfile, waitFor, type Lab } from './helpers/openvpnLab';

describe('OpenVpnBinaryManager', () => {
  it('parses `openvpn --version` output', () => {
    expect(parseOpenVpnVersion('OpenVPN 2.6.7 x86_64-apple-darwin23.0.0 [SSL (OpenSSL)]\nlibrary versions')).toBe('2.6.7');
    expect(parseOpenVpnVersion('OpenVPN 2.7_beta1 [git:...]')).toBe('2.7_beta1');
    expect(parseOpenVpnVersion('bash: openvpn: not found')).toBeNull();
  });

  it('lists bundled, well-known and PATH candidates per platform without hard-coding one path', () => {
    const mac = new OpenVpnBinaryManager({ bundledRoot: '/app/res', platform: 'darwin', arch: 'arm64', env: { PATH: '/usr/bin:/opt/x/bin' } });
    const paths = mac.candidates().map((c) => c.path);
    expect(paths[0]).toBe('/app/res/mac-arm64/openvpn');
    expect(paths).toEqual(expect.arrayContaining(['/opt/homebrew/sbin/openvpn', '/usr/local/sbin/openvpn', '/opt/x/bin/openvpn']));

    const win = new OpenVpnBinaryManager({
      bundledRoot: 'C:\\app\\res',
      platform: 'win32',
      arch: 'x64',
      env: { ProgramFiles: 'D:\\Programs', Path: 'C:\\Tools' },
    });
    const wpaths = win.candidates().map((c) => c.path);
    expect(wpaths[0]).toMatch(/win-x64[\\/]openvpn\.exe$/);
    expect(wpaths).toEqual(expect.arrayContaining(['D:\\Programs\\OpenVPN\\bin\\openvpn.exe', 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe', 'C:\\Tools\\openvpn.exe']));
  });

  it('refuses files that are not an OpenVPN binary', async () => {
    const m = new OpenVpnBinaryManager({ bundledRoot: '/nope' });
    await expect(m.validate('relative/openvpn')).rejects.toThrow(/absolute/);
    await expect(m.validate('/bin/sh')).rejects.toThrow(/not named openvpn/);
    const dir = mkdtempSync(join(tmpdir(), 'mov-bin-'));
    const fake = join(dir, 'openvpn');
    writeFileSync(fake, '#!/bin/sh\necho hello\n');
    chmodSync(fake, 0o755);
    await expect(m.validate(fake)).rejects.toThrow(/did not report an OpenVPN version/);
    expect(await m.resolve(fake)).toBeNull(); // custom path set but invalid → no silent fallback
  });
});

describe('buildOpenVpnArgs', () => {
  it('produces an argv array with a per-connection management port and password file', () => {
    const args = buildOpenVpnArgs({
      configPath: '/p/My VPN; rm -rf ~/config.ovpn',
      cwd: '/p',
      managementPort: 25101,
      managementPasswordFile: '/t/management.pw',
    });
    // a hostile-looking path stays one argv element: no shell ever sees it
    expect(args).toContain('/p/My VPN; rm -rf ~/config.ovpn');
    const i = args.indexOf('--management');
    expect(args.slice(i, i + 4)).toEqual(['--management', '127.0.0.1', '25101', '/t/management.pw']);
  });
});

describe('VpnProcess', () => {
  const node = process.execPath;

  it('stop() escalates SIGTERM → SIGKILL when the process ignores SIGTERM', async () => {
    const p = new VpnProcess({
      binary: node,
      args: ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
      stopTimeoutMs: 300,
    });
    const ready = new Promise((r) => p.on('line', (_s, l) => l === 'ready' && r(null)));
    await p.start();
    await ready;
    const exit = new Promise<[number | null, string | null]>((r) => p.on('exit', (c, s) => r([c, s])));
    const t0 = Date.now();
    await p.stop();
    expect(await exit).toEqual([null, 'SIGKILL']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('rejects start() with ENOENT for a missing binary', async () => {
    const p = new VpnProcess({ binary: '/does/not/exist/openvpn', args: [], cwd: tmpdir() });
    await expect(p.start()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('VpnProcessManager', () => {
  it('allocates unique ports and private work dirs for concurrent connections', async () => {
    const pm = new VpnProcessManager(join(mkdtempSync(join(tmpdir(), 'mov-pm-')), 'tmp'));
    const ids = Array.from({ length: 10 }, () => randomUUID());
    const res = await Promise.all(ids.map((id) => pm.allocate(id)));
    expect(new Set(res.map((r) => r.managementPort)).size).toBe(10);
    expect(new Set(res.map((r) => r.workDir)).size).toBe(10);
    expect(new Set(res.map((r) => r.managementPassword)).size).toBe(10);
    await Promise.all(ids.map((id, i) => pm.release(id, res[i])));
    expect(res.every((r) => !existsSync(r.workDir))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real openvpn processes (rootless lab). Skipped when openvpn/openssl are missing.

let lab: Lab | null = null;
beforeAll(async () => {
  lab = await createLab();
}, 30_000);
afterAll(() => lab?.cleanup());
const managers: VpnManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disconnectAll()));
});

describe('OpenVpnDriver with real openvpn', () => {
  function realManager(profiles: VpnProfile[]) {
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const processes = new VpnProcessManager(join(lab!.dir, 'run'));
    const manager = new VpnManager({
      getProfile: (id) => byId.get(id),
      createDriver: (ctx) => new OpenVpnDriver(ctx, { processes, binary: () => lab!.binary, stopTimeoutMs: 3_000 }),
    });
    managers.push(manager);
    return { manager, processes };
  }

  it('starts two real openvpn processes concurrently and stops them independently', async (ctx) => {
    if (!lab) return ctx.skip();
    const [pa, pb] = await Promise.all([lab.startServer(), lab.startServer()]);
    const a = labProfile('a', lab.clientConfig('a', pa));
    const b = labProfile('b', lab.clientConfig('b', pb));
    const { manager, processes } = realManager([a, b]);

    const ia = manager.connect(a.id);
    const ib = manager.connect(b.id);
    await Promise.all([waitFor(manager, ia, 'CONNECTED'), waitFor(manager, ib, 'CONNECTED')]);

    const ca = manager.get(ia)!;
    const cb = manager.get(ib)!;
    expect(ca.pid).not.toBe(cb.pid);
    expect(ca.managementPort).not.toBe(cb.managementPort);
    expect(alive(ca.pid) && alive(cb.pid)).toBe(true);
    expect(processes.list()).toHaveLength(2);

    await manager.disconnect(ia);
    expect(manager.get(ia)!.status).toBe('DISCONNECTED');
    expect(alive(ca.pid)).toBe(false);
    expect(manager.get(ib)!.status).toBe('CONNECTED');
    expect(alive(cb.pid)).toBe(true);

    await manager.disconnect(ib);
    expect(alive(cb.pid)).toBe(false);
    expect(processes.list()).toHaveLength(0);
  }, 30_000);

  it('reports OPENVPN_NOT_FOUND / INVALID_CONFIG before spawning', async (ctx) => {
    if (!lab) return ctx.skip();
    const missing = labProfile('missing', join(lab.dir, 'nope.ovpn'));
    const { manager } = realManager([missing]);
    const id = manager.connect(missing.id);
    await waitFor(manager, id, 'ERROR');
    expect(manager.get(id)!.error?.code).toBe(VpnErrorCode.INVALID_CONFIG);

    const p = labProfile('nobin', lab.clientConfig('nobin', 1));
    const processes = new VpnProcessManager(join(lab.dir, 'run2'));
    const m2 = new VpnManager({ getProfile: () => p, createDriver: (c) => new OpenVpnDriver(c, { processes, binary: () => null }) });
    const id2 = m2.connect(p.id);
    await waitFor(m2, id2, 'ERROR');
    expect(m2.get(id2)!.error?.code).toBe(VpnErrorCode.OPENVPN_NOT_FOUND);
  }, 15_000);
});
