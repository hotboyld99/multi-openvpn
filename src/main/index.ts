import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVENTS } from '../shared/ipc';
import type { AppInfo, HelperStatus, OpenVpnBinaryInfo } from '../shared/types';
import { HelperClient } from './helper/HelperClient';
import { defaultHelperBase } from './helper/protocol';
import type { PlatformNetworkService } from './platform/PlatformNetworkService';
import type { AppContext } from './context';
import { setTrustedOrigin } from './ipc/handle';
import { registerNetworkIpc } from './ipc/network.ipc';
import { registerProfileIpc } from './ipc/profile.ipc';
import { registerSettingsIpc } from './ipc/settings.ipc';
import { registerVpnIpc } from './ipc/vpn.ipc';
import { DnsManager } from './network/DnsManager';
import { CredentialStore } from './security/CredentialStore';
import { RouteManager } from './network/RouteManager';
import { createPlatformNetworkService } from './platform';
import { demoProfiles, ProfileStore } from './store/ProfileStore';
import { SettingsStore } from './store/SettingsStore';
import { MockVpnDriver } from './vpn/MockVpnDriver';
import { OpenVpnBinaryManager } from './vpn/OpenVpnBinaryManager';
import { OpenVpnDriver } from './vpn/OpenVpnDriver';
import type { DriverFactory } from './vpn/VpnDriver';
import { VpnManager } from './vpn/VpnManager';
import { VpnProcessManager } from './vpn/VpnProcessManager';

const mockMode = process.env.VPN_MOCK_MODE === 'true';
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = join(__dirname, '../renderer/index.html');

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Multi OpenVPN',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (mainWindow = null));
  if (rendererUrl) void win.loadURL(rendererUrl);
  else void win.loadFile(rendererFile);
  return win;
}

// The renderer never navigates anywhere and never opens windows; external links go to the browser.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

