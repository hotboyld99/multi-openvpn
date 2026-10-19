import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyLine, levelFromFlags } from '../src/main/vpn/LogClassifier';
import { ManagementParser, parseRealtime, passwordCommand, quoteArg, staticChallengePassword, usernameCommand } from '../src/main/vpn/managementProtocol';
import { OpenVpnDriver } from '../src/main/vpn/OpenVpnDriver';
import { OpenVpnManagementClient } from '../src/main/vpn/OpenVpnManagementClient';
import { VpnManager } from '../src/main/vpn/VpnManager';
import { VpnProcessManager } from '../src/main/vpn/VpnProcessManager';
import { VpnErrorCode, type VpnProfile } from '../src/shared/types';
import { alive, createLab, labProfile, waitFor, type Lab } from './helpers/openvpnLab';

describe('management protocol parser', () => {
  it('parses >STATE with all fields', () => {
    expect(parseRealtime('>STATE:1700000000,CONNECTED,SUCCESS,10.8.0.6,203.0.113.5,1194,,,fd00::1000')).toEqual({
      kind: 'state',
      time: 1700000000,
      state: 'CONNECTED',
      description: 'SUCCESS',
      localIp: '10.8.0.6',
      remoteIp: '203.0.113.5',
      remotePort: '1194',
      localIpv6: 'fd00::1000',
    });
    expect(parseRealtime('>STATE:1700000000,WAIT,,,,,,')).toMatchObject({ state: 'WAIT', localIp: undefined });
  });

  it('keeps commas inside >LOG messages', () => {
    expect(parseRealtime('>LOG:1700000000,W,OpenSSL: error:1C800064:Provider routines::bad decrypt, again')).toEqual({
      kind: 'log',
      time: 1700000000,
      flags: 'W',
      message: 'OpenSSL: error:1C800064:Provider routines::bad decrypt, again',
    });
  });

  it('parses bytecount, hold, fatal and the password variants', () => {
    expect(parseRealtime('>BYTECOUNT:12345,678')).toEqual({ kind: 'bytecount', bytesIn: 12345, bytesOut: 678 });
    expect(parseRealtime('>HOLD:Waiting for hold release:0')).toEqual({ kind: 'hold', message: 'Waiting for hold release:0' });
    expect(parseRealtime(">PASSWORD:Need 'Auth' username/password")).toEqual({ kind: 'password', action: 'need', realm: 'Auth', needsUsername: true, challenge: undefined });
    expect(parseRealtime(">PASSWORD:Need 'Private Key' password")).toMatchObject({ action: 'need', realm: 'Private Key', needsUsername: false });
    expect(parseRealtime(">PASSWORD:Need 'Auth' username/password SC:1,Enter PIN")).toMatchObject({ realm: 'Auth', challenge: { text: 'Enter PIN', echo: true, concat: false } });
    expect(parseRealtime(">PASSWORD:Verification Failed: 'Auth'")).toEqual({ kind: 'password', action: 'failed', realm: 'Auth' });
    expect(parseRealtime('>FATAL:Error: private key password verification failed')).toEqual({ kind: 'fatal', message: 'Error: private key password verification failed' });
    expect(parseRealtime('>NEED-OK:whatever')).toEqual({ kind: 'other', type: 'NEED-OK', payload: 'whatever' });
  });

  it('splits a CRLF stream into events and detects the newline-less password prompt across chunks', () => {
    const p = new ManagementParser();
    expect(p.feed('ENTER PASS')).toEqual([]);
    expect(p.feed('WORD:')).toEqual([{ type: 'passwordPrompt' }]);
    const ev = p.feed('SUCCESS: password is correct\r\n>INFO:OpenVPN Management Interface Version 5\r\n>HOLD:Waiting for hold release:0\r\nSUCCESS: hold');
    expect(ev.map((e) => e.type)).toEqual(['line', 'realtime', 'realtime']);
    expect(p.feed(' release succeeded\r\n')).toEqual([{ type: 'line', line: 'SUCCESS: hold release succeeded' }]);
  });

  it('quotes credentials and refuses command injection through newlines', () => {
    expect(quoteArg('se"cr\\et')).toBe('"se\\"cr\\\\et"');
    expect(usernameCommand('Auth', 'alice')).toBe('username "Auth" "alice"');
    expect(passwordCommand('Private Key', 'p w')).toBe('password "Private Key" "p w"');
    expect(() => passwordCommand('Auth', 'x"\nsignal SIGTERM')).toThrow(/control character/);
    expect(staticChallengePassword('pass', '123456', false)).toBe('SCRV1:cGFzcw==:MTIzNDU2');
    expect(staticChallengePassword('pass', '123456', true)).toBe('pass123456');
  });
});

