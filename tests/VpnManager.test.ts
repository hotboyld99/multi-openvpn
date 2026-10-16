import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { vpnError } from '../src/shared/errors';
import { VpnErrorCode, type VpnProfile } from '../src/shared/types';
import { MockVpnDriver } from '../src/main/vpn/MockVpnDriver';
import { VpnDriverError, type DriverContext, type DriverFactory, type VpnDriver } from '../src/main/vpn/VpnDriver';
import { BACKOFF_MS, VpnManager } from '../src/main/vpn/VpnManager';

/** Driver fully controlled by the test. */
class FakeDriver implements VpnDriver {
  pid = Math.floor(Math.random() * 1e5);
  managementPort = 30_000 + Math.floor(Math.random() * 1e4);
  stopped = false;
  constructor(readonly ctx: DriverContext) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ctx.emit({ type: 'exit', code: 0, signal: null });
  }
  connectUp(ip = '10.8.0.2'): void {
    for (const state of ['WAIT', 'AUTH', 'GET_CONFIG', 'ASSIGN_IP', 'ADD_ROUTES']) this.ctx.emit({ type: 'state', state });
    this.ctx.emit({ type: 'netinfo', interfaceName: `utun-${this.ctx.profile.name}` });
    this.ctx.emit({ type: 'state', state: 'CONNECTED', localIp: ip });
  }
  crash(): void {
    this.ctx.emit({ type: 'exit', code: null, signal: 'SIGKILL' });
  }
}

