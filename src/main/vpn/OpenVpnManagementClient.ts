import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { ManagementParser, type MgmtMessage } from './managementProtocol';

interface Pending {
  multiline: boolean;
  lines: string[];
  resolve(value: string[]): void;
  reject(err: Error): void;
}

export interface ManagementClientOptions {
  port: number;
  password: string;
  host?: string;
  /** Give up connecting after this long. */
  connectTimeoutMs?: number;
  /** Stop retrying early when this returns false (e.g. the process already exited). */
  shouldRetry?: () => boolean;
}

/**
 * Client for one openvpn's management interface. Commands are answered strictly in
 * order, so a FIFO queue matches SUCCESS/ERROR/END responses to their commands;
 * real-time `>...` lines are emitted as they arrive.
 */
export class OpenVpnManagementClient extends EventEmitter<{ message: [MgmtMessage]; close: [] }> {
  private socket?: Socket;
  private readonly parser = new ManagementParser();
  private readonly queue: Pending[] = [];
  private closed = false;

  constructor(private readonly opts: ManagementClientOptions) {
    super();
  }

  get connected(): boolean {
    return !!this.socket && !this.closed;
  }

  /** Connects (retrying while openvpn opens the port) and authenticates with the management password. */
  async connect(): Promise<void> {
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 10_000);
    for (;;) {
      try {
        this.socket = await this.tryConnect();
        break;
      } catch (err) {
        if (Date.now() > deadline || this.opts.shouldRetry?.() === false) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await this.authenticate(this.socket);
  }

  /** Sends a command; resolves with the SUCCESS text or, for multi-line commands, the lines before END. */
  async command(cmd: string, multiline = false): Promise<string[]> {
    const socket = this.socket;
    if (!socket || this.closed) throw new Error('Management interface is not connected');
    return new Promise((resolve, reject) => {
      this.queue.push({ multiline, lines: [], resolve, reject });
      socket.write(`${cmd}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
  }

  private tryConnect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(this.opts.port, this.opts.host ?? '127.0.0.1');
      s.once('connect', () => {
        s.off('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
  }

  private authenticate(socket: Socket): Promise<void> {
    socket.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      let authed = false;
      const timer = setTimeout(() => fail(new Error('Management authentication timed out')), 5_000);
      const fail = (err: Error): void => {
        clearTimeout(timer);
        if (!authed) reject(err);
        socket.destroy();
      };

      socket.on('data', (chunk: string) => {
        for (const ev of this.parser.feed(chunk)) {
          if (ev.type === 'passwordPrompt') {
            socket.write(`${this.opts.password}\n`);
          } else if (!authed && ev.type === 'line') {
            if (ev.line.startsWith('SUCCESS: password is correct')) {
              authed = true;
              clearTimeout(timer);
              resolve();
            } else if (ev.line.startsWith('ERROR')) {
              fail(new Error(`Management authentication failed: ${ev.line}`));
            }
          } else if (ev.type === 'realtime') {
            this.emit('message', ev.message);
          } else if (ev.type === 'line') {
            this.onResponseLine(ev.line);
          }
        }
      });
      socket.on('error', (err) => fail(err));
      socket.on('close', () => {
        this.closed = true;
        clearTimeout(timer);
        if (!authed) reject(new Error('Management connection closed during authentication'));
        for (const p of this.queue.splice(0)) p.reject(new Error('Management connection closed'));
        this.emit('close');
      });
    });
  }

  private onResponseLine(line: string): void {
    const head = this.queue[0];
    if (!head) return;
    if (line.startsWith('ERROR:')) {
      this.queue.shift();
      head.reject(new Error(line.slice(6).trim()));
    } else if (!head.multiline && line.startsWith('SUCCESS:')) {
      this.queue.shift();
      head.resolve([line.slice(8).trim()]);
    } else if (head.multiline && line === 'END') {
      this.queue.shift();
      head.resolve(head.lines);
    } else if (head.multiline) {
      head.lines.push(line);
    }
  }
}
