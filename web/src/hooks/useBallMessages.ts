import { useCallback, useEffect, useRef, useState } from 'react';

import type { ServerMessage } from '../../../core/src/messages.js';
import { MAX_OUTPUT_CHUNKS, STALE_MS, STALE_TICK_MS } from '../constants.js';
import { showNotification } from '../runtime.js';
import type { OutputChunk, SessionView } from '../state.js';
import { transport } from '../transport/index.js';

/** Helper: fire a best-effort browser notification (no-op if not permitted). */
function notify(title: string, body: string): void {
  showNotification(title, body);
}

/** Helper: derive a short display name for notifications. */
function label(s: SessionView): string {
  return s.folderName || s.projectDir || `Session ${s.id}`;
}

function basename(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || undefined;
}

export interface BallState {
  sessions: SessionView[];
  connected: boolean;
  /** Ask the server to replay a session's transcript. No-op for active
   *  sessions — they're already streaming live output, and re-reading the
   *  whole transcript would duplicate chunks. Inactive (historical) sessions
   *  have no live stream, so this is how the detail view gets their content. */
  loadHistory: (id: number) => void;
  /** Assign (or clear) a session's group label. */
  setGroup: (id: number, group?: string) => void;
  /** Rename a session (appends a custom-title record to its JSONL). */
  rename: (id: number, title: string) => void;
}

