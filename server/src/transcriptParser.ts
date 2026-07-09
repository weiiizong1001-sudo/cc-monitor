const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import * as fs from 'fs';

import type { AgentOutputRole } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { TEXT_IDLE_DELAY_MS, TOOL_DONE_DELAY_MS } from './constants.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';

/** Empty set used as safe fallback when no HookProvider is registered. */
const EMPTY_EXEMPT_TOOLS: ReadonlySet<string> = new Set();

/** Hook provider: supplies formatToolStatus. Registered once at startup via
 *  setHookProvider(). Functions below assume it's set. */
let hookProvider: HookProvider | null = null;

/** Permission-exempt tools come from the active provider. Fail-open if unset. */
function exemptTools(): ReadonlySet<string> {
  return hookProvider?.permissionExemptTools ?? EMPTY_EXEMPT_TOOLS;
}

/** Register the HookProvider that owns CLI-specific formatting. */
export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

/** Format a tool status line. Delegates to the active HookProvider's formatToolStatus.
 *  Invariant: a provider is registered before any transcript lines are parsed. */
export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  return hookProvider?.formatToolStatus(toolName, input) ?? `Using ${toolName}`;
}

/** Truncate a tool_result's content to a display-friendly summary. */
function summarizeToolResult(content: unknown): string {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
  } else {
    return '';
  }
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed;
}

export interface HistoryChunk {
  role: AgentOutputRole;
  text: string;
  toolName?: string;
}

/** Read an entire transcript JSONL and extract a cc-terminal-style chunk list
 *  (user prompts, assistant text, thinking, tool calls, tool results). Used to
 *  populate the monitor's detail view when a session is opened — including
 *  inactive/historical sessions. Stateless: does not touch AgentState. */
