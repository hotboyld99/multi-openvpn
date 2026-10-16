import { spawn, type ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, chownSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PlatformNetworkService } from '../platform/PlatformNetworkService';
import { commandLineOf } from '../vpn/VpnProcessManager';
import { sanitizeConfigForRoot, sha256File, validateOpenVpnArgs } from './policy';
import { HELPER_PROTOCOL, JsonLineChannel, type HelperConfig, type HelperRequest, type SpawnParams } from './protocol';

const CONN_ID = /^[0-9a-f-]{36}$/i;

interface Session {
  channel: JsonLineChannel;
  authed: boolean;
  children: Map<string, ChildProcess>;
  dns: Set<string>;
}

const tokenOk = (given: unknown, expected: string): boolean => {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
};

/**
 * The privileged side. It only does a fixed set of operations, validates every argument, and
 * ties everything it starts to the client session: when the app disconnects (quit, crash), its
 * openvpn processes are stopped and their DNS changes restored.
 */
export class HelperServer {
  private server?: Server;
  private readonly sessions = new Set<Session>();

  constructor(
    private readonly cfg: HelperConfig,
    private readonly platform: PlatformNetworkService,
  ) {}

  private get pidFile(): string {
    return join(this.cfg.runDir, 'children.json');
  }

  private savePids(): void {
    const pids = [...this.sessions].flatMap((s) => [...s.children.values()].map((c) => c.pid).filter(Boolean));
    writeFileSync(this.pidFile, JSON.stringify(pids), { mode: 0o600 });
  }