export function useBallMessages(): BallState {
  const [sessions, setSessions] = useState<Map<number, SessionView>>(new Map());
  const [connected, setConnected] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Mutation helper: update one session by id, then commit to React state.
  const mutate = useCallback((id: number, fn: (s: SessionView) => SessionView | null) => {
    setSessions((prev) => {
      const cur = prev.get(id);
      if (!cur) return prev;
      const next = fn(cur);
      const m = new Map(prev);
      if (next === null) m.delete(id);
      else m.set(id, next);
      return m;
    });
  }, []);

  const upsert = useCallback((id: number, patch: Partial<SessionView>) => {
    setSessions((prev) => {
      const m = new Map(prev);
      const cur = m.get(id);
      m.set(id, { ...(cur ?? blankSession(id)), ...patch });
      return m;
    });
  }, []);

  const loadHistory = useCallback((id: number) => {
    const s = sessionsRef.current.get(id);
    // Pull the transcript once per session. Active sessions get the replayed
    // history on first open (their output starts empty because the server
    // only tails from the adoption offset), then keep streaming live chunks
    // on top of it. Inactive sessions have no live stream at all.
    if (!s || s.historyLoaded) return;
    transport.send({ type: 'loadSessionHistory', id });
  }, []);

  const setGroup = useCallback((id: number, group?: string) => {
    transport.send({ type: 'setSessionGroup', id, group });
  }, []);

  const rename = useCallback((id: number, title: string) => {
    transport.send({ type: 'renameSession', id, title });
  }, []);

  useEffect(() => {
    const off = transport.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'existingAgents': {
          const m = new Map<number, SessionView>();
          const names = msg.folderNames ?? {};
          const sessionIds = msg.sessionIds ?? {};
          const projectDirs = msg.projectDirs ?? {};
          const lastDataAt = msg.lastDataAt ?? {};
          const permissionModes = msg.permissionModes ?? {};
          const inactive = msg.inactiveAgents ?? {};
          const groups = msg.groups ?? {};
          const jsonlFiles = msg.jsonlFiles ?? {};
          for (const id of msg.agents) {
            const isInactive = inactive[String(id)] === true;
            m.set(id, {
              ...blankSession(id),
              folderName: names[String(id)],
              sessionId: sessionIds[String(id)],
              projectDir: projectDirs[String(id)],
              lastDataAt: lastDataAt[String(id)] ?? 0,
              permissionMode: permissionModes[String(id)],
              status: isInactive ? 'inactive' : 'waiting',
              group: groups[String(id)],
              jsonlFile: jsonlFiles[String(id)],
            });
          }
          setSessions(m);
          break;
        }
        case 'agentCreated': {
          // Conditional patch: agentCreated is reused to push single-field
          // updates (folderName on rename, group on setSessionGroup), so we
          // must not overwrite the other field with undefined.
          // status / lastDataAt are intentionally OMITTED: a brand-new agent
          // defaults to active/now via blankSession() in upsert, but a rename
          // or group change on an INACTIVE session must NOT flip it to active.
          const patch: Partial<SessionView> = {};
          if (msg.folderName !== undefined) patch.folderName = msg.folderName;
          if (msg.sessionId !== undefined) patch.sessionId = msg.sessionId;
          if (msg.projectDir !== undefined) patch.projectDir = msg.projectDir;
          if (msg.permissionMode !== undefined) patch.permissionMode = msg.permissionMode;
          if (msg.group !== undefined) patch.group = msg.group;
          if (msg.jsonlFile !== undefined) patch.jsonlFile = msg.jsonlFile;
          upsert(msg.id, patch);
          break;
        }
        case 'agentClosed': {
          setSessions((prev) => {
            const m = new Map(prev);
            m.delete(msg.id);
            return m;
          });
          break;
        }
        case 'agentStatus': {
          const nextStatus = msg.status;
          mutate(msg.id, (s) => {
            const wasWaiting = s.status === 'waiting';
            const nowWaiting = nextStatus === 'waiting';
            // Fire a completion notification on the active→waiting transition.
            if (nowWaiting && !wasWaiting && !s.waitingNotified) {
              notify(`${label(s)} 完成`, '等待输入');
            }
            return {
              ...s,
              status: nextStatus,
              // Reset one-shot flags when activity resumes.
              waitingNotified: nowWaiting ? true : s.waitingNotified,
              stuckNotified: nextStatus === 'active' ? false : s.stuckNotified,
            };
          });
          break;
        }
        case 'agentToolStart': {
          mutate(msg.id, (s) => ({
            ...s,
            currentTool: msg.status,
            status: 'active',
            stuckNotified: false,
          }));
          break;
        }
        case 'agentToolDone': {
          // Keep currentTool label until next tool starts or turn ends; just
          // surface that the tool finished by clearing the active marker.
          break;
        }
        case 'agentToolsClear': {
          mutate(msg.id, (s) => ({ ...s, currentTool: undefined }));
          break;
        }
        case 'agentToolPermission': {
          mutate(msg.id, (s) => {
            const tool = s.currentTool ?? '工具';
            notify(`${label(s)} 需要批准`, tool);
            return { ...s, permissionPending: true };
          });
          break;
        }
        case 'agentToolPermissionClear': {
          mutate(msg.id, (s) => ({ ...s, permissionPending: false }));
          break;
        }
        case 'agentTokenUsage': {
          mutate(msg.id, (s) => ({
            ...s,
            inputTokens: msg.inputTokens,
            outputTokens: msg.outputTokens,
          }));
          break;
        }
        case 'agentOutput': {
          const chunk: OutputChunk = { role: msg.role, text: msg.text, toolName: msg.toolName };
          mutate(msg.id, (s) => {
            const output =
              s.output.length >= MAX_OUTPUT_CHUNKS
                ? [...s.output.slice(s.output.length - MAX_OUTPUT_CHUNKS + 1), chunk]
                : [...s.output, chunk];
            return { ...s, output, lastDataAt: Date.now(), stuckNotified: false };
          });
          break;
        }
        case 'sessionHistory': {
          // Server reply to loadSessionHistory: replace this session's output
          // with the parsed transcript so opening a historical/inactive session
          // shows what was said before. Each chunk already carries role/text/toolName.
          // Bump scrollNonce so OutputStream jumps to the latest line.
          mutate(msg.id, (s) => ({
            ...s,
            output: (msg.chunks ?? []).slice(-MAX_OUTPUT_CHUNKS),
            lastDataAt: Date.now(),
            historyLoaded: true,
            scrollNonce: (s.scrollNonce ?? 0) + 1,
          }));
          break;
        }
        case 'agentPermissionMode': {
          mutate(msg.id, (s) => ({ ...s, permissionMode: msg.mode }));
          break;
        }
        default:
          // Messages we don't care about for v1 (layout, assets, subagent, etc.).
          break;
      }
    });

    const offState = transport.onStateChange((s) => {
      setConnected(s === 'connected');
    });

    // Announce readiness so the server sends existingAgents.
    transport.send({ type: 'webviewReady' });

    return () => {
      off();
      offState?.();
    };
  }, [mutate, upsert]);

  // Stuck-detection tick: every STALE_TICK_MS, mark active sessions whose
  // lastDataAt is older than STALE_MS as stuck and fire a one-shot notification.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setSessions((prev) => {
        let changed = false;
        const m = new Map(prev);
        for (const [id, s] of m) {
          // Only check stuck while a tool is actually running. Claude thinks
          // between turns / tools with no hook events and no JSONL growth, so
          // lastDataAt goes stale during thinking — that's not a stuck tool,
          // it's just the model reasoning. Reserve stuck for a tool that's
          // hanging (currentTool set + no data for STALE_MS).
          if (s.status !== 'active' || !s.currentTool) {
            if (s.stuck) {
              m.set(id, { ...s, stuck: false, stuckNotified: false });
              changed = true;
            }
            continue;
          }
          const isStuck = now - s.lastDataAt > STALE_MS;
          if (isStuck && !s.stuck) {
            if (!s.stuckNotified) {
              notify(`${label(s)} 疑似卡死`, `${Math.round(STALE_MS / 1000)}s 无活动`);
            }
            m.set(id, { ...s, stuck: true, stuckNotified: true });
            changed = true;
          } else if (!isStuck && s.stuck) {
            m.set(id, { ...s, stuck: false });
            changed = true;
          }
        }
        return changed ? m : prev;
      });
    }, STALE_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  return { sessions: Array.from(sessions.values()), connected, loadHistory, setGroup, rename };
}

function blankSession(id: number): SessionView {
  return {
    id,
    status: 'active',
    lastDataAt: Date.now(),
    output: [],
    inputTokens: 0,
    outputTokens: 0,
    permissionPending: false,
    stuckNotified: false,
    waitingNotified: false,
    stuck: false,
  };
}

// Re-export for components that need it.
export { basename };
