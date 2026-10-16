import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { OpenVpnBinaryInfo } from '../../shared/types';

type Source = OpenVpnBinaryInfo['source'];

export interface BinaryManagerOptions {
  /** resources/openvpn directory (dev: <repo>/resources/openvpn, packaged: <resourcesPath>/openvpn). */
  bundledRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

const PLATFORM_DIR: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macos', win32: 'windows', linux: 'linux' };

/**
 * Finds the OpenVPN Community binary: user choice → bundled → well-known system paths → PATH.
 * Every candidate is validated (absolute, executable, named openvpn, `--version` says OpenVPN)
 * because whatever is chosen here gets executed with elevated rights later.
 */
export class OpenVpnBinaryManager {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: BinaryManagerOptions) {
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.env = opts.env ?? process.env;
  }

  private get exe(): string {
    return this.platform === 'win32' ? 'openvpn.exe' : 'openvpn';
  }

  /** Path rules of the target platform (not necessarily the one running the tests). */
  private get path(): typeof posix {
    return this.platform === 'win32' ? win32 : posix;
  }

  /** Candidate paths in priority order (not yet validated). */
  candidates(): { path: string; source: Source }[] {
    const list: { path: string; source: Source }[] = [];
    const dir = PLATFORM_DIR[this.platform];
    const { join, isAbsolute, delimiter } = this.path;
    if (dir) list.push({ path: join(this.opts.bundledRoot, `${dir}-${this.arch}`, this.exe), source: 'bundled' });

    const system: string[] = [];
    if (this.platform === 'darwin') {
      system.push('/opt/homebrew/sbin/openvpn', '/usr/local/sbin/openvpn', '/opt/local/sbin/openvpn', '/usr/local/opt/openvpn/sbin/openvpn');
    } else if (this.platform === 'win32') {
      for (const root of [this.env.ProgramFiles, this.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
        if (root) system.push(`${root}\\OpenVPN\\bin\\openvpn.exe`);
      }
    } else {
      system.push('/usr/sbin/openvpn', '/usr/local/sbin/openvpn');
    }
    for (const d of (this.env.PATH ?? this.env.Path ?? '').split(delimiter)) {
      if (d && isAbsolute(d)) system.push(join(d, this.exe));
    }
    for (const p of system) if (!list.some((c) => c.path === p)) list.push({ path: p, source: 'system' });
    return list;
  }

  /** Throws with a user-readable reason when the path is not a usable OpenVPN binary. */
  async validate(path: string, source: Source = 'custom'): Promise<OpenVpnBinaryInfo> {
    if (!this.path.isAbsolute(path)) throw new Error('OpenVPN path must be absolute');
    if (!/^openvpn(\.exe)?$/i.test(this.path.basename(path))) throw new Error('The selected file is not named openvpn');
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw new Error(`${path} does not exist`);
    if (this.platform !== 'win32') await access(path, constants.X_OK).catch(() => Promise.reject(new Error(`${path} is not executable`)));
    const version = await this.version(path);
    if (!version) throw new Error(`${path} did not report an OpenVPN version`);
    return { path, version, source };
  }

  /** All valid binaries found on this machine (for Settings). */
  async detectAll(): Promise<OpenVpnBinaryInfo[]> {
    const found = await Promise.all(
      this.candidates().map(async (c) => {
        const info = await this.validate(c.path, c.source).catch(() => null);
        return info && { info, real: await realpath(c.path).catch(() => c.path) };
      }),
    );
    // Symlinks (e.g. Homebrew's /usr/local/sbin → Cellar) are the same binary: list it once.
    const seen = new Set<string>();
    return found.flatMap((f) => (f && !seen.has(f.real) && seen.add(f.real) ? [f.info] : []));
  }

  /** The binary to use: the custom one if set (no silent fallback), otherwise the first valid candidate. */
  async resolve(customPath: string | null): Promise<OpenVpnBinaryInfo | null> {
    if (customPath) return this.validate(customPath).catch(() => null);
    for (const c of this.candidates()) {
      const info = await this.validate(c.path, c.source).catch(() => null);
      if (info) return info;
    }
    return null;
  }

  version(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      // `openvpn --version` exits 1 on some builds; only the output matters.
      execFile(path, ['--version'], { timeout: 5_000, windowsHide: true }, (_err, stdout) => {
        resolve(parseOpenVpnVersion(String(stdout ?? '')));
      });
    });
  }
}

export function parseOpenVpnVersion(output: string): string | null {
  return /^OpenVPN (\d+\.\d+(?:\.\d+)?[\w.-]*)/m.exec(output)?.[1] ?? null;
}
