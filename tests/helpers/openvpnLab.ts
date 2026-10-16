import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVpnBinaryManager } from '../../src/main/vpn/OpenVpnBinaryManager';
import { randomUUID } from 'node:crypto';
import type { VpnManager } from '../../src/main/vpn/VpnManager';
import type { OpenVpnBinaryInfo, VpnProfile, VpnStatus } from '../../src/shared/types';

/**
 * Rootless OpenVPN test lab: a throwaway PKI plus point-to-point TLS servers with
 * `--dev null`, so real openvpn clients can connect without creating a tun device.
 */
export interface Lab {
  dir: string;
  binary: OpenVpnBinaryInfo;
  /** Starts a p2p TLS server on a free UDP port; returns the port. */
  startServer(): Promise<number>;
  /** Writes a client config for the given server port and returns its path. */
  clientConfig(name: string, port: number, extra?: string[]): string;
  cleanup(): void;
}

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function createLab(): Promise<Lab | null> {
  const binary = await new OpenVpnBinaryManager({ bundledRoot: join(__dirname, '../../resources/openvpn') }).resolve(null);
  if (!binary || !hasOpenssl() || process.platform === 'win32') return null;

  const dir = mkdtempSync(join(tmpdir(), 'mov-lab-'));
  const ssl = (...args: string[]): void => void execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  ssl('req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-subj', '/CN=lab-ca');
  for (const [name, eku] of [['server', 'serverAuth'], ['client', 'clientAuth']]) {
    writeFileSync(join(dir, `${name}.ext`), `basicConstraints=CA:FALSE\nextendedKeyUsage=${eku}\nkeyUsage=digitalSignature\n`);
    ssl('req', ...ec, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '3650', '-extfile', `${name}.ext`);
  }
  // A second, unrelated CA: clients trusting it fail the TLS handshake.
  ssl('req', '-x509', ...ec, '-keyout', 'other-ca.key', '-out', 'other-ca.crt', '-days', '3650', '-subj', '/CN=other-ca');
  // Client key protected by a passphrase ("Private Key" password prompt).
  ssl('pkey', '-in', 'client.key', '-out', 'client-enc.key', '-aes256', '-passout', 'pass:keypass');

  const servers: ChildProcess[] = [];
  let nextPort = 21_000 + Math.floor(Math.random() * 20_000);

  return {
    dir,
    binary,
    async startServer() {
      const port = nextPort++;
      const srv = spawn(
        binary.path,
        ['--dev', 'null', '--tls-server', '--dh', 'none', '--ca', 'ca.crt', '--cert', 'server.crt', '--key', 'server.key',
          '--proto', 'udp4', '--lport', String(port), '--verb', '3', '--suppress-timestamps', '--keepalive', '1', '5'],
        { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      servers.push(srv);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('lab server did not start')), 5_000);
        srv.stdout!.on('data', (d: Buffer) => {
          if (/link local \(bound\)/.test(d.toString())) {
            clearTimeout(t);
            resolve();
          }
        });
        srv.once('exit', (code) => reject(new Error(`lab server exited ${code}`)));
      });
      return port;
    },
    clientConfig(name, port, extra = []) {
      const path = join(dir, `${name}.ovpn`);
      writeFileSync(
        path,
        [
          'dev null',
          'tls-client',
          'proto udp',
          `remote 127.0.0.1 ${port}`,
          'nobind',
          'ca ca.crt',
          'cert client.crt',
          'key client.key',
          'remote-cert-tls server',
          'keepalive 1 5',
          ...extra,
        ].join('\n') + '\n',
      );
      return path;
    },
    cleanup() {
      for (const s of servers) s.kill('SIGKILL');
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function labProfile(name: string, configPath: string, extra: Partial<VpnProfile> = {}): VpnProfile {
  return {
    id: randomUUID(),
    name,
    configPath,
    configFileName: `${name}.ovpn`,
    hasSavedPassword: false,
    autoConnect: false,
    reconnect: false,
    routingMode: 'config',
    dnsMode: 'vpn',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

export async function waitFor(manager: VpnManager, id: string, status: VpnStatus | VpnStatus[], ms = 15_000): Promise<void> {
  const want = Array.isArray(status) ? status : [status];
  const t0 = Date.now();
  while (!want.includes(manager.get(id)!.status)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${want} (now ${manager.get(id)!.status})\n${manager.getLogs(id).map((l) => l.message).join('\n')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const alive = (pid?: number): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
