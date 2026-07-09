/**
 * Provider abstraction for AI agent tools.
 *
 * cc-monitor ships a single HookProvider (Claude Code). Hook events drive
 * session lifecycle + permission/idle signals; everything else (tool start/end,
 * assistant text, token usage) comes from JSONL tailing.
 */

// ── Normalized Events (produced by normalizeHookEvent) ────────

export type AgentEvent =
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: 'toolEnd'; toolId: string }
  | {
      kind: 'turnEnd';
      /** True when the turn ended because the agent went idle waiting on the
       *  user (Notification idle_prompt) rather than finishing (Stop). Drives
       *  the "Waiting for input" vs "Done" label. */
      awaitingInput?: boolean;
    }
  | { kind: 'permissionRequest' }
  | {
      kind: 'sessionStart';
      source?: string;
      transcriptPath?: string;
      cwd?: string;
    }
  | { kind: 'sessionEnd'; reason?: string };

// ── Hook-based Provider ────────────────────────────────────────

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;
  /** Protocol version. Server refuses to dispatch events from a provider whose
   *  version it doesn't understand. Bump on every breaking change. */
  readonly protocolVersion: number;

  /** Normalize a raw hook event payload into an AgentEvent.
   *  Return null for events we should ignore. */
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;

  /** Install hook scripts that POST to our server. */
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  /** Remove installed hook scripts. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;

  /** Format tool status for display (e.g., "Read" -> "Reading foo.ts") */
  formatToolStatus(toolName: string, input?: unknown): string;
  /** Tools that don't trigger permission timers */
  readonly permissionExemptTools: ReadonlySet<string>;
  /** Tools that spawn sub-agent characters (Task/Agent) — used to label "Subtask:" */
  readonly subagentToolNames: ReadonlySet<string>;
  /** Tools that should show the "reading" state instead of "typing". */
  readonly readingTools: ReadonlySet<string>;

  // ── Optional file fallback (heuristic mode) ──

  /** Session directories to scan. Undefined = no file fallback. */
  getSessionDirs?(workspacePath: string): string[];
  /** Root directories containing every session this provider may have started. */
  getAllSessionRoots?(): string[];
  /** Glob pattern for session files (e.g., '*.jsonl'). */
  readonly sessionFilePattern?: string;
  /** Parse one line of a transcript file into an AgentEvent. */
  parseTranscriptLine?(line: string): AgentEvent | null;
}
