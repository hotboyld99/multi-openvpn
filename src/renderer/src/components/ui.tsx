import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn, STATUS, type Tone } from '../lib/format';
import type { VpnStatus } from '../../../shared/types';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-foreground hover:brightness-110',
  secondary: 'bg-surface-2 text-foreground border border-border hover:bg-border/60',
  ghost: 'text-muted hover:text-foreground hover:bg-surface-2',
  danger: 'bg-red-600 text-white hover:bg-red-500',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'icon' }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'icon' && 'h-7 w-7',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] outline-none placeholder:text-muted focus:border-accent',
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg border border-border bg-surface', className)}>{children}</div>;
}

const DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  busy: 'bg-amber-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-zinc-400 dark:bg-zinc-600',
};
const TEXT: Record<Tone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  busy: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
  idle: 'text-muted',
};

export function StatusBadge({ status }: { status: VpnStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', TEXT[tone])}>
      {tone === 'busy' ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <span className={cn('h-2 w-2 rounded-full', DOT[tone])} />}
      {label}
    </span>
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded border border-border bg-surface-2 px-1.5 py-px text-[11px] text-muted', className)}>
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="drag flex items-end justify-between gap-4 px-6 pt-6 pb-4">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="no-drag flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-14 text-center">
      <div className="text-muted">{icon}</div>
      <div className="font-medium">{title}</div>
      {children && <div className="max-w-md text-muted">{children}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-border')}
    >
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-4.5' : 'left-0.5')} />
    </button>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
}

/** Small dropdown menu; closes on outside click or Escape. */
export function Menu({ trigger, items }: { trigger: ReactNode; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className="absolute right-0 z-20 mt-1 min-w-48 rounded-md border border-border bg-surface p-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-surface-2',
                item.danger && 'text-red-600 dark:text-red-400',
              )}
            >
              <span className="flex w-4 justify-center text-muted">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.checked !== undefined && <span className="text-xs text-muted">{item.checked ? 'On' : 'Off'}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
