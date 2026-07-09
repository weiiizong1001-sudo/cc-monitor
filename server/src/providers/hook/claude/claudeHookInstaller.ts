import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { CLAUDE_HOOK_EVENTS, CLAUDE_HOOK_SCRIPT_NAME } from './constants.js';

/** Marker string used to identify Pixel Agents hook entries in Claude's settings. */
const HOOK_SCRIPT_MARKER = CLAUDE_HOOK_SCRIPT_NAME;

/** A single hook entry in Claude Code's ~/.claude/settings.json hooks config. */
interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
  }>;
}

/** Partial shape of ~/.claude/settings.json (only the hooks field is relevant). */
interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown;
}

/** Returns the absolute path to ~/.claude/settings.json. */
function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Returns the destination path for the hook script (~/.cc-monitor/hooks/claude-hook.js). */
function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CLAUDE_HOOK_SCRIPT_NAME);
}

/** Read and parse ~/.claude/settings.json. Returns empty object if missing or malformed. */
function readClaudeSettings(): ClaudeSettings {
  const settingsPath = getClaudeSettingsPath();
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    }
  } catch (e) {
    console.error(`[cc-monitor] Failed to read Claude settings: ${e}`);
  }
  return {};
}

/** Write settings back to ~/.claude/settings.json via atomic tmp + rename. */
function writeClaudeSettings(settings: ClaudeSettings): void {
  const settingsPath = getClaudeSettingsPath();
  const dir = path.dirname(settingsPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Atomic write via tmp file + rename
    const tmpPath = settingsPath + '.cc-monitor-tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    console.error(`[cc-monitor] Failed to write Claude settings: ${e}`);
  }
}

/** Legacy script name (before rename to claude-hook.js). */
const LEGACY_HOOK_MARKER = 'pixel-agents-hook.js';

/** Check if a hook entry belongs to Pixel Agents (current or legacy script name). */
function isOurHookEntry(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some(
    (h) => h.command.includes(HOOK_SCRIPT_MARKER) || h.command.includes(LEGACY_HOOK_MARKER),
  );
}

/** Build the shell command that Claude Code will execute for each hook event. */
function makeHookCommand(): string {
  const scriptPath = getHookScriptPath();
  return `node "${scriptPath}"`;
}

/** Create a hook entry object for Claude's settings.json. Matcher is empty (catch-all). */
function makeHookEntry(): ClaudeHookEntry {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: makeHookCommand(),
        timeout: 5,
      },
    ],
  };
}

/** Check if Pixel Agents hooks are already installed in ~/.claude/settings.json. */
export function areHooksInstalled(): boolean {
  const settings = readClaudeSettings();
  if (!settings.hooks) return false;
  const events = CLAUDE_HOOK_EVENTS;
  return events.every((event) => {
    const entries = settings.hooks?.[event];
    return Array.isArray(entries) && entries.some(isOurHookEntry);
  });
}

/**
 * Install cc-monitor hook entries into ~/.claude/settings.json for the 4
 * SessionStart / SessionEnd / PermissionRequest / Notification events.
 *
 * Fully replaces any prior monitor's hooks: phase 1 wipes every entry pointing
 * at a claude-hook.js script (current cc-monitor OR legacy pixel-agents paths
 * like .pixel-agents/hooks/claude-hook.js) from ALL event keys — including the
 * 10 events pixel-agents used (Stop, PreToolUse, SubagentStart, …) that
 * cc-monitor no longer installs. Phase 2 then writes the 4 fresh entries. This
 * makes cc-monitor the sole monitor and keeps hook spawn count at the minimum.
 * Idempotent.
 */
export function installHooks(): void {
  const settings = readClaudeSettings();
  if (!settings.hooks) {
    settings.hooks = {};
  }

  let changed = false;

  // Phase 1: remove ALL our entries (current + legacy) from every event key.
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((e) => !isOurHookEntry(e));
    if (filtered.length !== entries.length) {
      if (filtered.length === 0) {
        delete settings.hooks[event];
      } else {
        settings.hooks[event] = filtered;
      }
      changed = true;
    }
  }

  // Phase 2: write our 4 hook entries fresh.
  const events = CLAUDE_HOOK_EVENTS;
  for (const event of events) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
    }
    const entries = settings.hooks[event];
    const filtered = entries.filter((e) => !isOurHookEntry(e));
    filtered.push(makeHookEntry());
    if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
      settings.hooks[event] = filtered;
      changed = true;
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) {
    writeClaudeSettings(settings);
    console.log('[cc-monitor] Hooks installed in ~/.claude/settings.json');
  }
}

/** Remove all Pixel Agents hook entries from ~/.claude/settings.json. Cleans up empty objects. */
export function uninstallHooks(): void {
  const settings = readClaudeSettings();
  if (!settings.hooks) return;

  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((e) => !isOurHookEntry(e));
    if (filtered.length !== entries.length) {
      settings.hooks[event] = filtered;
      changed = true;
    }
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) {
    writeClaudeSettings(settings);
    console.log('[cc-monitor] Hooks removed from ~/.claude/settings.json');
  }
}

/** Copy the shipped hook script from the extension to ~/.cc-monitor/hooks/ */
export function copyHookScript(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', CLAUDE_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[cc-monitor] Hook script not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[cc-monitor] Hook script installed at ${dst}`);
  } catch (e) {
    console.error(`[cc-monitor] Failed to copy hook script: ${e}`);
  }
}
