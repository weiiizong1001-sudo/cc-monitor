#!/usr/bin/env node

/**
 * cc-monitor CLI entry point.
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as fs from 'fs';
import * as path from 'path';

import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import { readConfig } from './configPersistence.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { claudeProvider, copyHookScript } from './providers/index.js';
import { PixelAgentsServer } from './server.js';

// ── Argument parsing ──────────────────────────────────────────

interface CliArgs {
  port: number;
  host: string;
  hookHost?: string;
  scanDirs: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { port: 3100, host: '127.0.0.1', scanDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--hook-host' && argv[i + 1]) {
      args.hookHost = argv[i + 1];
      i++;
    } else if (argv[i] === '--scan-dir' && argv[i + 1]) {
      args.scanDirs.push(argv[i + 1]);
      i++;
    } else if (argv[i] === '--help') {
      console.log(`Usage: cc-monitor [options]

Options:
  --port, -p <number>   Port to listen on (default: 3100)
  --host <string>       Host to bind to (default: 127.0.0.1). Use 0.0.0.0 to
                        expose to the LAN (hook POSTs always require a token;
                        WS from private nets is passwordless, public needs token).
  --hook-host <string>  Address hook scripts POST to (written to server.json).
                        Defaults to --host. Set to a real IP when --host=0.0.0.0
                        so hooks from other machines can reach the server.
  --scan-dir <path>     Adopt every transcript in this claude project dir as an
                        inactive session on startup (repeatable)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Scan-dir resolution ──────────────────────────────────────

/** Resolve a --scan-dir argument to a claude project directory.
 *  If `dir` directly contains .jsonl files, it's already a project dir.
 *  Otherwise treat it as a workspace path and translate to
 *  ~/.claude/projects/<hash> via getSessionDirs. */
function resolveScanDir(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.some((f) => f.endsWith('.jsonl'))) return dir;
  } catch {
    /* not a readable dir — fall through to workspace translation */
  }
  const projectDirs = claudeProvider.getSessionDirs?.(dir) ?? [];
  const pd = projectDirs[0];
  return pd && fs.existsSync(pd) ? pd : null;
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // dist/ contains the CLI bundle plus the web/ SPA directory.
  const distRoot = __dirname;
  const repoRoot = path.join(distRoot, '..');
  const staticDir = fs.existsSync(path.join(distRoot, 'web'))
    ? path.join(distRoot, 'web')
    : undefined;

  // ── Store + adapter (flat config + standalone-scoped agents) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter();
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new PixelAgentsServer();

  try {
    // Create runtime first (before server.start, so we can pass it in)
    const runtime = new AgentRuntime(store, claudeProvider);

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall hooks when user toggles in UI.
    // Captures config from the outer scope after server.start().
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      if (enabled) {
        await claudeProvider.installHooks(
          `http://127.0.0.1:${currentConfig.port}`,
          currentConfig.token,
        );
        copyHookScript(repoRoot);
        console.log('[cc-monitor] Hooks installed (user toggle)');
      } else {
        await claudeProvider.uninstallHooks();
        console.log('[cc-monitor] Hooks uninstalled (user toggle)');
      }
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      hookHost: args.hookHost,
      port: args.port,
      staticDir,
      onSetHooksEnabled,
    });
    currentConfig = { port: config.port, token: config.token };

    // Sync runtime refs with persisted settings BEFORE first scan tick
    runtime.hooksEnabled.current = adapter.getSetting('hooksEnabled', true);
    runtime.watchAllSessions.current = adapter.getSetting('watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so
    if (runtime.hooksEnabled.current) {
      try {
        await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        copyHookScript(repoRoot);
        console.log('[cc-monitor] Hooks installed');
      } catch (err) {
        console.error('[cc-monitor] Failed to install hooks:', err);
      }
    }

    // Resolve --scan-dir flags and persisted startupScanDirs to actual claude
    // project directories. Each entry is either already a project dir (contains
    // .jsonl files) or a workspace path translated to ~/.claude/projects/<hash>
    // via getSessionDirs.
    const persistedConfig = readConfig();
    const rawScanDirs = Array.from(
      new Set([...args.scanDirs, ...persistedConfig.startupScanDirs]),
    );
    const resolvedScanDirs: string[] = [];
    for (const dir of rawScanDirs) {
      const resolved = resolveScanDir(dir);
      if (resolved) {
        resolvedScanDirs.push(resolved);
      } else {
        console.warn(`[cc-monitor] --scan-dir ${dir} resolved to no project directory, skipping`);
      }
    }

    // Live-tracking project dirs. Prefer explicitly resolved --scan-dir dirs;
    // fall back to the cwd-derived project dir when none were provided. These
    // dirs are registered into trackedProjectDirs by startProjectScan, which
    // is what makes onExternalSessionDetected's isTrackedProjectDir guard
    // accept new SessionStart events for this workspace. Using process.cwd()
    // directly here is wrong when the server is launched from the install dir
    // (e.g. ~/cc-monitor) rather than the workspace root: getSessionDirs(cwd)
    // resolves to a non-existent project dir, the guard then rejects every new
    // session, and no agent is ever created from the SessionStart hook.
    const cwd = process.cwd();
    const cwdDirs = claudeProvider.getSessionDirs?.(cwd) ?? [];
    const liveScanDirs =
      resolvedScanDirs.length > 0
        ? resolvedScanDirs
        : cwdDirs[0] && fs.existsSync(cwdDirs[0])
          ? [cwdDirs[0]]
          : [];

    runtime.startStaleCheck();
    for (const projectDir of liveScanDirs) {
      console.log(`[cc-monitor] Scanning project dir: ${projectDir}`);
      // Adopt historical transcripts BEFORE startProjectScan: ensureProjectScan
      // seeds every existing .jsonl into knownJsonlFiles, and scanStartupDir
      // skips files already in that set, so seeding first would adopt nothing.
      // Adopting first surfaces the full history; startProjectScan then
      // registers the dir into trackedProjectDirs (so the SessionStart hook's
      // isTrackedProjectDir guard accepts new sessions) and re-seeds mtimes
      // idempotently for --resume detection.
      runtime.startStartupScan([projectDir], persistedConfig.maxStartupAgents);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
    }

    console.log(`\n  cc-monitor server running at http://${args.host}:${config.port}\n`);

    // ── Graceful shutdown ──
    function shutdown(): void {
      console.log('\nShutting down...');
      runtime.dispose();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