function profile(name: string, extra: Partial<VpnProfile> = {}): VpnProfile {
  return {
    id: randomUUID(),
    name,
    configPath: `mock://ok`,
    configFileName: `${name}.ovpn`,
    hasSavedPassword: false,
    autoConnect: false,
    reconnect: false,
    routingMode: 'config',
    dnsMode: 'vpn',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

function setup(profiles: VpnProfile[], factory?: DriverFactory) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const drivers: FakeDriver[] = [];
  const manager = new VpnManager({
    getProfile: (id) => byId.get(id),
    createDriver:
      factory ??
      ((ctx) => {
        const d = new FakeDriver(ctx);
        drivers.push(d);
        return d;
      }),
  });
  const driverOf = (p: VpnProfile): FakeDriver => drivers.filter((d) => d.ctx.profile.id === p.id).at(-1)!;
  return { manager, drivers, driverOf };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe('VpnManager state machine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('walks CONNECTING → CONNECTED and records process + interface info', async () => {
    const a = profile('a');
    const { manager, driverOf } = setup([a]);
    const statuses: string[] = [];
    manager.on('connection', (c) => statuses.push(c.status));

    const id = manager.connect(a.id);
    await flush();
    driverOf(a).connectUp('10.8.0.12');

    const c = manager.get(id)!;
    expect(c.status).toBe('CONNECTED');
    expect(c.assignedIp).toBe('10.8.0.12');
    expect(c.interfaceName).toBe('utun-a');
    expect(c.pid).toBe(driverOf(a).pid);
    expect(c.managementPort).toBe(driverOf(a).managementPort);
    expect(c.connectedAt).toBeTypeOf('number');
    expect(statuses).toEqual(expect.arrayContaining(['CONNECTING', 'AUTH', 'ASSIGN_IP', 'CONNECTED']));
  });

  it('connect() on a live profile returns the same connection (one process per profile)', async () => {
    const a = profile('a');
    const { manager, drivers } = setup([a]);
    const id1 = manager.connect(a.id);
    const id2 = manager.connect(a.id);
    expect(id2).toBe(id1);
    expect(drivers).toHaveLength(1);
  });

  it('disconnect → DISCONNECTED without error, and no reconnect', async () => {
    const a = profile('a', { reconnect: true });
    const { manager, driverOf, drivers } = setup([a]);
    const id = manager.connect(a.id);
    await flush();
    driverOf(a).connectUp();
    await manager.disconnect(id);
    expect(manager.get(id)!.status).toBe('DISCONNECTED');
    expect(manager.get(id)!.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(drivers).toHaveLength(1);
  });

  it('crash with auto-reconnect retries with exponential backoff, capped at 60s', async () => {
    const a = profile('a', { reconnect: true });
    const { manager, drivers, driverOf } = setup([a]);
    const id = manager.connect(a.id);
    await flush();

    for (let i = 0; i < BACKOFF_MS.length + 2; i++) {
      driverOf(a).crash();
      const c = manager.get(id)!;
      expect(c.status).toBe('RECONNECTING');
      expect(c.error?.code).toBe(VpnErrorCode.PROCESS_CRASHED);
      const expected = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
      expect(c.nextRetryAt! - Date.now()).toBe(expected);
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(drivers).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(drivers).toHaveLength(i + 2);
    }
  });

  it('a successful connection resets the backoff', async () => {
    const a = profile('a', { reconnect: true });
    const { manager, driverOf } = setup([a]);
    const id = manager.connect(a.id);
    await flush();
    driverOf(a).crash();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    driverOf(a).crash();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1]);
    driverOf(a).connectUp();
    driverOf(a).crash();
    expect(manager.get(id)!.nextRetryAt! - Date.now()).toBe(BACKOFF_MS[0]);
  });

  it.each([VpnErrorCode.AUTH_FAILED, VpnErrorCode.CERT_EXPIRED, VpnErrorCode.INVALID_CONFIG])(
    '%s stops the process and never auto-reconnects',
    async (code) => {
      const a = profile('a', { reconnect: true });
      const { manager, drivers, driverOf } = setup([a]);
      const id = manager.connect(a.id);
      await flush();
      driverOf(a).ctx.emit({ type: 'error', error: vpnError(code) });
      await flush();
      expect(driverOf(a).stopped).toBe(true);
      const c = manager.get(id)!;
      expect(c.status).toBe('ERROR');
      expect(c.error?.code).toBe(code);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(drivers).toHaveLength(1);
    },
  );

  it('start() failure surfaces the driver error', async () => {
    const a = profile('a', { reconnect: true });
    const { manager } = setup([a], () => ({
      start: () => Promise.reject(new VpnDriverError(vpnError(VpnErrorCode.OPENVPN_NOT_FOUND))),
      stop: async () => {},
    }));
    const id = manager.connect(a.id);
    await flush();
    await flush();
    expect(manager.get(id)!.status).toBe('ERROR');
    expect(manager.get(id)!.error?.code).toBe(VpnErrorCode.OPENVPN_NOT_FOUND);
  });

  it('manual reconnect ignores the old process exit and starts a new one', async () => {
    const a = profile('a');
    const { manager, drivers, driverOf } = setup([a]);
    const id = manager.connect(a.id);
    await flush();
    driverOf(a).connectUp();
    await manager.reconnect(id);
    expect(drivers).toHaveLength(2);
    expect(drivers[0].stopped).toBe(true);
    const c = manager.get(id)!;
    expect(c.status).toBe('CONNECTING');
    expect(c.error).toBeUndefined();
    expect(c.reconnectCount).toBe(1);
    // late events from the old driver are ignored
    drivers[0].crash();
    expect(manager.get(id)!.status).toBe('CONNECTING');
  });

  it('byte counters accumulate across process restarts and compute rates', async () => {
    const a = profile('a', { reconnect: true });
    const { manager, driverOf } = setup([a]);
    const id = manager.connect(a.id);
    await flush();
    driverOf(a).ctx.emit({ type: 'bytes', bytesIn: 1000, bytesOut: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    driverOf(a).ctx.emit({ type: 'bytes', bytesIn: 3000, bytesOut: 600 });
    expect(manager.get(id)!.rateIn).toBe(2000);
    expect(manager.get(id)!.rateOut).toBe(500);
    driverOf(a).crash();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    driverOf(a).ctx.emit({ type: 'bytes', bytesIn: 10, bytesOut: 1 });
    expect(manager.get(id)!.bytesIn).toBe(3010);
    expect(manager.get(id)!.bytesOut).toBe(601);
  });

  it('logs are kept per connection', async () => {
    const a = profile('a');
    const b = profile('b');
    const { manager, driverOf } = setup([a, b]);
    const ia = manager.connect(a.id);
    const ib = manager.connect(b.id);
    await flush();
    driverOf(a).ctx.emit({ type: 'log', level: 'info', message: 'from A' });
    driverOf(b).ctx.emit({ type: 'log', level: 'info', message: 'from B' });
    expect(manager.getLogs(ia).map((l) => l.message)).toContain('from A');
    expect(manager.getLogs(ia).map((l) => l.message)).not.toContain('from B');
    expect(manager.getLogs(ib).map((l) => l.message)).toContain('from B');
  });
});

