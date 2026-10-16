// Development: run the privileged helper from this repo with sudo, so `npm run dev` can create
// real tun interfaces, routes and DNS without installing anything system-wide.
//
//   npm run build && npm run helper:dev        (asks for your sudo password)
//
// The app finds it through .dev-helper/token (only read when the app is not packaged).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const base = join(repo, '.dev-helper');
const electron = join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const helper = join(repo, 'out/main/helper.js');
const userData =
  process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/Multi OpenVPN') : join(homedir(), '.config/Multi OpenVPN');
const which = spawnSync('/bin/sh', ['-c', 'command -v openvpn'], { encoding: 'utf8' }).stdout.trim();
const binary = process.env.OPENVPN_BINARY ?? which;
if (!binary) throw new Error('openvpn not found; set OPENVPN_BINARY');

mkdirSync(base, { recursive: true });
const setup = JSON.stringify({
  ownerUid: process.getuid(),
  allowedRoots: [join(userData, 'profiles'), join(tmpdir(), 'multi-openvpn')],
  binaries: [binary],
  base,
  socketPath: `/tmp/mov-dev-${process.getuid()}.sock`, // short: unix socket paths are limited to ~104 bytes
});
const env = ['ELECTRON_RUN_AS_NODE=1', `MULTI_OPENVPN_HELPER_CONFIG=${join(base, 'helper.json')}`];
const run = (args) => {
  const r = spawnSync('sudo', ['env', ...env, electron, helper, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(['--setup', setup]);
console.log(`Helper config written to ${base}. Starting helper (Ctrl-C to stop)…`);
run([]);
