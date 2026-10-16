import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { IdSchema, ProfilePatchSchema } from '../../shared/schemas';
import type { AppContext } from '../context';
import { handle } from './handle';

export function registerProfileIpc(ctx: AppContext): void {
  const { profiles, manager } = ctx;

  handle(IPC.profilesList, z.tuple([]), () => profiles.list());
  handle(IPC.profilesUpdate, z.tuple([IdSchema, ProfilePatchSchema]), (id, patch) => profiles.update(id, patch));
  handle(IPC.profilesDuplicate, z.tuple([IdSchema]), (id) => profiles.duplicate(id));
  handle(IPC.profilesRemove, z.tuple([IdSchema]), async (id) => {
    await manager.removeProfile(id); // never leave an openvpn process behind for a deleted profile
    await profiles.remove(id);
  });
}
