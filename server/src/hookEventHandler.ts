import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { SESSION_END_GRACE_MS } from './constants.js';
import type { SessionRouter } from './sessionRouter.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState } from './types.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

/** Normalized hook event received from any provider's hook script via the HTTP server. */
export interface HookEvent {
  /** Hook event name (e.g., 'SessionStart', 'PermissionRequest', 'Notification') */
  hook_event_name: string;
  /** Claude Code session ID, maps to JSONL filename */
  session_id: string;
  /** Additional provider-specific fields (notification_type, tool_name, etc.) */
  [key: string]: unknown;
}

/**
 * Dispatches normalized AgentEvents to agents based on session_id.
 * Session routing (session→agent mapping, pending sessions, event buffering)
 * is delegated to an injected SessionRouter instance.
 *
 * cc-monitor installs only SessionStart / SessionEnd / PermissionRequest /
 * Notification hooks, so only those four event kinds are routed here. Tool
 * start/end, assistant text, token usage, and turn completion all arrive via
 * JSONL tailing (transcriptParser.ts), not hooks.
 */
interface SessionLifecycleCallbacks {
  /** Called when an external session is detected (unknown session_id in SessionStart).
   *  transcriptPath is undefined for providers without transcripts. */
  onExternalSessionDetected?: (
    sessionId: string,
    transcriptPath: string | undefined,
    cwd: string,
  ) => void;
  /** Called when /clear is detected via hooks (SessionEnd reason=clear + SessionStart source=clear). */
  onSessionClear?: (
    agentId: number,
    newSessionId: string,
    newTranscriptPath: string | undefined,
  ) => void;
  /** Called when a session is resumed (--resume). Clears dismissals so the file can be re-adopted. */
  onSessionResume?: (transcriptPath: string) => void;
  /** Called when a session ends (exit/logout). */
  onSessionEnd?: (agentId: number, reason: string) => void;
}

export class HookEventHandler {
  private lifecycleCallbacks: SessionLifecycleCallbacks = {};

  /** Highest HookProvider.protocolVersion this handler understands. */
  private static readonly SUPPORTED_PROTOCOL_VERSION = 1;

  constructor(
    private agents: AgentStateStore,
    private waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
    private permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
    private provider: HookProvider,
    private sessionRouter: SessionRouter,
    private watchAllSessionsRef?: { current: boolean },
  ) {
    if (provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
      console.warn(
        `[cc-monitor] HookProvider "${provider.id}" reports protocolVersion=${provider.protocolVersion}, ` +
          `but handler understands ${HookEventHandler.SUPPORTED_PROTOCOL_VERSION}. ` +
          `Events from this provider will be dropped.`,
      );
    }
  }

  /** Check if a session is tracked (in workspace project dir, or Watch All Sessions ON). */
  private isTrackedSession(transcriptPath?: string, cwd?: string): boolean {
    if (this.watchAllSessionsRef?.current) return true;
    const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
    if (!projectDir) return false;
    return [...this.agents.values()].some(
      (a) => path.resolve(a.projectDir).toLowerCase() === path.resolve(projectDir).toLowerCase(),
    );
  }

