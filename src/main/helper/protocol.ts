import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

// App ↔ privileged helper: newline-delimited JSON over a unix socket (macOS/Linux) or a
// named pipe (Windows). The first request must be `hello` with the install-time token.

export const HELPER_PROTOCOL = 1;

export interface HelperConfig {
  /** Shared secret; the app reads it from a file only the installing user can read. */
  token: string;
  socketPath: string;
  /** uid allowed to use the socket (unix); the socket is chowned to it with mode 0600. */
  ownerUid?: number;
  /** Profile and temp directories of the installing user; every path in a request must be inside. */
  allowedRoots: string[];
  /** OpenVPN binaries approved at install time, pinned by hash. */
  allowedBinaries: { path: string; sha256: string }[];
  /** Root-owned: sanitized config copies. */
  runDir: string;
  /** Root-owned: DNS backups for crash recovery. */
  stateDir: string;
}

export interface SpawnParams {
  connectionId: string;
  binary: string;
  args: string[];
  cwd: string;
}

export type HelperRequest = { id: number; method: string; params?: unknown };
export type HelperResponse = { id: number; result?: unknown; error?: string };
export type HelperEvent =
  | { event: 'line'; data: { connectionId: string; stream: 'stdout' | 'stderr'; line: string } }
  | { event: 'exit'; data: { connectionId: string; code: number | null; signal: string | null } };

export const defaultSocketPath = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? '\\\\.\\pipe\\multi-openvpn-helper' : '/var/run/multi-openvpn-helper.sock';

export const defaultHelperBase = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'darwin'
    ? '/Library/Application Support/MultiOpenVPN'
    : platform === 'win32'
      ? `${process.env.ProgramData ?? 'C:\\ProgramData'}\\MultiOpenVPN`
      : '/etc/multi-openvpn';

const MAX_LINE = 1024 * 1024;

/** Framing: one JSON value per line, in both directions. Oversized or malformed input closes the channel. */
export class JsonLineChannel extends EventEmitter<{ message: [unknown]; close: [] }> {
  private buf = '';

  constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      if (this.buf.length > MAX_LINE) return void socket.destroy();
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          this.emit('message', JSON.parse(line));
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    socket.on('close', () => this.emit('close'));
    socket.on('error', () => socket.destroy());
  }

  send(value: unknown): void {
    if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(value)}\n`);
  }

  close(): void {
    this.socket.destroy();
  }
}
