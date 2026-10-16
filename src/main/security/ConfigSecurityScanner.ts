import type { ProfileScan, SecurityFinding } from '../../shared/types';
import { analyzeConfig, type ParsedConfig } from '../vpn/OpenVpnConfigParser';

/** Directives that would break the app's control over the process; the importer disables them. */
export const UNSUPPORTED_DIRECTIVES = ['daemon', 'management', 'management-hold', 'management-query-passwords', 'management-client-auth', 'log', 'log-append', 'syslog', 'cd', 'chroot'];

/**
 * Reviews a parsed config: what protects the tunnel (CA, client cert, TLS auth/crypt,
 * server verification) and what is risky (local command execution, plugins, weak crypto).
 */
export function scanConfig(cfg: ParsedConfig, extraErrors: string[] = []): ProfileScan {
  const a = analyzeConfig(cfg);
  const findings: SecurityFinding[] = [];
  const ok = (title: string): void => void findings.push({ severity: 'ok', title });

  // --- protections
  if (a.has('ca') || a.has('pkcs12')) ok('CA certificate');
  else findings.push({ severity: 'warning', title: 'No CA certificate', detail: 'The server identity cannot be verified.' });

  if ((a.has('cert') && a.has('key')) || a.has('pkcs12')) ok('Client certificate');
  else if (!a.authUserPass) findings.push({ severity: 'warning', title: 'No client certificate or username/password' });

  if (a.has('tls-crypt') || a.has('tls-crypt-v2')) ok('TLS enabled (tls-crypt)');
  else if (a.has('tls-auth')) ok('TLS enabled (tls-auth)');
  else if (a.has('secret')) findings.push({ severity: 'warning', title: 'Static key mode', detail: 'No TLS; static keys are deprecated and offer no forward secrecy.' });
  else if (a.has('tls-client') || a.has('client')) ok('TLS enabled');

  if (a.has('remote-cert-tls') || a.has('verify-x509-name')) ok('Server certificate verification');
  else if (a.has('client') || a.has('tls-client')) {
    findings.push({ severity: 'warning', title: 'Server certificate type not verified', detail: 'Add "remote-cert-tls server" to prevent man-in-the-middle attacks by other clients of the same CA.' });
  }

  // --- risks
  const ss = a.first('script-security');
  const ssLevel = ss ? Number(ss.args[0] ?? 1) : 1;
  for (const d of a.execDirectives) {
    if (d.name === 'script-security' && ssLevel < 2) continue;
    findings.push({
      severity: 'danger',
      title: d.name === 'plugin' ? 'Loads a plugin' : d.name === 'script-security' ? `script-security ${ssLevel}` : `Runs a command on "${d.name}"`,
      detail: d.raw.trim(),
      line: d.line,
    });
  }

  for (const name of ['cipher', 'data-ciphers', 'auth']) {
    const d = a.first(name);
    if (d && /\bnone\b/i.test(d.args.join(' '))) findings.push({ severity: 'danger', title: `${name} none`, detail: 'Traffic is not protected.', line: d.line });
  }
  const comp = a.first('comp-lzo') ?? a.first('compress');
  if (comp && comp.args[0] !== 'no') {
    findings.push({ severity: 'warning', title: 'Compression enabled', detail: 'Compression with encryption is vulnerable to VORACLE-style attacks.', line: comp.line });
  }

  for (const name of UNSUPPORTED_DIRECTIVES) {
    const d = a.first(name);
    if (d) findings.push({ severity: 'info', title: `"${name}" will be disabled`, detail: 'The app manages this itself.', line: d.line });
  }
  if (a.redirectGateway) findings.push({ severity: 'info', title: 'Routes all traffic through the VPN', detail: `redirect-gateway ${a.redirectGateway.join(' ')}`.trim() });
  const dns = a.dhcpOptions.filter((o) => o.type?.toUpperCase() === 'DNS');
  if (dns.length) findings.push({ severity: 'info', title: 'Sets DNS servers', detail: dns.map((o) => o.value).join(', ') });

  const errors = [...cfg.errors.map((e) => `Line ${e.line}: ${e.message}`), ...extraErrors];
  if (a.remotes.length === 0 && !a.has('connection')) errors.push('No "remote" server in the configuration');

  return {
    findings,
    dangerous: findings.some((f) => f.severity === 'danger'),
    errors,
    remotes: a.remotes.map((r) => [r.host, r.port, r.proto].filter(Boolean).join(' ')),
    needsCredentials: a.authUserPass,
    wantsDefaultRoute: !!a.redirectGateway,
  };
}
