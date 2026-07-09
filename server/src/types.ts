/**
 * Agent runtime state for cc-monitor.
 * Tracks one Claude Code session: live JSONL tail state, active tools,
 * permission/waiting flags, and token usage.
 */

export interface AgentState {
  id: number;
  sessionId: string;
  /** Whether this agent was detected from an external source (terminal outside the server). */
  isExternal: boolean;
  projectDir: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** User-assigned group label for web-side session management. */
  group?: string;
  /** Timestamp of last JSONL data received (ms since epoch) */
  lastDataAt: number;
  /** Total JSONL lines processed for this agent */
  linesProcessed: number;
  /** Current Claude permission mode (default|acceptEdits|plan|bypassPermissions) */
  permissionMode?: string;
  /** Set of record.type values we've already warned about (prevents log spam) */
  seenUnknownRecordTypes: Set<string>;
  /** Set when SessionEnd(reason=clear) fires; cleared when SessionStart(source=clear) reassigns */
  pendingClear?: boolean;
  /**
   * Whether the underlying claude session is still alive (no SessionEnd received).
   * False for historical sessions adopted at startup and for sessions that have exited.
   */
  isActive?: boolean;

  // -- Token tracking --
  inputTokens: number;
  outputTokens: number;
}

export interface PersistedAgent {
  id: number;
  sessionId?: string;
  /** Whether this agent was detected from an external source */
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** User-assigned group label for web-side session management. */
  group?: string;
  /** False for historical sessions adopted at startup. Absent/true = active. */
  isActive?: boolean;
}
