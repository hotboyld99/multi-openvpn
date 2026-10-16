import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanConfig } from '../src/main/security/ConfigSecurityScanner';
import { buildPortableConfig, importProfile, prepareEditedConfig, previewImport } from '../src/main/store/ProfileImporter';
import { analyzeConfig, parseConfig, quoteToken, serializeConfig, setArgs, tokenizeLine, type Directive } from '../src/main/vpn/OpenVpnConfigParser';
import { OpenVpnDriver } from '../src/main/vpn/OpenVpnDriver';
import { VpnManager } from '../src/main/vpn/VpnManager';
import { VpnProcessManager } from '../src/main/vpn/VpnProcessManager';
import { createLab, waitFor, type Lab } from './helpers/openvpnLab';

describe('tokenizeLine (OpenVPN rules)', () => {
  it.each([
    ['remote vpn.example.com 1194 udp', ['remote', 'vpn.example.com', '1194', 'udp']],
    ['  remote   a   1194  ', ['remote', 'a', '1194']],
    ['remote a 1194 # comment', ['remote', 'a', '1194']],
    ['remote a 1194 ; comment', ['remote', 'a', '1194']],
    ['# whole line', []],
    ['auth-user-pass pass#word', ['auth-user-pass', 'pass#word']],
    ['ca "C:\\\\Program Files\\\\OpenVPN\\\\ca.crt"', ['ca', 'C:\\Program Files\\OpenVPN\\ca.crt']],
    ['ca C:\\certs\\ca.crt', ['ca', 'C:certsca.crt']], // unquoted single backslashes are escapes, as in openvpn
    ['ca C:/certs/ca.crt', ['ca', 'C:/certs/ca.crt']],
    ["ca 'C:\\certs\\my ca.crt'", ['ca', 'C:\\certs\\my ca.crt']], // no escaping inside single quotes
    ['cert my\\ cert.crt', ['cert', 'my cert.crt']],
    ['setenv FOO "a \\"quoted\\" value"', ['setenv', 'FOO', 'a "quoted" value']],
    ['ca "#notacomment.crt"', ['ca', '#notacomment.crt']],
  ])('%s', (line, tokens) => {
    expect(tokenizeLine(line).tokens).toEqual(tokens);
  });

  it('reports unterminated quotes', () => {
    expect(tokenizeLine('ca "unterminated').error).toMatch(/Unterminated double quote/);
  });

  it('quoteToken round-trips through the tokenizer', () => {
    for (const v of ['plain.crt', 'with space.crt', 'C:\\dir\\x.crt', 'q"uote', '#hash', ';semi', '']) {
      expect(tokenizeLine(`ca ${quoteToken(v)}`).tokens).toEqual(['ca', v]);
    }
  });
});

const SAMPLE = [
  '# Company VPN',
  'client',
  'dev tun',
  'proto udp',
  'remote vpn1.example.com 1194',
  'remote vpn2.example.com 443 tcp',
  '--nobind',
  'ca ca.crt',
  'cert "client cert.crt"',
  'key keys/client.key',
  'tls-auth ta.key 1',
  'remote-cert-tls server',
  'redirect-gateway def1 bypass-dhcp',
  'route 10.20.0.0 255.255.0.0',
  'route-ipv6 fd00::/64',
  'dhcp-option DNS 10.20.0.53',
  'auth-user-pass',
  '<connection>',
  'remote backup.example.com 1194',
  '</connection>',
  '<tls-crypt>',
  '-----BEGIN OpenVPN Static key V1-----',
  'abc',
  '-----END OpenVPN Static key V1-----',
  '</tls-crypt>',
].join('\r\n');

describe('parseConfig / analyzeConfig', () => {
  it('parses directives, inline blocks, <connection> blocks and keeps CRLF on round trip', () => {
    const cfg = parseConfig(SAMPLE + '\r\n');
    expect(cfg.errors).toEqual([]);
    expect(serializeConfig(cfg)).toBe(SAMPLE + '\r\n');
    const a = analyzeConfig(cfg);
    expect(a.remotes.map((r) => r.host)).toEqual(['vpn1.example.com', 'vpn2.example.com', 'backup.example.com']);
    expect(a.has('nobind')).toBe(true); // "--" prefix accepted
    expect(a.inlineBlocks).toEqual(['tls-crypt']);
    expect(a.fileRefs.map((r) => `${r.directive.name}:${r.path}`)).toEqual(['ca:ca.crt', 'cert:client cert.crt', 'key:keys/client.key', 'tls-auth:ta.key']);
    expect(a.redirectGateway).toEqual(['def1', 'bypass-dhcp']);
    expect(a.routes).toEqual([{ network: '10.20.0.0', netmask: '255.255.0.0', gateway: undefined, metric: undefined }]);
    expect(a.routesIpv6).toEqual(['fd00::/64']);
    expect(a.dhcpOptions).toEqual([{ type: 'DNS', value: '10.20.0.53' }]);
    expect(a.authUserPass).toBe(true);
  });

  it('rewrites only the edited directive', () => {
    const cfg = parseConfig('ca ca.crt   # trailing\nkey k.key\n');
    setArgs(cfg.nodes[0] as Directive, ['my ca.crt']);
    expect(serializeConfig(cfg)).toBe('ca "my ca.crt"\nkey k.key\n');
  });

  it('reports a missing closing tag', () => {
    expect(parseConfig('<ca>\nxxx\n').errors[0].message).toBe('Missing </ca>');
  });
});

