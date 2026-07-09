/** A session is considered "stuck" if a tool has been running with no JSONL
 *  data for this long. Only checked while currentTool is set (thinking between
 *  turns/tools produces no JSONL and must not trip stuck). */
export const STALE_MS = 300_000;

/** Stuck-detection tick interval. */
export const STALE_TICK_MS = 5_000;

/** Max output chunks retained per session in the detail view. */
export const MAX_OUTPUT_CHUNKS = 200;

/** Approximate token budget for the "near limit" red bar state. Claude's
 *  context window varies by model; this is a soft visual cue, not a hard cap. */
export const TOKEN_SOFT_LIMIT = 180_000;
