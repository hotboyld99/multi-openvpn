import type {
  AppInfo,
  AppSettings,
  ConnectOptions,
  ConnectResult,
  ImportPreview,
  LogEntry,
  NetworkInterfaceInfo,
  OpenVpnBinaryInfo,
  ProfileScan,
  RouteInfo,
  SecretInput,
  VpnConnection,
  VpnProfile,
} from './types';
import type { ProfilePatch, SettingsPatch } from './schemas';

/** Request/response channels (renderer → main, ipcRenderer.invoke). */
export const IPC = {
  appGetInfo: 'app:getInfo',

  vpnConnect: 'vpn:connect',
  vpnConnectMany: 'vpn:connectMany',
  vpnDisconnect: 'vpn:disconnect',
  vpnReconnect: 'vpn:reconnect',
  vpnDisconnectAll: 'vpn:disconnectAll',
  vpnGetConnections: 'vpn:getConnections',
  vpnGetLogs: 'vpn:getLogs',
  vpnClearLogs: 'vpn:clearLogs',
  vpnExportLogs: 'vpn:exportLogs',
  vpnSubmitSecret: 'vpn:submitSecret',
  vpnCancelSecret: 'vpn:cancelSecret',

  profilesList: 'profiles:list',
  profilesUpdate: 'profiles:update',
  profilesDuplicate: 'profiles:duplicate',
  profilesRemove: 'profiles:remove',
  profilesPickFiles: 'profiles:pickFiles',
  profilesPreviewImport: 'profiles:previewImport',
  profilesImport: 'profiles:import',
  profilesReadConfig: 'profiles:readConfig',
  profilesCheckConfig: 'profiles:checkConfig',
  profilesWriteConfig: 'profiles:writeConfig',
  profilesExport: 'profiles:export',

  networkGetInterfaces: 'network:getInterfaces',
  networkGetRoutes: 'network:getRoutes',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  openvpnDetect: 'openvpn:detect',
  openvpnBrowse: 'openvpn:browse',
} as const;

/** Push channels (main → renderer, webContents.send). */
export const EVENTS = {
  connection: 'vpn:connection',
  connectionRemoved: 'vpn:connectionRemoved',
  log: 'vpn:log',
  profilesChanged: 'profiles:changed',
  settingsChanged: 'settings:changed',
  appInfoChanged: 'app:infoChanged',
} as const;

export interface LogEvent {
  connectionId: string;
  entry: LogEntry;
}

type Unsubscribe = () => void;

/** The complete surface exposed to the renderer as `window.vpn`. Nothing else crosses the bridge. */
export interface VpnApi {
  getAppInfo(): Promise<AppInfo>;
  onAppInfo(cb: (info: AppInfo) => void): Unsubscribe;

  /** Resolves with a conflict instead of connecting when the default route is owned by another VPN. */
  connect(profileId: string, options?: ConnectOptions): Promise<ConnectResult>;
  connectMany(profileIds: string[]): Promise<ConnectResult[]>;
  disconnect(connectionId: string): Promise<void>;
  reconnect(connectionId: string): Promise<void>;
  disconnectAll(): Promise<void>;
  getConnections(): Promise<VpnConnection[]>;
  getLogs(connectionId: string): Promise<LogEntry[]>;
  clearLogs(connectionId: string): Promise<void>;
  /** Opens a save dialog in main; resolves false when the user cancels. */
  exportLogs(connectionId: string): Promise<boolean>;
  /** Answers `connection.authRequest`. The secret goes to openvpn's management socket only. */
  submitSecret(connectionId: string, secret: SecretInput): Promise<void>;
  /** Dismisses the prompt and disconnects. */
  cancelSecret(connectionId: string): Promise<void>;
  onConnection(cb: (connection: VpnConnection) => void): Unsubscribe;
  onConnectionRemoved(cb: (connectionId: string) => void): Unsubscribe;
  onLog(cb: (event: LogEvent) => void): Unsubscribe;

  profiles: {
    list(): Promise<VpnProfile[]>;
    update(id: string, patch: ProfilePatch): Promise<VpnProfile>;
    duplicate(id: string): Promise<VpnProfile>;
    remove(id: string): Promise<void>;
    onChanged(cb: (profiles: VpnProfile[]) => void): Unsubscribe;
    /** Native file dialog (multi-select .ovpn/.conf); resolves [] when cancelled. */
    pickFiles(): Promise<string[]>;
    /** Absolute path of a file dropped on the window. */
    pathForFile(file: File): string;
    /** Parses and security-scans files without importing them. */
    previewImport(paths: string[]): Promise<ImportPreview[]>;
    import(requests: { path: string; name: string; acceptDangerous: boolean }[]): Promise<{ imported: VpnProfile[]; failures: string[] }>;
    readConfig(id: string): Promise<string>;
    /** Scan an edited config without saving it. */
    checkConfig(id: string, text: string): Promise<ProfileScan>;
    writeConfig(id: string, text: string, acceptDangerous: boolean): Promise<ProfileScan>;
    /** Save dialog → single self-contained .ovpn with inline certificates. */
    exportConfig(id: string): Promise<boolean>;
  };

  network: {
    getInterfaces(): Promise<NetworkInterfaceInfo[]>;
    getRoutes(): Promise<RouteInfo[]>;
  };

  settings: {
    get(): Promise<AppSettings>;
    update(patch: SettingsPatch): Promise<AppSettings>;
    onChanged(cb: (settings: AppSettings) => void): Unsubscribe;
  };

  openvpn: {
    /** The binary in use plus every valid binary found on this machine. */
    detect(): Promise<{ current: OpenVpnBinaryInfo | null; candidates: OpenVpnBinaryInfo[] }>;
    /** File dialog → validate → save as custom path. Resolves null when cancelled. */
    browse(): Promise<OpenVpnBinaryInfo | null>;
  };
}
