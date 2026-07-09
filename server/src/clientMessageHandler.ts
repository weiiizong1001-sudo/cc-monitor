import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { claudeProvider } from './providers/index.js';
import { parseTranscriptHistory } from './transcriptParser.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Async hook toggle side effect (install/uninstall + script copy). Provided by cli.ts. */
export type SetHooksEnabledSideEffect = (enabled: boolean) => Promise<void> | void;

export interface ClientMessageContext {
  store: AgentStateStore;
  runtime?: AgentRuntime;
  /** Install/uninstall hooks side effect. Needs server url+token known only to cli.ts. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
}

// ── Setting keys (flat keys in ~/.cc-monitor/config.json) ──
const KEY_WATCH_ALL_SESSIONS = 'watchAllSessions';
const KEY_HOOKS_ENABLED = 'hooksEnabled';

/**
 * Handle incoming ClientMessage from a WebSocket client.
 * cc-monitor only handles: webviewReady, closeAgent, setWatchAllSessions,
 * setHooksEnabled, loadSessionHistory, setSessionGroup, renameSession.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const { store, runtime } = ctx;
  const adapter = store.getAdapter();

  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(send, ctx);
      break;

    case 'closeAgent': {
      const id = msg.id as number | undefined;
      if (id !== undefined) runtime?.removeAgent(id);
      break;
    }

    case 'setWatchAllSessions': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_WATCH_ALL_SESSIONS, enabled);
      if (runtime) runtime.watchAllSessions.current = enabled;
      break;
    }

    case 'setHooksEnabled': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_HOOKS_ENABLED, enabled);
      if (runtime) runtime.hooksEnabled.current = enabled;
      void ctx.onSetHooksEnabled?.(enabled);
      break;
    }

    case 'loadSessionHistory': {
      const id = msg.id as number | undefined;
      if (id === undefined) break;
      const agent = store.get(id);
      if (!agent || !agent.jsonlFile) break;
      const chunks = parseTranscriptHistory(agent.jsonlFile);
      send({ type: 'sessionHistory', id, chunks });
      break;
    }

    case 'setSessionGroup': {
      const id = msg.id as number | undefined;
      if (id === undefined) break;
      runtime?.setSessionGroup(id, msg.group as string | undefined);
      break;
    }

    case 'renameSession': {
      const id = msg.id as number | undefined;
      const title = msg.title as string | undefined;
      if (id === undefined || typeof title !== 'string') break;
      runtime?.renameSession(id, title);
      break;
    }

    default:
      break;
  }
}

function handleWebviewReady(send: WsSend, ctx: ClientMessageContext): void {
  const { store, runtime } = ctx;
  const adapter = store.getAdapter();

  // 1. Provider capabilities (must arrive before any agent messages)
  send({
    type: 'providerCapabilities',
    readingTools: [...claudeProvider.readingTools],
    subagentToolNames: [...claudeProvider.subagentToolNames],
  });

  // 2. Settings
  const watchAllSessions = adapter?.getSetting(KEY_WATCH_ALL_SESSIONS, false) ?? false;
  const hooksEnabled = adapter?.getSetting(KEY_HOOKS_ENABLED, true) ?? true;
  send({
    type: 'settingsLoaded',
    hooksEnabled,
    watchAllSessions,
    extensionVersion: process.env.CC_MONITOR_VERSION ?? '',
  });

  // Sync runtime refs with persisted settings so scanners behave correctly
  // from the first tick after a server restart.
  if (runtime) {
    runtime.watchAllSessions.current = watchAllSessions;
    runtime.hooksEnabled.current = hooksEnabled;
  }

  // 3. Restore persisted external agents
  runtime?.restoreExternalAgents();

  // 4. Existing agents
  const agentIds: number[] = [];
  const folderNames: Record<number, string> = {};
  const sessionIds: Record<number, string> = {};
  const projectDirs: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  const inactiveAgents: Record<number, boolean> = {};
  const lastDataAt: Record<number, number> = {};
  const permissionModes: Record<number, string> = {};
  const groups: Record<number, string> = {};
  const jsonlFiles: Record<number, string> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.folderName) folderNames[id] = agent.folderName;
    if (agent.sessionId) sessionIds[id] = agent.sessionId;
    if (agent.projectDir) projectDirs[id] = agent.projectDir;
    if (agent.isExternal) externalAgents[id] = true;
    if (agent.isActive === false) inactiveAgents[id] = true;
    if (typeof agent.lastDataAt === 'number') lastDataAt[id] = agent.lastDataAt;
    if (agent.permissionMode) permissionModes[id] = agent.permissionMode;
    if (agent.group) groups[id] = agent.group;
    if (agent.jsonlFile) jsonlFiles[id] = agent.jsonlFile;
  }
  send({
    type: 'existingAgents',
    agents: agentIds,
    folderNames,
    sessionIds,
    projectDirs,
    externalAgents,
    inactiveAgents,
    lastDataAt,
    permissionModes,
    groups,
    jsonlFiles,
  });
}
