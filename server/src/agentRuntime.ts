/**
 * AgentRuntime: agent lifecycle core for cc-monitor.
 *
 * Owns timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. The CLI creates an instance and
 * registers lifecycle callbacks. This is the single source of truth for
 * agent lifecycle wiring.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { DismissalTracker } from './dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  isTrackedProjectDir,
  reassignAgentToFile,
  scanStartupDir,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  startExternalSessionScanning,
  startFileWatching,
  startStaleExternalAgentCheck,
} from './fileWatcher.js';
import type { HookEvent } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import { SessionRouter } from './sessionRouter.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { setHookProvider } from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state
  readonly knownJsonlFiles = new Set<string>();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private externalScanTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  private hookEventHandler: HookEventHandler;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};

  constructor(
    private readonly store: AgentStateStore,
    provider: HookProvider,
  ) {
    // Wire module-level dependencies
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(provider);
    setFileWatcherHookProvider(provider);
    setAgentRemovalCallback((id) => this.removeAgent(id));

    this.hookEventHandler = new HookEventHandler(
      store,
      this.waitingTimers,
      this.permissionTimers,
      provider,
      new SessionRouter(),
      this.watchAllSessions,
    );

    // Wire hook lifecycle callbacks to shared agent operations
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (!isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) {
          return;
        }
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.knownJsonlFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => this.registerAgent(agent.sessionId, agent.id),
        );
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        if (newTranscriptPath) {
          this.knownJsonlFiles.add(newTranscriptPath);
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.knownJsonlFiles.delete(transcriptPath);
      },
      onSessionEnd: (agentId) => {
        const agent = this.store.get(agentId);
        if (!agent) return;
        this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (agent.isExternal) {
          // Don't despawn on exit — mark inactive so the session stays in the
          // history list. The session can be resumed later (claude --resume fires
          // SessionStart, which flips isActive back to true).
          agent.isActive = false;
          this.unregisterAgent(agent.sessionId);
          this.store.broadcast({ type: 'agentStatus', id: agentId, status: 'inactive' });
        }
      },
    });
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Hook event routing ──

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    this.hookEventHandler.handleEvent(providerId, event as HookEvent);
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number): void {
    this.hookEventHandler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string): void {
    this.hookEventHandler.unregisterAgent(sessionId);
  }

  // ── Agent removal (shared cleanup) ──

  /** Remove an agent: stop watchers, cancel timers, delete from store. */
  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;

    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Remove from store (fires agentRemoved event) and persist
    this.store.delete(id);
    this.store.persist();
  }

  // ── Web-side session management (group + rename) ──

  /** Assign (or clear) a session's group label. Persists + broadcasts. */
  setSessionGroup(id: number, group?: string): void {
    const agent = this.store.get(id);
    if (!agent) return;
    const next = group && group.trim() ? group.trim() : undefined;
    if (agent.group === next) return;
    agent.group = next;
    this.store.persist();
    // Broadcast with '' (not undefined) for "cleared": JSON.stringify drops
    // undefined fields, so an undefined group would never reach the client and
    // the old label would stick. '' is falsy on the client and renders as
    // ungrouped, matching undefined everywhere it matters.
    this.store.broadcast({ type: 'agentCreated', id, group: next ?? '' });
  }

  /** Rename a session by appending a custom-title record to its JSONL (the
   *  native Claude Code rename format — transcriptParser already honors it).
   *  Also updates folderName in-memory + persists + broadcasts so the label
   *  updates immediately without waiting for the file watcher to re-tail. */
  renameSession(id: number, title: string): void {
    const agent = this.store.get(id);
    if (!agent || !agent.jsonlFile) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    const capped = trimmed.slice(0, 40);
    try {
      // Match the native record shape minimally; parser only reads type +
      // customTitle. Trailing newline keeps it on its own line.
      const record = JSON.stringify({ type: 'custom-title', customTitle: capped });
      fs.appendFileSync(agent.jsonlFile, record + '\n');
    } catch (err) {
      console.error(`[cc-monitor] Failed to rename session ${id}:`, err);
      return;
    }
    agent.folderName = capped;
    this.store.persist();
    this.store.broadcast({ type: 'agentCreated', id, folderName: capped });
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(projectDir: string, onAgentCreated?: (agent: AgentState) => void): void {
    ensureProjectScan(
      projectDir,
      this.knownJsonlFiles,
      this.projectScanTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ?? ((agent) => this.registerAgent(agent.sessionId, agent.id)),
      this.hooksEnabled,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string): void {
    if (this.externalScanTimer) return;

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      this.hooksEnabled,
    );
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    if (this.staleCheckTimer) return;

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.store,
      this.knownJsonlFiles,
      this.hooksEnabled,
    );
  }

  /**
   * One-shot adoption of every transcript under the given directories as an
   * inactive external agent. Used by the CLI `--scan-dir` flag to surface
   * historical sessions on startup.
   */
  startStartupScan(dirs: string[], maxAgents = 0): void {
    for (const dir of dirs) {
      scanStartupDir(
        dir,
        this.knownJsonlFiles,
        this.store.nextAgentId,
        this.store,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        () => this.store.persist(),
        maxAgents,
      );
    }
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here.
   */
  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.knownJsonlFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent: AgentState = {
        id: p.id,
        sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
        isExternal: true,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        lastDataAt: 0,
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName: p.folderName,
        group: p.group,
        isActive: p.isActive === false ? false : true,
        inputTokens: 0,
        outputTokens: 0,
      };

      this.store.set(p.id, agent);
      this.knownJsonlFiles.add(p.jsonlFile);

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[cc-monitor] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. Called on shutdown. */
  dispose(): void {
    this.hookEventHandler.dispose();

    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
    if (this.externalScanTimer) {
      clearInterval(this.externalScanTimer);
      this.externalScanTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }
}
