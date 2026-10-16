// .ovpn / .conf parser that follows OpenVPN's own tokenizer (options.c: parse_line):
//  - '#' or ';' starts a comment only where a new token would start
//  - "double" and 'single' quotes group tokens
//  - backslash escapes the next character, except inside single quotes
//    (so an unquoted C:\certs\ca.crt really means "C:certsca.crt", exactly like openvpn)
//  - <tag> ... </tag> inline blocks; <connection> blocks contain directives
// Unmodified lines serialize back byte-for-byte.

export interface Directive {
  kind: 'directive';
  name: string;
  args: string[];
  line: number;
  raw: string;
}

export interface InlineBlock {
  kind: 'inline';
  name: string;
  content: string;
  line: number;
  raw: string;
  /** Parsed directives for <connection> blocks. */
  children?: ConfigNode[];
}

export interface OtherLine {
  kind: 'other';
  line: number;
  raw: string;
}

export type ConfigNode = Directive | InlineBlock | OtherLine;

export interface ParseIssue {
  line: number;
  message: string;
}

export interface ParsedConfig {
  nodes: ConfigNode[];
  errors: ParseIssue[];
  eol: '\n' | '\r\n';
}

export function tokenizeLine(text: string): { tokens: string[]; error?: string } {
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const c of text) {
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (escaped) {
      cur += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      inToken = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else cur += c;
      continue;
    }
    if (!inToken && (c === '#' || c === ';')) break;
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
      continue;
    }
    cur += c;
    inToken = true;
  }
  if (inToken) tokens.push(cur);
  if (quote) return { tokens, error: `Unterminated ${quote === '"' ? 'double' : 'single'} quote` };
  return { tokens };
}

const OPEN_TAG = /^\s*<([A-Za-z0-9][A-Za-z0-9-]*)>\s*$/;

function parseLines(lines: string[], offset: number, errors: ParseIssue[]): ConfigNode[] {
  const nodes: ConfigNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = offset + i + 1;
    const open = OPEN_TAG.exec(raw);
    if (open) {
      const name = open[1].toLowerCase();
      const close = new RegExp(`^\\s*</${open[1]}>\\s*$`, 'i');
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      if (j >= lines.length) {
        errors.push({ line: lineNo, message: `Missing </${name}>` });
        nodes.push({ kind: 'other', line: lineNo, raw });
        continue;
      }
      const body = lines.slice(i + 1, j);
      const block: InlineBlock = { kind: 'inline', name, content: body.join('\n'), line: lineNo, raw: lines.slice(i, j + 1).join('\n') };
      if (name === 'connection') block.children = parseLines(body, offset + i + 1, errors);
      nodes.push(block);
      i = j;
      continue;
    }

    const { tokens, error } = tokenizeLine(raw);
    if (error) errors.push({ line: lineNo, message: error });
    if (tokens.length === 0) {
      nodes.push({ kind: 'other', line: lineNo, raw });
      continue;
    }
    // Options may be written with a leading "--" inside config files too.
    const name = tokens[0].replace(/^--/, '').toLowerCase();
    nodes.push({ kind: 'directive', name, args: tokens.slice(1), line: lineNo, raw });
  }
  return nodes;
}