describe('LogClassifier', () => {
  const code = (line: string) => classifyLine(line).error?.code;

  it('maps real OpenVPN lines to error codes', () => {
    expect(code('AUTH: Received control message: AUTH_FAILED')).toBe(VpnErrorCode.AUTH_FAILED);
    expect(code('Error: private key password verification failed')).toBe(VpnErrorCode.AUTH_FAILED);
    expect(classifyLine('Error: private key password verification failed').error?.title).toBe('Wrong Private Key Password');
    expect(code('VERIFY ERROR: depth=0, error=certificate has expired: CN=server')).toBe(VpnErrorCode.CERT_EXPIRED);
    expect(code('TLS Error: TLS handshake failed')).toBe(VpnErrorCode.TLS_ERROR);
    expect(code('VERIFY ERROR: depth=1, error=self-signed certificate in certificate chain: CN=lab-ca')).toBe(VpnErrorCode.TLS_ERROR);
    expect(code('TLS Error: TLS key negotiation failed to occur within 60 seconds (check your network connectivity)')).toBe(VpnErrorCode.CONNECTION_TIMEOUT);
    expect(code('TCP: connect to [AF_INET]1.2.3.4:443 failed: Connection refused')).toBe(VpnErrorCode.NETWORK_UNREACHABLE);
    expect(code('RESOLVE: Cannot resolve host address: vpn.example.invalid:1194 (nodename nor servname provided)')).toBe(VpnErrorCode.NETWORK_UNREACHABLE);
    expect(code('Options error: Unrecognized option or missing or extra parameter(s) in x.ovpn:3: foo (2.6.7)')).toBe(VpnErrorCode.INVALID_CONFIG);
    expect(code('Cannot allocate TUN/TAP dev dynamically')).toBe(VpnErrorCode.PERMISSION_DENIED);
    expect(code('ERROR: route addition failed using CreateIpForwardEntry: The object already exists.')).toBe(VpnErrorCode.ROUTE_CONFLICT);
  });

  it('treats normal shutdown and normal progress as non-errors', () => {
    expect(code('SIGTERM[hard,] received, process exiting')).toBeUndefined();
    expect(code('Initialization Sequence Completed')).toBeUndefined();
    expect(code('TLS: Initial packet from [AF_INET]127.0.0.1:1194')).toBeUndefined();
  });

  it('extracts the interface name on macOS, Linux and Windows without assuming a fixed name', () => {
    expect(classifyLine('Opened utun device utun7').interfaceName).toBe('utun7');
    expect(classifyLine('TUN/TAP device tun3 opened').interfaceName).toBe('tun3');
    expect(classifyLine('Wintun device [OpenVPN Wintun] opened').interfaceName).toBe('OpenVPN Wintun');
    expect(classifyLine('TAP-WIN32 device [Ethernet 3] opened: \\\\.\\Global\\{ABC}.tap').interfaceName).toBe('Ethernet 3');
  });

  it('extracts the gateway from PUSH_REPLY', () => {
    expect(classifyLine("PUSH: Received control message: 'PUSH_REPLY,route-gateway 10.8.0.1,topology subnet,ifconfig 10.8.0.6 255.255.255.0'").gateway).toBe('10.8.0.1');
    expect(classifyLine("PUSH: Received control message: 'PUSH_REPLY,route 10.8.0.1,topology net30,ifconfig 10.8.0.6 10.8.0.5'").gateway).toBe('10.8.0.5');
  });

  it('maps management log flags to levels', () => {
    expect(levelFromFlags('F')).toBe('error');
    expect(levelFromFlags('N')).toBe('error');
    expect(levelFromFlags('W')).toBe('warn');
    expect(levelFromFlags('I')).toBe('info');
    expect(levelFromFlags('D')).toBe('debug');
  });
});

