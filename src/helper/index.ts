// Privileged helper entry. Runs as root (launchd daemon on macOS) or SYSTEM (Windows service),
// started by the app's own Electron binary with ELECTRON_RUN_AS_NODE=1.
//
//   helper.js                 serve requests (config from MULTI_OPENVPN_HELPER_CONFIG or the default path)
//   helper.js --setup <json>  install-time, as root: write config + token for the installing user
//   helper.js --setup-args --root <dir>... --binary <path>...   same, flag form (Windows installer)
import { randomBytes } from 'node:crypto';
import { chownSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HelperServer } from '../main/helper/HelperServer';
import { sha256File } from '../main/helper/policy';
import { defaultHelperBase, defaultSocketPath, type HelperConfig } from '../main/helper/protocol';
import { createPlatformNetworkService } from '../main/platform';
import { OpenVpnBinaryManager } from '../main/vpn/OpenVpnBinaryManager';

interface SetupArgs {
  ownerUid?: number;
  allowedRoots: string[];
  binaries: string[];
  base?: string;
  socketPath?: string;
}

async function setup(raw: string): Promise<void> {
  const a = JSON.parse(raw) as SetupArgs;
  const base = a.base ?? defaultHelperBase();
  const binaries = new OpenVpnBinaryManager({ bundledRoot: '/nonexistent' });
  const allowedBinaries = [];
  for (const path of a.binaries) {
    await binaries.validate(path); // must really be OpenVPN
    allowedBinaries.push({ path, sha256: await sha256File(path) });
  }
  if (!a.allowedRoots.length || a.allowedRoots.some((r) => resolve(r) === '/' || resolve(r).split(/[\\/]/).length < 3)) {
    throw new Error('Allowed roots must be specific directories');
  }
  const socketPath = a.socketPath ?? defaultSocketPath();
  // sockaddr_un is 104 bytes on macOS (108 on Linux): longer paths fail with EINVAL at listen().
  if (process.platform !== 'win32' && Buffer.byteLength(socketPath) > 103) throw new Error(`Socket path too long: ${socketPath}`);
  const cfg: HelperConfig = {
    token: randomBytes(32).toString('hex'),
    socketPath,
    ownerUid: a.ownerUid,
    allowedRoots: a.allowedRoots.map((r) => resolve(r)),
    allowedBinaries,
    runDir: join(base, 'run'),
    stateDir: join(base, 'state'),
  };
  mkdirSync(base, { recursive: true, mode: 0o755 });
  writeFileSync(join(base, 'helper.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // The token is the only thing the user can read: it proves the client is that user's app.
  const tokenFile = join(base, 'token');
  writeFileSync(tokenFile, JSON.stringify({ token: cfg.token, socketPath: cfg.socketPath }), { mode: 0o600 });
  if (a.ownerUid !== undefined && process.platform !== 'win32') chownSync(tokenFile, a.ownerUid, 0);
}

async function serve(): Promise<void> {
  const configPath = process.env.MULTI_OPENVPN_HELPER_CONFIG ?? join(defaultHelperBase(), 'helper.json');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as HelperConfig;
  const platform = createPlatformNetworkService(cfg.stateDir);
  // Undo DNS left behind if the helper itself was killed with active connections.
  await platform.restoreAllDns([]).catch((err) => console.error('DNS recovery failed:', err.message));
  const server = new HelperServer(cfg, platform);
  await server.listen();
  console.log(`multi-openvpn helper listening on ${cfg.socketPath}`);
  const stop = (): void => void server.close().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** `--root a --root b --binary x` → setup JSON (lets the NSIS installer avoid JSON escaping). */
function argsToSetup(argv: string[]): string {
  const roots: string[] = [];
  const binaries: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--root') roots.push(argv[++k]);
    else if (argv[k] === '--binary') binaries.push(argv[++k]);
  }
  return JSON.stringify({ allowedRoots: roots, binaries });
}

const i = process.argv.indexOf('--setup');
const j = process.argv.indexOf('--setup-args');
(i >= 0 ? setup(process.argv[i + 1] ?? '{}') : j >= 0 ? setup(argsToSetup(process.argv.slice(j + 1))) : serve()).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
