/**
 * Pluggable persistence backend for agent state and user settings.
 *
 * cc-monitor uses FileStateAdapter, which persists everything under
 * ~/.cc-monitor/ as plain JSON. The interface exists so future hosts can
 * swap in alternate backends without touching the rest of the code.
 */

import type { PersistedAgent } from './schemas.js';

export interface StateAdapter {
  // ── Per-adapter persisted state ───────────────────────────────
  loadAgents(): PersistedAgent[];
  saveAgents(agents: PersistedAgent[]): void;

  // ── User-level settings ───────────────────────────────────────
  getSetting<T>(key: string, defaultValue: T): T;
  setSetting<T>(key: string, value: T): void;
}
