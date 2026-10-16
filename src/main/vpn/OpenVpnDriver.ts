import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { vpnError } from '../../shared/errors';
import { VpnErrorCode, type LogLevel, type OpenVpnBinaryInfo } from '../../shared/types';
import { classifyLine, levelFromFlags, levelFromText } from './LogClassifier';
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
  ];
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
    const mgmt = new OpenVpnManagementClient({
      port: res.managementPort,
      password: res.managementPassword,
      shouldRetry: () => !proc.exited,
    });
    this.mgmt = mgmt;
    const proc = new VpnProcess({
      binary: binary.path,
      args: buildOpenVpnArgs({ configPath: profile.configPath, cwd, ...res }),
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
    if (info.interfaceName || info.gateway) this.ctx.emit({ type: 'netinfo', interfaceName: info.interfaceName, gateway: info.gateway });
    if (info.error) this.reportError(info.error);
  }

  /** One report per error code per process; openvpn repeats e.g. TLS errors on every retry. */
  private reportError(error: ReturnType<typeof vpnError>): void {
    if (this.reported.has(error.code)) return;
    this.reported.add(error.code);
    this.ctx.emit({ type: 'error', error });
  }
}
