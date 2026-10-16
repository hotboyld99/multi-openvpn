import type { BrowserWindow } from 'electron';
import type { AppInfo } from '../shared/types';
import type { DnsManager } from './network/DnsManager';
import type { RouteManager } from './network/RouteManager';
import type { CredentialStore } from './security/CredentialStore';
import type { ProfileStore } from './store/ProfileStore';
import type { SettingsStore } from './store/SettingsStore';
import type { OpenVpnBinaryManager } from './vpn/OpenVpnBinaryManager';
import type { VpnManager } from './vpn/VpnManager';

/** Long-lived services shared by IPC handlers. Created once in index.ts. */
export interface AppContext {
  manager: VpnManager;
  profiles: ProfileStore;
  settings: SettingsStore;
  mockMode: boolean;
  binaries: OpenVpnBinaryManager;
  routes: RouteManager;
  dns: DnsManager;
  credentials: CredentialStore;
  /** Re-resolves the OpenVPN binary from settings and notifies the renderer. */
  refreshBinary(): Promise<void>;
  /** Directories the privileged helper may access (profiles + per-connection temp dirs). */
  helperRoots: string[];
  /** (Re)connects to the privileged helper and publishes its status. */
  connectHelper(): Promise<void>;
  appInfo(): AppInfo;
  window(): BrowserWindow | null;
}
