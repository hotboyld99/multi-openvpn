// OpenVPN management interface (v5) wire format: pure parsing/formatting, no I/O.
// https://openvpn.net/community-resources/management-interface/

export type MgmtMessage =
  | {
      kind: 'state';
      time: number;
      state: string;
      description: string;
      localIp?: string;
      remoteIp?: string;
      remotePort?: string;
      localIpv6?: string;
    }
  | { kind: 'log'; time: number; flags: string; message: string }
  | { kind: 'bytecount'; bytesIn: number; bytesOut: number }
  | { kind: 'hold'; message: string }
  | { kind: 'password'; action: 'need'; realm: string; needsUsername: boolean; challenge?: string }
  | { kind: 'password'; action: 'failed'; realm: string }
  | { kind: 'fatal'; message: string }
  | { kind: 'info'; message: string }
  | { kind: 'other'; type: string; payload: string };

const opt = (s: string | undefined): string | undefined => (s ? s : undefined);

/** Splits off the first `n` comma-separated fields; the remainder (which may contain commas) is last. */
function splitFields(s: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = 0; i < n; i++) {
    const idx = rest.indexOf(',');
    if (idx < 0) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  out.push(rest);
  return out;
}

/** Parses one real-time line (starting with '>'). */
export function parseRealtime(line: string): MgmtMessage {
  const colon = line.indexOf(':');
  const type = line.slice(1, colon < 0 ? undefined : colon);
  const payload = colon < 0 ? '' : line.slice(colon + 1);

  switch (type) {
    case 'STATE': {
      const [time, state, description, localIp, remoteIp, remotePort, , , localIpv6] = payload.split(',');
      return {
        kind: 'state',
        time: Number(time),
        state: state ?? '',
        description: description ?? '',
        localIp: opt(localIp),
        remoteIp: opt(remoteIp),
        remotePort: opt(remotePort),
        localIpv6: opt(localIpv6),
      };
    }
    case 'LOG': {
      const [time, flags, message] = splitFields(payload, 2);
      return { kind: 'log', time: Number(time), flags: flags ?? '', message: message ?? '' };
    }
    case 'BYTECOUNT': {
      const [bytesIn, bytesOut] = payload.split(',').map(Number);
      return { kind: 'bytecount', bytesIn: bytesIn || 0, bytesOut: bytesOut || 0 };
    }
    case 'HOLD':
      return { kind: 'hold', message: payload };
    case 'PASSWORD': {
      const failed = /^Verification Failed: '([^']+)'/.exec(payload);
      if (failed) return { kind: 'password', action: 'failed', realm: failed[1] };
      const need = /^Need '([^']+)' (username\/password|password)(?: SC:\d,(.*))?/.exec(payload);
      if (need) return { kind: 'password', action: 'need', realm: need[1], needsUsername: need[2] === 'username/password', challenge: need[3] };
      return { kind: 'other', type, payload };
    }
    case 'FATAL':
      return { kind: 'fatal', message: payload };
    case 'INFO':
      return { kind: 'info', message: payload };
    default:
      return { kind: 'other', type, payload };
  }
}

export type ParserEvent = { type: 'realtime'; message: MgmtMessage } | { type: 'line'; line: string } | { type: 'passwordPrompt' };

/** Turns the raw byte stream into lines/events. Handles the newline-less "ENTER PASSWORD:" prompt. */
export class ManagementParser {
  private buf = '';

  feed(chunk: string): ParserEvent[] {
    this.buf += chunk;
    const events: ParserEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line === '') continue;
      events.push(line.startsWith('>') ? { type: 'realtime', message: parseRealtime(line) } : { type: 'line', line });
    }
    if (this.buf === 'ENTER PASSWORD:') {
      this.buf = '';
      events.push({ type: 'passwordPrompt' });
    }
    return events;
  }
}

/**
 * Quotes a value for username/password commands. Newlines are rejected outright:
 * they would terminate the command and let the rest be read as a new one.
 */
export function quoteArg(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Credential contains a forbidden control character');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const usernameCommand = (realm: string, username: string): string => `username ${quoteArg(realm)} ${quoteArg(username)}`;
export const passwordCommand = (realm: string, password: string): string => `password ${quoteArg(realm)} ${quoteArg(password)}`;
