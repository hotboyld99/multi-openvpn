import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { SettingsPatch } from '../../shared/schemas';
import type { AppSettings } from '../../shared/types';
import { readJson, writeJsonAtomic } from './jsonFile';

const DEFAULTS: AppSettings = {
  theme: 'system',
  openvpnPath: null,
  checkPublicIp: false,
  launchAtLogin: false,
};

export class SettingsStore extends EventEmitter<{ changed: [AppSettings] }> {
  private settings: AppSettings = { ...DEFAULTS };

  constructor(private readonly root: string) {
    super();
  }

  async load(): Promise<void> {
    this.settings = { ...DEFAULTS, ...(await readJson<Partial<AppSettings>>(join(this.root, 'settings.json'), {})) };
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
    await writeJsonAtomic(join(this.root, 'settings.json'), this.settings);
    this.emit('changed', this.get());
    return this.get();
  }
}
