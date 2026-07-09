/**
 * Config persistence for cc-monitor.
 * Flat schema stored at ~/.cc-monitor/config.json.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';

export interface MonitorConfig {
  hooksEnabled: boolean;
  watchAllSessions: boolean;
  /** Project dirs scanned at startup for historical Claude sessions (persisted
   *  --scan-dir). CLI flags merge into this list at launch. */
  startupScanDirs: string[];
  /** Max sessions adopted from startupScanDirs (most-recently-modified first). 0 = unlimited. */
  maxStartupAgents: number;
}

const DEFAULT_CONFIG: MonitorConfig = {
  hooksEnabled: true,
  watchAllSessions: false,
  startupScanDirs: [],
  /** 0 = unlimited. Defaulting to unlimited surfaces every historical session
   *  in the scanned project dir, which is what a monitor is for; users who
   *  want a cap can set maxStartupAgents in ~/.cc-monitor/config.json. */
  maxStartupAgents: 0,
};

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

export function readConfig(): MonitorConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MonitorConfig>;
    return {
      hooksEnabled:
        typeof parsed.hooksEnabled === 'boolean'
          ? parsed.hooksEnabled
          : DEFAULT_CONFIG.hooksEnabled,
      watchAllSessions:
        typeof parsed.watchAllSessions === 'boolean'
          ? parsed.watchAllSessions
          : DEFAULT_CONFIG.watchAllSessions,
      startupScanDirs: Array.isArray(parsed.startupScanDirs)
        ? parsed.startupScanDirs.filter((d): d is string => typeof d === 'string')
        : [],
      maxStartupAgents:
        typeof parsed.maxStartupAgents === 'number' && parsed.maxStartupAgents >= 0
          ? parsed.maxStartupAgents
          : DEFAULT_CONFIG.maxStartupAgents,
    };
  } catch (err) {
    console.error('[cc-monitor] Failed to read config file:', err);
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(config: MonitorConfig): void {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[cc-monitor] Failed to write config file:', err);
  }
}
