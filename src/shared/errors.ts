import { VpnErrorCode, type VpnError } from './types';

const CATALOG: Record<VpnErrorCode, { title: string; message: string }> = {
  [VpnErrorCode.AUTH_FAILED]: {
    title: 'Authentication Failed',
    message: 'The VPN server rejected your username or password.',
  },
  [VpnErrorCode.TLS_ERROR]: {
    title: 'TLS Handshake Failed',
    message: 'Could not establish a secure channel. The server certificate, tls-auth key or cipher settings may not match.',
  },
  [VpnErrorCode.CERT_EXPIRED]: {
    title: 'Certificate Expired',
    message: 'A certificate in this profile (or the server certificate) has expired. Ask your administrator for a new profile.',
  },
  [VpnErrorCode.NETWORK_UNREACHABLE]: {
    title: 'Server Unreachable',
    message: 'The VPN server refused the connection or the network is unreachable.',
  },
  [VpnErrorCode.CONNECTION_TIMEOUT]: {
    title: 'Connection Timed Out',
    message: 'The VPN server did not respond in time.',
  },
  [VpnErrorCode.ROUTE_CONFLICT]: {
    title: 'Route Conflict',
    message: 'This VPN wants routes that are already owned by another active VPN.',
  },
  [VpnErrorCode.DNS_CONFLICT]: {
    title: 'DNS Conflict',
    message: 'Another active VPN already controls the system DNS.',
  },
  [VpnErrorCode.OPENVPN_NOT_FOUND]: {
    title: 'OpenVPN Not Found',
    message: 'No OpenVPN binary was found. Install OpenVPN or choose the binary in Settings.',
  },
  [VpnErrorCode.INVALID_CONFIG]: {
    title: 'Invalid Configuration',
    message: 'OpenVPN could not parse this profile. Check the configuration file.',
  },
  [VpnErrorCode.PERMISSION_DENIED]: {
    title: 'Permission Denied',
    message: 'OpenVPN needs elevated privileges to create the tunnel interface or change routes.',
  },
  [VpnErrorCode.PROCESS_CRASHED]: {
    title: 'OpenVPN Stopped Unexpectedly',
    message: 'The OpenVPN process exited without being asked to.',
  },
  [VpnErrorCode.UNKNOWN]: {
    title: 'Connection Error',
    message: 'An unexpected error occurred. See the logs for details.',
  },
};

export function vpnError(code: VpnErrorCode, detail?: string): VpnError {
  return { code, ...CATALOG[code], ...(detail ? { detail } : {}) };
}

/** Errors that will not fix themselves; automatic reconnect must stop on these. */
const FATAL = new Set<VpnErrorCode>([
  VpnErrorCode.AUTH_FAILED,
  VpnErrorCode.CERT_EXPIRED,
  VpnErrorCode.INVALID_CONFIG,
  VpnErrorCode.OPENVPN_NOT_FOUND,
  VpnErrorCode.PERMISSION_DENIED,
]);

export const isRetryable = (code: VpnErrorCode): boolean => !FATAL.has(code);