  /** If the helper itself was killed, its openvpn children survived: stop them (only if they are ours). */
  private async killLeftovers(): Promise<void> {
    let pids: number[] = [];
    try {
      pids = JSON.parse(readFileSync(this.pidFile, 'utf8')) as number[];
    } catch {
      return;
    }
    for (const pid of pids) {
      if ((await commandLineOf(pid))?.includes(this.cfg.runDir)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }

  async listen(): Promise<void> {
    await mkdir(this.cfg.runDir, { recursive: true, mode: 0o700 });
    await this.killLeftovers();
    this.savePids();
    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.cfg.socketPath); // stale socket from a previous run
      } catch {
        // none
      }
    }
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((res, rej) => {
      this.server!.once('error', rej);
      this.server!.listen(this.cfg.socketPath, () => res());
    });
    if (process.platform !== 'win32') {
      chmodSync(this.cfg.socketPath, 0o600);
      if (this.cfg.ownerUid !== undefined && process.getuid?.() === 0) chownSync(this.cfg.socketPath, this.cfg.ownerUid, 0);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions].map((s) => this.endSession(s)));
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
  }

  private accept(socket: Socket): void {
    const session: Session = { channel: new JsonLineChannel(socket), authed: false, children: new Map(), dns: new Set() };
    this.sessions.add(session);
    session.channel.on('message', (m) => void this.onRequest(session, m as HelperRequest));
    session.channel.on('close', () => void this.endSession(session));
  }

  private async endSession(s: Session): Promise<void> {
    if (!this.sessions.delete(s)) return;
    // Graceful first; whatever is still running after 2s is killed. DNS is restored once the tunnels are gone.
    const children = [...s.children.values()];
    const gone = children.map((c) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((r) => c.once('close', r))));
    for (const child of children) child.kill('SIGTERM');
    const timeout = new Promise((r) => setTimeout(r, 2_000));
    await Promise.race([Promise.all(gone), timeout]);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const id of s.dns) await this.platform.restoreDns(id).catch(() => undefined);
    s.channel.close();
  }

  private async onRequest(s: Session, req: HelperRequest): Promise<void> {
    const reply = (result?: unknown, error?: string): void => s.channel.send(error ? { id: req.id, error } : { id: req.id, result });
    try {
      if (typeof req?.id !== 'number' || typeof req.method !== 'string') throw new Error('Malformed request');
      if (!s.authed) {
        if (req.method !== 'hello' || !tokenOk((req.params as { token?: unknown })?.token, this.cfg.token)) {
          reply(undefined, 'Unauthorized');
          return s.channel.close();
        }
        s.authed = true;
        return reply({ protocol: HELPER_PROTOCOL, pid: process.pid });
      }
      reply(await this.dispatch(s, req.method, req.params ?? {}));
    } catch (err) {
      reply(undefined, (err as Error).message);
    }
  }

  private async dispatch(s: Session, method: string, p: Record<string, unknown> | unknown): Promise<unknown> {
    const params = p as Record<string, unknown>;
    const connId = (): string => {
      const id = params.connectionId;
      if (typeof id !== 'string' || !CONN_ID.test(id)) throw new Error('Invalid connection id');
      return id;
    };
    switch (method) {
      case 'spawn':
        return this.spawnOpenVpn(s, params as unknown as SpawnParams, connId());
      case 'signal': {
        const child = s.children.get(connId());
        const sig = params.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
        child?.kill(sig);
        return { ok: !!child };
      }
      case 'setDns': {
        const id = connId();
        await this.platform.setDns(id, params.dns as never); // validated by the platform layer
        s.dns.add(id);
        return { ok: true };
      }
      case 'restoreDns': {
        const id = connId();
        await this.platform.restoreDns(id);
        s.dns.delete(id);
        return { ok: true };
      }
      case 'restoreAllDns': {
        const keep = Array.isArray(params.keep) ? params.keep.filter((k): k is string => typeof k === 'string' && CONN_ID.test(k)) : [];
        await this.platform.restoreAllDns(keep);
        return { ok: true };
      }
      case 'removeRoute':
      case 'addRoute': {
        const r = params.route as { destination?: unknown; gateway?: unknown; interface?: unknown };
        const dest = String(r?.destination ?? '');
        const [ip, bits] = dest.split('/');
        if (!/^[0-9a-f.:]+$/i.test(ip) || !/^\d{1,3}$/.test(bits ?? '')) throw new Error('Invalid route');
        if (r.gateway !== undefined && !/^[0-9a-f.:]+$/i.test(String(r.gateway))) throw new Error('Invalid gateway');
        if (r.interface !== undefined && !/^[\w .()-]{1,64}$/.test(String(r.interface))) throw new Error('Invalid interface');
        const spec = { destination: dest, gateway: r.gateway as string | undefined, interface: r.interface as string | undefined };
        await (method === 'addRoute' ? this.platform.addRoute(spec) : this.platform.removeRoute(spec));
        return { ok: true };
      }
      default:
        throw new Error(`Unknown method ${method.slice(0, 40)}`);
    }
  }

  private async spawnOpenVpn(s: Session, p: SpawnParams, connectionId: string): Promise<{ pid: number }> {
    if (s.children.has(connectionId)) throw new Error('Connection already has a process');
    const approved = this.cfg.allowedBinaries.find((b) => b.path === p.binary);
    if (!approved || (await sha256File(p.binary)) !== approved.sha256) throw new Error('OpenVPN binary is not approved (re-install the helper after changing it)');
    if (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string')) throw new Error('Invalid arguments');

    const v = validateOpenVpnArgs(p.args, this.cfg.allowedRoots);
    if (p.cwd !== v.cd) throw new Error('Working directory must equal --cd');
    if ((await stat(v.config)).size > 1024 * 1024) throw new Error('Config too large');

    // Validate a root-owned copy: the app could rewrite its own file after the check otherwise.
    const copy = join(this.cfg.runDir, `${connectionId}.ovpn`);
    await writeFile(copy, sanitizeConfigForRoot(await readFile(v.config, 'utf8'), v.cd), { mode: 0o600 });

    const args = [
      '--cd', v.cd,
      '--config', copy,
      '--management', '127.0.0.1', String(v.managementPort), v.managementPasswordFile,
      '--management-hold', '--management-query-passwords', '--suppress-timestamps', '--verb', '3',
      ...v.extra,
      '--script-security', '1', // never run scripts from a user-controlled config as root
    ];
    const child = spawn(approved.path, args, { cwd: v.cd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await new Promise<void>((res, rej) => {
      child.once('spawn', res);
      child.once('error', rej);
    });
    s.children.set(connectionId, child);
    this.savePids();
    for (const stream of ['stdout', 'stderr'] as const) {
      createInterface({ input: child[stream]! }).on('line', (line) => s.channel.send({ event: 'line', data: { connectionId, stream, line } }));
    }
    child.once('close', (code, signal) => {
      s.children.delete(connectionId);
      this.savePids();
      void rm(copy, { force: true });
      s.channel.send({ event: 'exit', data: { connectionId, code, signal } });
    });
    return { pid: child.pid! };
  }
}
