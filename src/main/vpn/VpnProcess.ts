import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

/** How a process is created. DirectLauncher = child_process.spawn; Phase 8 adds the privileged helper. */
export type Launcher = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export const directLauncher: Launcher = (command, args, options) => spawn(command, args, { ...options, shell: false });

export interface VpnProcessOptions {
  binary: string;
  args: string[];
  cwd: string;
  launcher?: Launcher;
  /** Graceful stop request (Phase 3: management `signal SIGTERM`). Defaults to an OS SIGTERM. */
  requestStop?: () => void | Promise<void>;
  /** How long to wait for a graceful exit before force-killing. */
  stopTimeoutMs?: number;
}

/**
 * One openvpn process. Arguments are always an array and shell is always false:
 * no user value is ever interpreted by a shell.
 */
export class VpnProcess extends EventEmitter<{
  line: [stream: 'stdout' | 'stderr', line: string];
  exit: [code: number | null, signal: string | null];
}> {
  private child?: ChildProcess;
  private exitPromise?: Promise<void>;
  private exitedFlag = false;

  constructor(private readonly opts: VpnProcessOptions) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get exited(): boolean {
    return this.exitedFlag;
  }

  /** Resolves once the OS created the process; rejects with the spawn error (ENOENT, EACCES, ...). */
  start(): Promise<void> {
    if (this.child) return Promise.reject(new Error('Process already started'));
    const launcher = this.opts.launcher ?? directLauncher;
    const child = launcher(this.opts.binary, this.opts.args, {
      cwd: this.opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    for (const stream of ['stdout', 'stderr'] as const) {
      const src = child[stream];
      if (src) createInterface({ input: src }).on('line', (line) => this.emit('line', stream, line));
    }

    this.exitPromise = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.exitedFlag = true;
        this.emit('exit', code, signal);
        resolve();
      });
    });

    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => {
        // 'close' may not follow a failed spawn; make sure waiters are released.
        if (!child.pid) this.exitedFlag = true;
        reject(err);
      });
    });
  }

  /** Graceful stop → timeout → force kill. Resolves when the process is gone. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exitedFlag || !child.pid) return;
    const timeout = this.opts.stopTimeoutMs ?? 5_000;

    try {
      if (this.opts.requestStop) await this.opts.requestStop();
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }

    if (await this.waitExit(timeout)) return;
    child.kill('SIGKILL');
    await this.waitExit(timeout);
  }

  /** Immediate kill without waiting; used when the app itself is going down. */
  kill(): void {
    if (this.child?.pid && !this.exitedFlag) this.child.kill('SIGKILL');
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (!this.exitPromise) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
    const result = await Promise.race([this.exitPromise.then(() => true as const), timedOut]);
    clearTimeout(timer);
    return result;
  }
}
