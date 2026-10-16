import type { DnsMode, DnsState } from '../../shared/types';
import type { PlatformNetworkService } from '../platform/PlatformNetworkService';

export interface DnsRequest {
  connectionId: string;
  /** Profile name, used in conflict messages. */
  label: string;
  mode: DnsMode;
  customServers?: string[];
  pushed?: { servers: string[]; domains: string[] };
  ownsDefaultRoute: boolean;
  interfaceName?: string;
}

export interface GlobalOwner {
  connectionId: string;
  label: string;
  servers: string[];
}

/**
 * What DNS a connection should get:
 *  - system: nothing changes.
 *  - vpn: pushed servers; custom: the profile's servers.
 *  - split when the VPN does not own the default route and has domains: only those domains
 *    use its servers, so any number of VPNs coexist.
 *  - global otherwise: its servers answer everything, and only one VPN may do that.
 */
export function planDns(req: DnsRequest, owner?: GlobalOwner): DnsState {
  const servers = req.mode === 'custom' ? (req.customServers ?? []) : req.mode === 'vpn' ? (req.pushed?.servers ?? []) : [];
  const domains = req.mode === 'vpn' ? (req.pushed?.domains ?? []) : [];
  if (req.mode === 'system' || servers.length === 0) return { mode: req.mode, scope: 'none', servers: [], domains: [], applied: false };
  const scope = req.ownsDefaultRoute || domains.length === 0 ? 'global' : 'split';
  if (scope === 'global' && owner && owner.connectionId !== req.connectionId) {
    return { mode: req.mode, scope, servers, domains, applied: false, warning: `DNS not changed: “${owner.label}” already controls the system DNS` };
  }
  return { mode: req.mode, scope, servers, domains, applied: true };
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Applies and restores DNS per connection, with one global owner at most. */
export class DnsManager {
  private owner?: GlobalOwner & { interfaceName?: string; domains: string[] };
  private readonly applied = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: PlatformNetworkService,
    private readonly opts: { simulate?: boolean; reassertMs?: number } = {},
  ) {
    // macOS rewrites the primary service's DNS on DHCP renewal; put ours back.
    if (opts.reassertMs && !opts.simulate) this.timer = setInterval(() => void this.reassert(), opts.reassertMs);
  }

  globalOwner(): GlobalOwner | undefined {
    return this.owner;
  }

  async setDns(req: DnsRequest): Promise<DnsState> {
    if (this.applied.has(req.connectionId)) await this.restore(req.connectionId);
    const plan = planDns(req, this.owner);
    if (!plan.applied) return plan;
    if (!this.opts.simulate) {
      try {
        await this.platform.setDns(req.connectionId, { servers: plan.servers, domains: plan.domains, scope: plan.scope as 'global' | 'split', interfaceName: req.interfaceName });
      } catch (err) {
        await this.platform.restoreDns(req.connectionId).catch(() => undefined); // undo a half-applied change
        return { ...plan, applied: false, warning: `DNS could not be applied: ${(err as Error).message}` };
      }
    }
    this.applied.add(req.connectionId);
    if (plan.scope === 'global') this.owner = { connectionId: req.connectionId, label: req.label, servers: plan.servers, domains: plan.domains, interfaceName: req.interfaceName };
    return plan;
  }

  /** Restores the system DNS for a connection (disconnect, crash, reconnect). */
  async restore(connectionId: string): Promise<void> {
    this.applied.delete(connectionId);
    if (this.owner?.connectionId === connectionId) this.owner = undefined;
    if (!this.opts.simulate) await this.platform.restoreDns(connectionId);
  }

  /** At startup: undo whatever a previous run (that crashed) left behind. */
  async recover(): Promise<void> {
    if (!this.opts.simulate) await this.platform.restoreAllDns([]);
  }

  getCurrentDns(): Promise<string[]> {
    return this.platform.getCurrentDns();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async reassert(): Promise<void> {
    const o = this.owner;
    if (!o) return;
    const current = await this.platform.getCurrentDns().catch(() => o.servers);
    if (sameSet(current, o.servers)) return;
    await this.platform
      .setDns(o.connectionId, { servers: o.servers, domains: o.domains, scope: 'global', interfaceName: o.interfaceName })
      .catch(() => undefined);
  }
}
