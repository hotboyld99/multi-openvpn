import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';

let trusted: (url: string) => boolean = () => false;

/** Only frames loaded from these origins may call IPC (blocks injected/navigated content). */
export function setTrustedOrigin(check: (url: string) => boolean): void {
  trusted = check;
}

/**
 * Registers an invoke handler whose arguments are parsed by a zod tuple first.
 * Invalid input is rejected before any handler code runs.
 */
export function handle<A extends z.ZodTuple, R>(
  channel: string,
  args: A,
  fn: (...parsed: z.infer<A>) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
    const url = event.senderFrame?.url ?? '';
    if (!trusted(url)) throw new Error(`IPC ${channel} rejected: untrusted sender`);
    const parsed = args.safeParse(raw);
    if (!parsed.success) throw new Error(`IPC ${channel}: invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    return fn(...(parsed.data as z.infer<A>));
  });
}