export function parseConfig(text: string): ParsedConfig {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const errors: ParseIssue[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return { nodes: parseLines(lines, 0, errors), errors, eol };
}

/** Quotes a token only when OpenVPN would otherwise split or reinterpret it. */
export function quoteToken(s: string): string {
  if (s !== '' && /^[^\s"'\\#;]/.test(s) && !/[\s"'\\]/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatDirective(name: string, args: string[]): string {
  return [name, ...args.map(quoteToken)].join(' ');
}

/** Replaces a directive's arguments (and its raw text). */
export function setArgs(node: Directive, args: string[]): void {
  node.args = args;
  node.raw = formatDirective(node.name, args);
}

export function serializeConfig(cfg: ParsedConfig): string {
  const render = (n: ConfigNode): string => n.raw.replace(/\n/g, cfg.eol);
  return cfg.nodes.map(render).join(cfg.eol) + cfg.eol;
}

/** All directives, including those inside <connection> blocks. */
export function allDirectives(nodes: ConfigNode[]): Directive[] {
  return nodes.flatMap((n) => (n.kind === 'directive' ? [n] : n.kind === 'inline' && n.children ? allDirectives(n.children) : []));
}

// ---------------------------------------------------------------------------
// Analysis

/** Directives whose argument at `index` names a file. */
export const FILE_ARGS: Record<string, number> = {
  ca: 0,
  cert: 0,
  key: 0,
  pkcs12: 0,
  dh: 0,
  'extra-certs': 0,
  'crl-verify': 0,
  'tls-auth': 0,
  'tls-crypt': 0,
  'tls-crypt-v2': 0,
  secret: 0,
  'auth-user-pass': 0,
  askpass: 0,
  'http-proxy-user-pass': 0,
};

/** Directives that can make openvpn execute programs or load code. */
export const EXEC_DIRECTIVES = [
  'script-security',
  'up',
  'down',
  'route-up',
  'route-pre-down',
  'ipchange',
  'tls-verify',
  'auth-user-pass-verify',
  'client-connect',
  'client-disconnect',
  'learn-address',
  'plugin',
] as const;

export interface FileRef {
  directive: Directive;
  argIndex: number;
  path: string;
}

export interface RouteDirective {
  network: string;
  netmask?: string;
  gateway?: string;
  metric?: string;
}

export interface ConfigAnalysis {
  remotes: { host: string; port?: string; proto?: string }[];
  proto?: string;
  dev?: string;
  isClient: boolean;
  authUserPass: boolean;
  inlineBlocks: string[];
  fileRefs: FileRef[];
  redirectGateway: string[] | null;
  routes: RouteDirective[];
  routesIpv6: string[];
  dhcpOptions: { type: string; value?: string }[];
  execDirectives: Directive[];
  has(name: string): boolean;
  first(name: string): Directive | undefined;
}

export function analyzeConfig(cfg: ParsedConfig): ConfigAnalysis {
  const dirs = allDirectives(cfg.nodes);
  const first = (name: string): Directive | undefined => dirs.find((d) => d.name === name);
  const all = (name: string): Directive[] => dirs.filter((d) => d.name === name);
  const inlineBlocks = cfg.nodes.filter((n): n is InlineBlock => n.kind === 'inline' && n.name !== 'connection').map((n) => n.name);

  const fileRefs: FileRef[] = [];
  for (const d of dirs) {
    const idx = FILE_ARGS[d.name];
    const path = idx === undefined ? undefined : d.args[idx];
    // `crl-verify dir`, `[inline]` and the stdin form of askpass/auth-user-pass are not files to copy.
    if (path && path !== '[inline]' && path !== 'stdin' && !(d.name === 'crl-verify' && d.args[1] === 'dir')) {
      fileRefs.push({ directive: d, argIndex: idx!, path });
    }
  }

  const rg = first('redirect-gateway') ?? first('redirect-private');
  return {
    remotes: all('remote').map((d) => ({ host: d.args[0], port: d.args[1], proto: d.args[2] })),
    proto: first('proto')?.args[0],
    dev: first('dev')?.args[0],
    isClient: !!(first('client') || first('pull') || first('tls-client')),
    authUserPass: !!first('auth-user-pass'),
    inlineBlocks,
    fileRefs,
    redirectGateway: rg ? (rg.name === 'redirect-private' ? ['private', ...rg.args] : rg.args) : null,
    routes: all('route').map((d) => ({ network: d.args[0], netmask: d.args[1], gateway: d.args[2], metric: d.args[3] })),
    routesIpv6: all('route-ipv6').map((d) => d.args[0]),
    dhcpOptions: all('dhcp-option').map((d) => ({ type: d.args[0], value: d.args[1] })),
    execDirectives: dirs.filter((d) => (EXEC_DIRECTIVES as readonly string[]).includes(d.name)),
    has: (name) => !!first(name) || inlineBlocks.includes(name),
    first,
  };
}
