import { useEffect, useState } from 'react';
import { FileUp } from 'lucide-react';
import { Button, Input, Pill } from './ui';
import { Findings } from './Findings';
import { closeImport, run, toast, useStore } from '../store';

interface Choice {
  include: boolean;
  name: string;
  trust: boolean;
}

/** Preview of the files to import, with the security scan of each; nothing is written before "Import". */
export function ImportDialog() {
  const previews = useStore((s) => s.importPreviews);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setChoices((previews ?? []).map((p) => ({ include: p.scan.errors.length === 0, name: p.suggestedName, trust: false })));
  }, [previews]);

  if (!previews) return null;

  const update = (i: number, patch: Partial<Choice>): void => setChoices((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const selected = previews.map((p, i) => ({ p, c: choices[i] })).filter(({ p, c }) => c?.include && p.scan.errors.length === 0);
  const blocked = selected.some(({ p, c }) => p.scan.dangerous && !c.trust);
  const anyDangerous = selected.some(({ p }) => p.scan.dangerous);

  const submit = async (): Promise<void> => {
    setBusy(true);
    const res = await run(() =>
      window.vpn.profiles.import(selected.map(({ p, c }) => ({ path: p.path, name: c.name, acceptDangerous: c.trust }))),
    );
    setBusy(false);
    if (!res) return;
    res.failures.forEach((f) => toast(f));
    if (res.imported.length) toast(`Imported ${res.imported.length} profile${res.imported.length === 1 ? '' : 's'}`, 'info');
    closeImport();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6">
      <div className="flex max-h-full w-[640px] flex-col rounded-lg border border-border bg-surface shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3 font-semibold">
          <FileUp className="h-4 w-4 text-accent" /> Import profiles
        </div>
        <div className="flex flex-col gap-3 overflow-auto p-5">
          {previews.map((p, i) => {
            const c = choices[i];
            if (!c) return null;
            const invalid = p.scan.errors.length > 0;
            return (
              <div key={p.path} className="rounded-md border border-border p-3">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent)]"
                    disabled={invalid}
                    checked={c.include}
                    onChange={(e) => update(i, { include: e.target.checked })}
                    aria-label={`Import ${p.fileName}`}
                  />
                  <Input className="h-7 flex-1" value={c.name} disabled={invalid} onChange={(e) => update(i, { name: e.target.value })} aria-label="Profile name" />
                  <Pill>{p.fileName}</Pill>
                </div>
                {p.scan.remotes.length > 0 && <div className="mt-2 font-mono text-[11px] text-muted">remote {p.scan.remotes.join(' · ')}</div>}
                <div className="mt-2">
                  <Findings scan={p.scan} />
                </div>
                {p.scan.dangerous && c.include && (
                  <label className="mt-2 flex items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400">
                    <input type="checkbox" className="h-4 w-4" checked={c.trust} onChange={(e) => update(i, { trust: e.target.checked })} />
                    I trust this configuration and allow it to run local commands
                  </label>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={closeImport}>Cancel</Button>
          <Button variant={anyDangerous ? 'danger' : 'primary'} disabled={busy || selected.length === 0 || blocked} onClick={submit}>
            {anyDangerous ? 'Import Anyway' : 'Import'}
            {selected.length > 0 && ` (${selected.length})`}
          </Button>
        </div>
      </div>
    </div>
  );
}
