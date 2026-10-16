import { app, dialog, Menu, nativeImage, powerMonitor, Tray, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { EVENTS } from '../shared/ipc';
import type { AppSettings } from '../shared/types';
import type { ProfileStore } from './store/ProfileStore';
import { trayMenuTemplate, trayTooltip } from './trayMenu';
import { RouteConflictError, type VpnManager } from './vpn/VpnManager';

export interface ShellDeps {
  manager: VpnManager;
  profiles: ProfileStore;
  createWindow(): BrowserWindow;
}

/**
 * Window, tray and quit behaviour. VPNs may keep running with the window closed; quitting with
 * active VPNs always asks first, and a real quit disconnects everything gracefully.
 */
export class AppShell {
  private win: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;
  private asking = false;
  private rebuildTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: ShellDeps) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** Launched at login: start in the tray without showing the window. */
  static startHidden(): boolean {
    return process.argv.includes('--hidden') || (app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin);
  }

  start(showWindow: boolean): void {
    this.createTray();
    if (showWindow) this.show();
    const rebuild = (): void => {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => this.updateTray(), 150);
    };
    this.deps.manager.on('connection', rebuild);
    this.deps.manager.on('removed', rebuild);
    this.deps.profiles.on('changed', rebuild);

    app.on('before-quit', (e) => {
      if (this.quitting) return;
      if (this.deps.manager.activeCount() === 0) {
        this.quitting = true;
        return;
      }
      e.preventDefault();
      void this.askQuit();
    });
    // OS shutdown/logout: no dialog, just disconnect cleanly (restores routes and DNS).
    // The typings omit the event argument, but per the docs preventDefault() delays shutdown.
    const onShutdown = (e: Electron.Event): void => {
      if (this.deps.manager.activeCount() === 0) return;
      e.preventDefault();
      void this.quitNow();
    };
    powerMonitor.on('shutdown', onShutdown as unknown as () => void);
    app.on('activate', () => this.show());
  }

  /** Shows (or recreates) the main window, optionally on a page. */
  show(page?: string): void {
    let win = this.window;
    if (!win) {
      win = this.deps.createWindow();
      this.attach(win);
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (page) {
      const target = win;
      const go = (): void => target.webContents.send(EVENTS.navigate, page);
      if (target.webContents.isLoading()) target.webContents.once('did-finish-load', go);
      else go();
    }
  }

  send(channel: string, ...args: unknown[]): void {
    this.window?.webContents.send(channel, ...args);
  }

  /** Applies "Start app when operating system starts". Only for the packaged app. */
  applyLoginItem(settings: AppSettings): void {
    if (!app.isPackaged) return;
    // Only touch the OS setting when it differs (macOS refuses changes from unsigned builds).
    if (app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin === settings.launchAtLogin) return;
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--hidden'] });
  }

  private attach(win: BrowserWindow): void {
    this.win = win;
    win.on('close', (e) => {
      if (this.quitting) return;
      if (this.deps.manager.activeCount() === 0) return; // nothing running: closing quits (window-all-closed)
      e.preventDefault();
      void this.askQuit();
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
  }

  private async askQuit(): Promise<void> {
    if (this.asking) return;
    this.asking = true;
    try {
      const n = this.deps.manager.activeCount();
      const opts = {
        type: 'question' as const,
        message: `${n} VPN connection${n === 1 ? ' is' : 's are'} currently active.`,
        detail: 'What would you like to do?',
        buttons: ['Disconnect All && Quit', 'Keep Running in Background', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      };
      const win = this.window;
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (response === 0) await this.quitNow();
      else if (response === 1) this.window?.hide();
    } finally {
      this.asking = false;
    }
  }

  private async quitNow(): Promise<void> {
    this.quitting = true;
    await this.deps.manager.disconnectAll().catch(() => undefined);
    app.quit();
  }

  private trayImage(active: boolean): Electron.NativeImage {
    const dir = app.isPackaged ? join(process.resourcesPath, 'tray') : join(app.getAppPath(), 'resources', 'tray');
    if (process.platform === 'darwin') {
      const img = nativeImage.createFromPath(join(dir, active ? 'trayActiveTemplate.png' : 'trayTemplate.png'));
      img.setTemplateImage(true); // adapts to light/dark menu bar
      return img;
    }
    return nativeImage.createFromPath(join(dir, active ? 'tray-win-active.png' : 'tray-win.png'));
  }

  private createTray(): void {
    this.tray = new Tray(this.trayImage(false));
    if (process.platform !== 'darwin') this.tray.on('click', () => this.show());
    this.updateTray();
  }

  private updateTray(): void {
    if (!this.tray) return;
    const { manager, profiles } = this.deps;
    const conns = manager.list();
    this.tray.setImage(this.trayImage(conns.some((c) => c.status === 'CONNECTED')));
    this.tray.setToolTip(trayTooltip(conns));
    this.tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenuTemplate(profiles.list(), conns, {
          open: () => this.show(),
          openDashboard: () => this.show('dashboard'),
          disconnectAll: () => void manager.disconnectAll(),
          quit: () => app.quit(),
          toggle: (profileId, connectionId) => {
            if (connectionId) return void manager.disconnect(connectionId);
            try {
              manager.connect(profileId);
            } catch (err) {
              if (!(err instanceof RouteConflictError)) return;
              // The choice belongs to the user: open the app with the Route Conflict dialog.
              this.show();
              this.send(EVENTS.routeConflict, { profileId, holderConnectionId: err.holderConnectionId, holderProfileId: err.holderProfileId });
            }
          },
        }),
      ),
    );
  }
}
