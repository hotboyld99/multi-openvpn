import { dialog } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { SettingsPatchSchema } from '../../shared/schemas';
import type { AppContext } from '../context';
import { handle } from './handle';

export function registerSettingsIpc(ctx: AppContext): void {
  const { settings, binaries } = ctx;

  handle(IPC.settingsGet, z.tuple([]), () => settings.get());
  handle(IPC.settingsUpdate, z.tuple([SettingsPatchSchema]), async (patch) => {
    // A custom binary is executed later (possibly elevated): only accept a verified OpenVPN.
    if (patch.openvpnPath) await binaries.validate(patch.openvpnPath);
    const next = await settings.update(patch);
    if ('openvpnPath' in patch) await ctx.refreshBinary();
    return next;
  });

  handle(IPC.openvpnDetect, z.tuple([]), async () => ({
    current: ctx.appInfo().openvpn,
    candidates: await binaries.detectAll(),
  }));

  handle(IPC.openvpnBrowse, z.tuple([]), async () => {
    const win = ctx.window();
    const options: Electron.OpenDialogOptions = {
      title: 'Select the OpenVPN binary',
      properties: ['openFile', 'treatPackageAsDirectory'],
      filters: process.platform === 'win32' ? [{ name: 'OpenVPN', extensions: ['exe'] }] : [],
    };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const path = res.filePaths[0];
    if (res.canceled || !path) return null;
    const info = await binaries.validate(path);
    await settings.update({ openvpnPath: info.path });
    await ctx.refreshBinary();
    return info;
  });
}