/** Minimal fake of openvpn's management side, for flows a rootless openvpn cannot produce (auth-user-pass). */
async function fakeManagement(password: string, onCommand: (cmd: string, sock: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((sock) => {
    sock.setEncoding('utf8');
    sock.write('ENTER PASSWORD:');
    let authed = false;
    let buf = '';
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!authed) {
          if (line === password) {
            authed = true;
            sock.write('SUCCESS: password is correct\r\n>INFO:OpenVPN Management Interface Version 5\r\n');
          } else sock.write('ERROR: bad password\r\n');
          continue;
        }
        onCommand(line, sock);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

describe('OpenVpnManagementClient (fake server)', () => {
  it('authenticates, matches responses in order, handles multi-line END and real-time messages', async () => {
    const { server, port } = await fakeManagement('pw', (cmd, s) => {
      if (cmd === 'state') s.write('>BYTECOUNT:1,2\r\n1700000000,CONNECTED,SUCCESS,10.8.0.2,1.2.3.4\r\nEND\r\n');
      else if (cmd === 'bogus') s.write('ERROR: unknown command, enter \'help\' for more options\r\n');
      else s.write(`SUCCESS: ${cmd} ok\r\n`);
    });
    const c = new OpenVpnManagementClient({ port, password: 'pw' });
    const messages: unknown[] = [];
    c.on('message', (m) => messages.push(m));
    await c.connect();
    const [a, b, st] = await Promise.all([c.command('state on'), c.command('bytecount 1'), c.command('state', true)]);
    expect(a).toEqual(['state on ok']);
    expect(b).toEqual(['bytecount 1 ok']);
    expect(st).toEqual(['1700000000,CONNECTED,SUCCESS,10.8.0.2,1.2.3.4']);
    await expect(c.command('bogus')).rejects.toThrow(/unknown command/);
    expect(messages).toContainEqual({ kind: 'bytecount', bytesIn: 1, bytesOut: 2 });
    c.close();
    server.close();
  });

  it('rejects a wrong management password', async () => {
    const { server, port } = await fakeManagement('right', () => {});
    const c = new OpenVpnManagementClient({ port, password: 'wrong' });
    await expect(c.connect()).rejects.toThrow(/authentication failed/);
    server.close();
  });
});

// ---------------------------------------------------------------------------
// Real openvpn through the management interface (rootless lab).

let lab: Lab | null = null;
beforeAll(async () => {
  lab = await createLab();
}, 30_000);
afterAll(() => lab?.cleanup());

// A failed assertion must not leave openvpn processes behind.
const managers: VpnManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disconnectAll()));
});

function realManager(profiles: VpnProfile[]) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const processes = new VpnProcessManager(join(lab!.dir, `run-${Math.random().toString(36).slice(2)}`));
  const manager = new VpnManager({
    getProfile: (id) => byId.get(id),
    createDriver: (ctx) => new OpenVpnDriver(ctx, { processes, binary: () => lab!.binary, stopTimeoutMs: 3_000 }),
  });
  managers.push(manager);
  return { manager, processes };
}

/** Client config with one directive swapped (e.g. the encrypted key or an untrusted CA). */
function configWith(name: string, port: number, from: string, to: string): string {
  const cfg = lab!.clientConfig(name, port);
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(from, to));
  return cfg;
}

