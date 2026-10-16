import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ProfileScan, SecurityFinding } from '../../../shared/types';
import { cn } from '../lib/format';

const ICON = {
  ok: <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />,
  info: <Info className="h-3.5 w-3.5 text-muted" />,
  warning: <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />,
  danger: <CircleAlert className="h-3.5 w-3.5 text-red-500" />,
} as const;

function Row({ f }: { f: SecurityFinding }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5">{ICON[f.severity]}</span>
      <span>
        <span className={cn(f.severity === 'danger' && 'font-medium text-red-600 dark:text-red-400')}>{f.title}</span>
        {f.detail && <span className="selectable block font-mono text-[11px] text-muted">{f.line ? `line ${f.line}: ` : ''}{f.detail}</span>}
      </span>
    </li>
  );
}

/** Security scan result: errors first, then dangers, then protections and notes. */
export function Findings({ scan }: { scan: ProfileScan }) {
  const order = { danger: 0, warning: 1, ok: 2, info: 3 } as const;
  const sorted = [...scan.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <div className="flex flex-col gap-2 text-xs">
      {scan.errors.length > 0 && (
        <ul className="selectable flex flex-col gap-1 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-red-600 dark:text-red-400">
          {scan.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {scan.dangerous && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-red-600 dark:text-red-400">
          This configuration may execute local commands.
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {sorted.map((f, i) => (
          <Row key={`${f.title}-${i}`} f={f} />
        ))}
      </ul>
    </div>
  );
}
