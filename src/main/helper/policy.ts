import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { analyzeConfig, parseConfig, serializeConfig, type ConfigNode } from '../vpn/OpenVpnConfigParser';

// Everything the privileged helper accepts from the (unprivileged) app is checked here.
// The app is not trusted: a compromised user account must not be able to turn the helper
// into "run anything as root".

/** `child` is `root` or inside it (no "..", no other drive). */
export function isWithin(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/** Same, after resolving symlinks, so a link inside an allowed root cannot point outside it. */
export function isReallyWithin(root: string, child: string): boolean {
  try {
    return isWithin(realpathSync(root), realpathSync(child));
  } catch {
    return false;
  }
}

export interface ValidatedArgs {
  cd: string;
  config: string;
  managementPort: number;
  managementPasswordFile: string;
  /** Re-serialized policy arguments (pull filters, routes). */
  extra: string[];
}

const PULL_FILTER_TEXT = /^[a-z0-9 -]{1,40}$/i;

/**
 * Accepts exactly the command line built by buildOpenVpnArgs + routingArgs; anything else is
 * rejected. Paths must be inside the allowed roots.
 */
export function validateOpenVpnArgs(args: string[], roots: string[]): ValidatedArgs {
  const out: Partial<ValidatedArgs> = { extra: [] };
  const inRoots = (p: string | undefined, what: string): string => {
    if (!p || !isAbsolute(p) || !roots.some((r) => isReallyWithin(r, p))) throw new Error(`${what} is outside the allowed directories`);
    return p;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (n: number): string[] => {
      const v = args.slice(i + 1, i + 1 + n);
      if (v.length !== n) throw new Error(`${a} is missing arguments`);
      i += n;
      return v;
    };
    switch (a) {
      case '--cd':
        out.cd = inRoots(next(1)[0], '--cd');
        break;
      case '--config':
        out.config = inRoots(next(1)[0], '--config');
        break;
      case '--management': {
        const [host, port, pw] = next(3);
        if (host !== '127.0.0.1') throw new Error('Management must listen on 127.0.0.1');
        const n = Number(port);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('Invalid management port');
        out.managementPort = n;
        out.managementPasswordFile = inRoots(pw, 'management password file');
        break;
      }
      case '--management-hold':
      case '--management-query-passwords':
      case '--suppress-timestamps':
        break;
      case '--verb': {
        const [v] = next(1);
        if (!/^[0-9]$/.test(v)) throw new Error('Invalid --verb');
        break;
      }
      case '--pull-filter': {
        const [action, text] = next(2);
        if ((action !== 'accept' && action !== 'ignore') || !PULL_FILTER_TEXT.test(text)) throw new Error('Invalid --pull-filter');
        out.extra!.push(a, action, text);
        break;
      }
      case '--route': {
        const [net, mask] = next(2);
        if (isIP(net) !== 4 || isIP(mask) !== 4) throw new Error('Invalid --route');
        out.extra!.push(a, net, mask);
        break;
      }
      case '--route-ipv6': {
        const [cidr] = next(1);
        const [ip, bits] = cidr.split('/');
        if (isIP(ip) !== 6 || !/^\d{1,3}$/.test(bits ?? '') || Number(bits) > 128) throw new Error('Invalid --route-ipv6');
        out.extra!.push(a, cidr);
        break;
      }
      default:
        throw new Error(`Option not allowed: ${a.slice(0, 40)}`);
    }
  }
  if (!out.cd || !out.config || !out.managementPort || !out.managementPasswordFile) throw new Error('Incomplete openvpn command line');
  return out as ValidatedArgs;
}

/** Make openvpn load code or another config file: refused outright. */
const FORBIDDEN = new Set(['plugin', 'config', 'iproute', 'tls-export-cert', 'dev-node']);
/** Write files, change directories/identity, or run scripts: removed (scripts also blocked by --script-security 1). */
const STRIPPED = new Set([
  'status', 'log', 'log-append', 'syslog', 'writepid', 'replay-persist', 'ifconfig-pool-persist', 'tmp-dir', 'chroot', 'cd',
  'daemon', 'management', 'management-hold', 'management-query-passwords', 'management-client-auth', 'script-security',
  'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'tls-verify', 'auth-user-pass-verify', 'client-connect',
  'client-disconnect', 'learn-address', 'setenv-safe', 'up-restart', 'down-pre',
]);

/**
 * Turns the app's runtime config into the copy root's openvpn will read (written by the helper to
 * a root-owned directory, so the app cannot change it after this check). Referenced files must
 * be plain names that really live in the profile directory.
 */
export function sanitizeConfigForRoot(text: string, profileDir: string): string {
  const cfg = parseConfig(text);
  if (cfg.errors.length) throw new Error(`Config does not parse: ${cfg.errors[0].message}`);
  const walk = (nodes: ConfigNode[]): void => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kind === 'inline' && n.children) walk(n.children);
      if (n.kind !== 'directive') continue;
      if (FORBIDDEN.has(n.name)) throw new Error(`Directive not allowed for the privileged helper: ${n.name}`);
      if (STRIPPED.has(n.name)) nodes[i] = { kind: 'other', line: n.line, raw: `# [helper] removed: ${n.name}` };
    }
  };
  walk(cfg.nodes);
  for (const ref of analyzeConfig(cfg).fileRefs) {
    if (ref.path !== basename(ref.path) || ref.path.startsWith('.')) throw new Error(`File reference must be a name inside the profile folder: ${ref.path}`);
    if (!isReallyWithin(profileDir, join(profileDir, ref.path))) throw new Error(`File reference escapes the profile folder: ${ref.path}`);
  }
  return serializeConfig(cfg);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}
