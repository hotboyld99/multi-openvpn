import { useEffect, useState } from 'react';
import { Plus, Settings2, X } from 'lucide-react';
import { isLive, type RouteRule, type RoutingMode, type VpnProfile } from '../../../shared/types';
import { Button, Input, Pill } from './ui';
import { cn } from '../lib/format';
import { connectionOf, openProfileSettings, run, toast, useStore } from '../store';

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const ruleType = (v: string): RouteRule['type'] => (v.includes('/') ? 'cidr' : IPV4.test(v) || v.includes(':') ? 'ip' : 'hostname');

function Radio({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint?: string }) {
  return (
    <label className={cn('flex cursor-pointer gap-2 rounded-md border p-2.5', checked ? 'border-accent bg-accent/5' : 'border-border')}>
      <input type="radio" className="mt-0.5 accent-[var(--accent)]" checked={checked} onChange={onChange} />
      <span>
        <span className="block font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Per-profile routing (and, from Phase 7, DNS) settings. Applies on the next connect. */
export function ProfileSettingsDialog() {
  const profileId = useStore((s) => s.profileSettings);
  const profile = useStore((s) => s.profiles.find((p) => p.id === profileId));
  const connections = useStore((s) => s.connections);
  if (!profile) return null;
  const conn = connectionOf(connections, profile.id);
  return <Editor key={profile.id} profile={profile} liveConnectionId={conn && isLive(conn.status) ? conn.id : undefined} />;
}

function Editor({ profile, liveConnectionId }: { profile: VpnProfile; liveConnectionId?: string }) {
  const live = !!liveConnectionId;
  const [mode, setMode] = useState<RoutingMode>(profile.routingMode);
  const [ignoreDefault, setIgnoreDefault] = useState(!!profile.ignoreRedirectGateway);
  const [rules, setRules] = useState<RouteRule[]>(profile.customRoutes ?? []);
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(''), [mode]);

  const add = (): void => {
    const value = draft.trim();
    if (!value || rules.some((r) => r.value === value)) return;
    setRules([...rules, { id: crypto.randomUUID(), type: ruleType(value), value }]);
    setDraft('');
  };

  const save = async (reconnect: boolean): Promise<void> => {
    const saved = await run(() =>
      window.vpn.profiles.update(profile.id, { routingMode: mode, customRoutes: rules, ignoreRedirectGateway: ignoreDefault }),
    );
    if (!saved) return;
    openProfileSettings(null);
    if (reconnect && liveConnectionId) await run(() => window.vpn.reconnect(liveConnectionId));
    else if (live) toast('Saved. Routing changes apply the next time this VPN connects.', 'info');
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-full w-[520px] flex-col rounded-lg border border-border bg-surface shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3 font-semibold">
          <Settings2 className="h-4 w-4 text-accent" /> {profile.name} — Routing
        </div>
        <div className="flex flex-col gap-2 overflow-auto p-5">
          <Radio checked={mode === 'config'} onChange={() => setMode('config')} label="Use routes from OpenVPN configuration" />
          {mode === 'config' && (
            <label className="ml-6 flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={ignoreDefault} onChange={(e) => setIgnoreDefault(e.target.checked)} />
              <span>
                Never take the default route (ignore redirect-gateway)
                {(profile.wantsDefaultRoute || profile.pushesDefaultRoute) && (
                  <span className="block text-muted">
                    This VPN {profile.wantsDefaultRoute ? 'is configured' : 'has been told by its server'} to route all traffic.
                  </span>
                )}
              </span>
            </label>
          )}
          <Radio
            checked={mode === 'custom'}
            onChange={() => setMode('custom')}
            label="Custom routing (split tunnel)"
            hint="Only the networks below go through this VPN; routes and redirect-gateway from the server are ignored."
          />
          {mode === 'custom' && (
            <div className="ml-6 flex flex-col gap-2">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <Input className="flex-1 font-mono" placeholder="10.20.0.0/16, 192.168.1.100 or internal.company.com" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <Button type="submit" disabled={!draft.trim()}>
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </form>
              {rules.length === 0 && <div className="text-xs text-muted">No routes yet: nothing would go through this VPN.</div>}
              {rules.map((r) => (
                <div key={r.id} className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
                  <span className="selectable flex-1 font-mono text-xs">{r.value}</span>
                  <span className="text-xs text-muted">→ this VPN</span>
                  <Pill>{r.type}</Pill>
                  <Button size="icon" variant="ghost" aria-label={`Remove ${r.value}`} onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {rules.some((r) => r.type === 'hostname') && (
                <p className="text-xs text-muted">
                  Hostnames are resolved once when the VPN connects. If the name later points to another address, reconnect to refresh the route.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={() => openProfileSettings(null)}>Cancel</Button>
          {live && <Button onClick={() => save(true)}>Save & Reconnect</Button>}
          <Button variant="primary" onClick={() => save(false)}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
