/**
 * cc-monitor wire protocol (server <-> web).
 *
 * Hand-written: the monitor uses a small message subset, so the asyncapi
 * generation chain is dropped. Add messages here directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | AgentTokenUsage
  | AgentOutput
  | AgentPermissionMode
  | SessionHistory
  | SettingsLoaded;

export type ClientMessage =
  | WebviewReady
  | CloseAgent
  | SetHooksEnabled
  | SetWatchAllSessions
  | LoadSessionHistory
  | SetSessionGroup
  | RenameSession;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  folderName?: string;
  isExternal?: boolean;
  sessionId?: string;
  projectDir?: string;
  permissionMode?: string;
  lastDataAt?: number;
  /** User-assigned group label (management only; not from JSONL). */
  group?: string;
  /** Absolute path to the session transcript JSONL. */
  jsonlFile?: string;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  folderNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
  inactiveAgents?: Record<string, boolean>;
  sessionIds?: Record<string, string>;
  projectDirs?: Record<string, string>;
  lastDataAt?: Record<string, number>;
  permissionModes?: Record<string, string>;
  /** id → user-assigned group label. */
  groups?: Record<string, string>;
  /** id → absolute JSONL transcript path. */
  jsonlFiles?: Record<string, string>;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
}

export type AgentActivityStatus = 'active' | 'waiting' | 'inactive';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface AgentTokenUsage {
  type: 'agentTokenUsage';
  id: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentOutput {
  type: 'agentOutput';
  id: number;
  role: AgentOutputRole;
  text: string;
  toolName?: string;
}

export type AgentOutputRole = 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result';

export interface AgentPermissionMode {
  type: 'agentPermissionMode';
  id: number;
  mode: string;
}

export interface SessionHistory {
  type: 'sessionHistory';
  id: number;
  chunks: OutputChunk[];
}

export interface OutputChunk {
  role: AgentOutputRole;
  text: string;
  toolName?: string;
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  hooksEnabled: boolean;
  watchAllSessions: boolean;
  extensionVersion?: string;
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  enabled: boolean;
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface LoadSessionHistory {
  type: 'loadSessionHistory';
  id: number;
}

export interface SetSessionGroup {
  type: 'setSessionGroup';
  id: number;
  /** New group label; undefined/empty clears the group. */
  group?: string;
}

export interface RenameSession {
  type: 'renameSession';
  id: number;
  /** New display title; appended to the JSONL as a custom-title record. */
  title: string;
}
