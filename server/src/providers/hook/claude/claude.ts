import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';
import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './claudeHookInstaller.js';

// ── formatToolStatus ──────────────────────────────────────────

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(inp.file_path)}`;
    case 'Edit':
      return `Editing ${base(inp.file_path)}`;
    case 'Write':
      return `Writing ${base(inp.file_path)}`;
    case 'Bash': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '…' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof inp.description === 'string' ? inp.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '…' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return 'Editing notebook';
    default:
      return `Using ${toolName}`;
  }
}

// ── Session dir discovery ─────────────────────────────────────

function getSessionDirs(workspacePath: string): string[] {
  // Claude stores sessions at ~/.claude/projects/<workspace-path-with-dashes>/.
  const dirName = normalizeProjectPath(workspacePath);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);

  if (fs.existsSync(projectDir)) return [projectDir];

  // Case-insensitive fallback for Windows: drive letter casing can differ.
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  try {
    if (fs.existsSync(projectsRoot)) {
      const lowerDirName = dirName.toLowerCase();
      const match = fs.readdirSync(projectsRoot).find((c) => c.toLowerCase() === lowerDirName);
      if (match) return [path.join(projectsRoot, match)];
    }
  } catch {
    /* ignore scan errors */
  }

  return [projectDir];
}

/** Root that holds every Claude session across all workspaces ("Watch All Sessions"). */
function getAllSessionRoots(): string[] {
  return [path.join(os.homedir(), '.claude', 'projects')];
}

// ── normalizeHookEvent: only the 4 events JSONL tailing can't recover ──
//
// cc-monitor installs only SessionStart / SessionEnd / PermissionRequest /
// Notification hooks. Tool start/end, assistant text, token usage, and turn
// completion (Stop) all come from JSONL polling. Any other event name is
// dropped here (return null).

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'Notification': {
      const notificationType =
        typeof raw.notification_type === 'string' ? raw.notification_type : '';
      if (notificationType === 'permission_prompt') {
        return { sessionId, event: { kind: 'permissionRequest' } };
      }
      if (notificationType === 'idle_prompt') {
        // idle_prompt = Claude went idle waiting on the user. awaitingInput
        // drives the "Waiting for input" label (vs "Done" from JSONL turn_duration).
        return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };
      }
      return null;
    }

    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          transcriptPath: typeof raw.transcript_path === 'string' ? raw.transcript_path : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    default:
      return null;
  }
}

// ── Installer wrappers: adapt sync signatures to async interface ──

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  installerInstallHooks();
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  installerUninstallHooks();
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

// ── The provider ──

export const claudeProvider: HookProvider = {
  kind: 'hook',
  id: 'claude',
  displayName: 'Claude Code',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: new Set(['Task', 'Agent', 'AskUserQuestion']),
  subagentToolNames: new Set(['Task', 'Agent']),
  readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),

  getSessionDirs,
  getAllSessionRoots,
  sessionFilePattern: '*.jsonl',
};
