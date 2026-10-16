import type { LogLevel, SecretInput, VpnError, VpnProfile, VpnStatus } from '../../shared/types';

/**
 * Raw events a driver reports for its own connection. A driver knows nothing about
 * other connections, reconnect policy or the UI — VpnManager owns all of that.
 */
export type DriverEvent =
  | { type: 'state'; state: string; localIp?: string; remote?: string; gateway?: string }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'bytes'; bytesIn: number; bytesOut: number }
  /** Tunnel details learned from the log: interface name, pushed gateway. */
  | { type: 'netinfo'; interfaceName?: string; gateway?: string }
  /** A failure detected while the process is still alive (e.g. AUTH_FAILED in the log). */
  | { type: 'error'; error: VpnError }
  /** The process is gone. Must be emitted exactly once per started driver. */
  | { type: 'exit'; code: number | null; signal: string | null };

export interface VpnDriver {
  readonly pid?: number;
  readonly managementPort?: number;
  /** Spawns the process. Rejects (with VpnDriverError) when it cannot even start. */
  start(): Promise<void>;
  /** Graceful stop with forced fallback. Resolves once the process is gone. */
  stop(): Promise<void>;
}

export interface SecretRequest {
  realm: string;
  needsUsername: boolean;
}

export interface DriverContext {
  connectionId: string;
  profile: VpnProfile;
  emit(event: DriverEvent): void;
  /** Asks the user (or, later, secure storage) for a secret. Resolves null when cancelled. */
  requestSecret(req: SecretRequest): Promise<SecretInput | null>;
}

export type DriverFactory = (ctx: DriverContext) => VpnDriver;

export class VpnDriverError extends Error {
  constructor(readonly vpnError: VpnError) {
    super(vpnError.message);
  }
}

const STATE_MAP: Record<string, VpnStatus> = {
  CONNECTING: 'CONNECTING',
  RESOLVE: 'CONNECTING',
  TCP_CONNECT: 'CONNECTING',
  WAIT: 'WAIT',
  AUTH: 'AUTH',
  AUTH_PENDING: 'AUTH',
  GET_CONFIG: 'GET_CONFIG',
  ASSIGN_IP: 'ASSIGN_IP',
  ADD_ROUTES: 'ADD_ROUTES',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  EXITING: 'DISCONNECTING',
};

/** Maps an OpenVPN management-interface state name to our status; unknown names are ignored. */
export const mapOpenVpnState = (state: string): VpnStatus | undefined => STATE_MAP[state];
