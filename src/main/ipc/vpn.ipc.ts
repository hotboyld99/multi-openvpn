import { dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { IdListSchema, IdSchema } from '../../shared/schemas';
import type { AppContext } from '../context';
import { handle } from './handle';

export function registerVpnIpc(ctx: AppContext): void {
  const { manager } = ctx;

  handle(IPC.appGetInfo, z.tuple([]), () => ctx.appInfo());

  handle(IPC.vpnConnect, z.tuple([IdSchema]), (profileId) => manager.connect(profileId));
  handle(IPC.vpnConnectMany, z.tuple([IdListSchema]), (ids) => ids.map((id) => manager.connect(id)));
  handle(IPC.vpnDisconnect, z.tuple([IdSchema]), (id) => manager.disconnect(id));
  handle(IPC.vpnReconnect, z.tuple([IdSchema]), (id) => manager.reconnect(id));
  handle(IPC.vpnDisconnectAll, z.tuple([]), () => manager.disconnectAll());
  handle(IPC.vpnGetConnections, z.tuple([]), () => manager.list());
  handle(IPC.vpnGetLogs, z.tuple([IdSchema]), (id) => manager.getLogs(id));
  handle(IPC.vpnClearLogs, z.tuple([IdSchema]), (id) => manager.clearLogs(id));

  handle(IPC.vpnExportLogs, z.tuple([IdSchema]), async (id) => {
    const conn = manager.get(id);
    if (!conn) throw new Error(`Connection ${id} not found`);
    const profile = ctx.profiles.get(conn.profileId);
    const win = ctx.window();
    const options = {
      defaultPath: `${(profile?.name ?? 'vpn').replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`,
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return false;
    const text = manager
      .getLogs(id)
      .map((l) => `${new Date(l.ts).toISOString()} [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    await writeFile(res.filePath, `${text}\n`, 'utf8');
    return true;
  });
}
