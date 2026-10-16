import type { BrowserWindow } from 'electron';
import type { AppInfo } from '../shared/types';
import type { ProfileStore } from './store/ProfileStore';
import type { SettingsStore } from './store/SettingsStore';
import type { VpnManager } from './vpn/VpnManager';

/** Long-lived services shared by IPC handlers. Created once in index.ts. */
export interface AppContext {
  manager: VpnManager;
  profiles: ProfileStore;
  settings: SettingsStore;
  mockMode: boolean;
  appInfo(): AppInfo;
  window(): BrowserWindow | null;
}
