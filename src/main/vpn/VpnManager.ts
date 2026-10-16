import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isRetryable, vpnError } from '../../shared/errors';
import {
  isLive,
  VpnErrorCode,
  type LogEntry,
  type LogLevel,
  type VpnConnection,
  type VpnError,
  type VpnProfile,
} from '../../shared/types';
import { mapOpenVpnState, VpnDriverError, type DriverEvent, type DriverFactory, type VpnDriver } from './VpnDriver';

/** Automatic reconnect delays; the last value repeats. */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_LOG_ENTRIES = 5_000;

interface Entry {
  conn: VpnConnection;
  logs: LogEntry[];
  driver?: VpnDriver;
  /** Bumped for every driver started; events from older drivers are dropped. */
  generation: number;
  /** The user asked the current driver to stop. */
  stopping: boolean;
  /** Error seen while the process was still alive; reported when it exits. */
  pendingError?: VpnError;
  /** Consecutive failed attempts, indexes BACKOFF_MS. */
  attempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Byte counters restart with every process; totals carry over between attempts. */
  baseIn: number;
  baseOut: number;
  lastBytesAt?: number;
}

export interface VpnManagerEvents {
  connection: [VpnConnection];
  removed: [connectionId: string];
  log: [connectionId: string, entry: LogEntry];
  connected: [VpnConnection];
}

export interface VpnManagerDeps {
  createDriver: DriverFactory;
  getProfile(id: string): VpnProfile | undefined;
}

/**
 * Owns every connection, indexed by connectionId. Each connection has its own driver
 * (= its own openvpn process); nothing here is shared between connections except this map.
 */
export class VpnManager extends EventEmitter<VpnManagerEvents> {
  private readonly entries = new Map<string, Entry>();
  private logSeq = 0;

  constructor(private readonly deps: VpnManagerDeps) {
    super();
  }

  list(): VpnConnection[] {
    return [...this.entries.values()].map((e) => ({ ...e.conn }));
  }

  get(connectionId: string): VpnConnection | undefined {
    const e = this.entries.get(connectionId);
    return e && { ...e.conn };
  }

  getLogs(connectionId: string): LogEntry[] {
    return [...(this.entries.get(connectionId)?.logs ?? [])];
  }

  clearLogs(connectionId: string): void {
    const e = this.entries.get(connectionId);
    if (e) e.logs = [];
  }

  activeCount(): number {
    return [...this.entries.values()].filter((e) => isLive(e.conn.status)).length;
  }

  /** Starts a connection for the profile, or returns the live one it already has. */
  connect(profileId: string): string {
    if (!this.deps.getProfile(profileId)) throw new Error(`Profile ${profileId} not found`);

    const previous = this.findByProfile(profileId);
    if (previous && isLive(previous.conn.status)) return previous.conn.id;
    if (previous) this.drop(previous);

    const entry: Entry = {
      conn: {
        id: randomUUID(),
        profileId,
        status: 'CONNECTING',
        startedAt: Date.now(),
        bytesIn: 0,
        bytesOut: 0,
        rateIn: 0,
        rateOut: 0,
        reconnectCount: 0,
      },
      logs: [],
      generation: 0,
      stopping: false,
      attempt: 0,
      baseIn: 0,
      baseOut: 0,
    };
    this.entries.set(entry.conn.id, entry);
    void this.startAttempt(entry);
    return entry.conn.id;
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.require(connectionId);
    this.clearRetry(entry);
    const driver = entry.driver;
    if (!driver) {
      if (isLive(entry.conn.status)) this.finishStopped(entry);
      return;
    }
    entry.stopping = true;
    this.patch(entry, { status: 'DISCONNECTING', nextRetryAt: undefined });
    this.log(entry, 'info', 'Disconnect requested');
    const generation = entry.generation;
    await driver.stop();
    // Normally the driver's exit event already finished the job; this covers drivers that resolve stop() first.
    if (entry.generation === generation && entry.stopping) this.finishStopped(entry);
  }

