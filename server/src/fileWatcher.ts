/**
 * Session Detection: Dual-Mode Architecture
 *
 * HOOKS MODE (preferred): Claude Code Hooks API delivers instant, reliable events
 * for session lifecycle (SessionStart, SessionEnd, Stop, PermissionRequest, etc.).
 * When hooks work, heuristic scanners are suppressed via hooksEnabledRef.
 *
 * HEURISTIC MODE (fallback): For environments without hooks (other providers,
 * hooks disabled, older Claude versions). Uses:
 * - Per-agent 500ms JSONL polling for tool activity
 * - 3s external scanner for external session detection
 * - 30s stale check for orphaned external agents
 * - Multiple dismissal systems to prevent re-adoption races
 *
 * JSONL POLLING (always active): readNewLines + processTranscriptLine run in both
 * modes. They provide tool content (status text, animations) that hooks don't carry.
 */
import * as fs from 'fs';
import * as path from 'path';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  FILE_WATCHER_POLL_INTERVAL_MS,
  GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
  GLOBAL_SCAN_ACTIVE_MIN_SIZE,
  PROJECT_SCAN_INTERVAL_MS,
} from './constants.js';
import type { DismissalTracker } from './dismissalTracker.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Dismissal tracker instance. Set once at startup via setDismissalTracker().
 *  Replaces the former module-global dismissedJsonlFiles, clearDismissedFiles,
 *  seededMtimes, and pendingClearFiles Maps/Sets. */
let dismissalTracker: DismissalTracker | null = null;

/** Register the DismissalTracker instance. Called from PixelAgentsViewProvider at startup. */
export function setDismissalTracker(tracker: DismissalTracker): void {
  dismissalTracker = tracker;
}

/** Get the active DismissalTracker (for PixelAgentsViewProvider direct access). */
export function getDismissalTracker(): DismissalTracker | null {
  return dismissalTracker;
}

/** Agent removal callback. Injected by PixelAgentsViewProvider to avoid a
 *  server/src/ → src/ back-import on agentManager.ts. The ViewProvider closure
 *  captures the store and timer Maps, so only the agent ID is needed. */
let agentRemovalCallback: ((id: number) => void) | null = null;

/** Register the agent removal callback. Called by PixelAgentsViewProvider. */
export function setAgentRemovalCallback(cb: typeof agentRemovalCallback): void {
  agentRemovalCallback = cb;
}

export function startFileWatching(
  agentId: number,
  _filePath: string,
  agents: AgentStateStore,
  _fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  // Single polling approach: reliable on all platforms (macOS, Linux, WSL2, Windows).
  // Previously used triple-redundant fs.watch + fs.watchFile + setInterval, but
  // fs.watch is unreliable on macOS/WSL2 and the redundancy created 3 timers per
  // agent doing synchronous I/O. The manual poll at 500ms is fast enough for a
  // pixel art visualization and works everywhere.
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      return;
    }
    readNewLines(agentId, agents, waitingTimers, permissionTimers);
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    // Cap single read at 64KB to prevent blocking on massive JSONL dumps.
    // Remaining data will be picked up on the next poll cycle.
    const MAX_READ_BYTES = 65536;
    const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      // New data arriving — cancel timers (data flowing means agent is still active).
      // When hooks are active, don't clear permission state here — the hook gave us a
      // definitive signal that permission is needed. Only a new user prompt or tool_result
      // (processed in transcriptParser) should clear it.
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent) {
        agent.permissionSent = false;
        agents.broadcast({ type: 'agentToolPermissionClear', id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers);
    }
  } catch (e) {
    // ENOENT is expected for hook-detected agents where the JSONL file hasn't been created yet
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.log(`[cc-monitor] Watcher: Agent ${agentId} - read error: ${e}`);
  }
}

// Track all project directories to scan (supports multi-root workspaces)
const trackedProjectDirs = new Set<string>();

/** Check if a project dir is tracked by the workspace scanner. */
export function isTrackedProjectDir(dir: string): boolean {
  if (trackedProjectDirs.has(dir)) return true;
  // Case-insensitive fallback for Windows (drive letter casing: c:\ vs C:\)
  const resolved = path.resolve(dir).toLowerCase();
  for (const tracked of trackedProjectDirs) {
    if (path.resolve(tracked).toLowerCase() === resolved) return true;
  }
  return false;
}

/**
 * Seed a project directory's known files and register it for periodic scanning.
 * Can be called multiple times with different directories — all will be scanned
 * by the single shared interval timer.
 */
