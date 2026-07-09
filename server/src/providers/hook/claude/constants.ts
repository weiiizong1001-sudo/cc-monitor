/**
 * Claude-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on Claude
 * unless Claude is the active provider.
 *
 * Adding another provider? Create its own `providers/<kind>/<name>/constants.ts`.
 */

/** Output filename after esbuild compiles claude-hook.ts to CJS (source is .ts, output is .js) */
export const CLAUDE_HOOK_SCRIPT_NAME = 'claude-hook.js';

/** Hook events to install in ~/.claude/settings.json.
 *  Only the 4 events JSONL tailing can't recover:
 *    - SessionStart/SessionEnd: session lifecycle (start, /clear, resume, exit)
 *    - PermissionRequest: real-time permission-wait signal
 *    - Notification: idle_prompt (waiting for input) + permission_prompt
 *  Tool start/end, assistant text, token usage, and turn completion all come
 *  from JSONL polling — no PreToolUse/PostToolUse/Stop hooks needed, which
 *  keeps the number of node spawns per cc turn low. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PermissionRequest',
  'Notification',
] as const;
