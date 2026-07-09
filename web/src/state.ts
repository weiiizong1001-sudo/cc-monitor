/** Per-session view model maintained by the ball UI. */
export interface SessionView {
  id: number;
  /** Display name: custom-title/ai-title (folderName) > project basename > #id. */
  folderName?: string;
  projectDir?: string;
  sessionId?: string;
  /** User-assigned group label (web-side management). */
  group?: string;
  /** Absolute path to the session JSONL transcript. */
  jsonlFile?: string;
  status: 'active' | 'waiting' | 'inactive';
  /** Current Claude permission mode (default|acceptEdits|plan|bypassPermissions). */
  permissionMode?: string;
  /** Epoch ms of last JSONL data — for stuck detection. */
  lastDataAt: number;
  /** Formatted status line of the currently running tool, if any. */
  currentTool?: string;
  /** Live assistant/thinking output chunks (capped to MAX_OUTPUT_CHUNKS). */
  output: OutputChunk[];
  inputTokens: number;
  outputTokens: number;
  /** True while a permission prompt is awaiting the user. */
  permissionPending: boolean;
  /** True once a stuck notification has fired for the current stall (dedup). */
  stuckNotified: boolean;
  /** True once a completion notification has fired for the current waiting turn. */
  waitingNotified: boolean;
  /** Set by the stale tick when no JSONL data has arrived within STALE_MS. */
  stuck: boolean;
  /** True once the server has replayed this session's transcript via
   *  loadSessionHistory — so we only pull once per session (active sessions
   *  then keep streaming live on top of the replayed history). */
  historyLoaded?: boolean;
  /** Bumped each time a sessionHistory replay lands — OutputStream watches
   *  this to force-scroll to the latest message (opening a session should
   *  show the most recent line, not the first). */
  scrollNonce?: number;
}

export interface OutputChunk {
  role: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result';
  text: string;
  /** Tool name for tool_use chunks (drives the ⏵ prefix styling). */
  toolName?: string;
}

/** A session is "running" (shown in the list) when it's active or waiting
 *  — i.e. the Claude process is alive and not just a historical corpse. */
export function isRunning(s: SessionView): boolean {
  return s.status !== 'inactive';
}

/** Display name precedence: folderName (custom/ai title) > project basename > #id. */
export function displayName(s: SessionView): string {
  if (s.folderName) return s.folderName;
  if (s.projectDir) {
    const parts = s.projectDir.replace(/\\/g, '/').split('/').filter(Boolean);
    const base = parts[parts.length - 1];
    if (base) return base;
  }
  return `#${s.id}`;
}
