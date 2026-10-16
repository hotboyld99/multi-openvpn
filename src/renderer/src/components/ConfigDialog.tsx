import { useEffect, useState } from 'react';
import { FileCode } from 'lucide-react';
import type { ProfileScan } from '../../../shared/types';
import { Button } from './ui';
import { Findings } from './Findings';
import { closeConfig, openConfig, run, toast, useStore } from '../store';

/** View or edit a profile's config. Saving re-scans it; risky changes need confirmation. */
export function ConfigDialog() {
  const editor = useStore((s) => s.configEditor);
  const profiles = useStore((s) => s.profiles);
  const profile = profiles.find((p) => p.id === editor?.profileId);
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [scan, setScan] = useState<ProfileScan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOriginal(null);
    setScan(null);
    if (!editor) return;
    void run(() => window.vpn.profiles.readConfig(editor.profileId)).then((t) => {
      if (t === undefined) return closeConfig();
      setOriginal(t);
      setText(t);
    });
  }, [editor?.profileId]);

  if (!editor || !profile) return null;
  const dirty = original !== null && text !== original;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const check = await run(() => window.vpn.profiles.checkConfig(profile.id, text));
      if (!check) return;
      // First save attempt of a risky config only shows the findings; the second confirms.
      const confirmRisk = check.dangerous && scan?.dangerous === true;
      setScan(check);
      if (check.errors.length || (check.dangerous && !confirmRisk)) return;
      const saved = await run(() => window.vpn.profiles.writeConfig(profile.id, text, confirmRisk));
      if (saved) {
        toast('Configuration saved. It applies the next time this VPN connects.', 'info');
        closeConfig();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6">
      <div className="flex h-full max-h-[760px] w-[760px] flex-col rounded-lg border border-border bg-surface shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <FileCode className="h-4 w-4 text-accent" />
          <span className="font-semibold">{profile.name}</span>
          <span className="text-xs text-muted">{editor.edit ? 'Edit config' : 'View config'}</span>
        </div>
        <textarea
          className="selectable min-h-0 flex-1 resize-none bg-surface-2 p-4 font-mono text-xs leading-5 outline-none"
          value={original === null ? 'Loading…' : text}
          readOnly={!editor.edit || original === null}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setScan(null);
          }}
        />
        {scan && (
          <div className="max-h-48 overflow-auto border-t border-border px-5 py-3">
            <Findings scan={scan} />
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={closeConfig}>{editor.edit ? 'Cancel' : 'Close'}</Button>
          {editor.edit ? (
            <Button variant={scan?.dangerous ? 'danger' : 'primary'} disabled={busy || !dirty} onClick={save}>
              {scan?.dangerous && !scan.errors.length ? 'Save Anyway' : 'Save'}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => openConfig(profile.id, true)}>
              Edit
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
