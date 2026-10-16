import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVpnDriver } from '../src/main/vpn/OpenVpnDriver';
import { VpnManager } from '../src/main/vpn/VpnManager';
import { VpnProcessManager } from '../src/main/vpn/VpnProcessManager';
import { VpnErrorCode, type VpnProfile } from '../src/shared/types';
import { alive, createLab, labProfile, waitFor, type Lab } from './helpers/openvpnLab';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('orphan cleanup', () => {
  it('kills processes recorded by a previous run, but never a reused PID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mov-orphan-'));
    const workDir = join(root, 'deadbeef-abc');
    mkdirSync(workDir);
    // Stand-in for an orphaned openvpn: its command line contains its work dir, like openvpn's does.
    const ours = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', workDir], { stdio: 'ignore' });
    // A process whose PID is in the registry but that is not ours (PID reuse).
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await sleep(200);
    writeFileSync(
      join(root, 'running.json'),
      JSON.stringify([
        { connectionId: 'a', pid: ours.pid, workDir },
        { connectionId: 'b', pid: stranger.pid, workDir: join(root, 'other-dir') },
      ]),
    );

    const killed = await new VpnProcessManager(root).cleanupOrphans();
    expect(killed).toEqual([ours.pid]);
    expect(alive(ours.pid)).toBe(false);
    expect(alive(stranger.pid)).toBe(true);
    expect(existsSync(workDir)).toBe(false); // stale work dirs removed
    stranger.kill('SIGKILL');
  });
});

// ---------------------------------------------------------------------------
// Three real openvpn processes at once (rootless lab).

let lab: Lab | null = null;
beforeAll(async () => {
  lab = await createLab();
}, 30_000);
afterAll(() => lab?.cleanup());

const managers: VpnManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disconnectAll()));
});

async function setup(names: string[], extra: Partial<VpnProfile> = {}) {
  const ports = await Promise.all(names.map(() => lab!.startServer()));
  const profiles = names.map((n, i) => labProfile(n, lab!.clientConfig(`${n}-${ports[i]}`, ports[i]), extra));
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const tempRoot = join(lab!.dir, `run-${Math.random().toString(36).slice(2)}`);
  const processes = new VpnProcessManager(tempRoot);
  const manager = new VpnManager({
    getProfile: (id) => byId.get(id),
    createDriver: (ctx) => new OpenVpnDriver(ctx, { processes, binary: () => lab!.binary, stopTimeoutMs: 3_000 }),
  });
  managers.push(manager);
  const ids = profiles.map((p) => manager.connect(p.id));
  await Promise.all(ids.map((id) => waitFor(manager, id, 'CONNECTED')));
  return { manager, processes, ids, tempRoot };
}

async function bytesGrow(manager: VpnManager, id: string): Promise<boolean> {
  const before = manager.get(id)!.bytesIn;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (manager.get(id)!.bytesIn > before) return true;
  }
  return false;
}

describe('multiple real VPN connections', () => {
  it('A, B and C run concurrently with isolated process, management port, logs and state', async (ctx) => {
    if (!lab) return ctx.skip();
    const { manager, processes, ids } = await setup(['a', 'b', 'c']);
    const conns = ids.map((id) => manager.get(id)!);

    expect(conns.every((c) => c.status === 'CONNECTED')).toBe(true);
    expect(new Set(conns.map((c) => c.pid)).size).toBe(3);
    expect(new Set(conns.map((c) => c.managementPort)).size).toBe(3);
    expect(conns.every((c) => alive(c.pid))).toBe(true);
    expect(processes.list()).toHaveLength(3);

    // Each log stream only talks about its own process.
    for (const c of conns) {
      const text = manager.getLogs(c.id).map((l) => l.message).join('\n');
      expect(text).toContain(`management 127.0.0.1:${c.managementPort}`);
      for (const other of conns.filter((o) => o !== c)) expect(text).not.toContain(`127.0.0.1:${other.managementPort}`);
    }
    for (const id of ids) expect(await bytesGrow(manager, id)).toBe(true);
  }, 45_000);

  it('disconnecting A leaves B and C connected and carrying traffic', async (ctx) => {
    if (!lab) return ctx.skip();
    const { manager, ids } = await setup(['a', 'b', 'c']);
    const [a, b, c] = ids.map((id) => manager.get(id)!);

    await manager.disconnect(a.id);
    expect(manager.get(a.id)!.status).toBe('DISCONNECTED');
    expect(alive(a.pid)).toBe(false);

    for (const x of [b, c]) {
      expect(manager.get(x.id)!.status).toBe('CONNECTED');
      expect(manager.get(x.id)!.pid).toBe(x.pid);
      expect(manager.get(x.id)!.connectedAt).toBe(x.connectedAt);
      expect(await bytesGrow(manager, x.id)).toBe(true);
    }
  }, 45_000);

  it('A crashing (kill -9) leaves B and C connected; A is cleaned up', async (ctx) => {
    if (!lab) return ctx.skip();
    const { manager, processes, ids, tempRoot } = await setup(['a', 'b', 'c']);
    const [a, b, c] = ids.map((id) => manager.get(id)!);

    process.kill(a.pid!, 'SIGKILL');
    await waitFor(manager, a.id, 'ERROR');
    expect(manager.get(a.id)!.error?.code).toBe(VpnErrorCode.PROCESS_CRASHED);

    for (const x of [b, c]) {
      expect(manager.get(x.id)!.status).toBe('CONNECTED');
      expect(manager.get(x.id)!.pid).toBe(x.pid);
      expect(await bytesGrow(manager, x.id)).toBe(true);
    }
    // A's process entry, management port reservation and work dir are released.
    await sleep(100);
    expect(processes.list().map((p) => p.connectionId).sort()).toEqual([b.id, c.id].sort());
    expect(readdirSync(tempRoot).filter((d) => d !== 'running.json')).toHaveLength(2);
  }, 45_000);

  it('with auto-reconnect, a crashed A comes back with a new process while B is untouched', async (ctx) => {
    if (!lab) return ctx.skip();
    const { manager, ids } = await setup(['a', 'b'], { reconnect: true });
    const [a, b] = ids.map((id) => manager.get(id)!);

    process.kill(a.pid!, 'SIGKILL');
    await waitFor(manager, a.id, 'RECONNECTING');
    await waitFor(manager, a.id, 'CONNECTED');
    const a2 = manager.get(a.id)!;
    expect(a2.pid).not.toBe(a.pid);
    expect(a2.reconnectCount).toBe(1);
    expect(manager.get(b.id)!.pid).toBe(b.pid);
    expect(manager.get(b.id)!.connectedAt).toBe(b.connectedAt);
  }, 45_000);

  it('after an app crash, the next start stops the orphaned openvpn processes', async (ctx) => {
    if (!lab) return ctx.skip();
    const { manager, ids, tempRoot } = await setup(['a', 'b']);
    const pids = ids.map((id) => manager.get(id)!.pid!);
    managers.splice(managers.indexOf(manager), 1); // "crash": nobody disconnects them

    const killed = await new VpnProcessManager(tempRoot).cleanupOrphans();
    expect(killed.sort()).toEqual([...pids].sort());
    expect(pids.some(alive)).toBe(false);
    await waitFor(manager, ids[0], 'ERROR'); // the old manager sees its processes die
  }, 45_000);
});
