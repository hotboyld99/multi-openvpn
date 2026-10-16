import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { vpnError } from '../../shared/errors';
import { VpnErrorCode, type LogLevel, type OpenVpnBinaryInfo } from '../../shared/types';
import { directivesToStrip, resolveCustomRoutes, routingArgs, type RoutingPlan } from '../network/routingPolicy';
import { classifyLine, dnsFromOptions, levelFromFlags, levelFromText } from './LogClassifier';
import { allDirectives, analyzeConfig, parseConfig, serializeConfig, type ConfigNode } from './OpenVpnConfigParser';
import { passwordCommand, usernameCommand, type MgmtMessage } from './managementProtocol';
import { OpenVpnManagementClient } from './OpenVpnManagementClient';
import { VpnDriverError, type DriverContext, type VpnDriver } from './VpnDriver';
import { VpnProcess, type Launcher } from './VpnProcess';
import type { ConnectionResources, VpnProcessManager } from './VpnProcessManager';

export interface OpenVpnDriverDeps {
  processes: VpnProcessManager;
  binary(): OpenVpnBinaryInfo | null;
  launcher?: Launcher;
  stopTimeoutMs?: number;
}

export interface ArgsInput {
  configPath: string;
  cwd: string;
  managementPort: number;
  managementPasswordFile: string;
  /** Routing/DNS policy arguments, appended last so they win over the config file. */
  extra?: string[];
}

/** Command line for one connection. Always an array — never joined into a shell string. */
export function buildOpenVpnArgs(i: ArgsInput): string[] {
  return [
    '--cd', i.cwd,
    '--config', i.configPath,
    // Per-connection management port, protected by a per-connection password file.
    '--management', '127.0.0.1', String(i.managementPort), i.managementPasswordFile,
    // Wait for us before connecting, and ask us (not a terminal) for every secret.
    '--management-hold',
    '--management-query-passwords',
    '--suppress-timestamps',
    '--verb', '3',
    ...(i.extra ?? []),
  ];
}

/**
 * Writes the per-connection runtime copy of the profile config with the given directives
 * commented out. The stored profile is never modified; relative file references keep
 * working because openvpn runs with --cd <profile dir>.
 */
export async function writeRuntimeConfig(
  profileConfig: string,
  workDir: string,
  strip: string[],
): Promise<{ path: string; pulls: boolean; dns: { servers: string[]; domains: string[] } }> {
  const cfg = parseConfig(await readFile(profileConfig, 'utf8'));
  const disable = (nodes: ConfigNode[]): void => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kind === 'directive' && strip.includes(n.name)) nodes[i] = { kind: 'other', line: n.line, raw: `# [routing policy] ${n.raw.trim()}` };
      if (n.kind === 'inline' && n.children) disable(n.children);
    }
  };
  // DNS set in the config itself is applied by the app (DnsManager), like pushed DNS.
  const configDns = dnsFromOptions(allDirectives(cfg.nodes).filter((d) => d.name === 'dhcp-option' || d.name === 'dns').map((d) => d.raw));
  disable(cfg.nodes);
  const a = analyzeConfig(cfg);
  const path = join(workDir, 'runtime.ovpn');
  await writeFile(path, serializeConfig(cfg), { mode: 0o600 });
  return { path, pulls: a.has('client') || a.has('pull'), dns: configDns };
}

/**
 * One real openvpn process for one connection, driven through its own management interface:
 * state, log, byte counters and credential prompts all come from there.
 */
export class OpenVpnDriver implements VpnDriver {
  private proc?: VpnProcess;
  private res?: ConnectionResources;
  private mgmt?: OpenVpnManagementClient;
  /** While the management interface is attached its `>LOG` stream replaces stdout. */
  private mgmtLogs = false;
  private readonly reported = new Set<VpnErrorCode>();

  constructor(
    private readonly ctx: DriverContext,
    private readonly deps: OpenVpnDriverDeps,
  ) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get managementPort(): number | undefined {
    return this.res?.managementPort;
  }