async function bootstrap(): Promise<void> {
  if (!app.hasSingleInstanceLock()) return;
  const root = app.getPath('userData');
  const profiles = new ProfileStore(root);
  const settings = new SettingsStore(root);
  await Promise.all([profiles.load(), settings.load()]);
  if (mockMode && profiles.list().length === 0) for (const p of demoProfiles()) await profiles.add(p);

  const binaries = new OpenVpnBinaryManager({
    bundledRoot: app.isPackaged ? join(process.resourcesPath, 'openvpn') : join(app.getAppPath(), 'resources', 'openvpn'),
  });
  let openvpn: OpenVpnBinaryInfo | null = null;

  const tempRoot = join(app.getPath('temp'), 'multi-openvpn');
  const processes = new VpnProcessManager(tempRoot);

  // Privileged helper: when connected, openvpn and every route/DNS change run through it.
  const helperBase = app.isPackaged ? defaultHelperBase() : join(app.getAppPath(), '.dev-helper');
  let helper: HelperClient | null = null;
  let helperStatus: HelperStatus = { state: mockMode ? 'mock' : 'not-installed' };
  let helperRetry: ReturnType<typeof setTimeout> | undefined;
  // If main dies without a graceful disconnect, do not leave orphaned openvpn processes behind;
  // if it was killed too hard for that, stop what the previous run left over now.
  process.on('exit', () => processes.killAll());
  const orphans = await processes.cleanupOrphans();
  if (orphans.length) console.warn(`Stopped ${orphans.length} orphaned openvpn process(es): ${orphans.join(', ')}`);

  const createDriver: DriverFactory = (dctx) =>
    mockMode
      ? new MockVpnDriver(dctx)
      : new OpenVpnDriver(dctx, { processes, binary: () => openvpn, launcher: helper?.connected ? helper.launcher : undefined });
  const credentials = new CredentialStore(root, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    isWeak: () => process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text',
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b),
  });

  const resolveInterface = (ip: string): string | undefined =>
    Object.entries(networkInterfaces()).find(([, addrs]) => addrs?.some((a) => a.address === ip))?.[0];
  const manager = new VpnManager({
    createDriver,
    getProfile: (id) => profiles.get(id),
    resolveInterface,
    getStoredSecret: (profileId, realm) => credentials.get(profileId, realm),
  });

  const localPlatform = createPlatformNetworkService(join(root, 'state'));
  const changes = (): PlatformNetworkService => (helper?.connected ? helper.platform(localPlatform) : localPlatform);
  const platform: PlatformNetworkService = {
    getRoutes: () => localPlatform.getRoutes(),
    getCurrentDns: () => localPlatform.getCurrentDns(),
    addRoute: (r) => changes().addRoute(r),
    removeRoute: (r) => changes().removeRoute(r),
    setDns: (id, d) => changes().setDns(id, d),
    restoreDns: (id) => changes().restoreDns(id),
    restoreAllDns: (keep) => changes().restoreAllDns(keep),
  };
  const routes = new RouteManager(platform, { simulate: mockMode });
  const dns = new DnsManager(platform, { simulate: mockMode, reassertMs: process.platform === 'darwin' ? 15_000 : undefined });
  process.on('exit', () => dns.dispose());

  const appInfo = (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    mockMode,
    openvpn: mockMode ? { path: 'mock', version: '2.6.x (mock)', source: 'bundled' } : openvpn,
    secureStorage: credentials.available,
    helper: helperStatus,
  });

  const send = (channel: string, ...args: unknown[]): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  const refreshBinary = async (): Promise<void> => {
    openvpn = await binaries.resolve(settings.get().openvpnPath);
    send(EVENTS.appInfoChanged, appInfo());
  };
  await refreshBinary();

  const connectHelper = async (): Promise<void> => {
    if (mockMode) return;
    clearTimeout(helperRetry);
    helper?.close();
    helper = null;
    try {
      const { token, socketPath } = JSON.parse(readFileSync(join(helperBase, 'token'), 'utf8')) as { token: string; socketPath: string };
      helper = await HelperClient.connect(socketPath, token);
      helperStatus = { state: 'connected' };
      helper.on('disconnected', () => {
        helper = null;
        helperStatus = { state: 'unavailable', detail: 'The privileged helper stopped; retrying…' };
        send(EVENTS.appInfoChanged, appInfo());
        helperRetry = setTimeout(() => void connectHelper(), 5_000);
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      helperStatus = e.code === 'ENOENT' && e.path?.endsWith('token') ? { state: 'not-installed' } : { state: 'unavailable', detail: e.message };
      if (helperStatus.state === 'unavailable') helperRetry = setTimeout(() => void connectHelper(), 10_000);
    }
    send(EVENTS.appInfoChanged, appInfo());
  };
  await connectHelper();
  // A previous run that crashed may have left DNS changed; undo it before anything connects.
  await dns.recover().catch((err) => console.error('DNS recovery failed:', err.message));

  const ctx: AppContext = {
    manager,
    profiles,
    settings,
    mockMode,
    binaries,
    routes,
    dns,
    credentials,
    refreshBinary,
    helperRoots: [profiles.profilesDir, tempRoot],
    connectHelper,
    appInfo,
    window: () => mainWindow,
  };

  const devOrigin = rendererUrl ? new URL(rendererUrl).origin : null;
  const fileUrl = pathToFileURL(rendererFile).href;
  setTrustedOrigin((url) => (devOrigin ? url.startsWith(devOrigin) : url.startsWith(fileUrl)));

  registerVpnIpc(ctx);
  registerProfileIpc(ctx);
  registerNetworkIpc(ctx);
  registerSettingsIpc(ctx);
  manager.on('connection', (c) => send(EVENTS.connection, c));
  manager.on('removed', (id) => send(EVENTS.connectionRemoved, id));
  manager.on('log', (connectionId, entry) => send(EVENTS.log, { connectionId, entry }));
  // Remembered passwords: saved only after they worked, forgotten as soon as they are rejected.
  manager.on('credentialsVerified', (profileId, realm, secret) => {
    void credentials
      .set(profileId, realm, secret)
      .then(() => profiles.get(profileId) && profiles.update(profileId, { hasSavedPassword: true }))
      .catch((err) => console.error('Saving credentials failed:', err.message));
  });
  manager.on('credentialsRejected', (profileId, realm) => {
    void credentials
      .remove(profileId, realm)
      .then(async () => profiles.get(profileId) && profiles.update(profileId, { hasSavedPassword: await credentials.has(profileId) }));
  });
  manager.on('pushesDefaultRoute', (profileId) => {
    if (profiles.get(profileId) && !profiles.get(profileId)!.pushesDefaultRoute) void profiles.update(profileId, { pushesDefaultRoute: true });
  });
  // DNS is applied by the app once the tunnel is up, and restored whenever its process ends.
  manager.on('connected', (c) => {
    const p = profiles.get(c.profileId);
    if (!p) return;
    void dns
      .setDns({
        connectionId: c.id,
        label: p.name,
        mode: p.dnsMode,
        customServers: p.dnsServers,
        pushed: c.pushedDns,
        ownsDefaultRoute: !!c.ownsDefaultRoute,
        interfaceName: c.interfaceName,
      })
      .then((state) => {
        if (manager.get(c.id)?.status !== 'CONNECTED') return void dns.restore(c.id); // went down meanwhile
        manager.setDnsState(c.id, state);
        if (state.warning) manager.appendLog(c.id, 'warn', state.warning);
        else if (state.applied) manager.appendLog(c.id, 'info', `DNS ${state.scope}: ${state.servers.join(', ')}${state.domains.length ? ` for ${state.domains.join(', ')}` : ''}`);
      });
  });
  manager.on('ended', (c) => {
    void dns.restore(c.id).catch((err) => manager.appendLog(c.id, 'error', `DNS restore failed: ${err.message}`));
  });

  // openvpn removes its own routes on a graceful stop; after a crash, remove what it left behind.
  manager.on('ended', (c, graceful) => {
    if (graceful) return;
    routes
      .cleanupAfterCrash(c, manager.list())
      .then((removed) => removed.length && console.warn(`Removed ${removed.length} stale route(s) of crashed connection ${c.id}`))
      .catch((err) => console.error('Route cleanup failed (needs the privileged helper):', err.message));
  });
  manager.on('connected', (c) => {
    if (profiles.get(c.profileId)) void profiles.update(c.profileId, { lastConnectedAt: Date.now() });
  });
  profiles.on('changed', (list) => send(EVENTS.profilesChanged, list));
  settings.on('changed', (s) => send(EVENTS.settingsChanged, s));

  // Never leave openvpn processes running when the app exits. (Quit dialog + tray: Phase 9.)
  app.on('before-quit', (event) => {
    if (quitting || manager.activeCount() === 0) return;
    event.preventDefault();
    quitting = true;
    void manager.disconnectAll().finally(() => app.quit());
  });

  mainWindow = createWindow();
  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow();
  });
}

app.on('window-all-closed', () => app.quit());

// One instance only: two instances would share (and clean up) each other's openvpn processes.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app
  .whenReady()
  .then(bootstrap)
  .catch((err) => {
    console.error('Fatal startup error', err);
    app.exit(1);
  });