describe('ConfigSecurityScanner', () => {
  it('lists protections of a well-formed profile', () => {
    const scan = scanConfig(parseConfig(SAMPLE));
    expect(scan.dangerous).toBe(false);
    const ok = scan.findings.filter((f) => f.severity === 'ok').map((f) => f.title);
    expect(ok).toEqual(expect.arrayContaining(['CA certificate', 'Client certificate', 'TLS enabled (tls-crypt)', 'Server certificate verification']));
    expect(scan.wantsDefaultRoute).toBe(true);
    expect(scan.needsCredentials).toBe(true);
  });

  it('flags command execution and plugins as dangerous', () => {
    const scan = scanConfig(parseConfig('client\nremote x\nscript-security 2\nup ./script.sh\nplugin /usr/lib/evil.so\n'));
    expect(scan.dangerous).toBe(true);
    const danger = scan.findings.filter((f) => f.severity === 'danger');
    expect(danger.map((f) => f.title)).toEqual(['script-security 2', 'Runs a command on "up"', 'Loads a plugin']);
    expect(danger[1]).toMatchObject({ detail: 'up ./script.sh', line: 4 });
  });

  it('does not flag script-security 1 alone, but flags weak crypto and missing server verification', () => {
    const scan = scanConfig(parseConfig('client\nremote x\nscript-security 1\ncipher none\ncomp-lzo\n'));
    const titles = scan.findings.map((f) => f.title);
    expect(titles).not.toContain('script-security 1');
    expect(titles).toEqual(expect.arrayContaining(['cipher none', 'Compression enabled', 'Server certificate type not verified', 'No CA certificate']));
  });

  it('errors on a config without any remote', () => {
    expect(scanConfig(parseConfig('client\n')).errors).toContain('No "remote" server in the configuration');
  });
});

