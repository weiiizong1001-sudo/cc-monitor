/**
 * FileStateAdapter: StateAdapter implementation for cc-monitor.
 *
 * Settings persist to ~/.cc-monitor/config.json (shared with configPersistence).
 * Agents persist to ~/.cc-monitor/standalone-state.json.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { readConfig, writeConfig } from './configPersistence.js';
import { LAYOUT_FILE_DIR } from './constants.js';

interface AdapterState {
  agents: PersistedAgent[];
}

export class FileStateAdapter implements StateAdapter {
  private readonly stateFilePath: string;

  constructor() {
    this.stateFilePath = path.join(os.homedir(), LAYOUT_FILE_DIR, 'standalone-state.json');
  }

  // ── Settings (shared config.json) ───────────────────────────

  getSetting<T>(key: string, defaultValue: T): T {
    const config = readConfig() as unknown as Record<string, unknown>;
    const v = config[key];
    return v === undefined ? defaultValue : (v as T);
  }

  setSetting<T>(key: string, value: T): void {
    const config = readConfig();
    (config as unknown as Record<string, unknown>)[key] = value;
    writeConfig(config);
  }

  // ── Agents (adapter-scoped file) ────────────────────────────

  loadAgents(): PersistedAgent[] {
    return this.readState().agents;
  }

  saveAgents(agents: PersistedAgent[]): void {
    const state = this.readState();
    state.agents = agents;
    this.writeState(state);
  }

  // ── Internal state-file I/O ─────────────────────────────────

  private readState(): AdapterState {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return { agents: [] };
      }
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AdapterState>;
      return {
        agents: Array.isArray(parsed.agents) ? (parsed.agents as PersistedAgent[]) : [],
      };
    } catch (err) {
      console.error('[cc-monitor] Failed to read adapter state:', err);
      return { agents: [] };
    }
  }

  private writeState(state: AdapterState): void {
    const dir = path.dirname(this.stateFilePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const json = JSON.stringify(state, null, 2);
      const tmpPath = this.stateFilePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      console.error('[cc-monitor] Failed to write adapter state:', err);
    }
  }
}
