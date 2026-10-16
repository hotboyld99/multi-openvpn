import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { ImportPreview, ProfileScan, SecretInput, VpnProfile } from '../../shared/types';
import { scanConfig, UNSUPPORTED_DIRECTIVES } from '../security/ConfigSecurityScanner';
import {
  analyzeConfig,
  parseConfig,
  serializeConfig,
  setArgs,
  type ConfigNode,
  type FileRef,
  type ParsedConfig,
} from '../vpn/OpenVpnConfigParser';

export const MAX_CONFIG_BYTES = 1024 * 1024;
const CONFIG_EXT = new Set(['.ovpn', '.conf']);
/** Files holding plaintext credentials: never copied; the secret is asked for instead. */
const CREDENTIAL_FILE_DIRECTIVES = new Set(['auth-user-pass', 'askpass', 'http-proxy-user-pass']);

export const isDemoProfile = (p: VpnProfile): boolean => p.configPath.startsWith('mock://');

async function readSmallFile(path: string): Promise<Buffer> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.size > MAX_CONFIG_BYTES) throw new Error(`${basename(path)} is larger than 1 MB`);
  return readFile(path);
}

async function loadConfigFile(path: string): Promise<ParsedConfig> {
  if (!isAbsolute(path)) throw new Error('Path must be absolute');
  if (!CONFIG_EXT.has(extname(path).toLowerCase())) throw new Error(`${basename(path)} is not a .ovpn or .conf file`);
  return parseConfig((await readSmallFile(path)).toString('utf8'));
}

const resolveRef = (sourceDir: string, ref: FileRef): string => (isAbsolute(ref.path) ? ref.path : resolve(sourceDir, ref.path));

/** Turns directives the app must control itself into comments, keeping them visible. */
function disableUnsupported(nodes: ConfigNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'directive' && UNSUPPORTED_DIRECTIVES.includes(n.name)) {
      nodes[i] = { kind: 'other', line: n.line, raw: `# [multi-openvpn] disabled: ${n.raw.trim()}` };
    }
  }
}

/** Reads a config and everything it references, without changing anything. */
export async function previewImport(path: string): Promise<ImportPreview> {
  const fileName = basename(path);
  const suggestedName = fileName.replace(/\.(ovpn|conf)$/i, '');
  try {
    const cfg = await loadConfigFile(path);
    const missing: string[] = [];
    for (const ref of analyzeConfig(cfg).fileRefs) {
      if (CREDENTIAL_FILE_DIRECTIVES.has(ref.directive.name)) continue;
      await readSmallFile(resolveRef(dirname(path), ref)).catch((e: Error) =>
        missing.push(`${ref.directive.name} file "${ref.path}" (line ${ref.directive.line}): ${e.message.replace(/^ENOENT.*/, 'not found')}`),
      );
    }
    const scan = scanConfig(cfg, missing);
    if (analyzeConfig(cfg).fileRefs.some((r) => r.directive.name === 'auth-user-pass')) {
      scan.findings.push({
        severity: 'info',
        title: 'Credentials file not imported',
        detail: 'The file is not copied. The username is kept and the password is moved to the OS secure storage (or asked for when connecting).',
      });
    }
    return { path, fileName, suggestedName, scan };
  } catch (err) {
    const scan: ProfileScan = { findings: [], dangerous: false, errors: [(err as Error).message], remotes: [], needsCredentials: false, wantsDefaultRoute: false };
    return { path, fileName, suggestedName, scan };
  }
}

function uniqueName(wanted: string, taken: Set<string>): string {
  const clean = basename(wanted).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'file';
  let name = clean;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = clean.replace(/(\.[^.]*)?$/, `-${i}$1`);
  taken.add(name.toLowerCase());
  return name;
}

export interface ImportRequest {
  path: string;
  name: string;
  /** The user confirmed "Import anyway" for a config that can execute commands. */
  acceptDangerous: boolean;
}

/**
 * Copies a config and all files it references into <profilesDir>/<id>/, rewriting the
 * references to local names so the profile is self-contained and relative paths keep working.
 */