export function parseTranscriptHistory(jsonlFile: string): HistoryChunk[] {
  const chunks: HistoryChunk[] = [];
  let data: string;
  try {
    data = fs.readFileSync(jsonlFile, 'utf-8');
  } catch {
    return chunks;
  }
  for (const line of data.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmedLine) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rtype = record['type'];
    if (rtype === 'user') {
      const msg = record['message'] as { content?: unknown } | undefined;
      const content = (msg?.content ?? record['content']) as unknown;
      if (typeof content === 'string') {
        const t = content.trim();
        if (t) chunks.push({ role: 'user', text: t });
      } else if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b['type'] === 'tool_result') {
            const summary = summarizeToolResult(b['content']);
            if (summary) chunks.push({ role: 'tool_result', text: summary });
          }
        }
      }
    } else if (rtype === 'assistant') {
      const msg = record['message'] as { content?: unknown } | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          const bt = b['type'];
          if (bt === 'text' && typeof b['text'] === 'string' && b['text']) {
            chunks.push({ role: 'assistant', text: b['text'] });
          } else if (bt === 'thinking' && typeof b['thinking'] === 'string' && b['thinking']) {
            chunks.push({ role: 'thinking', text: b['thinking'] });
          } else if (bt === 'tool_use' && b['id']) {
            const toolName = typeof b['name'] === 'string' ? b['name'] : '';
            chunks.push({
              role: 'tool_use',
              text: formatToolStatus(toolName, (b['input'] as Record<string, unknown>) ?? {}),
              toolName,
            });
          }
        }
      }
    }
  }
  return chunks;
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;
  try {
    const record = JSON.parse(line);

    // -- Token usage extraction from assistant records --
    const usage = record.message?.usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    if (usage) {
      if (typeof usage.input_tokens === 'number') {
        agent.inputTokens += usage.input_tokens;
      }
      if (typeof usage.output_tokens === 'number') {
        agent.outputTokens += usage.output_tokens;
      }
      agents.broadcast({
        type: 'agentTokenUsage',
        id: agentId,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }

    // Resilient content extraction: support both record.message.content and record.content
    // Claude Code may change the JSONL structure across versions
    const assistantContent = record.message?.content ?? record.content;

    if (record.type === 'assistant' && Array.isArray(assistantContent)) {
      const blocks = assistantContent as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        text?: string;
        thinking?: string;
      }>;
      // Broadcast assistant text + thinking + tool_use blocks as a live output stream.
      // One agentOutput per block — consumed by the monitor.
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          agents.broadcast({
            type: 'agentOutput',
            id: agentId,
            role: 'assistant',
            text: block.text,
          });
        } else if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking.length > 0
        ) {
          agents.broadcast({
            type: 'agentOutput',
            id: agentId,
            role: 'thinking',
            text: block.thinking,
          });
        } else if (block.type === 'tool_use' && block.id) {
          // Surface the tool call in the output stream (cc-terminal style).
          const toolName = block.name || '';
          agents.broadcast({
            type: 'agentOutput',
            id: agentId,
            role: 'tool_use',
            text: formatToolStatus(toolName, block.input || {}),
            toolName,
          });
        }
      }
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
        let hasNonExemptTool = false;
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = formatToolStatus(toolName, block.input || {});
            if (debug) {
              console.log(
                `[cc-monitor] JSONL: Agent ${agentId} - tool start: ${block.id} ${status}`,
              );
            }
            agent.activeToolIds.add(block.id);
            agent.activeToolStatuses.set(block.id, status);
            agent.activeToolNames.set(block.id, toolName);
            if (!exemptTools().has(toolName)) {
              hasNonExemptTool = true;
            }
            // Tool start is always driven by JSONL (no PreToolUse hook installed).
            agents.broadcast({
              type: 'agentToolStart',
              id: agentId,
              toolId: block.id,
              status,
              toolName,
              permissionActive: agent.permissionSent,
            });
          }
        }
        // Heuristic permission timer: if a non-exempt tool runs long without
        // a permission_prompt hook, surface the permission bubble. The hook
        // (Notification permission_prompt) cancels this timer when it fires.
        if (hasNonExemptTool) {
          startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
        }
      } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
        // Text-only response in a turn that hasn't used any tools.
        // turn_duration handles tool-using turns reliably but is never
        // emitted for text-only turns, so we use a silence-based timer:
        // if no new JSONL data arrives within TEXT_IDLE_DELAY_MS, mark as waiting.
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers);
      }
    } else if (record.type === 'assistant' && typeof assistantContent === 'string') {
      // Text-only assistant response (content is a string, not an array)
      if (assistantContent.length > 0) {
        agents.broadcast({
          type: 'agentOutput',
          id: agentId,
          role: 'assistant',
          text: assistantContent,
        });
      }
      if (!agent.hadToolsInTurn) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers);
      }
    } else if (record.type === 'assistant' && assistantContent === undefined) {
      // Assistant record with no recognizable content structure
      console.warn(
        `[cc-monitor] Agent ${agentId}: assistant record has no content. Keys: ${Object.keys(record).join(', ')}`,
      );
    } else if (record.type === 'progress') {
      processProgressRecord(agentId, record, agents, permissionTimers);
    } else if (record.type === 'user') {
      const content = record.message?.content ?? record.content;
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string }>;
        const hasToolResult = blocks.some((b) => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result') {
              const summary = summarizeToolResult((block as { content?: unknown }).content);
              if (summary) {
                agents.broadcast({
                  type: 'agentOutput',
                  id: agentId,
                  role: 'tool_result',
                  text: summary,
                });
              }
            }
            if (block.type === 'tool_result' && block.tool_use_id) {
              const completedToolId = block.tool_use_id;
              if (debug) {
                console.log(
                  `[cc-monitor] JSONL: Agent ${agentId} - tool done: ${block.tool_use_id}`,
                );
              }
              agent.activeToolIds.delete(completedToolId);
              agent.activeToolStatuses.delete(completedToolId);
              agent.activeToolNames.delete(completedToolId);
              // Tool done is always driven by JSONL (no PostToolUse hook installed).
              const toolId = completedToolId;
              setTimeout(() => {
                agents.broadcast({
                  type: 'agentToolDone',
                  id: agentId,
                  toolId,
                });
              }, TOOL_DONE_DELAY_MS);
            }
          }
          // All tools completed — allow text-idle timer as fallback
          // for turn-end detection when turn_duration is not emitted
          if (agent.activeToolIds.size === 0) {
            agent.hadToolsInTurn = false;
          }
        } else {
          // New user text prompt — new turn starting
          cancelWaitingTimer(agentId, waitingTimers);
          clearAgentActivity(agent, agentId, agents, permissionTimers);
          agent.hadToolsInTurn = false;
        }
      } else if (typeof content === 'string' && content.trim()) {
        // New user text prompt — new turn starting
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, agents, permissionTimers);
        agent.hadToolsInTurn = false;
        agents.broadcast({
          type: 'agentOutput',
          id: agentId,
          role: 'user',
          text: content.trim(),
        });
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      // Definitive turn-end: clean up all tool state and mark waiting.
      // turn_duration = the turn completed ("Done"), not awaiting input.
      agent.activeToolIds.clear();
      agent.activeToolStatuses.clear();
      agent.activeToolNames.clear();
      agents.broadcast({ type: 'agentToolsClear', id: agentId });

      agent.isWaiting = true;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
      agents.broadcast({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
        awaitingInput: false,
      });
    } else if (record.type === 'custom-title') {
      // User renamed the session in Claude Code. Highest priority — overrides
      // ai-title and the project-directory fallback. Broadcast so the webview
      // label updates live.
      const title =
        typeof (record as { customTitle?: unknown }).customTitle === 'string'
          ? (record as { customTitle: string }).customTitle
          : undefined;
      if (title && agent.folderName !== title) {
        agent.folderName = title;
        agents.broadcast({ type: 'agentCreated', id: agentId, folderName: title });
      }
    } else if (record.type === 'agent-name') {
      const title =
        typeof (record as { agentName?: unknown }).agentName === 'string'
          ? (record as { agentName: string }).agentName
          : undefined;
      if (title && !agent.folderName) {
        agent.folderName = title;
      }
    } else if (record.type === 'ai-title') {
      // Claude writes an "ai-title" record once it has generated a short title
      // for the conversation. Use it as the display name only if a custom-title
      // (user rename) hasn't already set one — custom-title wins.
      const title =
        typeof (record as { aiTitle?: unknown }).aiTitle === 'string'
          ? (record as { aiTitle: string }).aiTitle
          : undefined;
      if (title && !agent.folderName) {
        agent.folderName = title;
      }
    } else if (record.type === 'permission-mode') {
      // Claude Code records the active permission mode. Persist + broadcast so
      // the monitor can show a mode chip (e.g. plan mode).
      const mode =
        typeof (record as { permissionMode?: unknown }).permissionMode === 'string'
          ? (record as { permissionMode: string }).permissionMode
          : undefined;
      if (mode && mode !== agent.permissionMode) {
        agent.permissionMode = mode;
        agents.broadcast({ type: 'agentPermissionMode', id: agentId, mode });
      }
    } else if (record.type === 'mode') {
      // Older/alternate spelling of permission-mode.
      const mode =
        typeof (record as { mode?: unknown }).mode === 'string'
          ? (record as { mode: string }).mode
          : undefined;
      if (mode && mode !== agent.permissionMode) {
        agent.permissionMode = mode;
        agents.broadcast({ type: 'agentPermissionMode', id: agentId, mode });
      }
    } else if (record.type && !agent.seenUnknownRecordTypes.has(record.type)) {
      // Log first occurrence of unrecognized record types to help diagnose issues
      // where Claude Code changes JSONL format. Known types we intentionally skip:
      // file-history-snapshot, queue-operation, etc.
      const knownSkippableTypes = new Set(['file-history-snapshot', 'system', 'queue-operation']);
      if (!knownSkippableTypes.has(record.type)) {
        agent.seenUnknownRecordTypes.add(record.type);
        if (debug) {
          console.log(
            `[cc-monitor] JSONL: Agent ${agentId} - unrecognized record type '${record.type}'. ` +
              `Keys: ${Object.keys(record).join(', ')}`,
          );
        }
      }
    }
  } catch {
    // Ignore malformed lines
  }
}

/**
 * Process a `progress` record. Only bash_progress / mcp_progress are consumed:
 * they signal a tool is actively executing (not stuck on permission), so we
 * restart the heuristic permission timer to give it another window. The
 * Notification(permission_prompt) hook cancels this timer when it fires.
 */
function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: AgentStateStore,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId)) {
      startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
    }
  }
}