describe('Multi-VPN isolation (mock drivers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function mockSetup(names: string[]) {
    const profiles = names.map((n) => profile(n, { reconnect: false }));
    const drivers = new Map<string, MockVpnDriver>();
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const manager = new VpnManager({
      getProfile: (id) => byId.get(id),
      createDriver: (ctx) => {
        const d = new MockVpnDriver(ctx, 'ok');
        drivers.set(ctx.profile.id, d);
        return d;
      },
    });
    return { manager, profiles, drivers };
  }

  it('A, B and C connect concurrently with distinct pid, port, interface and IP', async () => {
    const { manager, profiles } = mockSetup(['a', 'b', 'c']);
    const ids = profiles.map((p) => manager.connect(p.id));
    await vi.advanceTimersByTimeAsync(3_000);
    const conns = ids.map((id) => manager.get(id)!);
    expect(conns.map((c) => c.status)).toEqual(['CONNECTED', 'CONNECTED', 'CONNECTED']);
    for (const key of ['pid', 'managementPort', 'interfaceName', 'id'] as const) {
      expect(new Set(conns.map((c) => c[key])).size).toBe(3);
    }
    expect(manager.activeCount()).toBe(3);
  });

  it('disconnecting A leaves B connected', async () => {
    const { manager, profiles } = mockSetup(['a', 'b']);
    const [ia, ib] = profiles.map((p) => manager.connect(p.id));
    await vi.advanceTimersByTimeAsync(3_000);
    const bBefore = manager.get(ib)!;

    const done = manager.disconnect(ia);
    await vi.advanceTimersByTimeAsync(500);
    await done;

    expect(manager.get(ia)!.status).toBe('DISCONNECTED');
    const bAfter = manager.get(ib)!;
    expect(bAfter.status).toBe('CONNECTED');
    expect(bAfter.pid).toBe(bBefore.pid);
    expect(bAfter.connectedAt).toBe(bBefore.connectedAt);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.get(ib)!.bytesIn).toBeGreaterThan(bBefore.bytesIn); // B still carrying traffic
  });

  it('A crashing leaves B connected', async () => {
    const { manager, profiles, drivers } = mockSetup(['a', 'b']);
    const [ia, ib] = profiles.map((p) => manager.connect(p.id));
    await vi.advanceTimersByTimeAsync(3_000);
    const bPid = manager.get(ib)!.pid;

    // simulate kill -9 of A's process
    (drivers.get(profiles[0].id) as unknown as { exit(code: number | null, signal: string | null): void }).exit(null, 'SIGKILL');

    expect(manager.get(ia)!.status).toBe('ERROR');
    expect(manager.get(ia)!.error?.code).toBe(VpnErrorCode.PROCESS_CRASHED);
    expect(manager.get(ib)!.status).toBe('CONNECTED');
    expect(manager.get(ib)!.pid).toBe(bPid);
  });

  it('disconnectAll stops every connection', async () => {
    const { manager, profiles } = mockSetup(['a', 'b', 'c']);
    profiles.forEach((p) => manager.connect(p.id));
    await vi.advanceTimersByTimeAsync(3_000);
    const done = manager.disconnectAll();
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(manager.activeCount()).toBe(0);
    expect(manager.list().every((c) => c.status === 'DISCONNECTED')).toBe(true);
  });
});

describe('VpnManager error precedence', () => {
  it('keeps the first fatal error when consequences follow', async () => {
    const a = profile('a', { reconnect: true });
    const { manager, driverOf } = setup([a]);
    const id = manager.connect(a.id);
    await flush();
    driverOf(a).ctx.emit({ type: 'error', error: vpnError(VpnErrorCode.AUTH_FAILED) });
    driverOf(a).ctx.emit({ type: 'error', error: vpnError(VpnErrorCode.INVALID_CONFIG) });
    await flush();
    expect(manager.get(id)!.status).toBe('ERROR');
    expect(manager.get(id)!.error?.code).toBe(VpnErrorCode.AUTH_FAILED);
  });
});