  /** Set callbacks for session lifecycle events (SessionStart/SessionEnd). */
  setLifecycleCallbacks(callbacks: SessionLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  /** Register an agent for hook event routing. Flushes any buffered events for this session. */
  registerAgent(sessionId: string, agentId: number): void {
    const flushed = this.sessionRouter.register(sessionId, agentId);
    if (debug && flushed.length > 0)
      console.log(
        `[cc-monitor] Hook: flushing ${flushed.length} buffered event(s) for session ${sessionId.slice(0, 8)}...`,
      );
    for (const { providerId, event } of flushed) {
      this.handleEvent(providerId, event as HookEvent);
    }
  }

  /** Remove an agent's session mapping (called on agent removal). */
  unregisterAgent(sessionId: string): void {
    this.sessionRouter.unregister(sessionId);
  }

  /**
   * Process an incoming hook event. Looks up the agent by session_id,
   * falls back to auto-discovery scan, or buffers if agent not yet registered.
   * @param providerId - Provider that sent the event ('claude', etc.)
   * @param event - The hook event payload from the CLI tool
   */
  handleEvent(_providerId: string, event: HookEvent): void {
    if (this.provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
      return; // version mismatch already logged in constructor
    }
    // ── Provider normalization boundary ───────────────────────────────────────
    // All raw Claude-specific fields (notification_type, reason, source) are
    // extracted by provider.normalizeHookEvent. Downstream dispatch uses the
    // normalized AgentEvent.kind.
    const normalized = this.provider.normalizeHookEvent(event);
    if (!normalized) return; // unknown / uninteresting event -- silently drop
    const normEvent = normalized.event;
    const eventName = event.hook_event_name; // retained for logs only
    if (process.env['PIXEL_AGENTS_DEBUG_LOG']) {
      try {
        const fs = require('fs') as typeof import('fs');
        const sid = (event.session_id as string | undefined)?.slice(0, 8) ?? '?';
        fs.appendFileSync(
          process.env['PIXEL_AGENTS_DEBUG_LOG']!,
          `${new Date().toISOString()} HOOK kind=${normEvent.kind} sid=${sid} src=${(normEvent as { source?: string }).source ?? ''}\n`,
        );
      } catch {
        /* never crash on diagnostic failure */
      }
    }

    // --- Wake adopted inactive agents on any activity event ---
    // A historical session adopted at startup is marked inactive. If the server
    // restarts while the session is still alive, no new SessionStart arrives —
    // only tool/turn events flow. Any non-sessionEnd event proves the session
    // is alive, so flip it back to active.
    if (normEvent.kind !== 'sessionEnd') {
      const wakeId = this.sessionRouter.resolve(event.session_id);
      if (wakeId !== undefined) {
        const wakeAgent = this.agents.get(wakeId);
        if (wakeAgent && wakeAgent.isActive === false) {
          wakeAgent.isActive = true;
          this.agents.broadcast({ type: 'agentStatus', id: wakeId, status: 'active' });
        }
      }
    }

    // --- SessionStart: handle /clear for known agents, detect external sessions ---
    if (normEvent.kind === 'sessionStart') {
      const sid = event.session_id.slice(0, 8);
      const source = normEvent.source ?? 'unknown';
      const transcriptPath = normEvent.transcriptPath;
      const cwd = normEvent.cwd;
      const tracked = this.isTrackedSession(transcriptPath, cwd);
      if (debug && tracked)
        console.log(`[cc-monitor] Hook: SessionStart(source=${source}, session=${sid}...)`);

      // Check registered mapping
      const existingAgentId = this.sessionRouter.resolve(event.session_id);
      if (existingAgentId !== undefined) {
        const agent = this.agents.get(existingAgentId);
        if (agent && agent.isActive === false) {
          agent.isActive = true;
          this.agents.broadcast({ type: 'agentStatus', id: existingAgentId, status: 'active' });
        }
        if (debug)
          console.log(
            `[cc-monitor] Hook: Agent ${existingAgentId} - SessionStart(source=${source}) known`,
          );
        return;
      }
      // Check auto-discovery (agent exists but not yet registered for hooks)
      for (const [id, agent] of this.agents) {
        if (agent.sessionId === event.session_id) {
          this.registerAgent(agent.sessionId, id);
          if (agent.isActive === false) {
            agent.isActive = true;
            this.agents.broadcast({ type: 'agentStatus', id, status: 'active' });
          }
          if (debug)
            console.log(
              `[cc-monitor] Hook: Agent ${id} - SessionStart(source=${source}) auto-discovered`,
            );
          return;
        }
      }
      // /clear or /resume: reassign existing agent to new session
      if (normEvent.source === 'clear' || normEvent.source === 'resume') {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (projectDir) {
          for (const [id, agent] of this.agents) {
            const isMatch =
              agent.pendingClear &&
              path.resolve(agent.projectDir).toLowerCase() ===
                path.resolve(projectDir).toLowerCase();
            if (isMatch) {
              agent.pendingClear = false;
              console.log(
                `[cc-monitor] Hook: Agent ${id} - /${normEvent.source} detected, reassigning to ${event.session_id}`,
              );
              this.sessionRouter.unregister(agent.sessionId);
              this.registerAgent(event.session_id, id);
              this.lifecycleCallbacks.onSessionClear?.(id, event.session_id, transcriptPath);
              return;
            }
          }
        }
      }
      // Unknown session -- store as pending, create only when a confirmation event
      // arrives (Notification, PermissionRequest). This filters transient sessions
      // from Claude Code Extension which fire SessionStart + SessionEnd without activity.
      if (transcriptPath || cwd) {
        if (normEvent.source === 'resume' && transcriptPath) {
          this.lifecycleCallbacks.onSessionResume?.(transcriptPath);
        }
        if (debug && tracked)
          console.log(
            `[cc-monitor] Hook: SessionStart(source=${source}) -> pending external session ${sid}..., awaiting confirmation`,
          );
        this.sessionRouter.storePending(event.session_id, {
          sessionId: event.session_id,
          transcriptPath,
          cwd: cwd ?? '',
        });
      } else {
        if (debug && tracked)
          console.log(
            `[cc-monitor] Hook: SessionStart -> unknown session ${sid}..., no transcript_path`,
          );
      }
      return;
    }

    // --- All other events: standard agent lookup ---
    // If SessionEnd arrives for a pending external session, discard it (transient session)
    if (normEvent.kind === 'sessionEnd' && this.sessionRouter.hasPending(event.session_id)) {
      this.sessionRouter.discardPending(event.session_id);
      if (debug)
        console.log(
          `[cc-monitor] Hook: SessionEnd discarded pending external session ${event.session_id.slice(0, 8)}...`,
        );
      return;
    }

    // If a confirmation event arrives for a pending external session, create the agent first
    const pending = this.sessionRouter.confirmPending(event.session_id);
    if (pending) {
      if (debug)
        console.log(
          `[cc-monitor] Hook: ${eventName} confirmed external session ${event.session_id.slice(0, 8)}..., creating agent`,
        );
      this.lifecycleCallbacks.onExternalSessionDetected?.(
        pending.sessionId,
        pending.transcriptPath,
        pending.cwd,
      );
      // Re-process this event now that the agent exists
      this.handleEvent(_providerId, event);
      return;
    }

    let agentId = this.sessionRouter.resolve(event.session_id);
    if (agentId === undefined) {
      for (const [id, agent] of this.agents) {
        if (agent.sessionId === event.session_id) {
          this.registerAgent(agent.sessionId, id);
          agentId = id;
          break;
        }
      }
    }
    if (agentId === undefined) {
      // Buffer if: pending external session, already buffering for this session,
      // OR agents exist that haven't been registered yet. Silently drop events
      // for sessions we have no record of (e.g. other projects with Watch All OFF).
      const isPending = this.sessionRouter.hasPending(event.session_id);
      const hasBuffered = this.sessionRouter.hasBuffered(event.session_id);
      const hasUnregisteredAgents = [...this.agents.values()].some(
        (a) => a.sessionId && !this.sessionRouter.hasSession(a.sessionId),
      );
      if (isPending || hasBuffered || hasUnregisteredAgents) {
        if (debug)
          console.log(
            `[cc-monitor] Hook: ${eventName} - unknown session ${event.session_id.slice(0, 8)}..., buffering`,
          );
        this.sessionRouter.bufferEvent(_providerId, event);
      }
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) return;

    if (debug)
      console.log(
        `[cc-monitor] Hook: Agent ${agentId} - ${eventName} (session=${event.session_id.slice(0, 8)}...)`,
      );

    // Dispatch on normalized AgentEvent.kind. Only the 4 hook-driven kinds
    // arrive here; tool/turn/token events come from JSONL tailing.
    switch (normEvent.kind) {
      case 'sessionEnd':
        return this.handleSessionEnd(normEvent, agent, agentId);
      case 'permissionRequest':
        // Handles BOTH the PermissionRequest hook AND the Notification(permission_prompt)
        // hook -- normalizeHookEvent collapses them into one event kind.
        return this.handlePermissionRequest(agent, agentId);
      case 'turnEnd':
        // Notification(idle_prompt) normalizes to turnEnd with awaitingInput=true,
        // surfacing "Waiting for input" instantly (JSONL turn_duration is the fallback).
        return this.markAgentWaiting(agent, agentId, normEvent.awaitingInput === true);
      default:
        return;
    }
  }

  /**
   * Handle SessionEnd: /clear marks pendingClear (SessionStart follows),
   * exit/logout marks agent waiting or triggers cleanup.
   */
  private handleSessionEnd(
    normEvent: Extract<AgentEvent, { kind: 'sessionEnd' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    const reason = normEvent.reason;
    if (debug)
      console.log(
        `[cc-monitor] Hook: Agent ${agentId} - SessionEnd(reason=${reason ?? 'unknown'})`,
      );

    // /clear and /resume send SessionEnd then SessionStart. Wait briefly for the follow-up.
    // All other reasons (exit, logout, prompt_input_exit) are final -- despawn immediately.
    const expectsFollowUp = reason === 'clear' || reason === 'resume';

    if (expectsFollowUp) {
      agent.pendingClear = true;
      this.markAgentWaiting(agent, agentId);
      if (debug)
        console.log(
          `[cc-monitor] Hook: Agent ${agentId} - SessionEnd(reason=${reason}), awaiting possible SessionStart`,
        );
      // Safety net: if SessionStart never arrives, clean up the zombie agent
      setTimeout(() => {
        if (agent.pendingClear) {
          agent.pendingClear = false;
          this.lifecycleCallbacks.onSessionEnd?.(agentId, reason);
        }
      }, SESSION_END_GRACE_MS);
    } else {
      this.markAgentWaiting(agent, agentId);
      this.lifecycleCallbacks.onSessionEnd?.(agentId, reason ?? 'unknown');
    }
  }

  /** Handle PermissionRequest: cancel heuristic timer, show permission bubble on agent. */
  private handlePermissionRequest(agent: AgentState, agentId: number): void {
    cancelPermissionTimer(agentId, this.permissionTimers);
    agent.permissionSent = true;
    this.agents.broadcast({ type: 'agentToolPermission', id: agentId });
  }

  /**
   * Transition agent to waiting state. Clears foreground tools, cancels timers,
   * and notifies the webview. Same logic as the turn_duration handler in
   * transcriptParser.ts.
   */
  private markAgentWaiting(agent: AgentState, agentId: number, awaitingInput = false): void {
    cancelWaitingTimer(agentId, this.waitingTimers);
    cancelPermissionTimer(agentId, this.permissionTimers);

    // Clear foreground tools. ALWAYS send agentToolsClear at turn end -- even
    // when activeToolIds is empty by now (because tool_results already processed
    // and removed them). Without this, stale permission bubbles from the turn
    // would never clear.
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    this.agents.broadcast({ type: 'agentToolsClear', id: agentId });

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    this.agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
      awaitingInput,
    });
  }

  /** Clean up timers and maps. Called on shutdown. */
  dispose(): void {
    this.sessionRouter.dispose();
  }
}