export function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  _onAgentCreated?: (agent: AgentState) => void,
  hooksEnabledRef?: { current: boolean },
): void {
  // Always seed this directory's files (supports multi-root workspaces).
  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
    for (const f of files) {
      // Seed all files and track mtime. External scanner detects --resume
      // by comparing current mtime to seeded mtime (changed = new writes).
      knownJsonlFiles.add(f);
      try {
        const stat = fs.statSync(f);
        dismissalTracker!.seedMtime(f, stat.mtimeMs);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  // Register for periodic scanning
  trackedProjectDirs.add(projectDir);

  // Start the shared timer only once
  if (projectScanTimerRef.current) return;
  projectScanTimerRef.current = setInterval(() => {
    // When hooks are active, SessionStart handles new file detection.
    if (hooksEnabledRef?.current) return;

    for (const dir of trackedProjectDirs) {
      scanForNewJsonlFiles(
        dir,
        knownJsonlFiles,
        activeAgentIdRef,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, PROJECT_SCAN_INTERVAL_MS);
}

export function scanForNewJsonlFiles(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  _activeAgentIdRef: { current: number | null },
  _nextAgentIdRef: { current: number },
  _agents: AgentStateStore,
  _fileWatchers: Map<number, fs.FSWatcher>,
  _pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  _waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  _permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  _persistAgents: () => void,
  _onAgentCreated?: (agent: AgentState) => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  // Track files seen by the scanner. cc-monitor does not adopt terminals; new
  // sessions are detected via hooks (SessionStart) or the external-session
  // scanner. Files remain out of knownJsonlFiles until claimed elsewhere.
  for (const file of files) {
    if (knownJsonlFiles.has(file)) continue;
  }
}

// ── Hook provider ──

/** Hook provider: supplies capabilities fileWatcher needs (all-session roots
 *  for global discovery). Set once at startup. */
let hookProvider: HookProvider | null = null;

/** Register the active HookProvider. */
export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

// ── External session support (VS Code extension panel, etc.) ──

/**
 * Adopt an external session detected via hooks (SessionStart for unknown session_id).
 * Thinner wrapper than filesystem-based adoptExternalSession: hooks provide
 * transcript_path and cwd directly, no scanning needed.
 */
export function adoptExternalSessionFromHook(
  sessionId: string,
  transcriptPath: string | undefined,
  cwd: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (transcriptPath) {
    // File-based provider (Claude, Codex): adopt with JSONL file watching
    // Guard: don't adopt if file is already tracked by an agent
    for (const agent of agents.values()) {
      if (agent.jsonlFile === transcriptPath) return;
    }
    // Don't check knownJsonlFiles here -- hooks confirmed this is a real session,
    // and seeded files at startup are in knownJsonlFiles but may become active later.
    if (dismissalTracker!.isDismissed(transcriptPath)) return;
    if (dismissalTracker!.isPermanentlyDismissed(transcriptPath)) return;

    knownJsonlFiles.add(transcriptPath);
    const projectDir = path.dirname(transcriptPath);
    const folderName = folderNameFromProjectDir(path.basename(projectDir));

    adoptExternalSession(
      transcriptPath,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      folderName,
    );

    const adoptedAgent = [...agents.values()].find((a) => a.jsonlFile === transcriptPath);
    if (adoptedAgent && debug) {
      console.log(
        `[cc-monitor] Hook: Agent ${adoptedAgent.id} - detected external session ${path.basename(transcriptPath)}${adoptedAgent.folderName ? ` (${adoptedAgent.folderName})` : ''}`,
      );
    }
    if (adoptedAgent) {
      adoptedAgent.sessionId = sessionId;
      onAgentCreated?.(adoptedAgent);
    }
  } else {
    // Hooks-only provider (OpenCode, Copilot): no transcript file, all state from hooks
    const id = nextAgentIdRef.current++;
    const folderName = cwd ? path.basename(cwd) : undefined;
    const agent: AgentState = {
      id,
      sessionId,
      isExternal: true,
      projectDir: cwd,
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName,
      inputTokens: 0,
      outputTokens: 0,
    };
    agents.set(id, agent);
    persistAgents();
    if (debug) {
      console.log(
        `[cc-monitor] Hook: Agent ${id} - detected hooks-only external session${folderName ? ` (${folderName})` : ''}`,
      );
    }
    onAgentCreated?.(agent);
  }
}

/**
 * Scan a transcript file once (at adoption time) to derive a display name.
 * Returns the `aiTitle` from an `ai-title` record if present (Claude-generated
 * conversation title); otherwise returns the first user text prompt, truncated.
 * Returns undefined if neither is found. Used so historical sessions adopted
 * at startup show a meaningful label instead of the project directory name.
 */
function extractSessionTitle(jsonlFile: string): string | undefined {
  try {
    const content = fs.readFileSync(jsonlFile, 'utf-8');
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    let firstUserText: string | undefined;
    for (const line of content.split('\n')) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      // custom-title (user rename) wins; keep the last one in case of repeated
      // renames. ai-title is the model-generated fallback. firstUserText is the
      // final fallback when neither exists.
      if (
        record.type === 'custom-title' &&
        typeof record.customTitle === 'string' &&
        record.customTitle
      ) {
        customTitle = record.customTitle.slice(0, 40);
      } else if (
        record.type === 'ai-title' &&
        !aiTitle &&
        typeof record.aiTitle === 'string' &&
        record.aiTitle
      ) {
        aiTitle = record.aiTitle.slice(0, 40);
      } else if (!firstUserText && record.type === 'user') {
        const c = record.content;
        if (typeof c === 'string' && c.trim()) {
          firstUserText = c.trim().replace(/\s+/g, ' ').slice(0, 30);
        } else if (Array.isArray(c)) {
          for (const part of c) {
            if (
              part &&
              typeof part === 'object' &&
              typeof part.text === 'string' &&
              part.text.trim()
            ) {
              firstUserText = part.text.trim().replace(/\s+/g, ' ').slice(0, 30);
              break;
            }
          }
        }
      }
    }
    return customTitle || aiTitle || firstUserText;
  } catch {
    return undefined;
  }
}

function adoptExternalSession(
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  folderName?: string,
  isActive = true,
): void {
  const id = nextAgentIdRef.current++;
  // Decide whether to replay the existing file content or skip to its end.
  //
  // The external scanner runs every EXTERNAL_SCAN_INTERVAL_MS. A freshly-created
  // session writes its first records in the gap between scanner ticks (typical
  // mock-claude scenarios: tool_use at t=1s, scanner ticks at t=3s). If we
  // unconditionally skip to the end of the file, those pre-adoption records
  // are silently discarded — the agent character appears but its tool history
  // and active tools never surface, producing a "stuck on Idle" UI and flaky
  // e2e failures whose mode depends entirely on scanner-tick alignment.
  //
  // Heuristic: a file whose birthtime is inside the scan window (2× the
  // interval, for one missed tick of margin) is "a session we just watched
  // come to life" — replay it from the start so no records are lost. Older
  // files are ongoing sessions the user already had running before adoption;
  // for those we keep the original skip-to-end behavior so an hours-long
  // session doesn't flash hundreds of past tool overlays through the UI.
  //
  // birthtimeMs is reliable on macOS APFS, Windows NTFS, and modern Linux
  // ext4. On filesystems that don't track it, Node returns the epoch (0) —
  // we treat that as "very old" and skip to end, matching prior behavior.
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    const ageMs = stat.birthtimeMs > 0 ? Date.now() - stat.birthtimeMs : Number.POSITIVE_INFINITY;
    const freshnessWindowMs = EXTERNAL_SCAN_INTERVAL_MS * 2;
    fileOffset = ageMs <= freshnessWindowMs ? 0 : stat.size;
  } catch {
    /* start from beginning if stat fails */
  }
  const agent: AgentState = {
    id,
    sessionId: path.basename(jsonlFile, '.jsonl'),
    isExternal: true,
    projectDir,
    jsonlFile,
    fileOffset,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    folderName,
    isActive,
    inputTokens: 0,
    outputTokens: 0,
  };

  agents.set(id, agent);
  persistAgents();

  // Best-effort: derive a human-readable display name for this session by
  // scanning its transcript. Prefers Claude's "ai-title" record; falls back to
  // the first user prompt. Stored on folderName (rendered as the agent label).
  const title = extractSessionTitle(jsonlFile);
  if (title) {
    agent.folderName = title;
  }

  // Log is emitted by the caller (adoptExternalSessionFromHook or scanExternalDir)
  // to use the correct prefix (Hook: vs Watcher:).

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers);
}

/**
 * Periodically scans for external sessions (VS Code extension panel, etc.)
 * that produce JSONL files without an associated terminal.
 */
export function startExternalSessionScanning(
  _projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  _jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,

  persistAgents: () => void,
  watchAllSessionsRef?: { current: boolean },
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    // When hooks are active, SessionStart handles workspace session detection.
    // Only skip workspace scanning; global scanning (Watch All) still needed
    // because hooks can't detect already-running sessions from other projects.
    if (!hooksEnabledRef?.current) {
      // Scan all tracked project dirs (heuristic fallback)
      for (const dir of trackedProjectDirs) {
        scanExternalDir(
          dir,
          knownJsonlFiles,
          nextAgentIdRef,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          persistAgents,
        );
      }
    }
    // If "Watch All Sessions" is ON, also scan all global project dirs
    if (watchAllSessionsRef?.current) {
      scanGlobalProjectDirs(
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, EXTERNAL_SCAN_INTERVAL_MS);
}

/** Scan a single project dir for external sessions. */
export function scanExternalDir(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  const now = Date.now();

  // If an internal agent in this projectDir is still waiting for its JSONL file
  // (file doesn't exist), skip all adoptions. The agent may have done /resume,
  // and agentManager will detect and reassign it. Prevents the scanner from
  // stealing the file as a new external agent.
  const hasOrphanedInternal = [...agents.values()].some((a) => {
    if (a.isExternal || a.projectDir !== projectDir) return false;
    try {
      fs.statSync(a.jsonlFile);
      return false;
    } catch {
      return true;
    }
  });
  if (hasOrphanedInternal) return;

  for (const file of files) {
    // --resume detection: seeded files whose mtime changed have new data.
    // Adopt directly, bypassing content check (old /clear files have
    // /clear content but should still be adoptable when resumed).
    // File stays in knownJsonlFiles (safe from per-agent /clear stealing).
    const seededMtime = dismissalTracker!.getSeededMtime(file);
    if (seededMtime !== undefined) {
      // Seeded files are pre-existing at extension startup. If mtime changed,
      // it could be --resume or internal agent activity. Don't adopt or reassign
      // here (too ambiguous, causes cascading stealing). Just remove from tracking
      // so the file can be handled through normal adoption if appropriate.
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > seededMtime) {
          dismissalTracker!.clearSeededMtime(file);
          knownJsonlFiles.delete(file);
        }
      } catch {
        /* ignore */
      }
      continue;
    }

    // Skip files already known (seeded or adopted).
    if (knownJsonlFiles.has(file)) continue;

    // Skip files permanently dismissed by /clear (never re-adopted)
    if (dismissalTracker!.isPermanentlyDismissed(file)) continue;

    // Skip files recently dismissed by the user (closed via X).
    // isDismissed() handles the 3-minute cooldown and auto-expires old entries.
    if (dismissalTracker!.isDismissed(file)) continue;

    // Check if already tracked by an agent (normalize paths for comparison).
    // This prevents the external scanner from adopting /clear files (already
    // reassigned to a terminal agent) while allowing untracked files through.
    const normalizedFile = path.resolve(file);
    let tracked = false;
    for (const agent of agents.values()) {
      if (path.resolve(agent.jsonlFile) === normalizedFile) {
        tracked = true;
        break;
      }
    }
    if (tracked) continue;

    // Only adopt recently-active files (modified within threshold).
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > EXTERNAL_ACTIVE_THRESHOLD_MS) continue;
    } catch {
      continue;
    }

    // Content check with two-tick delay for /clear files:
    // First tick: skip /clear files (give per-agent 3s to claim for internal /clear).
    // Second tick: per-agent didn't claim → adopt as new external agent.
    try {
      const buf = Buffer.alloc(8192);
      const fd = fs.openSync(file, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      if (buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) {
        if (!dismissalTracker!.hasPendingClear(file)) {
          dismissalTracker!.registerPendingClear(file);
          continue; // First tick: skip, give per-agent a chance
        }
        dismissalTracker!.clearPendingClear(file);
        // Second tick: per-agent didn't claim → fall through to adopt
      }
    } catch {
      continue;
    }

    knownJsonlFiles.add(file);
    console.log(`[cc-monitor] Watcher: detected external session ${path.basename(file)}`);
    adoptExternalSession(
      file,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );
  }
}

