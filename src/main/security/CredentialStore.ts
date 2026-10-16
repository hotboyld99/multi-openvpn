import { join } from 'node:path';
import type { SecretInput } from '../../shared/types';
import { readJson, writeJsonAtomic } from '../store/jsonFile';

/** Encryption backed by the OS: Electron safeStorage (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux). */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  /** safeStorage on Linux may fall back to a hard-coded key ("basic_text"); that is not secure storage. */
  isWeak?(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

type Stored = Record<string, Record<string, string>>; // profileId → realm → base64 ciphertext

/**
 * Remembered VPN passwords. Only ciphertext ever touches the disk (<userData>/secrets.json);
 * the key lives in the OS credential store. Profiles (profiles.json) never contain secrets.
 */
export class CredentialStore {
  constructor(
    private readonly root: string,
    private readonly cipher: SecretCipher,
  ) {}

  private get file(): string {
    return join(this.root, 'secrets.json');
  }

  get available(): boolean {
    return this.cipher.isEncryptionAvailable() && !this.cipher.isWeak?.();
  }

  async get(profileId: string, realm: string): Promise<SecretInput | undefined> {
    if (!this.available) return undefined;
    const enc = (await readJson<Stored>(this.file, {}))[profileId]?.[realm];
    if (!enc) return undefined;
    try {
      return JSON.parse(this.cipher.decryptString(Buffer.from(enc, 'base64'))) as SecretInput;
    } catch {
      return undefined; // key changed (e.g. OS keychain reset): behave as if nothing was stored
    }
  }

  async set(profileId: string, realm: string, secret: SecretInput): Promise<void> {
    if (!this.available) throw new Error('Secure storage is not available on this system; the password was not saved');
    const all = await readJson<Stored>(this.file, {});
    all[profileId] = { ...all[profileId], [realm]: this.cipher.encryptString(JSON.stringify(secret)).toString('base64') };
    await writeJsonAtomic(this.file, all);
  }

  /** Forgets one realm, or every secret of the profile. */
  async remove(profileId: string, realm?: string): Promise<void> {
    const all = await readJson<Stored>(this.file, {});
    if (!all[profileId]) return;
    if (realm) delete all[profileId][realm];
    if (!realm || Object.keys(all[profileId]).length === 0) delete all[profileId];
    await writeJsonAtomic(this.file, all);
  }

  async has(profileId: string): Promise<boolean> {
    return Object.keys((await readJson<Stored>(this.file, {}))[profileId] ?? {}).length > 0;
  }
}
