import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { describeInterfaces } from '../src/main/network/InterfaceManager';
import { mapOpenVpnState } from '../src/main/vpn/VpnDriver';
import { isRetryable } from '../src/shared/errors';
import { ProfilePatchSchema, SettingsPatchSchema } from '../src/shared/schemas';
import { VpnErrorCode, type VpnConnection } from '../src/shared/types';

describe('mapOpenVpnState', () => {
  it('maps management states, including aliases', () => {
    expect(mapOpenVpnState('CONNECTED')).toBe('CONNECTED');
    expect(mapOpenVpnState('RESOLVE')).toBe('CONNECTING');
    expect(mapOpenVpnState('TCP_CONNECT')).toBe('CONNECTING');
    expect(mapOpenVpnState('AUTH_PENDING')).toBe('AUTH');
    expect(mapOpenVpnState('EXITING')).toBe('DISCONNECTING');
    expect(mapOpenVpnState('SOMETHING_NEW')).toBeUndefined();
  });
});

describe('isRetryable', () => {
  it('blocks reconnect loops on errors that cannot fix themselves', () => {
    expect(isRetryable(VpnErrorCode.AUTH_FAILED)).toBe(false);
    expect(isRetryable(VpnErrorCode.CERT_EXPIRED)).toBe(false);
    expect(isRetryable(VpnErrorCode.INVALID_CONFIG)).toBe(false);
    expect(isRetryable(VpnErrorCode.PROCESS_CRASHED)).toBe(true);
    expect(isRetryable(VpnErrorCode.CONNECTION_TIMEOUT)).toBe(true);
  });
});

describe('IPC schemas', () => {
  it('accepts a valid profile patch with custom routes', () => {
    const r = ProfilePatchSchema.safeParse({
      name: 'Office',
      routingMode: 'custom',
      customRoutes: [
        { id: randomUUID(), type: 'cidr', value: '10.20.0.0/16' },
        { id: randomUUID(), type: 'ip', value: '192.168.1.100' },
        { id: randomUUID(), type: 'hostname', value: 'internal.company.com' },
      ],
      dnsServers: ['1.1.1.1'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown keys, bad routes and injection-looking values', () => {
    expect(ProfilePatchSchema.safeParse({ configPath: '/etc/passwd' }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ customRoutes: [{ id: randomUUID(), type: 'cidr', value: '10.0.0.0/99' }] }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ customRoutes: [{ id: randomUUID(), type: 'hostname', value: 'a; rm -rf /' }] }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ dnsServers: ['8.8.8.8 && x'] }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ theme: 'neon' }).success).toBe(false);
  });
});

describe('describeInterfaces', () => {
  const conn = (over: Partial<VpnConnection>): VpnConnection => ({
    id: randomUUID(),
    profileId: randomUUID(),
    status: 'CONNECTED',
    startedAt: 0,
    bytesIn: 0,
    bytesOut: 0,
    rateIn: 0,
    rateOut: 0,
    reconnectCount: 0,
    ...over,
  });
  const os = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00', netmask: '255.0.0.0', cidr: '127.0.0.1/8' }],
    en0: [{ address: '192.168.1.10', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:ff', netmask: '255.255.255.0', cidr: '192.168.1.10/24' }],
    utun1: [{ address: 'fe80::1', family: 'IPv6', internal: false, mac: '00:00:00:00:00:00', netmask: 'ffff::', cidr: 'fe80::1/64', scopeid: 1 }],
    utun5: [{ address: '10.8.0.12', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', netmask: '255.255.255.0', cidr: '10.8.0.12/24' }],
    utun6: [{ address: '10.9.0.8', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', netmask: '255.255.255.0', cidr: '10.9.0.8/24' }],
  } as const;

  it('attributes tunnels to connections by assigned IP or interface name', () => {
    const a = conn({ assignedIp: '10.8.0.12' });
    const b = conn({ interfaceName: 'utun6' });
    const list = describeInterfaces(structuredClone(os) as never, [a, b]);
    const byName = Object.fromEntries(list.map((i) => [i.name, i]));
    expect(byName.utun5.kind).toBe('vpn');
    expect(byName.utun5.connectionId).toBe(a.id);
    expect(byName.utun6.connectionId).toBe(b.id);
    expect(byName.utun1.kind).toBe('tunnel');
    expect(byName.en0.kind).toBe('physical');
    expect(byName.lo0.kind).toBe('loopback');
  });

  it('ignores disconnected connections and simulates mock interfaces only when asked', () => {
    const dead = conn({ status: 'DISCONNECTED', assignedIp: '10.8.0.12' });
    expect(describeInterfaces(structuredClone(os) as never, [dead]).find((i) => i.name === 'utun5')!.kind).toBe('tunnel');
    const mock = conn({ interfaceName: 'utun42', assignedIp: '10.50.0.2' });
    expect(describeInterfaces({}, [mock]).length).toBe(0);
    expect(describeInterfaces({}, [mock], { simulateMissing: true })[0]).toMatchObject({ name: 'utun42', simulated: true });
  });
});
