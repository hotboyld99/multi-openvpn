import { LinuxNetworkService } from './linux/LinuxNetworkService';
import { MacNetworkService } from './macos/MacNetworkService';
import type { PlatformNetworkService } from './PlatformNetworkService';
import { WindowsNetworkService } from './windows/WindowsNetworkService';

/** `stateDir` holds what was changed (DNS backups) so it can be undone after a crash. */
export function createPlatformNetworkService(stateDir: string, platform: NodeJS.Platform = process.platform): PlatformNetworkService {
  if (platform === 'darwin') return new MacNetworkService(stateDir);
  if (platform === 'win32') return new WindowsNetworkService(stateDir);
  return new LinuxNetworkService(stateDir);
}
