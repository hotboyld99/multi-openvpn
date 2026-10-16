import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { VpnProcess } from './VpnProcess';

/** Asks the OS for a free loopback TCP port. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('No port'))));
    });
  });
}

export interface ConnectionResources {
  managementPort: number;
  managementPasswordFile: string;
  managementPassword: string;
  workDir: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
};

/** Full command line of a process, or null if it is gone. Never goes through a shell. */
export function commandLineOf(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  const [cmd, args] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]]
      : ['ps', ['-o', 'command=', '-p', String(pid)]];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

interface RegistryEntry {
  connectionId: string;
  pid: number;
  workDir: string;
}

/**
 * Registry of live openvpn processes, one per connection, plus the per-connection
 * resources they need: a unique management port and a private temp directory.
 * Nothing here is shared between connections.
 *
 * Live PIDs are also written to <tempRoot>/running.json so that processes orphaned by an
 * app crash can be found and stopped on the next start.
 */
export class VpnProcessManager {
  private readonly processes = new Map<string, { proc: VpnProcess; workDir: string }>();
  private readonly reservedPorts = new Set<number>();

  constructor(private readonly tempRoot: string) {}

  private get registryFile(): string {
    return join(this.tempRoot, 'running.json');
  }

  private saveRegistry(): void {
    const entries: RegistryEntry[] = [...this.processes].flatMap(([connectionId, { proc, workDir }]) =>
      proc.pid ? [{ connectionId, pid: proc.pid, workDir }] : [],
    );
    try {
      mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
      writeFileSync(this.registryFile, JSON.stringify(entries), { mode: 0o600 });
    } catch {
      // best effort: losing the registry only weakens crash recovery
    }
  }

  /**
   * Stops openvpn processes left behind by a previous run (app crash, force quit) and removes
   * stale work directories. A PID is only killed if its command line still contains the work
   * directory we created for it, so a PID reused by an unrelated process is never touched.
   * Call before any connection is started.
   */
  async cleanupOrphans(): Promise<number[]> {
    let entries: RegistryEntry[] = [];
    try {
      entries = JSON.parse(readFileSync(this.registryFile, 'utf8')) as RegistryEntry[];
    } catch {
      // no registry: nothing was running
    }
    const killed: number[] = [];
    for (const e of entries) {
      if (!alive(e.pid)) continue;
      const cmdline = await commandLineOf(e.pid);
      if (!cmdline?.includes(e.workDir)) continue;
      try {
        process.kill(e.pid, 'SIGTERM');
        for (let i = 0; i < 20 && alive(e.pid); i++) await new Promise((r) => setTimeout(r, 100));
        if (alive(e.pid)) process.kill(e.pid, 'SIGKILL');
        killed.push(e.pid);
      } catch {
        // not ours to kill (e.g. root-owned): the privileged helper handles those
      }
    }
    const dirs = await readdir(this.tempRoot).catch(() => [] as string[]);
    await Promise.all(dirs.filter((d) => d !== 'running.json').map((d) => rm(join(this.tempRoot, d), { recursive: true, force: true })));
    this.saveRegistry();
    return killed;
  }

  async allocate(connectionId: string): Promise<ConnectionResources> {
    let port = await findFreePort();
    // Another connection may have been handed the same port but not bound it yet.
    for (let i = 0; this.reservedPorts.has(port) && i < 20; i++) port = await findFreePort();
    if (this.reservedPorts.has(port)) throw new Error('Could not allocate a unique management port');
    this.reservedPorts.add(port);

    try {
      await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
      const workDir = await mkdtemp(join(this.tempRoot, `${connectionId.slice(0, 8)}-`));
      const password = randomBytes(24).toString('hex');
      const managementPasswordFile = join(workDir, 'management.pw');
      await writeFile(managementPasswordFile, `${password}\n`, { mode: 0o600 });
      return { managementPort: port, managementPasswordFile, managementPassword: password, workDir };
    } catch (err) {
      this.reservedPorts.delete(port);
      throw err;
    }
  }

  async release(connectionId: string, res: ConnectionResources): Promise<void> {
    if (this.processes.get(connectionId)?.workDir === res.workDir) {
      this.processes.delete(connectionId);
      this.saveRegistry();
    }
    this.reservedPorts.delete(res.managementPort);
    await rm(res.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  register(connectionId: string, proc: VpnProcess, workDir: string): void {
    this.processes.set(connectionId, { proc, workDir });
    this.saveRegistry();
  }

  list(): { connectionId: string; pid?: number }[] {
    return [...this.processes].map(([connectionId, { proc }]) => ({ connectionId, pid: proc.pid }));
  }

  /** Last-resort synchronous kill (main process exiting). Graceful paths go through VpnManager. */
  killAll(): void {
    for (const { proc } of this.processes.values()) proc.kill();
  }
}
