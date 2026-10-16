import { useEffect, useState, type ComponentType, type DragEvent } from 'react';
import { FileUp, X } from 'lucide-react';
import { AuthDialog } from './components/AuthDialog';
import { ConfigDialog } from './components/ConfigDialog';
import { ImportDialog } from './components/ImportDialog';
import { ProfileSettingsDialog } from './components/ProfileSettingsDialog';
import { RouteConflictDialog } from './components/RouteConflictDialog';
import { Sidebar } from './components/Sidebar';
import { cn } from './lib/format';
import { Connections } from './pages/Connections';
import { Dashboard } from './pages/Dashboard';
import { Interfaces } from './pages/Interfaces';
import { Logs } from './pages/Logs';
import { Profiles } from './pages/Profiles';
import { Routes } from './pages/Routes';
import { Settings } from './pages/Settings';
import { initStore, startImport, useStore, type Page } from './store';

const PAGES: Record<Page, ComponentType> = {
  dashboard: Dashboard,
  profiles: Profiles,
  connections: Connections,
  routes: Routes,
  interfaces: Interfaces,
  logs: Logs,
  settings: Settings,
};

function useTheme(): void {
  const theme = useStore((s) => s.settings?.theme ?? 'system');
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches));
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'flex items-start gap-2 rounded-md border bg-surface p-3 text-xs shadow-lg',
            t.kind === 'error' ? 'border-red-500/40' : 'border-border',
          )}
        >
          <span className="selectable flex-1">{t.message}</span>
          <X className="h-3.5 w-3.5 text-muted" />
        </div>
      ))}
    </div>
  );
}

export function App() {
  const ready = useStore((s) => s.ready);
  const page = useStore((s) => s.page);
  useTheme();

  useEffect(() => {
    void initStore();
  }, []);

  // Drop .ovpn/.conf files anywhere on the window to import them.
  const [dragging, setDragging] = useState(false);
  const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files');
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    const paths = [...e.dataTransfer.files].map((f) => window.vpn.profiles.pathForFile(f)).filter(Boolean);
    void startImport(paths);
  };

  const Current = PAGES[page];
  return (
    <div
      className="flex h-full"
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-auto">{ready ? <Current /> : <div className="p-6 text-muted">Loading…</div>}</main>
      <ImportDialog />
      <ConfigDialog />
      <ProfileSettingsDialog />
      <RouteConflictDialog />
      <AuthDialog />
      <Toasts />
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-50 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent bg-accent/10 text-accent">
          <FileUp className="h-8 w-8" />
          <div className="font-medium">Drop .ovpn or .conf files to import</div>
        </div>
      )}
    </div>
  );
}
