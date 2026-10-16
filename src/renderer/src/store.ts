import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppInfo, AppSettings, ImportPreview, LogEntry, VpnConnection, VpnProfile } from '../../shared/types';

// Central renderer state. Connections are keyed by connectionId — there is no global "connected" flag.

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  message: string;
}

export type Page = 'dashboard' | 'profiles' | 'connections' | 'routes' | 'interfaces' | 'logs' | 'settings';

export interface State {
  ready: boolean;
  page: Page;
  /** Connection preselected on the Logs page. */
  logsFor: string | null;
  appInfo: AppInfo | null;
  settings: AppSettings | null;
  profiles: VpnProfile[];
  connections: Record<string, VpnConnection>;
  logs: Record<string, LogEntry[]>;
  toasts: Toast[];
  /** Files waiting for import confirmation. */
  importPreviews: ImportPreview[] | null;
  /** Profile whose config is open in the viewer/editor. */
  configEditor: { profileId: string; edit: boolean } | null;
}

const MAX_LOGS_PER_CONNECTION = 2_000;

let state: State = {
  ready: false,
  page: 'dashboard',
  logsFor: null,
  appInfo: null,
  settings: null,
  profiles: [],
  connections: {},
  logs: {},
  toasts: [],
  importPreviews: null,
  configEditor: null,
};
const listeners = new Set<() => void>();

function set(updater: (s: State) => Partial<State>): void {
  state = { ...state, ...updater(state) };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Selectors must return a value already in state (stable reference); derive lists with useMemo. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function navigate(page: Page, logsFor?: string): void {
  set((s) => ({ page, logsFor: logsFor ?? s.logsFor }));
}

/** Scans the given files and opens the import dialog. */
export async function startImport(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const previews = await run(() => window.vpn.profiles.previewImport(paths));
  if (previews) set(() => ({ importPreviews: previews, page: 'profiles' }));
}

export const closeImport = (): void => set(() => ({ importPreviews: null }));

export function openConfig(profileId: string, edit: boolean): void {
  set(() => ({ configEditor: { profileId, edit } }));
}

export const closeConfig = (): void => set(() => ({ configEditor: null }));

let toastSeq = 0;
export function toast(message: string, kind: Toast['kind'] = 'error'): void {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5_000);
}

/** Runs an IPC action and turns a rejection into a toast instead of an unhandled promise. */
export async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (err) {
    toast((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

let started = false;
export async function initStore(): Promise<void> {
  if (started) return;
  started = true;
  const api = window.vpn;

  // Subscribe first so nothing that happens during the initial fetch is lost.
  api.onConnection((c) => set((s) => ({ connections: { ...s.connections, [c.id]: c } })));
  api.onConnectionRemoved((id) =>
    set((s) => {
      const { [id]: _c, ...connections } = s.connections;
      const { [id]: _l, ...logs } = s.logs;
      return { connections, logs };
    }),
  );
  api.onLog(({ connectionId, entry }) =>
    set((s) => {
      const prev = s.logs[connectionId] ?? [];
      const next = prev.length >= MAX_LOGS_PER_CONNECTION ? [...prev.slice(-MAX_LOGS_PER_CONNECTION + 1), entry] : [...prev, entry];
      return { logs: { ...s.logs, [connectionId]: next } };
    }),
  );
  api.profiles.onChanged((profiles) => set(() => ({ profiles })));
  api.settings.onChanged((settings) => set(() => ({ settings })));
  api.onAppInfo((appInfo) => set(() => ({ appInfo })));

  const [appInfo, settings, profiles, connections] = await Promise.all([
    api.getAppInfo(),
    api.settings.get(),
    api.profiles.list(),
    api.getConnections(),
  ]);
  const logPairs = await Promise.all(connections.map(async (c) => [c.id, await api.getLogs(c.id)] as const));

  set((s) => ({
    ready: true,
    appInfo,
    settings,
    profiles,
    connections: { ...Object.fromEntries(connections.map((c) => [c.id, c])), ...s.connections },
    logs: { ...Object.fromEntries(logPairs), ...s.logs },
  }));
}

export function clearLogsLocal(connectionId: string): void {
  set((s) => ({ logs: { ...s.logs, [connectionId]: [] } }));
}

/** The (single) connection record of a profile, if any. */
export function connectionOf(connections: Record<string, VpnConnection>, profileId: string): VpnConnection | undefined {
  for (const c of Object.values(connections)) if (c.profileId === profileId) return c;
  return undefined;
}

/** Re-renders every `ms` so durations and countdowns tick. */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
