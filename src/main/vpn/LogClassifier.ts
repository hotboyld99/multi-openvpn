import { vpnError } from '../../shared/errors';
import { VpnErrorCode, type LogLevel, type VpnError } from '../../shared/types';

export interface LineInfo {
  error?: VpnError;
  interfaceName?: string;
  gateway?: string;
  /** The server pushed redirect-gateway / redirect-private. */
  pushedDefaultRoute?: boolean;
  /** DNS settings pushed by the server (dhcp-option DNS/DOMAIN or OpenVPN 2.6 `dns`). */
  dns?: { servers: string[]; domains: string[] };
}

/** DNS servers and domains in a list of pushed/config options ("dhcp-option DNS 10.8.0.1", "dns server 0 address ..."). */
export function dnsFromOptions(options: string[]): { servers: string[]; domains: string[] } {
  const servers: string[] = [];
  const domains: string[] = [];
  for (const opt of options) {
    const [kw, a, b, ...rest] = opt.trim().split(/\s+/);
    if (kw === 'dhcp-option' && (a === 'DNS' || a === 'DNS6') && b) servers.push(b);
    else if (kw === 'dhcp-option' && (a === 'DOMAIN' || a === 'DOMAIN-SEARCH' || a === 'ADAPTER_DOMAIN_SUFFIX') && b) domains.push(b);
    else if (kw === 'dns' && a === 'server' && rest[0] && b !== undefined && rest[0] === 'address') servers.push(...rest.slice(1));
    else if (kw === 'dns' && a === 'search-domains') domains.push(...[b, ...rest].filter(Boolean));
  }
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  return { servers: uniq(servers), domains: uniq(domains.map((d) => d.toLowerCase().replace(/\.$/, ''))) };
}

interface Rule {
  re: RegExp;
  code: VpnErrorCode;
  title?: string;
  message?: string;
}

// Order matters: the first match wins.
const RULES: Rule[] = [
  { re: /AUTH_FAILED|Verification Failed: 'Auth'/, code: VpnErrorCode.AUTH_FAILED },
  {
    re: /private key password verification failed|Verification Failed: 'Private Key'/i,
    code: VpnErrorCode.AUTH_FAILED,
    title: 'Wrong Private Key Password',
    message: 'The password for the private key in this profile is incorrect.',
  },
  { re: /certificate has expired|CRL has expired|certificate is not yet valid/i, code: VpnErrorCode.CERT_EXPIRED },
  { re: /TLS key negotiation failed to occur within|Connection timed out|connection timeout|Server poll timeout/i, code: VpnErrorCode.CONNECTION_TIMEOUT },
  { re: /TLS Error|TLS handshake failed|VERIFY ERROR|tls_process|TLS_ERROR/, code: VpnErrorCode.TLS_ERROR },
  {
    re: /Connection refused|Network is unreachable|No route to host|Cannot resolve host address|RESOLVE: Cannot resolve|getaddrinfo failed/i,
    code: VpnErrorCode.NETWORK_UNREACHABLE,
  },
  {
    re: /Cannot allocate TUN\/TAP dev dynamically|Cannot open TUN\/TAP dev|Operation not permitted|Permission denied|must be root|Access is denied/i,
    code: VpnErrorCode.PERMISSION_DENIED,
  },
  {
    re: /Options error|Error opening configuration file|Unrecognized option|option .* is missing|Cannot load (?:CA|certificate|private key)|Cannot pre-load/i,
    code: VpnErrorCode.INVALID_CONFIG,
  },
  {
    re: /route addition failed|route add command failed|ERROR: .*route|route_ipv4_add|Route: Waiting for TUN\/TAP interface to come up failed/i,
    code: VpnErrorCode.ROUTE_CONFLICT,
    title: 'Route Error',
    message: 'OpenVPN could not install one or more routes. Another VPN may already use the same network.',
  },
  {
    re: /dhcp-option DNS.*(?:failed|error)|DNS.*(?:failed to|error setting)|set DNS.*failed/i,
    code: VpnErrorCode.DNS_CONFLICT,
    title: 'DNS Error',
    message: 'OpenVPN could not apply the DNS settings pushed by the server.',
  },
];

const INTERFACE = [
  /Opened utun device (\S+)/,
  /TUN\/TAP device (\S+) opened/,
  /(?:Wintun|TAP-WIN32|TAP-Windows) device \[([^\]]+)\] opened/,
  /DCO device (\S+) opened/,
];

/**
 * Extracts what a single OpenVPN log line means: a user-facing error, the tunnel
 * interface name, or the gateway pushed by the server.
 */
export function classifyLine(line: string): LineInfo {
  const info: LineInfo = {};

  for (const re of INTERFACE) {
    const m = re.exec(line);
    if (m) info.interfaceName = m[1];
  }

  if (line.includes('PUSH_REPLY')) {
    const gw = /route-gateway ([\d.]+)/.exec(line);
    const ifc = /ifconfig ([\d.]+) ([\d.]+)/.exec(line);
    // net30/p2p topology: the second ifconfig argument is the peer, which is the gateway
    if (gw) info.gateway = gw[1];
    else if (ifc && !ifc[2].startsWith('255.')) info.gateway = ifc[2];
    if (/[,']redirect-(gateway|private)\b/.test(line)) info.pushedDefaultRoute = true;
    const body = /PUSH_REPLY,(.*?)'?$/.exec(line)?.[1] ?? '';
    const dns = dnsFromOptions(body.split(','));
    if (dns.servers.length || dns.domains.length) info.dns = dns;
  }

  // "SIGTERM received" etc. are normal shutdown, not errors.
  if (/SIGTERM\[|SIGINT\[|process exiting$/.test(line) && !/fatal/i.test(line)) return info;

  const rule = RULES.find((r) => r.re.test(line));
  if (rule) {
    const base = vpnError(rule.code, line);
    info.error = { ...base, ...(rule.title ? { title: rule.title } : {}), ...(rule.message ? { message: rule.message } : {}) };
  }
  return info;
}

/** Management log flags: F fatal, N non-fatal error, W warning, I info, D debug. */
export function levelFromFlags(flags: string): LogLevel {
  if (/[FN]/.test(flags)) return 'error';
  if (flags.includes('W')) return 'warn';
  if (flags.includes('D')) return 'debug';
  return 'info';
}

/** Best-effort level for plain stdout lines (before the management interface is attached). */
export const levelFromText = (line: string): LogLevel =>
  /\b(error|failed|fatal|cannot|exiting due to)\b/i.test(line) ? 'error' : /\bwarn(ing)?\b/i.test(line) ? 'warn' : 'info';