describe('ProfileImporter', () => {
  const root = mkdtempSync(join(tmpdir(), 'mov-import-'));
  const src = join(root, 'src');
  const profilesDir = join(root, 'profiles');
  mkdirSync(join(src, 'keys'), { recursive: true });
  mkdirSync(join(root, 'shared'), { recursive: true });
  for (const [f, c] of [
    ['ca.crt', 'CA'],
    ['client cert.crt', 'CERT'],
    ['keys/client.key', 'KEY'],
    ['ta.key', 'TA'],
    ['creds.txt', 'alice\nhunter2\n'],
  ]) writeFileSync(join(src, f), c);
  writeFileSync(join(root, 'shared', 'ca.crt'), 'OTHER-CA'); // same basename, different file

  const write = (name: string, text: string): string => {
    const p = join(src, name);
    writeFileSync(p, text);
    return p;
  };

  it('copies every referenced file, rewrites references and never copies credential files', async () => {
    const path = write(
      'company.ovpn',
      ['client', 'remote vpn 1194', 'ca ca.crt', 'extra-certs ../shared/ca.crt', 'cert "client cert.crt"', 'key keys/client.key', 'tls-auth ta.key 1', 'auth-user-pass creds.txt', 'daemon', 'log /tmp/x.log', ''].join('\n'),
    );
    const preview = await previewImport(path);
    expect(preview.scan.errors).toEqual([]);
    expect(preview.suggestedName).toBe('company');

    const p = await importProfile({ path, name: 'Company', acceptDangerous: false }, profilesDir);
    const dir = dirname(p.configPath);
    expect(dir).toBe(join(profilesDir, p.id));
    expect(p.username).toBe('alice');
    expect(readdirSync(dir).sort()).toEqual(['ca-2.crt', 'ca.crt', 'client.key', 'client_cert.crt', 'config.ovpn', 'ta.key']);
    expect(readFileSync(join(dir, 'ca-2.crt'), 'utf8')).toBe('OTHER-CA');

    const text = readFileSync(p.configPath, 'utf8');
    expect(text).toContain('ca ca.crt\nextra-certs ca-2.crt\ncert client_cert.crt\nkey client.key\ntls-auth ta.key 1\n');
    expect(text).toContain('\nauth-user-pass\n'); // file dropped, password never stored
    expect(text).not.toContain('hunter2');
    expect(text).toContain('# [multi-openvpn] disabled: daemon');
    expect(text).toContain('# [multi-openvpn] disabled: log /tmp/x.log');
    if (process.platform !== 'win32') expect(statSync(p.configPath).mode & 0o777).toBe(0o600);
  });

  it('refuses missing files, non-config extensions and unconfirmed dangerous configs', async () => {
    const missing = write('missing.ovpn', 'client\nremote x\nca nope.crt\n');
    expect((await previewImport(missing)).scan.errors[0]).toMatch(/ca file "nope.crt".*not found/);
    await expect(importProfile({ path: missing, name: 'x', acceptDangerous: true }, profilesDir)).rejects.toThrow(/not found/);

    const txt = write('notes.txt', 'remote x\n');
    expect((await previewImport(txt)).scan.errors[0]).toMatch(/not a .ovpn or .conf/);

    const danger = write('danger.conf', 'client\nremote x\nscript-security 2\nup ./x.sh\n');
    await expect(importProfile({ path: danger, name: 'd', acceptDangerous: false }, profilesDir)).rejects.toThrow(/confirmation required/);
    const ok = await importProfile({ path: danger, name: 'd', acceptDangerous: true }, profilesDir);
    expect(existsSync(ok.configPath)).toBe(true);
  });

  it('edited configs may only reference files inside the profile folder', async () => {
    const path = write('edit.ovpn', 'client\nremote x\nca ca.crt\n');
    const p = await importProfile({ path, name: 'e', acceptDangerous: false }, profilesDir);
    const dir = dirname(p.configPath);
    expect((await prepareEditedConfig('client\nremote y\nca ca.crt\n', dir)).scan.errors).toEqual([]);
    expect((await prepareEditedConfig('client\nremote y\nca /etc/passwd\n', dir)).scan.errors[0]).toMatch(/inside the profile folder/);
    expect((await prepareEditedConfig('client\nremote y\nca ../other/ca.crt\n', dir)).scan.errors[0]).toMatch(/inside the profile folder/);
    expect((await prepareEditedConfig('client\nremote y\nauth-user-pass creds.txt\n', dir)).scan.errors[0]).toMatch(/must not reference a file/);
    expect((await prepareEditedConfig('client\nremote y\ndaemon\n', dir)).text).toContain('# [multi-openvpn] disabled: daemon');
  });

  it('exports a self-contained config with inline blocks', async () => {
    const path = write('export.ovpn', 'client\nremote x\nca ca.crt\ntls-auth ta.key 1\n');
    const p = await importProfile({ path, name: 'x', acceptDangerous: false }, profilesDir);
    const out = await buildPortableConfig(p.configPath);
    expect(out).toBe('client\nremote x\n<ca>\nCA\n</ca>\nkey-direction 1\n<tls-auth>\nTA\n</tls-auth>\n');
    expect(analyzeConfig(parseConfig(out)).fileRefs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

let lab: Lab | null = null;
beforeAll(async () => {
  lab = await createLab();
}, 30_000);
afterAll(() => lab?.cleanup());

describe('imported profile connects with real openvpn', () => {
  it('certificates referenced from another folder keep working after import', async (ctx) => {
    if (!lab) return ctx.skip();
    const port = await lab.startServer();
    // A config in a sub folder referencing certs with relative paths (../) and a quoted path.
    const sub = join(lab.dir, 'downloads', 'vpn');
    mkdirSync(sub, { recursive: true });
    const cfg = join(sub, 'lab.ovpn');
    writeFileSync(
      cfg,
      ['dev null', 'tls-client', 'proto udp4', `remote 127.0.0.1 ${port}`, 'nobind', 'ca ../../ca.crt', `cert "${join(lab.dir, 'client.crt')}"`, 'key ../../client.key', 'remote-cert-tls server', ''].join('\n'),
    );
    const profile = await importProfile({ path: cfg, name: 'Lab', acceptDangerous: false }, join(lab.dir, 'profiles'));

    const processes = new VpnProcessManager(join(lab.dir, 'run-import'));
    const manager = new VpnManager({
      getProfile: () => profile,
      createDriver: (c) => new OpenVpnDriver(c, { processes, binary: () => lab!.binary, stopTimeoutMs: 3_000 }),
    });
    const id = manager.connect(profile.id);
    try {
      await waitFor(manager, id, 'CONNECTED');
    } finally {
      await manager.disconnectAll();
    }
  }, 30_000);
});
