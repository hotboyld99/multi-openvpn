import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVENTS } from '../shared/ipc';
import type { AppInfo, OpenVpnBinaryInfo } from '../shared/types';
import type { AppContext } from './context';
import { setTrustedOrigin } from './ipc/handle';
import { registerNetworkIpc } from './ipc/network.ipc';
import { registerProfileIpc } from './ipc/profile.ipc';
import { registerSettingsIpc } from './ipc/settings.ipc';
import { registerVpnIpc } from './ipc/vpn.ipc';
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
  const root = app.getPath('userData');
  const profiles = new ProfileStore(root);
  const settings = new SettingsStore(root);
  await Promise.all([profiles.load(), settings.load()]);
  if (mockMode && profiles.list().length === 0) for (const p of demoProfiles()) await profiles.add(p);

  const binaries = new OpenVpnBinaryManager({
    bundledRoot: app.isPackaged ? join(process.resourcesPath, 'openvpn') : join(app.getAppPath(), 'resources', 'openvpn'),
  });
  let openvpn: OpenVpnBinaryInfo | null = null;

  const processes = new VpnProcessManager(join(app.getPath('temp'), 'multi-openvpn'));
  // If main dies without a graceful disconnect, do not leave orphaned openvpn processes behind.
  process.on('exit', () => processes.killAll());

  const createDriver: DriverFactory = (dctx) =>
    mockMode ? new MockVpnDriver(dctx) : new OpenVpnDriver(dctx, { processes, binary: () => openvpn });
  const manager = new VpnManager({ createDriver, getProfile: (id) => profiles.get(id) });

  const appInfo = (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    mockMode,
    openvpn: mockMode ? { path: 'mock', version: '2.6.x (mock)', source: 'bundled' } : openvpn,
  });

  const send = (channel: string, ...args: unknown[]): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  const refreshBinary = async (): Promise<void> => {
    openvpn = await binaries.resolve(settings.get().openvpnPath);
    send(EVENTS.appInfoChanged, appInfo());
  };
  await refreshBinary();

  const ctx: AppContext = { manager, profiles, settings, mockMode, binaries, refreshBinary, appInfo, window: () => mainWindow };

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

app
  .whenReady()
  .then(bootstrap)
  .catch((err) => {
    console.error('Fatal startup error', err);
    app.exit(1);
  });