  async start(): Promise<void> {
    const { profile, connectionId, emit } = this.ctx;
    const binary = this.deps.binary();
    if (!binary) throw new VpnDriverError(vpnError(VpnErrorCode.OPENVPN_NOT_FOUND));
    await access(profile.configPath, constants.R_OK).catch(() => {
      throw new VpnDriverError(vpnError(VpnErrorCode.INVALID_CONFIG, `Config file not readable: ${profile.configPath}`));
    });

    const res = await this.deps.processes.allocate(connectionId);
    this.res = res;
    const cwd = dirname(profile.configPath);

    let configPath: string;
    let extra: string[];
    try {
      ({ configPath, extra } = await this.prepareRouting(res.workDir));
    } catch (err) {
      await this.deps.processes.release(connectionId, res);
      throw new VpnDriverError(vpnError(VpnErrorCode.INVALID_CONFIG, (err as Error).message));
    }
    const mgmt = new OpenVpnManagementClient({
      port: res.managementPort,
      password: res.managementPassword,
      shouldRetry: () => !proc.exited,
    });
    this.mgmt = mgmt;
    const proc = new VpnProcess({
      binary: binary.path,
      args: buildOpenVpnArgs({ configPath, cwd, ...res, extra }),
      cwd,
      launcher: this.deps.launcher,
      stopTimeoutMs: this.deps.stopTimeoutMs,
      requestStop: async () => {
        // throwing makes VpnProcess fall back to an OS SIGTERM
        if (!mgmt.connected) throw new Error('management not attached');
        await mgmt.command('signal SIGTERM');
      },
    });
    this.proc = proc;

    proc.on('line', (_stream, line) => {
      if (!this.mgmtLogs) this.onLogLine(levelFromText(line), line);
    });

    let started = false;
    proc.on('exit', (code, signal) => {
      mgmt.close();
      void this.deps.processes.release(connectionId, res);
      if (started) emit({ type: 'exit', code, signal });
    });

    emit({ type: 'log', level: 'info', message: `Starting ${binary.path} (OpenVPN ${binary.version ?? '?'}), management 127.0.0.1:${res.managementPort}` });
    try {
      await proc.start();
    } catch (err) {
      await this.deps.processes.release(connectionId, res);
      const e = err as NodeJS.ErrnoException;
      const code = e.code === 'ENOENT' ? VpnErrorCode.OPENVPN_NOT_FOUND : e.code === 'EACCES' || e.code === 'EPERM' ? VpnErrorCode.PERMISSION_DENIED : VpnErrorCode.UNKNOWN;
      throw new VpnDriverError(vpnError(code, e.message));
    }
    started = true;
    this.deps.processes.register(connectionId, proc, res.workDir);
    void this.attach(mgmt, proc);
  }

  async stop(): Promise<void> {
    await this.proc?.stop();
  }

  /** Turns the routing decision and profile settings into a runtime config + arguments. */
  private async prepareRouting(workDir: string): Promise<{ configPath: string; extra: string[] }> {
    const { profile, routing, emit } = this.ctx;
    const plan: RoutingPlan = { defaultRoute: routing.defaultRoute, mode: profile.routingMode, pulls: true };
    if (plan.mode === 'custom') {
      plan.routes = await resolveCustomRoutes(profile.customRoutes ?? []);
      for (const f of plan.routes.failed) emit({ type: 'log', level: 'warn', message: `Custom route ${f.rule} skipped: ${f.reason}` });
      const bits = (mask: string): number => mask.split('.').reduce((n, o) => n + Number(o).toString(2).replace(/0/g, '').length, 0);
      const applied = [...plan.routes.v4.map((r) => `${r.network}/${bits(r.netmask)}`), ...plan.routes.v6.map((r) => r.cidr)];
      emit({ type: 'netinfo', appliedRoutes: applied });
    }
    // The app applies DNS itself on every OS (DnsManager), so openvpn must not.
    const runtime = await writeRuntimeConfig(profile.configPath, workDir, [...directivesToStrip(plan), 'dhcp-option', 'dns']);
    plan.pulls = runtime.pulls;
    if (profile.dnsMode === 'vpn' && (runtime.dns.servers.length || runtime.dns.domains.length)) emit({ type: 'netinfo', dns: runtime.dns });
    const extra = [...routingArgs(plan), ...(plan.pulls ? ['--pull-filter', 'ignore', 'dhcp-option', '--pull-filter', 'ignore', 'dns '] : [])];
    if (plan.defaultRoute === 'skip' || plan.mode === 'custom') {
      emit({ type: 'log', level: 'info', message: `Routing policy: ${plan.mode === 'custom' ? 'custom routes only' : 'default route not taken'}` });
    }
    return { configPath: runtime.path, extra };
  }

