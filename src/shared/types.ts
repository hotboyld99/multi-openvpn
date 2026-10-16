// Domain types shared by main, preload and renderer.
// Timestamps are epoch milliseconds: they survive JSON persistence and IPC unchanged.

export type VpnStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'WAIT'
  | 'AUTH'
  | 'GET_CONFIG'
  | 'ASSIGN_IP'
  | 'ADD_ROUTES'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'DISCONNECTING'
  | 'ERROR';

/** Statuses in which a connection owns (or is acquiring) a live openvpn process. */
export const LIVE_STATUSES: readonly VpnStatus[] = [
  'CONNECTING',
  'WAIT',
  'AUTH',
  'GET_CONFIG',
  'ASSIGN_IP',
  'ADD_ROUTES',
  'CONNECTED',
  'RECONNECTING',
  'DISCONNECTING',
];

export const isLive = (s: VpnStatus): boolean => LIVE_STATUSES.includes(s);

export enum VpnErrorCode {
  AUTH_FAILED = 'AUTH_FAILED',
  TLS_ERROR = 'TLS_ERROR',
  CERT_EXPIRED = 'CERT_EXPIRED',
  NETWORK_UNREACHABLE = 'NETWORK_UNREACHABLE',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
  ROUTE_CONFLICT = 'ROUTE_CONFLICT',
  DNS_CONFLICT = 'DNS_CONFLICT',
  OPENVPN_NOT_FOUND = 'OPENVPN_NOT_FOUND',
  INVALID_CONFIG = 'INVALID_CONFIG',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  PROCESS_CRASHED = 'PROCESS_CRASHED',
  UNKNOWN = 'UNKNOWN',
}

export interface VpnError {
  code: VpnErrorCode;
  /** Short title, e.g. "Authentication Failed". */
  title: string;
  /** Human explanation shown in the UI. */
  message: string;
  /** Raw log line or exception text that triggered it, for debugging. */
  detail?: string;
}

export type RouteRuleType = 'cidr' | 'ip' | 'hostname';

export interface RouteRule {
  id: string;
  type: RouteRuleType;
  value: string;
}

export type RoutingMode = 'config' | 'custom';
export type DnsMode = 'vpn' | 'system' | 'custom';

export interface VpnProfile {
  id: string;
  name: string;
  /** Absolute path of the stored config inside the profile directory. */
  configPath: string;
  /** Original file name, shown in lists. */
  configFileName: string;
  username?: string;
  /** True when a password is stored in secure storage. The password itself never leaves main. */
  hasSavedPassword: boolean;
  autoConnect: boolean;
  reconnect: boolean;
  routingMode: RoutingMode;
  customRoutes?: RouteRule[];
  dnsMode: DnsMode;
  dnsServers?: string[];
  /** Never let this VPN take the default route, even if its config or server asks for it. */
  ignoreRedirectGateway?: boolean;
  /** The config file contains redirect-gateway (computed at import/edit). */
  wantsDefaultRoute?: boolean;
  /** The server pushed redirect-gateway on a previous connection (learned). */
  pushesDefaultRoute?: boolean;
  lastConnectedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** OpenVPN is waiting for a secret (management `>PASSWORD:Need ...`). */
export interface AuthRequest {
  /** OpenVPN realm: 'Auth' (auth-user-pass), 'Private Key', 'HTTP Proxy', ... */
  realm: string;
  needsUsername: boolean;
  /** Prefill for the username field. */
  username?: string;
}

export interface SecretInput {
  username?: string;
  password: string;
}

export interface VpnConnection {
  id: string;
  profileId: string;
  pid?: number;
  managementPort?: number;
  status: VpnStatus;
  /** When the user asked to connect. */
  startedAt: number;
  /** When the tunnel last reached CONNECTED; drives the duration timer. */
  connectedAt?: number;
  assignedIp?: string;
  publicIp?: string;
  interfaceName?: string;
  gateway?: string;
  remote?: string;
  bytesIn: number;
  bytesOut: number;
  /** Bytes per second, computed from the last two counter samples. */
  rateIn: number;
  rateOut: number;
  reconnectCount: number;
  /** Epoch ms of the next automatic retry while RECONNECTING. */
  nextRetryAt?: number;
  error?: VpnError;
  /** Set while the UI must ask the user for credentials. */
  authRequest?: AuthRequest;
  /** take = may install the default route; skip = redirect-gateway is filtered out. */
  defaultRoute?: 'take' | 'skip';
  /** This connection currently routes all traffic (owns 0.0.0.0/0). */
  ownsDefaultRoute?: boolean;
  /** The server pushed redirect-gateway but it was filtered because another VPN owns the default route. */
  ignoredDefaultRoute?: boolean;
  /** Custom routes actually requested from openvpn (hostnames resolved). */
  appliedRoutes?: string[];
}

/** Another VPN already owns (or is acquiring) the default route. */
export interface RouteConflict {
  profileId: string;
  holderConnectionId: string;
  holderProfileId: string;
}

export type ConnectResult = { connectionId: string } | { conflict: RouteConflict };

export interface ConnectOptions {
  /** Resolution chosen in the Route Conflict dialog. */
  defaultRoute?: 'take' | 'skip';
  /** With defaultRoute 'take': first move the current owner off the default route. */
  replaceDefault?: boolean;
}

export interface RouteInfo {
  destination: string;
  gateway: string;
  interface: string;
  family: 'IPv4' | 'IPv6';
  /** Default route or one of the halves openvpn uses for def1 (0/1, 128/1). */
  isDefault: boolean;
  connectionId?: string;
  profileId?: string;
  /** Same destination installed by more than one VPN. */
  conflict?: boolean;
  simulated?: boolean;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  seq: number;
  ts: number;
  level: LogLevel;
  message: string;
}

export interface InterfaceAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
  cidr: string | null;
}

/** vpn = a tunnel owned by one of our connections; tunnel = a tunnel-like interface we do not own. */
export type InterfaceKind = 'physical' | 'vpn' | 'tunnel' | 'loopback' | 'other';

export interface NetworkInterfaceInfo {
  name: string;
  kind: InterfaceKind;
  mac?: string;
  addresses: InterfaceAddress[];
  /** Connection that owns this interface, when it is a tunnel of ours. */
  connectionId?: string;
  profileId?: string;
  /** Synthesized by mock mode; does not exist in the OS. */
  simulated?: boolean;
}

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface AppSettings {
  theme: ThemeSetting;
  /** null = auto detect. */
  openvpnPath: string | null;
  checkPublicIp: boolean;
  launchAtLogin: boolean;
}

export interface OpenVpnBinaryInfo {
  path: string;
  version: string | null;
  source: 'custom' | 'bundled' | 'system';
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  mockMode: boolean;
  openvpn: OpenVpnBinaryInfo | null;
}

export type FindingSeverity = 'ok' | 'info' | 'warning' | 'danger';

export interface SecurityFinding {
  severity: FindingSeverity;
  title: string;
  detail?: string;
  line?: number;
}

/** Result of scanning a config before import/save. */
export interface ProfileScan {
  findings: SecurityFinding[];
  /** The config may execute local commands or load plugins: the user must confirm. */
  dangerous: boolean;
  /** Problems that prevent using the config at all (parse errors, missing files). */
  errors: string[];
  remotes: string[];
  needsCredentials: boolean;
  wantsDefaultRoute: boolean;
}

export interface ImportPreview {
  /** Absolute source path, echoed back on confirm. */
  path: string;
  fileName: string;
  suggestedName: string;
  scan: ProfileScan;
}