export async function importProfile(
  req: ImportRequest,
  profilesDir: string,
  /** Puts the password of an auth-user-pass file into secure storage; resolves false if it cannot. */
  storeCredentials?: (profileId: string, secret: SecretInput) => Promise<boolean>,
): Promise<VpnProfile> {
  const preview = await previewImport(req.path);
  if (preview.scan.errors.length) throw new Error(`${preview.fileName}: ${preview.scan.errors.join('; ')}`);
  if (preview.scan.dangerous && !req.acceptDangerous) throw new Error(`${preview.fileName} can execute local commands; confirmation required`);

  const cfg = await loadConfigFile(req.path);
  const id = randomUUID();
  const dir = join(profilesDir, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let username: string | undefined;
  let password: string | undefined;

  try {
    const taken = new Set(['config.ovpn']);
    const copied = new Map<string, string>(); // same source referenced twice → one copy
    for (const ref of analyzeConfig(cfg).fileRefs) {
      const args = [...ref.directive.args];
      if (CREDENTIAL_FILE_DIRECTIVES.has(ref.directive.name)) {
        if (ref.directive.name === 'auth-user-pass') {
          const text = await readSmallFile(resolveRef(dirname(req.path), ref)).then((b) => b.toString('utf8')).catch(() => '');
          const [user, pass] = text.split(/\r?\n/);
          username = user?.trim() || undefined;
          password = pass || undefined;
        }
        args.splice(ref.argIndex, 1); // management will ask instead
        setArgs(ref.directive, args);
        continue;
      }
      const src = resolveRef(dirname(req.path), ref);
      let local = copied.get(src);
      if (!local) {
        local = uniqueName(ref.path, taken);
        await copyFile(src, join(dir, local));
        copied.set(src, local);
      }
      args[ref.argIndex] = local;
      setArgs(ref.directive, args);
    }
    disableUnsupported(cfg.nodes);

    const configPath = join(dir, 'config.ovpn');
    await writeFile(configPath, serializeConfig(cfg), { mode: 0o600 });
    // The plaintext password file is never copied; its password goes to secure storage (if available).
    const hasSavedPassword = !!(username && password && (await storeCredentials?.(id, { username, password }).catch(() => false)));
    const now = Date.now();
    return {
      id,
      name: req.name.trim() || preview.suggestedName,
      configPath,
      configFileName: preview.fileName,
      username,
      hasSavedPassword,
      autoConnect: false,
      reconnect: true,
      routingMode: 'config',
      dnsMode: 'vpn',
      wantsDefaultRoute: !!analyzeConfig(cfg).redirectGateway,
      createdAt: now,
      updatedAt: now,
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Validates an edited config for an existing profile. File references must be plain
 * names of files inside the profile directory (openvpn may later run privileged; it must
 * not be pointed at arbitrary files).
 */
export async function prepareEditedConfig(text: string, profileDir: string): Promise<{ text: string; scan: ProfileScan; wantsDefaultRoute: boolean }> {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error('Configuration is larger than 1 MB');
  const cfg = parseConfig(text);
  const problems: string[] = [];
  for (const ref of analyzeConfig(cfg).fileRefs) {
    if (CREDENTIAL_FILE_DIRECTIVES.has(ref.directive.name)) {
      problems.push(`Line ${ref.directive.line}: "${ref.directive.name}" must not reference a file; credentials are asked for when connecting`);
    } else if (ref.path !== basename(ref.path) || ref.path.startsWith('.')) {
      problems.push(`Line ${ref.directive.line}: "${ref.path}" must be a file inside the profile folder`);
    } else {
      await readSmallFile(join(profileDir, ref.path)).catch(() => problems.push(`Line ${ref.directive.line}: file "${ref.path}" not found in the profile folder`));
    }
  }
  disableUnsupported(cfg.nodes);
  return { text: serializeConfig(cfg), scan: scanConfig(cfg, problems), wantsDefaultRoute: !!analyzeConfig(cfg).redirectGateway };
}

const INLINE_AS_BASE64 = new Set(['pkcs12']);

/** A single self-contained .ovpn: every referenced file becomes an inline <block>. */
export async function buildPortableConfig(configPath: string): Promise<string> {
  const cfg = parseConfig((await readSmallFile(configPath)).toString('utf8'));
  const dir = dirname(configPath);
  for (const ref of analyzeConfig(cfg).fileRefs) {
    if (CREDENTIAL_FILE_DIRECTIVES.has(ref.directive.name)) continue;
    const data = await readSmallFile(join(dir, basename(ref.path)));
    const content = INLINE_AS_BASE64.has(ref.directive.name) ? data.toString('base64').replace(/(.{64})/g, '$1\n').trim() : data.toString('utf8').trimEnd();
    const { name } = ref.directive;
    const idx = cfg.nodes.indexOf(ref.directive);
    const replacement: ConfigNode[] = [{ kind: 'inline', name, line: ref.directive.line, content, raw: `<${name}>\n${content}\n</${name}>` }];
    // `tls-auth file 1` keeps its direction as a separate directive once inlined.
    if (name === 'tls-auth' && ref.directive.args[1] !== undefined) {
      replacement.unshift({ kind: 'directive', name: 'key-direction', args: [ref.directive.args[1]], line: ref.directive.line, raw: `key-direction ${ref.directive.args[1]}` });
    }
    if (idx >= 0) cfg.nodes.splice(idx, 1, ...replacement);
  }
  return serializeConfig(cfg);
}
