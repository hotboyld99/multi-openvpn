import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RouteRule, VpnProfile } from '../../shared/types';
import { cidrToRoute } from './routeParsers';

// Multi-VPN routing rules:
//  1. At most one connection may hold the default route. The first live connection started
//     with defaultRoute 'take' holds it until it turns out not to want it.
//  2. Every other connection is started with redirect-gateway filtered out, so a server that
//     pushes it cannot silently steal the default route from the holder.
//  3. A profile known to want the default route while another VPN holds it is a conflict the
//     user resolves explicitly (replace / keep / always ignore / custom routes).

export type DefaultRouteDecision = { defaultRoute: 'take' | 'skip' } | { conflict: true };

export interface DecisionInput {
  profile: Pick<VpnProfile, 'routingMode' | 'ignoreRedirectGateway' | 'wantsDefaultRoute' | 'pushesDefaultRoute'>;
  /** Another live connection currently holds the default route. */
  holderExists: boolean;
  /** Explicit choice from the conflict dialog. */
  choice?: 'take' | 'skip';
}

export function decideDefaultRoute({ profile, holderExists, choice }: DecisionInput): DefaultRouteDecision {
  if (profile.routingMode === 'custom' || profile.ignoreRedirectGateway) return { defaultRoute: 'skip' };
  if (choice) return { defaultRoute: choice };
  if (!holderExists) return { defaultRoute: 'take' };
  return profile.wantsDefaultRoute || profile.pushesDefaultRoute ? { conflict: true } : { defaultRoute: 'skip' };
}

export interface ResolvedRoutes {
  /** IPv4 routes as network/netmask pairs, IPv6 as CIDR. */
  v4: { network: string; netmask: string; source: string }[];
  v6: { cidr: string; source: string }[];
  /** Rules that could not be applied (e.g. hostname did not resolve). */
  failed: { rule: string; reason: string }[];
}

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultLookup: Lookup = (host) => lookup(host, { all: true });

/**
 * Turns user rules into concrete routes. Hostnames are resolved once, at connect time:
 * if the name later points elsewhere the route is stale until the VPN reconnects.
 */
export async function resolveCustomRoutes(rules: RouteRule[], resolve: Lookup = defaultLookup): Promise<ResolvedRoutes> {
  const out: ResolvedRoutes = { v4: [], v6: [], failed: [] };
  const add = (addr: string, bits: number | undefined, source: string): void => {
    if (isIP(addr) === 6) out.v6.push({ cidr: `${addr}/${bits ?? 128}`, source });
    else out.v4.push({ ...cidrToRoute(`${addr}/${bits ?? 32}`), source });
  };
  for (const rule of rules) {
    if (rule.type === 'hostname') {
      try {
        const addrs = await resolve(rule.value);
        if (addrs.length === 0) throw new Error('no address');
        for (const a of addrs) add(a.address, undefined, rule.value);
      } catch (err) {
        out.failed.push({ rule: rule.value, reason: (err as Error).message });
      }
    } else {
      const [addr, bits] = rule.value.split('/');
      add(addr, bits === undefined ? undefined : Number(bits), rule.value);
    }
  }
  return out;
}

export interface RoutingPlan {
  defaultRoute: 'take' | 'skip';
  mode: 'config' | 'custom';
  routes?: ResolvedRoutes;
  /** openvpn only accepts --pull-filter when it pulls options from a server. */
  pulls: boolean;
}

/** Directives removed from the runtime copy of the config (CLI options cannot unset them). */
export function directivesToStrip(plan: RoutingPlan): string[] {
  if (plan.mode === 'custom') return ['redirect-gateway', 'redirect-private', 'route', 'route-ipv6'];
  if (plan.defaultRoute === 'skip') return ['redirect-gateway', 'redirect-private'];
  return [];
}

/** Extra openvpn arguments implementing the plan. */
export function routingArgs(plan: RoutingPlan): string[] {
  const args: string[] = [];
  const filter = (action: 'accept' | 'ignore', text: string): void => {
    if (plan.pulls) args.push('--pull-filter', action, text);
  };
  if (plan.mode === 'custom') {
    filter('accept', 'route-gateway'); // first match wins: keep the gateway our routes use
    filter('accept', 'route-metric');
    filter('ignore', 'route'); // also matches route-ipv6
    filter('ignore', 'redirect-');
  } else if (plan.defaultRoute === 'skip') {
    filter('ignore', 'redirect-gateway');
    filter('ignore', 'redirect-private');
  }
  for (const r of plan.routes?.v4 ?? []) args.push('--route', r.network, r.netmask);
  for (const r of plan.routes?.v6 ?? []) args.push('--route-ipv6', r.cidr);
  return args;
}
