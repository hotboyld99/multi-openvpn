import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { cp, rm } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import type { ProfilePatch } from '../../shared/schemas';
import type { VpnProfile } from '../../shared/types';
import { readJson, writeJsonAtomic } from './jsonFile';

/**
 * Profile metadata (no secrets) in <userData>/profiles.json; each profile's config and
 * certificates live in <userData>/profiles/<id>/.
 */
export class ProfileStore extends EventEmitter<{ changed: [VpnProfile[]] }> {
  private profiles = new Map<string, VpnProfile>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {
    super();
  }

  get file(): string {
    return join(this.root, 'profiles.json');
  }

  get profilesDir(): string {
    return join(this.root, 'profiles');
  }

  async load(): Promise<void> {
    const list = await readJson<VpnProfile[]>(this.file, []);
    this.profiles = new Map(list.map((p) => [p.id, p]));
  }

  list(): VpnProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): VpnProfile | undefined {
    return this.profiles.get(id);
  }

  async add(profile: VpnProfile): Promise<VpnProfile> {
    this.profiles.set(profile.id, profile);
    await this.persist();
    return profile;
  }

  async update(id: string, patch: ProfilePatch & { lastConnectedAt?: number; hasSavedPassword?: boolean }): Promise<VpnProfile> {
    const current = this.require(id);
    const next: VpnProfile = { ...current, ...patch, updatedAt: Date.now() };
    this.profiles.set(id, next);
    await this.persist();
    return next;
  }

  async duplicate(id: string): Promise<VpnProfile> {
    const src = this.require(id);
    const newId = randomUUID();
    let configPath = src.configPath;
    if (this.ownsPath(src.configPath)) {
      const newDir = join(this.profilesDir, newId);
      await cp(dirname(src.configPath), newDir, { recursive: true });
      configPath = join(newDir, relative(dirname(src.configPath), src.configPath));
    }
    const now = Date.now();
    return this.add({
      ...src,
      id: newId,
      name: `${src.name} (copy)`,
      configPath,
      hasSavedPassword: false,
      lastConnectedAt: undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  async remove(id: string): Promise<void> {
    const p = this.require(id);
    this.profiles.delete(id);
    await this.persist();
    if (this.ownsPath(p.configPath)) await rm(dirname(p.configPath), { recursive: true, force: true });
  }

  /** True when the path is inside <userData>/profiles/<id>/ — never delete or copy anything else. */
  private ownsPath(path: string): boolean {
    const rel = relative(this.profilesDir, path);
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.split(/[\\/]/).length >= 2;
  }

  private require(id: string): VpnProfile {
    const p = this.profiles.get(id);
    if (!p) throw new Error(`Profile ${id} not found`);
    return p;
  }

  private persist(): Promise<void> {
    const snapshot = this.list();
    this.writeQueue = this.writeQueue.then(() => writeJsonAtomic(this.file, snapshot));
    this.emit('changed', snapshot);
    return this.writeQueue;
  }
}

export function demoProfiles(): VpnProfile[] {
  const now = Date.now();
  const make = (name: string, scenario: string, extra: Partial<VpnProfile> = {}): VpnProfile => ({
    id: randomUUID(),
    name,
    configPath: `mock://${scenario}`,
    configFileName: `${name.toLowerCase().replace(/\s+/g, '-')}.ovpn`,
    hasSavedPassword: false,
    autoConnect: false,
    reconnect: true,
    routingMode: 'config',
    dnsMode: 'vpn',
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return [
    make('Company Singapore', 'ok'),
    make('Development VPN', 'ok'),
    make('Office VPN', 'ok'),
    make('Staging', 'flaky'),
    make('Broken Auth', 'auth-fail'),
  ];
}
