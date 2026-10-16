import { useEffect, type ComponentType } from 'react';
import { X } from 'lucide-react';
import { AuthDialog } from './components/AuthDialog';
import { Sidebar } from './components/Sidebar';
import { cn } from './lib/format';
import { Connections } from './pages/Connections';
import { Dashboard } from './pages/Dashboard';
import { Interfaces } from './pages/Interfaces';
import { Logs } from './pages/Logs';
import { Profiles } from './pages/Profiles';
import { Routes } from './pages/Routes';
import { Settings } from './pages/Settings';
import { initStore, useStore, type Page } from './store';

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

  const Current = PAGES[page];
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-auto">{ready ? <Current /> : <div className="p-6 text-muted">Loading…</div>}</main>
      <AuthDialog />
      <Toasts />
    </div>
  );
}
