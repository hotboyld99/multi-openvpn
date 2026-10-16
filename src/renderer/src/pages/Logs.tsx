import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Download, Eraser, ScrollText, Search } from 'lucide-react';
import type { LogEntry, LogLevel } from '../../../shared/types';
import { Button, Card, EmptyState, Input, PageHeader } from '../components/ui';
import { cn, formatTime } from '../lib/format';
import { clearLogsLocal, run, useStore } from '../store';

const EMPTY: LogEntry[] = [];
const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: 'text-muted',
  info: '',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};
const select = 'h-8 rounded-md border border-border bg-surface px-2 text-[13px] outline-none focus:border-accent';

export function Logs() {
  const profiles = useStore((s) => s.profiles);
  const connections = useStore((s) => s.connections);
  const logsFor = useStore((s) => s.logsFor);
  const allLogs = useStore((s) => s.logs);

  const options = useMemo(
    () =>
      Object.values(connections)
        .map((c) => ({ id: c.id, label: profiles.find((p) => p.id === c.profileId)?.name ?? c.id.slice(0, 8) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [connections, profiles],
  );

  const [selected, setSelected] = useState<string | null>(logsFor);
  useEffect(() => setSelected(logsFor), [logsFor]);
  const current = selected && connections[selected] ? selected : (options[0]?.id ?? null);

  const [level, setLevel] = useState<'all' | LogLevel>('all');
  const [query, setQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logs = (current && allLogs[current]) || EMPTY;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((l) => (level === 'all' || l.level === level) && (!q || l.message.toLowerCase().includes(q)));
  }, [logs, level, query]);

  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (autoScroll && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [filtered, autoScroll]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Logs" subtitle="Each VPN connection has its own log stream" />
      {options.length === 0 ? (
        <div className="px-6">
          <EmptyState icon={<ScrollText className="h-8 w-8" />} title="No logs yet">
            Connect a profile to see its OpenVPN log here.
          </EmptyState>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <select className={select} value={current ?? ''} onChange={(e) => setSelected(e.target.value)} aria-label="Profile">
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <select className={select} value={level} onChange={(e) => setLevel(e.target.value as typeof level)} aria-label="Level">
              <option value="all">All levels</option>
              <option value="error">Error</option>
              <option value="warn">Warning</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </select>
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-muted" />
              <Input className="w-full pl-8" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
              Auto scroll
            </label>
            <Button
              disabled={!current}
              onClick={async () => {
                if (!current) return;
                await run(() => window.vpn.clearLogs(current));
                clearLogsLocal(current);
              }}
            >
              <Eraser className="h-4 w-4" /> Clear
            </Button>
            <Button disabled={!current} onClick={() => current && run(() => window.vpn.exportLogs(current))}>
              <Download className="h-4 w-4" /> Export
            </Button>
          </div>
          <Card className="min-h-0 flex-1 overflow-hidden">
            <div ref={scroller} className="selectable h-full overflow-auto p-3 font-mono text-xs leading-5">
              {filtered.length === 0 && <div className="text-muted">No log lines{query || level !== 'all' ? ' match the filter' : ''}.</div>}
              {filtered.map((l) => (
                <div key={l.seq} className={cn('whitespace-pre-wrap break-all', LEVEL_CLASS[l.level])}>
                  <span className="mr-3 text-muted">{formatTime(l.ts)}</span>
                  {l.message}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
