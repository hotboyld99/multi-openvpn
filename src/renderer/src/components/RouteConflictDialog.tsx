import { useEffect, useState } from 'react';
import { Route } from 'lucide-react';
import { Button } from './ui';
import { cn } from '../lib/format';
import { connectProfile, dismissConflict, openProfileSettings, run, useStore } from '../store';

type Choice = 'replace' | 'keep' | 'ignore' | 'custom';

const OPTIONS: { value: Choice; label: string; hint: string }[] = [
  { value: 'replace', label: 'Replace current default VPN', hint: 'The current VPN reconnects without the default route; this one takes it.' },
  { value: 'keep', label: 'Keep current default VPN', hint: 'Connect this VPN now without changing the default route.' },
  { value: 'ignore', label: 'Ignore redirect-gateway for this connection', hint: 'Always connect this profile without taking the default route.' },
  { value: 'custom', label: 'Configure custom routes', hint: 'Choose exactly which networks go through this VPN.' },
];

/** Shown when a VPN wants the default route that another active VPN already owns. Nothing changes until the user picks. */
export function RouteConflictDialog() {
  const conflict = useStore((s) => s.routeConflicts[0]);
  const profiles = useStore((s) => s.profiles);
  const [choice, setChoice] = useState<Choice>('keep');
  useEffect(() => setChoice('keep'), [conflict?.profileId]);
  if (!conflict) return null;

  const name = (id: string): string => profiles.find((p) => p.id === id)?.name ?? 'Unknown VPN';

  const apply = async (): Promise<void> => {
    const id = conflict.profileId;
    dismissConflict();
    if (choice === 'replace') await connectProfile(id, { defaultRoute: 'take', replaceDefault: true });
    else if (choice === 'keep') await connectProfile(id, { defaultRoute: 'skip' });
    else if (choice === 'ignore') {
      await run(() => window.vpn.profiles.update(id, { ignoreRedirectGateway: true }));
      await connectProfile(id);
    } else openProfileSettings(id);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-[460px] rounded-lg border border-border bg-surface p-5 shadow-xl">
        <div className="flex items-center gap-2 font-semibold">
          <Route className="h-4 w-4 text-amber-500" /> Route Conflict
        </div>
        <p className="mt-3">
          VPN <span className="font-semibold">“{name(conflict.profileId)}”</span> wants to change the system default route.
        </p>
        <p className="mt-2 text-xs text-muted">Current default VPN</p>
        <p className="font-medium">{name(conflict.holderProfileId)}</p>

        <p className="mt-4 mb-2 text-xs text-muted">Choose routing mode</p>
        <div className="flex flex-col gap-1.5">
          {OPTIONS.map((o) => (
            <label
              key={o.value}
              className={cn('flex cursor-pointer gap-2 rounded-md border p-2.5', choice === o.value ? 'border-accent bg-accent/5' : 'border-border')}
            >
              <input type="radio" name="route-choice" className="mt-0.5 accent-[var(--accent)]" checked={choice === o.value} onChange={() => setChoice(o.value)} />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-xs text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={dismissConflict}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            {choice === 'custom' ? 'Open Routing Settings' : 'Connect'}
          </Button>
        </div>
      </div>
    </div>
  );
}
