import type { VpnStatus } from '../../../shared/types';

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export const formatRate = (bytesPerSec: number): string => `${formatBytes(bytesPerSec)}/s`;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function timeAgo(ts: number, now = Date.now()): string {
  const sec = Math.round((ts - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return rtf.format(sec, 'second');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  return rtf.format(Math.round(sec / 86400), 'day');
}

export const formatTime = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour12: false });

export type Tone = 'ok' | 'busy' | 'error' | 'idle';

export const STATUS: Record<VpnStatus, { label: string; tone: Tone }> = {
  CONNECTED: { label: 'Connected', tone: 'ok' },
  CONNECTING: { label: 'Connecting', tone: 'busy' },
  WAIT: { label: 'Waiting for server', tone: 'busy' },
  AUTH: { label: 'Authenticating', tone: 'busy' },
  GET_CONFIG: { label: 'Getting config', tone: 'busy' },
  ASSIGN_IP: { label: 'Assigning IP', tone: 'busy' },
  ADD_ROUTES: { label: 'Adding routes', tone: 'busy' },
  RECONNECTING: { label: 'Reconnecting', tone: 'busy' },
  DISCONNECTING: { label: 'Disconnecting', tone: 'busy' },
  DISCONNECTED: { label: 'Disconnected', tone: 'idle' },
  ERROR: { label: 'Error', tone: 'error' },
};

export const cn = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');
