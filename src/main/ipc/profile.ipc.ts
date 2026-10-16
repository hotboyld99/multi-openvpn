import { dialog } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { ConfigTextSchema, IdSchema, ImportRequestListSchema, PathListSchema, ProfilePatchSchema } from '../../shared/schemas';
import type { VpnProfile } from '../../shared/types';
import type { AppContext } from '../context';
import { buildPortableConfig, importProfile, isDemoProfile, prepareEditedConfig, previewImport } from '../store/ProfileImporter';
import { handle } from './handle';

export function registerProfileIpc(ctx: AppContext): void {
  const { profiles, manager } = ctx;

  const withConfig = (id: string): VpnProfile => {
    const p = profiles.get(id);
    if (!p) throw new Error(`Profile ${id} not found`);
    if (isDemoProfile(p)) throw new Error('Demo profiles have no configuration file');
    return p;
  };

  handle(IPC.profilesList, z.tuple([]), () => profiles.list());
  handle(IPC.profilesUpdate, z.tuple([IdSchema, ProfilePatchSchema]), (id, patch) => profiles.update(id, patch));
  handle(IPC.profilesDuplicate, z.tuple([IdSchema]), (id) => profiles.duplicate(id));
  handle(IPC.profilesRemove, z.tuple([IdSchema]), async (id) => {
    await manager.removeProfile(id); // never leave an openvpn process behind for a deleted profile
    await profiles.remove(id);
  });

  handle(IPC.profilesPickFiles, z.tuple([]), async () => {
    const win = ctx.window();
    const options: Electron.OpenDialogOptions = {
      title: 'Import OpenVPN profiles',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'OpenVPN configuration', extensions: ['ovpn', 'conf'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return res.canceled ? [] : res.filePaths;
  });

  handle(IPC.profilesPreviewImport, z.tuple([PathListSchema]), (paths) => Promise.all(paths.map(previewImport)));

  handle(IPC.profilesImport, z.tuple([ImportRequestListSchema]), async (requests) => {
    const imported: VpnProfile[] = [];
    const failures: string[] = [];
    for (const req of requests) {
      try {
        imported.push(await profiles.add(await importProfile(req, profiles.profilesDir)));
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    return { imported, failures };
  });

  handle(IPC.profilesReadConfig, z.tuple([IdSchema]), async (id) => readFile(withConfig(id).configPath, 'utf8'));

  handle(IPC.profilesCheckConfig, z.tuple([IdSchema, ConfigTextSchema]), async (id, text) => {
    return (await prepareEditedConfig(text, dirname(withConfig(id).configPath))).scan;
  });

  handle(IPC.profilesWriteConfig, z.tuple([IdSchema, ConfigTextSchema, z.boolean()]), async (id, text, acceptDangerous) => {
    const p = withConfig(id);
    const prepared = await prepareEditedConfig(text, dirname(p.configPath));
    if (prepared.scan.errors.length) throw new Error(prepared.scan.errors.join('\n'));
    if (prepared.scan.dangerous && !acceptDangerous) throw new Error('This configuration can execute local commands; confirmation required');
    await writeFile(p.configPath, prepared.text, { mode: 0o600 });
    await profiles.update(id, { wantsDefaultRoute: prepared.wantsDefaultRoute }); // also bumps updatedAt
    return prepared.scan;
  });

  handle(IPC.profilesExport, z.tuple([IdSchema]), async (id) => {
    const p = withConfig(id);
    const win = ctx.window();
    const options = {
      defaultPath: `${p.name.replace(/[^\w.-]+/g, '_')}.ovpn`,
      filters: [{ name: 'OpenVPN configuration', extensions: ['ovpn'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return false;
    await writeFile(res.filePath, await buildPortableConfig(p.configPath), { mode: 0o600 });
    return true;
  });
}
