import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENTS, IPC, type VpnApi } from '../shared/ipc';

// Sandboxed preload: the only bridge between UI and main. No Node APIs are exposed.

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: VpnApi = {
  getAppInfo: () => invoke(IPC.appGetInfo),

  connect: (profileId) => invoke(IPC.vpnConnect, profileId),
  connectMany: (profileIds) => invoke(IPC.vpnConnectMany, profileIds),
  disconnect: (connectionId) => invoke(IPC.vpnDisconnect, connectionId),
  reconnect: (connectionId) => invoke(IPC.vpnReconnect, connectionId),
  disconnectAll: () => invoke(IPC.vpnDisconnectAll),
  getConnections: () => invoke(IPC.vpnGetConnections),
  getLogs: (connectionId) => invoke(IPC.vpnGetLogs, connectionId),
  clearLogs: (connectionId) => invoke(IPC.vpnClearLogs, connectionId),
  exportLogs: (connectionId) => invoke(IPC.vpnExportLogs, connectionId),
  onConnection: (cb) => subscribe(EVENTS.connection, cb),
  onConnectionRemoved: (cb) => subscribe(EVENTS.connectionRemoved, cb),
  onLog: (cb) => subscribe(EVENTS.log, cb),

  profiles: {
    list: () => invoke(IPC.profilesList),
    update: (id, patch) => invoke(IPC.profilesUpdate, id, patch),
    duplicate: (id) => invoke(IPC.profilesDuplicate, id),
    remove: (id) => invoke(IPC.profilesRemove, id),
    onChanged: (cb) => subscribe(EVENTS.profilesChanged, cb),
  },

  network: {
    getInterfaces: () => invoke(IPC.networkGetInterfaces),
  },

  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch),
    onChanged: (cb) => subscribe(EVENTS.settingsChanged, cb),
  },
};

contextBridge.exposeInMainWorld('vpn', api);
