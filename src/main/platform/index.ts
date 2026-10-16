import { LinuxNetworkService } from './linux/LinuxNetworkService';
import { MacNetworkService } from './macos/MacNetworkService';
import type { PlatformNetworkService } from './PlatformNetworkService';
import { WindowsNetworkService } from './windows/WindowsNetworkService';

export function createPlatformNetworkService(platform: NodeJS.Platform = process.platform): PlatformNetworkService {
  if (platform === 'darwin') return new MacNetworkService();
  if (platform === 'win32') return new WindowsNetworkService();
  return new LinuxNetworkService();
}