  /** Connects to the management interface, subscribes to everything, then lets openvpn go. */
  private async attach(mgmt: OpenVpnManagementClient, proc: VpnProcess): Promise<void> {
    mgmt.on('message', (m) => void this.onMessage(m));
    mgmt.on('close', () => (this.mgmtLogs = false));
    try {
      await mgmt.connect();
      this.mgmtLogs = true;
      await mgmt.command('state on');
      await mgmt.command('log on');
      await mgmt.command('bytecount 1');
      await mgmt.command('hold release');
    } catch (err) {
      if (proc.exited) return; // the exit event already tells the story
      this.reportError(vpnError(VpnErrorCode.UNKNOWN, `Management interface unavailable: ${(err as Error).message}`));
      proc.kill(); // with --management-hold it would wait forever
    }
  }

  private async onMessage(m: MgmtMessage): Promise<void> {
    const { emit } = this.ctx;
    switch (m.kind) {
      case 'state':
        emit({ type: 'state', state: m.state, localIp: m.localIp, remote: m.remoteIp });
        return;
      case 'log':
        this.onLogLine(levelFromFlags(m.flags), m.message);
        return;
      case 'bytecount':
        emit({ type: 'bytes', bytesIn: m.bytesIn, bytesOut: m.bytesOut });
        return;
      case 'hold':
        // also after openvpn-internal restarts
        await this.mgmt?.command('hold release').catch(() => undefined);
        return;
      case 'password':
        if (m.action === 'failed') {
          this.onLogLine('error', `Verification Failed: '${m.realm}'`);
          return;
        }
        await this.answerPassword(m.realm, m.needsUsername);
        return;
      case 'fatal':
        this.onLogLine('error', m.message);
        this.reportError(classifyLine(m.message).error ?? vpnError(VpnErrorCode.UNKNOWN, m.message));
        return;
      default:
        return;
    }
  }

  private async answerPassword(realm: string, needsUsername: boolean): Promise<void> {
    this.ctx.emit({ type: 'state', state: 'AUTH' });
    const secret = await this.ctx.requestSecret({ realm, needsUsername });
    const mgmt = this.mgmt;
    if (!secret || !mgmt?.connected) return; // cancelled: VpnManager is already disconnecting
    try {
      if (needsUsername) await mgmt.command(usernameCommand(realm, secret.username ?? ''));
      await mgmt.command(passwordCommand(realm, secret.password));
    } catch (err) {
      // Never include the command (it holds the secret) in the message.
      this.reportError(vpnError(VpnErrorCode.UNKNOWN, `Could not send credentials: ${(err as Error).message}`));
    }
  }

  private onLogLine(level: LogLevel, line: string): void {
    this.ctx.emit({ type: 'log', level, message: line });
    const info = classifyLine(line);
    const dns = this.ctx.profile.dnsMode === 'vpn' ? info.dns : undefined; // 'system'/'custom' ignore pushed DNS
    if (info.interfaceName || info.gateway || info.pushedDefaultRoute || dns) {
      this.ctx.emit({ type: 'netinfo', interfaceName: info.interfaceName, gateway: info.gateway, pushedDefaultRoute: info.pushedDefaultRoute, dns });
    }
    if (info.error) this.reportError(info.error);
  }

  /** One report per error code per process; openvpn repeats e.g. TLS errors on every retry. */
  private reportError(error: ReturnType<typeof vpnError>): void {
    if (this.reported.has(error.code)) return;
    this.reported.add(error.code);
    this.ctx.emit({ type: 'error', error });
  }
}
