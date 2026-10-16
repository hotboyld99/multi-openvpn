import { vpnError } from '../../shared/errors';
import { VpnErrorCode } from '../../shared/types';
import type { DriverContext, VpnDriver } from './VpnDriver';

/**
 * VPN_MOCK_MODE driver: walks the same state sequence a real openvpn reports and
 * generates traffic, so the whole app (VpnManager, IPC, UI) runs without a server.
 *
 * Demo profiles pick a scenario through their config path: mock://ok, mock://auth (asks for
 * username/password; password "wrong" fails), mock://default (server pushes redirect-gateway),
 * mock://auth-fail, mock://flaky.
 */
export type MockScenario = 'ok' | 'default' | 'auth' | 'auth-fail' | 'flaky';

let nextPid = 41_000;
// Prefixed so a mock tunnel can never be mistaken for a real utunN of the OS.
let nextUtun = 0;
let nextPort = 25_100;

export const scenarioOf = (configPath: string): MockScenario => {
  const m = /^mock:\/\/(ok|default|auth|auth-fail|flaky)$/.exec(configPath);
  return (m?.[1] as MockScenario | undefined) ?? 'ok';
};

const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export class MockVpnDriver implements VpnDriver {
  pid?: number;
  managementPort?: number;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private traffic?: ReturnType<typeof setInterval>;
  private exited = false;
  private bytesIn = 0;
  private bytesOut = 0;

  constructor(
    private readonly ctx: DriverContext,
    private readonly scenario: MockScenario = scenarioOf(ctx.profile.configPath),
  ) {}

  async start(): Promise<void> {
    this.pid = nextPid++;
    this.managementPort = nextPort++;
    const h = hash(this.ctx.profile.id);
    const subnet = 8 + (h % 40);
    const ip = `10.${subnet}.0.${2 + (h % 200)}`;
    const gateway = `10.${subnet}.0.1`;
    const remote = `203.0.113.${1 + (h % 250)}`;
    const utun = `mock-utun${nextUtun++}`;
    const { emit } = this.ctx;

    emit({ type: 'log', level: 'info', message: `OpenVPN 2.6.x (mock) pid ${this.pid}, management 127.0.0.1:${this.managementPort}` });
    this.at(150, () => emit({ type: 'state', state: 'RESOLVE' }));
    this.at(300, () => {
      emit({ type: 'log', level: 'info', message: `TCP/UDP: Preserving recently used remote address: [AF_INET]${remote}:1194` });
      emit({ type: 'state', state: 'WAIT' });
    });
    this.at(700, () => {
      emit({ type: 'log', level: 'info', message: 'TLS: Initial packet from server, sid=mock' });
      emit({ type: 'state', state: 'AUTH' });
    });

    if (this.scenario === 'auth') {
      // Real openvpn pauses here until the management client answers >PASSWORD.
      this.at(800, async () => {
        const secret = await this.ctx.requestSecret({ realm: 'Auth', needsUsername: true });
        if (this.exited || !secret) return;
        emit({ type: 'log', level: 'debug', message: "MANAGEMENT: CMD 'password [...]'" });
        if (secret.password === 'wrong') {
          emit({ type: 'log', level: 'error', message: 'AUTH: Received control message: AUTH_FAILED' });
          emit({ type: 'error', error: vpnError(VpnErrorCode.AUTH_FAILED, 'AUTH: Received control message: AUTH_FAILED') });
          return;
        }
        this.connectUp(0, ip, gateway, remote, utun, subnet);
      });
      return;
    }

    if (this.scenario === 'auth-fail') {
      this.at(1200, () => {
        emit({ type: 'log', level: 'error', message: 'AUTH: Received control message: AUTH_FAILED' });
        emit({ type: 'error', error: vpnError(VpnErrorCode.AUTH_FAILED, 'AUTH: Received control message: AUTH_FAILED') });
      });
      return;
    }

    this.connectUp(1100, ip, gateway, remote, utun, subnet);

    if (this.scenario === 'flaky') {
      this.at(20_000, () => {
        emit({ type: 'log', level: 'error', message: 'Inactivity timeout (--ping-restart), restarting' });
        this.exit(1, null);
      });
    }
  }

  private connectUp(t: number, ip: string, gateway: string, remote: string, utun: string, subnet: number): void {
    const { emit } = this.ctx;
    this.at(t, () => {
      emit({ type: 'state', state: 'GET_CONFIG' });
      if (this.scenario === 'default') {
        emit({ type: 'log', level: 'info', message: `PUSH: Received control message: 'PUSH_REPLY,redirect-gateway def1,route-gateway ${gateway}'` });
        emit({ type: 'netinfo', pushedDefaultRoute: true });
      }
      const { profile, routing } = this.ctx;
      // Pushed DNS: full-tunnel servers push a resolver only; the dev VPN pushes a split domain.
      if (profile.dnsMode === 'vpn' && this.scenario !== 'auth') {
        const domains = /development/i.test(profile.name) ? ['dev.internal'] : [];
        emit({ type: 'netinfo', dns: { servers: [`10.${subnet}.0.53`], domains } });
      }
      if (routing.defaultRoute === 'skip') emit({ type: 'log', level: 'info', message: 'Routing policy: default route not taken' });
      if (profile.routingMode === 'custom') {
        emit({ type: 'netinfo', appliedRoutes: (profile.customRoutes ?? []).filter((r) => r.type !== 'hostname').map((r) => (r.value.includes('/') ? r.value : `${r.value}/32`)) });
      }
    });
    this.at(t + 300, () => {
      emit({ type: 'log', level: 'info', message: `Opened utun device ${utun}` });
      emit({ type: 'netinfo', interfaceName: utun });
      emit({ type: 'state', state: 'ASSIGN_IP', localIp: ip });
    });
    this.at(t + 600, () => {
      emit({ type: 'log', level: 'info', message: `/sbin/route add -net 10.${subnet}.0.0 ${gateway} 255.255.0.0` });
      emit({ type: 'state', state: 'ADD_ROUTES' });
    });
    this.at(t + 900, () => {
      emit({ type: 'log', level: 'info', message: 'Initialization Sequence Completed' });
      emit({ type: 'state', state: 'CONNECTED', localIp: ip, remote, gateway });
      this.traffic = setInterval(() => {
        // ~1.4 MB/s down, ~320 KB/s up with jitter
        this.bytesIn += Math.round(1_400_000 * (0.5 + Math.random()));
        this.bytesOut += Math.round(320_000 * (0.5 + Math.random()));
        emit({ type: 'bytes', bytesIn: this.bytesIn, bytesOut: this.bytesOut });
      }, 1_000);
    });
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.clear();
    this.ctx.emit({ type: 'log', level: 'info', message: 'SIGTERM[hard,] received, process exiting' });
    this.ctx.emit({ type: 'state', state: 'EXITING' });
    await new Promise((r) => setTimeout(r, 200));
    this.exit(0, null);
  }

  private exit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.clear();
    this.ctx.emit({ type: 'exit', code, signal });
  }

  private at(ms: number, fn: () => void | Promise<void>): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clear(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.traffic) clearInterval(this.traffic);
    this.traffic = undefined;
  }
}