/** Derive a readable folder name from the Claude project dir hash. */
function folderNameFromProjectDir(dirName: string): string {
  const parts = dirName.replace(/^-+/, '').split('-');
  return parts[parts.length - 1] || dirName;
}

/** Scan every session root the active provider exposes for active sessions
 *  (global discovery — powers the "Watch All Sessions" toggle). */
/**
 * One-shot startup scan of an explicit project directory: adopts EVERY .jsonl
 * transcript in it as an external agent, regardless of age or size, marking
 * each inactive (isActive=false) so the webview places them in the living area.
 * Used by the CLI `--scan-dir` flag to surface historical sessions as
 * characters on startup. Skips files already tracked by an existing agent.
 */
export function scanStartupDir(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  maxAgents = 0,
): number {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return 0;
  }
  // Sort by mtime descending (most-recently-modified first) so the cap keeps
  // the sessions the user actually still uses, dropping ancient ones.
  const filesWithMtime = files.map((file) => {
    try {
      return { file, mtime: fs.statSync(file).mtimeMs };
    } catch {
      return { file, mtime: 0 };
    }
  });
  filesWithMtime.sort((a, b) => b.mtime - a.mtime);
  let filesToAdopt = filesWithMtime.map((f) => f.file);
  if (maxAgents > 0) {
    filesToAdopt = filesToAdopt.slice(0, maxAgents);
  }
  const folderName = folderNameFromProjectDir(path.basename(projectDir));
  let adopted = 0;
  for (const file of filesToAdopt) {
    if (knownJsonlFiles.has(file)) continue;
    let tracked = false;
    for (const agent of agents.values()) {
      if (agent.jsonlFile === file) {
        tracked = true;
        break;
      }
    }
    if (tracked) continue;
    knownJsonlFiles.add(file);
    // Historical sessions start inactive (living area). An agent only moves to a
    // workstation while it's actively outputting (toolStart → agentStatus
    // 'active'); it returns to the living area when the turn ends (waiting) or
    // the session exits (inactive).
    adoptExternalSession(
      file,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      folderName,
      false,
    );
    adopted++;
  }
  if (adopted > 0) {
    console.log(`[cc-monitor] Startup scan: adopted ${adopted} session(s) from ${projectDir}`);
  }
  return adopted;
}

