import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { vpnError } from '../../shared/errors';
import { VpnErrorCode, type LogLevel, type OpenVpnBinaryInfo } from '../../shared/types';
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
    '--management', '127.0.0.1', String(i.managementPort), i.managementPasswordFile,
    '--suppress-timestamps',
    '--verb', '3',
  ];
}

const levelOf = (line: string): LogLevel =>
  /\b(error|failed|fatal|cannot|exiting due to)\b/i.test(line) ? 'error' : /\bwarn(ing)?\b/i.test(line) ? 'warn' : 'info';

/** One real openvpn process for one connection. */
export class OpenVpnDriver implements VpnDriver {
  private proc?: VpnProcess;
  private res?: ConnectionResources;

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
    const proc = new VpnProcess({
      binary: binary.path,
      args: buildOpenVpnArgs({ configPath: profile.configPath, cwd, ...res }),
      cwd,
      launcher: this.deps.launcher,
      stopTimeoutMs: this.deps.stopTimeoutMs,
    });
    this.proc = proc;

    proc.on('line', (_stream, line) => {
      emit({ type: 'log', level: levelOf(line), message: line });
      if (line.includes('Initialization Sequence Completed')) emit({ type: 'state', state: 'CONNECTED' });
      else if (/SIGUSR1\[|Restart pause/.test(line)) emit({ type: 'state', state: 'RECONNECTING' });
    });

    let started = false;
    proc.on('exit', (code, signal) => {
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
    this.deps.processes.register(connectionId, proc);
    emit({ type: 'state', state: 'CONNECTING' });
  }

  async stop(): Promise<void> {
    await this.proc?.stop();
  }
}