  /** User-initiated restart of one connection. Other connections are untouched. */
  async reconnect(connectionId: string): Promise<void> {
    const entry = this.require(connectionId);
    this.clearRetry(entry);
    const old = entry.driver;
    entry.generation++; // silence the old driver: its exit must not be treated as a crash
    entry.driver = undefined;
    entry.attempt = 0;
    entry.conn.reconnectCount++;
    this.patch(entry, { status: 'RECONNECTING', connectedAt: undefined, rateIn: 0, rateOut: 0 });
    this.log(entry, 'info', 'Reconnect requested');
    if (old) await old.stop();
    await this.startAttempt(entry);
  }

  async disconnectAll(): Promise<void> {
    const live = [...this.entries.values()].filter((e) => isLive(e.conn.status));
    await Promise.allSettled(live.map((e) => this.disconnect(e.conn.id)));
  }

  /** Disconnects and forgets the connection of a profile (used when the profile is deleted). */
  async removeProfile(profileId: string): Promise<void> {
    const entry = this.findByProfile(profileId);
    if (!entry) return;
    if (isLive(entry.conn.status)) await this.disconnect(entry.conn.id);
    this.drop(entry);
  }

  // ---------------------------------------------------------------------------

  private async startAttempt(entry: Entry): Promise<void> {
    const generation = ++entry.generation;
    const profile = this.deps.getProfile(entry.conn.profileId);
    if (!profile) {
      this.fail(entry, vpnError(VpnErrorCode.INVALID_CONFIG, 'Profile no longer exists'));
      return;
    }

    entry.stopping = false;
    entry.pendingError = undefined;
    entry.baseIn = entry.conn.bytesIn;
    entry.baseOut = entry.conn.bytesOut;
    entry.lastBytesAt = undefined;

    const driver = this.deps.createDriver({
      connectionId: entry.conn.id,
      profile,
      emit: (event) => {
        if (entry.generation === generation) this.onDriverEvent(entry, event);
      },
    });
    entry.driver = driver;
    this.patch(entry, {
      status: 'CONNECTING',
      pid: undefined,
      managementPort: undefined,
      assignedIp: undefined,
      interfaceName: undefined,
      gateway: undefined,
      connectedAt: undefined,
      nextRetryAt: undefined,
      error: undefined,
      rateIn: 0,
      rateOut: 0,
    });

    try {
      await driver.start();
      if (entry.generation === generation && entry.driver === driver) {
        this.patch(entry, { pid: driver.pid, managementPort: driver.managementPort });
      }
    } catch (err) {
      if (entry.generation !== generation) return;
      entry.driver = undefined;
      const error = err instanceof VpnDriverError ? err.vpnError : vpnError(VpnErrorCode.UNKNOWN, String(err));
      this.log(entry, 'error', `${error.title}: ${error.detail ?? error.message}`);
      this.fail(entry, error);
    }
  }

