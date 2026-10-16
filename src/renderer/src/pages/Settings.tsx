import type { ReactNode } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeSetting } from '../../../shared/types';
import { Card, PageHeader } from '../components/ui';
import { cn } from '../lib/format';
import { run, useStore } from '../store';

const THEMES: { value: ThemeSetting; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

export function Settings() {
  const settings = useStore((s) => s.settings);
  const appInfo = useStore((s) => s.appInfo);
  if (!settings || !appInfo) return null;

  return (
    <div>
      <PageHeader title="Settings" />
      <div className="flex max-w-2xl flex-col gap-4 px-6 pb-8">
        <Section title="Appearance">
          <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => run(() => window.vpn.settings.update({ theme: value }))}
                className={cn(
                  'flex items-center gap-1.5 rounded px-3 py-1 text-[13px]',
                  settings.theme === value ? 'bg-surface font-medium shadow-sm' : 'text-muted hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="OpenVPN binary">
          {appInfo.openvpn ? (
            <div className="selectable flex flex-col gap-1 text-xs">
              <div>
                <span className="text-muted">Path: </span>
                <span className="font-mono">{appInfo.openvpn.path}</span>
              </div>
              <div>
                <span className="text-muted">Version: </span>
                <span className="font-mono">{appInfo.openvpn.version ?? 'unknown'}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">Not detected. Auto-detection and manual selection arrive in Phase 2.</p>
          )}
        </Section>

        <Section title="About">
          <div className="selectable text-xs text-muted">
            Multi OpenVPN {appInfo.version} · {appInfo.platform}/{appInfo.arch}
            {appInfo.mockMode && ' · mock mode'}
          </div>
        </Section>
      </div>
    </div>
  );
}