function scanGlobalProjectDirs(
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  const roots = hookProvider?.getAllSessionRoots?.() ?? [];
  if (roots.length === 0) return;

  const projectDirs: string[] = [];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) projectDirs.push(path.join(root, entry.name));
      }
    } catch {
      // root missing / unreadable -> skip
    }
  }

  const now = Date.now();
  for (const dirPath of projectDirs) {
    // Skip directories already tracked by workspace scanning
    if (trackedProjectDirs.has(dirPath)) continue;

    let files: string[];
    try {
      files = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dirPath, f));
    } catch {
      continue;
    }

    for (const file of files) {
      if (knownJsonlFiles.has(file)) continue;
      let tracked = false;
      for (const agent of agents.values()) {
        if (agent.jsonlFile === file) {
          tracked = true;
          break;
        }
      }
      if (tracked) continue;
      // Activity filter: >3KB AND modified within 10 minutes
      try {
        const stat = fs.statSync(file);
        if (stat.size < GLOBAL_SCAN_ACTIVE_MIN_SIZE) continue;
        if (now - stat.mtimeMs > GLOBAL_SCAN_ACTIVE_MAX_AGE_MS) continue;
      } catch {
        continue;
      }

      const folderName = folderNameFromProjectDir(path.basename(dirPath));
      knownJsonlFiles.add(file);
      console.log(
        `[cc-monitor] Watcher: detected global session ${path.basename(file)} (${folderName})`,
      );
      adoptExternalSession(
        file,
        dirPath,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
        folderName,
      );
    }
  }
}

