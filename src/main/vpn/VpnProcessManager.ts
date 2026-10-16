import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/**
 * Registry of live openvpn processes, one per connection, plus the per-connection
 * resources they need: a unique management port and a private temp directory.
 * Nothing here is shared between connections.
 */
export class VpnProcessManager {
  private readonly processes = new Map<string, VpnProcess>();
  private readonly reservedPorts = new Set<number>();

  constructor(private readonly tempRoot: string) {}

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
    this.processes.delete(connectionId);
    this.reservedPorts.delete(res.managementPort);
    await rm(res.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  register(connectionId: string, proc: VpnProcess): void {
    this.processes.set(connectionId, proc);
  }

  list(): { connectionId: string; pid?: number }[] {
    return [...this.processes].map(([connectionId, p]) => ({ connectionId, pid: p.pid }));
  }

  /** Last-resort synchronous kill (main process exiting). Graceful paths go through VpnManager. */
  killAll(): void {
    for (const p of this.processes.values()) p.kill();
  }
}
