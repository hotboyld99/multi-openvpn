import type { VpnApi } from '../../shared/ipc';

declare global {
  interface Window {
    vpn: VpnApi;
  }
}