/**
 * Periodically removes stale external agents whose JSONL files
 * haven't been modified recently.
 */
export function startStaleExternalAgentCheck(
  agents: AgentStateStore,
  knownJsonlFiles: Set<string>,
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    // When hooks are active, SessionEnd handles agent cleanup.
    if (hooksEnabledRef?.current) return;
    const toRemove: number[] = [];

    for (const [id, agent] of agents) {
      if (!agent.isExternal) continue;

      // Only despawn if the JSONL file has been deleted from disk.
      // Inactive external agents stay alive so they can resume when
      // the session continues (e.g., claude --resume).
      try {
        fs.statSync(agent.jsonlFile);
        // File still exists — keep the agent alive regardless of mtime
      } catch {
        // File deleted — remove agent
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const agent = agents.get(id);
      if (agent) {
        // Remove from knownJsonlFiles so the file can be re-adopted if it becomes active again
        knownJsonlFiles.delete(agent.jsonlFile);
      }
      console.log(`[cc-monitor] Watcher: Agent ${id} - removing stale external agent`);
      agentRemovalCallback?.(id);
    }
  }, EXTERNAL_STALE_CHECK_INTERVAL_MS);
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop old file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Clear activity
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, agents, permissionTimers);

  // Permanently dismiss old file so scanners never re-adopt it as external
  dismissalTracker!.permanentlyDismiss(agent.jsonlFile);

  // Swap to new file (update sessionId for hook registration).
  agent.sessionId = path.basename(newFilePath, '.jsonl');
  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  // Start watching new file
  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers);
}