  private onDriverEvent(entry: Entry, event: DriverEvent): void {
    switch (event.type) {
      case 'log':
        this.log(entry, event.level, event.message);
        return;

      case 'state': {
        const status = mapOpenVpnState(event.state);
        if (!status || entry.stopping) return;
        const patch: Partial<VpnConnection> = { status };
        if (event.localIp) patch.assignedIp = event.localIp;
        if (event.remote) patch.remote = event.remote;
        if (event.gateway) patch.gateway = event.gateway;
        if (status === 'RECONNECTING') {
          // openvpn restarted the tunnel itself (ping-restart, TLS renegotiation failure, ...)
          entry.conn.reconnectCount++;
          patch.connectedAt = undefined;
        }
        if (status === 'CONNECTED') {
          entry.attempt = 0;
          patch.connectedAt = Date.now();
          patch.error = undefined;
        }
        this.patch(entry, patch);
        if (status === 'CONNECTED') this.emit('connected', { ...entry.conn });
        return;
      }

      case 'bytes': {
        const now = Date.now();
        const bytesIn = entry.baseIn + event.bytesIn;
        const bytesOut = entry.baseOut + event.bytesOut;
        const dt = entry.lastBytesAt ? (now - entry.lastBytesAt) / 1000 : 0;
        entry.lastBytesAt = now;
        this.patch(entry, {
          bytesIn,
          bytesOut,
          rateIn: dt > 0 ? Math.max(0, (bytesIn - entry.conn.bytesIn) / dt) : 0,
          rateOut: dt > 0 ? Math.max(0, (bytesOut - entry.conn.bytesOut) / dt) : 0,
        });
        return;
      }

      case 'interface':
        this.patch(entry, { interfaceName: event.name });
        return;

      case 'error':
        entry.pendingError = event.error;
        this.patch(entry, { error: event.error });
        this.log(entry, 'error', `${event.error.title}: ${event.error.detail ?? event.error.message}`);
        // openvpn would keep retrying a wrong password or an expired cert forever; stop it now.
        if (!isRetryable(event.error.code) && entry.driver && !entry.stopping) void entry.driver.stop();
        return;

      case 'exit': {
        entry.driver = undefined;
        if (entry.stopping) {
          this.finishStopped(entry);
          return;
        }
        const reason = event.signal ? `signal ${event.signal}` : `exit code ${event.code}`;
        this.log(entry, 'warn', `OpenVPN process exited (${reason})`);
        this.fail(entry, entry.pendingError ?? vpnError(VpnErrorCode.PROCESS_CRASHED, reason));
        return;
      }
    }
  }

  private fail(entry: Entry, error: VpnError): void {
    const profile = this.deps.getProfile(entry.conn.profileId);
    const base: Partial<VpnConnection> = {
      error,
      pid: undefined,
      managementPort: undefined,
      connectedAt: undefined,
      rateIn: 0,
      rateOut: 0,
    };

    if (profile?.reconnect && isRetryable(error.code)) {
      const delay = BACKOFF_MS[Math.min(entry.attempt, BACKOFF_MS.length - 1)];
      entry.attempt++;
      this.patch(entry, { ...base, status: 'RECONNECTING', nextRetryAt: Date.now() + delay });
      this.log(entry, 'warn', `Reconnecting in ${delay / 1000}s (attempt ${entry.attempt})`);
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        entry.conn.reconnectCount++;
        void this.startAttempt(entry);
      }, delay);
      return;
    }

    this.patch(entry, { ...base, status: 'ERROR', nextRetryAt: undefined });
  }

  private finishStopped(entry: Entry): void {
    entry.stopping = false;
    entry.driver = undefined;
    if (entry.conn.status === 'DISCONNECTED') return;
    this.patch(entry, {
      status: 'DISCONNECTED',
      interfaceName: undefined,
      pid: undefined,
      managementPort: undefined,
      connectedAt: undefined,
      nextRetryAt: undefined,
      error: undefined,
      rateIn: 0,
      rateOut: 0,
    });
    this.log(entry, 'info', 'Disconnected');
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  }

  private drop(entry: Entry): void {
    this.clearRetry(entry);
    entry.generation++;
    this.entries.delete(entry.conn.id);
    this.emit('removed', entry.conn.id);
  }

  private patch(entry: Entry, patch: Partial<VpnConnection>): void {
    Object.assign(entry.conn, patch);
    this.emit('connection', { ...entry.conn });
  }

  private log(entry: Entry, level: LogLevel, message: string): void {
    const item: LogEntry = { seq: ++this.logSeq, ts: Date.now(), level, message };
    entry.logs.push(item);
    if (entry.logs.length > MAX_LOG_ENTRIES) entry.logs.splice(0, entry.logs.length - MAX_LOG_ENTRIES);
    this.emit('log', entry.conn.id, item);
  }

  private findByProfile(profileId: string): Entry | undefined {
    for (const e of this.entries.values()) if (e.conn.profileId === profileId) return e;
    return undefined;
  }

  private require(connectionId: string): Entry {
    const entry = this.entries.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);
    return entry;
  }
}
