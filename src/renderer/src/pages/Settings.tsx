import { useEffect, useState, type ReactNode } from 'react';
import { FolderOpen, Monitor, Moon, ScanSearch, Sun } from 'lucide-react';
import type { OpenVpnBinaryInfo, ThemeSetting } from '../../../shared/types';
import { Button, Card, PageHeader, Pill } from '../components/ui';
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

function OpenVpnBinary({ custom, mock }: { custom: string | null; mock: boolean }) {
  const current = useStore((s) => s.appInfo?.openvpn ?? null);
  const [candidates, setCandidates] = useState<OpenVpnBinaryInfo[] | null>(null);

  useEffect(() => {
    void run(() => window.vpn.openvpn.detect()).then((r) => r && setCandidates(r.candidates));
  }, [custom]);

  const use = (path: string | null): Promise<unknown> => run(() => window.vpn.settings.update({ openvpnPath: path }));

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-center gap-2">
        <Button size="sm" variant={custom ? 'secondary' : 'primary'} onClick={() => use(null)}>
          <ScanSearch className="h-3.5 w-3.5" /> Auto detect
        </Button>
        <Button size="sm" onClick={() => run(() => window.vpn.openvpn.browse())}>
          <FolderOpen className="h-3.5 w-3.5" /> Browse…
        </Button>
        {mock && <span className="text-muted">Mock mode does not run OpenVPN.</span>}
      </div>

      <div className="selectable rounded-md bg-surface-2 p-3">
        <div className="mb-1 text-muted">In use{custom ? ' (custom)' : ' (auto detected)'}</div>
        {current && !mock ? (
          <div className="font-mono">
            {current.path} <span className="text-muted">· {current.version}</span>
          </div>
        ) : custom ? (
          <div className="text-red-600 dark:text-red-400">{custom} is not a valid OpenVPN binary.</div>
        ) : (
          <div className="text-red-600 dark:text-red-400">{mock ? 'mock' : 'No OpenVPN binary found. Install OpenVPN or choose the binary.'}</div>
        )}
      </div>

      <div>
        <div className="mb-1 text-muted">Detected</div>
        {candidates === null ? (
          <div className="text-muted">Scanning…</div>
        ) : candidates.length === 0 ? (
          <div className="text-muted">None</div>
        ) : (
          <div className="flex flex-col gap-1">
            {candidates.map((c) => (
              <div key={c.path} className="flex items-center justify-between gap-2">
                <span className="selectable font-mono">
                  {c.path} <span className="text-muted">· {c.version}</span> <Pill>{c.source}</Pill>
                </span>
                {custom !== c.path && (
                  <Button size="sm" variant="ghost" onClick={() => use(c.path)}>
                    Use
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
          <OpenVpnBinary custom={settings.openvpnPath} mock={appInfo.mockMode} />
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
