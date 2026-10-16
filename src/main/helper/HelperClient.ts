import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import type { RouteEntry } from '../network/routeParsers';
import type { DnsSettings, PlatformNetworkService, RouteSpec } from '../platform/PlatformNetworkService';
import type { Launcher } from '../vpn/VpnProcess';
import { JsonLineChannel, type HelperEvent, type HelperResponse } from './protocol';

/**
 * Stand-in for a ChildProcess whose real process runs inside the helper. It implements exactly
 * what VpnProcess uses: pid, stdout/stderr streams, 'spawn' / 'error' / 'close' events, kill().
 */
class HelperChild extends EventEmitter {
  pid?: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;

  constructor(
    private readonly client: HelperClient,
    readonly connectionId: string,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    void this.client.call('signal', { connectionId: this.connectionId, signal: signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM' }).catch(() => undefined);
    return true;
  }

  /** Called by the client when the helper reports the process exit. */
  finish(code: number | null, signal: string | null): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

export class HelperClient extends EventEmitter<{ disconnected: [] }> {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly children = new Map<string, HelperChild>();
  private closed = false;

  private constructor(private readonly channel: JsonLineChannel) {
    super();
    channel.on('message', (m) => this.onMessage(m as HelperResponse | HelperEvent));
    channel.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('Privileged helper disconnected'));
      this.pending.clear();
      // The helper stops a session's processes when it ends; report them as gone.
      for (const c of this.children.values()) c.finish(null, 'SIGKILL');
      this.children.clear();
      this.emit('disconnected');
    });
  }

  static async connect(socketPath: string, token: string, timeoutMs = 2_000): Promise<HelperClient> {
    const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const s = connect(socketPath);
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error('Privileged helper not responding'));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const client = new HelperClient(new JsonLineChannel(socket));
    await client.call('hello', { token });
    return client;
  }

  get connected(): boolean {
    return !this.closed;
  }

  call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Privileged helper disconnected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel.send({ id, method, params });
    });
  }

  close(): void {
    this.channel.close();
  }

  /** Launcher for VpnProcess: openvpn is started by the helper, with root/SYSTEM rights. */
  readonly launcher: Launcher = (command, args, options) => {
    const connectionId = randomUUID();
    const child = new HelperChild(this, connectionId);
    this.children.set(connectionId, child);
    this.call('spawn', { connectionId, binary: command, args, cwd: String(options.cwd ?? '') })
      .then((r) => {
        child.pid = (r as { pid: number }).pid;
        child.emit('spawn');
      })
      .catch((err: Error) => {
        this.children.delete(connectionId);
        child.emit('error', Object.assign(new Error(err.message), { code: 'EHELPER' }));
      });
    return child as unknown as ChildProcess;
  };

  /** Platform operations: read-only ones stay local, changes go through the helper. */
  platform(local: PlatformNetworkService): PlatformNetworkService {
    return {
      getRoutes: (): Promise<RouteEntry[]> => local.getRoutes(),
      getCurrentDns: (): Promise<string[]> => local.getCurrentDns(),
      addRoute: async (route: RouteSpec) => void (await this.call('addRoute', { route })),
      removeRoute: async (route: RouteSpec) => void (await this.call('removeRoute', { route })),
      setDns: async (connectionId: string, dns: DnsSettings) => void (await this.call('setDns', { connectionId, dns })),
      restoreDns: async (connectionId: string) => void (await this.call('restoreDns', { connectionId })),
      restoreAllDns: async (keep: string[]) => void (await this.call('restoreAllDns', { keep })),
    };
  }

  private onMessage(m: HelperResponse | HelperEvent): void {
    if ('event' in m) {
      const child = this.children.get(m.data.connectionId);
      if (!child) return;
      if (m.event === 'line') (m.data.stream === 'stderr' ? child.stderr : child.stdout).write(`${m.data.line}\n`);
      else {
        this.children.delete(m.data.connectionId);
        child.finish(m.data.code, m.data.signal);
      }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  }
}