async function waitAuth(manager: VpnManager, id: string, ms = 10_000) {
  const t0 = Date.now();
  while (!manager.get(id)!.authRequest) {
    if (Date.now() - t0 > ms) throw new Error(`no auth request; status ${manager.get(id)!.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return manager.get(id)!.authRequest!;
}

describe('OpenVpnDriver over the management interface (real openvpn)', () => {
  it('reports state transitions and byte counters, and stops gracefully via `signal SIGTERM`', async (ctx) => {
    if (!lab) return ctx.skip();
    const port = await lab.startServer();
    const p = labProfile('mgmt', lab.clientConfig('mgmt', port));
    const { manager } = realManager([p]);
    const seen = new Set<string>();
    manager.on('connection', (c) => seen.add(c.status));

    const id = manager.connect(p.id);
    await waitFor(manager, id, 'CONNECTED');
    expect([...seen]).toEqual(expect.arrayContaining(['CONNECTING', 'AUTH', 'CONNECTED'])); // WAIT is skipped on fast links
    const t0 = Date.now();
    while (manager.get(id)!.bytesIn === 0 && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 100));
    expect(manager.get(id)!.bytesIn).toBeGreaterThan(0); // keepalive pings counted via >BYTECOUNT

    const logs = () => manager.getLogs(id).map((l) => l.message);
    expect(logs()).toContain('Initialization Sequence Completed');
    expect(logs().some((l) => l.includes("MANAGEMENT: CMD 'hold release'"))).toBe(true);

    const pid = manager.get(id)!.pid;
    await manager.disconnect(id);
    expect(manager.get(id)!.status).toBe('DISCONNECTED');
    expect(alive(pid)).toBe(false);
    expect(logs().some((l) => /OpenVPN process exited|SIGKILL/.test(l))).toBe(false); // graceful, not killed
  }, 30_000);

  it('asks for the private key password through the UI flow and never logs it', async (ctx) => {
    if (!lab) return ctx.skip();
    const port = await lab.startServer();
    const p = labProfile('enc', configWith('enc', port, 'key client.key', 'key client-enc.key'));
    const { manager } = realManager([p]);

    const id = manager.connect(p.id);
    const req = await waitAuth(manager, id);
    expect(req).toMatchObject({ realm: 'Private Key', needsUsername: false });
    expect(manager.get(id)!.status).toBe('AUTH');
    manager.submitSecret(id, { password: 'keypass' });
    await waitFor(manager, id, 'CONNECTED');
    expect(manager.get(id)!.authRequest).toBeUndefined();
    expect(manager.getLogs(id).some((l) => l.message.includes('keypass'))).toBe(false);
    await manager.disconnect(id);
  }, 30_000);

  it('a wrong private key password ends in ERROR without a reconnect loop', async (ctx) => {
    if (!lab) return ctx.skip();
    const port = await lab.startServer();
    const p = labProfile('enc-wrong', configWith('enc-wrong', port, 'key client.key', 'key client-enc.key'), { reconnect: true });
    const { manager } = realManager([p]);

    const id = manager.connect(p.id);
    await waitAuth(manager, id);
    manager.submitSecret(id, { password: 'nope' });
    await waitFor(manager, id, 'ERROR');
    expect(manager.get(id)!.error).toMatchObject({ code: VpnErrorCode.AUTH_FAILED, title: 'Wrong Private Key Password' });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(manager.get(id)!.status).toBe('ERROR'); // no automatic retry
  }, 30_000);

  it('cancelling the prompt disconnects cleanly', async (ctx) => {
    if (!lab) return ctx.skip();
    const port = await lab.startServer();
    const p = labProfile('enc-cancel', configWith('enc-cancel', port, 'key client.key', 'key client-enc.key'));
    const { manager } = realManager([p]);
    const id = manager.connect(p.id);
    await waitAuth(manager, id);
    const pid = manager.get(id)!.pid;
    await manager.cancelSecret(id);
    expect(manager.get(id)!.status).toBe('DISCONNECTED');
    expect(manager.get(id)!.authRequest).toBeUndefined();
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('a server certificate from an unknown CA is reported as TLS_ERROR', async (ctx) => {
    if (!lab) return ctx.skip();
    const port = await lab.startServer();
    const p = labProfile('badca', configWith('badca', port, 'ca ca.crt', 'ca other-ca.crt'));
    const { manager } = realManager([p]);
    const id = manager.connect(p.id);
    const t0 = Date.now();
    while (manager.get(id)!.error?.code !== VpnErrorCode.TLS_ERROR) {
      if (Date.now() - t0 > 10_000) throw new Error(manager.getLogs(id).map((l) => l.message).join('\n'));
      await new Promise((r) => setTimeout(r, 50));
    }
    await manager.disconnect(id);
    expect(manager.get(id)!.status).toBe('DISCONNECTED');
  }, 30_000);
});
