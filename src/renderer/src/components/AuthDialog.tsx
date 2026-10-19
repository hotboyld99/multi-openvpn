import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Input } from './ui';
import { run, useStore } from '../store';

const TITLES: Record<string, string> = {
  Auth: 'VPN Authentication',
  'Private Key': 'Private Key Password',
  'HTTP Proxy': 'HTTP Proxy Authentication',
};

/** Shown whenever any connection's openvpn is waiting for a secret. One prompt at a time. */
export function AuthDialog() {
  const connections = useStore((s) => s.connections);
  const profiles = useStore((s) => s.profiles);
  const pending = useMemo(() => Object.values(connections).find((c) => c.authRequest), [connections]);
  const request = pending?.authRequest;
  const profile = profiles.find((p) => p.id === pending?.profileId);
  const secureStorage = useStore((s) => s.appInfo?.secureStorage ?? false);
  const [remember, setRemember] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset the form for every new prompt; never keep a password around afterwards.
  useEffect(() => {
    setUsername(request?.username ?? '');
    setPassword('');
    setResponse('');
    setBusy(false);
    setRemember(false);
  }, [pending?.id, request?.realm, request?.username, request?.challenge?.text, request?.savedPassword]);

  if (!pending || !request) return null;
  const askCredentials = !request.savedPassword;
  const challenge = request.challenge;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    const secret = { ...(request.needsUsername ? { username } : {}), password, ...(challenge ? { response } : {}) };
    await run(() => window.vpn.submitSecret(pending.id, secret, remember));
    setPassword('');
    setResponse('');
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="w-96 rounded-lg border border-border bg-surface p-5 shadow-xl">
        <div className="flex items-center gap-2 font-semibold">
          <KeyRound className="h-4 w-4 text-accent" />
          {TITLES[request.realm] ?? `${request.realm} credentials`}
        </div>
        <p className="mt-1 text-xs text-muted">{profile?.name ?? 'VPN'}</p>

        <div className="mt-4 flex flex-col gap-3">
          {askCredentials && request.needsUsername && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Username</span>
              <Input autoFocus={!request.username} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            </label>
          )}
          {askCredentials && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">{request.realm === 'Private Key' ? 'Private Key Password' : 'Password'}</span>
              <Input
                type="password"
                autoFocus={!request.needsUsername || !!request.username}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
          )}
          {challenge && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">{challenge.text}</span>
              <Input
                type={challenge.echo ? 'text' : 'password'}
                autoFocus={!askCredentials}
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
              />
            </label>
          )}
          {askCredentials && secureStorage && (
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>
                Remember securely
                <span className="block text-muted">
                  Stored with the {navigator.platform.startsWith('Mac') ? 'macOS Keychain' : 'OS credential store'}, only after the VPN connects.
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={busy} onClick={() => run(() => window.vpn.cancelSecret(pending.id))}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || (askCredentials && (!password || (request.needsUsername && !username))) || (!!challenge && !response)}>
            Connect
          </Button>
        </div>
      </form>
    </div>
  );
}
