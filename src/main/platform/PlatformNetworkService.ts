import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { RouteEntry } from '../network/routeParsers';

export interface RouteSpec {
  /** CIDR */
  destination: string;
  gateway?: string;
  interface?: string;
}

export interface DnsSettings {
  servers: string[];
  domains: string[];
  /** global = default resolver; split = only `domains` use `servers`. */
  scope: 'global' | 'split';
  /** Tunnel interface (needed on Windows/Linux, where DNS is per interface). */
  interfaceName?: string;
}

/**
 * OS-specific network operations. Implemented per platform; the mutating ones need
 * root/admin and run inside the privileged helper in production (Phase 8).
 */
export interface PlatformNetworkService {
  getRoutes(): Promise<RouteEntry[]>;
  addRoute(route: RouteSpec): Promise<void>;
  removeRoute(route: RouteSpec): Promise<void>;
  /** Servers the system resolver currently uses by default. */
  getCurrentDns(): Promise<string[]>;
  /** Applies DNS for one connection; owned by connectionId so restore is exact. */
  setDns(connectionId: string, dns: DnsSettings): Promise<void>;
  /** Undoes exactly what setDns(connectionId) changed. No-op if nothing was changed. */
  restoreDns(connectionId: string): Promise<void>;
  /** Crash recovery: undo DNS changes of every connection not in `keep`. */
  restoreAllDns(keep: string[]): Promise<void>;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/i;
const CONN_ID = /^[0-9a-f-]{36}$/i;
const IFACE = /^[\w .()-]{1,64}$/;

/**
 * Trust boundary for DNS values: they end up in scutil/PowerShell/resolvectl commands run as
 * root, so anything that is not a plain IP, domain or interface name is rejected.
 */
export function validateDns(connectionId: string, dns: DnsSettings): void {
  if (!CONN_ID.test(connectionId)) throw new Error('Invalid connection id');
  if (dns.servers.length === 0 || dns.servers.length > 8 || dns.servers.some((s) => !isIP(s))) throw new Error('Invalid DNS servers');
  if (dns.domains.length > 32 || dns.domains.some((d) => !DOMAIN.test(d))) throw new Error('Invalid DNS domains');
  if (dns.interfaceName !== undefined && !IFACE.test(dns.interfaceName)) throw new Error('Invalid interface name');
}

/** Small JSON file remembering what was changed, so it can be undone even after a crash. */
export class StateFile<T> {
  constructor(
    private readonly dir: string,
    private readonly name: string,
  ) {}

  read(): Record<string, T> {
    try {
      return JSON.parse(readFileSync(join(this.dir, this.name), 'utf8')) as Record<string, T>;
    } catch {
      return {};
    }
  }

  write(data: Record<string, T>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, this.name);
    writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
}

/** Runs a program without a shell; rejects with stderr on failure. */
export function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0] ?? ''} failed: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
