/**
 * Provider registry: re-exports all bundled providers.
 *
 * cc-monitor ships a single provider (Claude Code). The adapter (CLI) imports
 * from here rather than reaching into the provider directory directly.
 */

export { claudeProvider } from './hook/claude/claude.js';
export { copyHookScript } from './hook/claude/claudeHookInstaller.js';
