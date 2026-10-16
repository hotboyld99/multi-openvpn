import { execFile } from 'node:child_process';
import type { RouteEntry } from '../network/routeParsers';

export interface RouteSpec {
  /** CIDR */
  destination: string;
  gateway?: string;
  interface?: string;
}

/**
 * OS-specific network operations. Implemented per platform; the mutating ones need
 * root/admin and run inside the privileged helper in production (Phase 8).
 */
export interface PlatformNetworkService {
  getRoutes(): Promise<RouteEntry[]>;
  addRoute(route: RouteSpec): Promise<void>;
  removeRoute(route: RouteSpec): Promise<void>;
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
