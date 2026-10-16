import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import type { AppContext } from '../context';
import { describeInterfaces } from '../network/InterfaceManager';
import { handle } from './handle';

export function registerNetworkIpc(ctx: AppContext): void {
  handle(IPC.networkGetInterfaces, z.tuple([]), () =>
    describeInterfaces(networkInterfaces(), ctx.manager.list(), { simulateMissing: ctx.mockMode }),
  );
  handle(IPC.networkGetRoutes, z.tuple([]), () => ctx.routes.list(ctx.manager.list()));
}
