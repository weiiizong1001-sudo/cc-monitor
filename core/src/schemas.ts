/**
 * Shared data types for cc-monitor.
 */

/** Persisted agent data (survives restart) */
export interface PersistedAgent {
  id: number;
  sessionId?: string;
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  folderName?: string;
  /** User-assigned group label for web-side session management. */
  group?: string;
  /** False for historical sessions adopted at startup. Absent/true = active. */
  isActive?: boolean;
}

/** Raw hook event received from the hook script via HTTP server */
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  [key: string]: unknown;
}
