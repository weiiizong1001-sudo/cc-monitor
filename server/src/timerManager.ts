import type { AgentStateStore } from './agentStateStore.js';
import { PERMISSION_TIMER_DELAY_MS } from './constants.js';
import type { AgentState } from './types.js';

export function clearAgentActivity(
  agent: AgentState | undefined,
  agentId: number,
  agents: AgentStateStore,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  if (!agent) return;

  agent.activeToolIds.clear();
  agent.activeToolStatuses.clear();
  agent.activeToolNames.clear();

  agent.isWaiting = false;
  agent.permissionSent = false;
  cancelPermissionTimer(agentId, permissionTimers);
  agents.broadcast({ type: 'agentToolsClear', id: agentId });
  agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
}

export function cancelWaitingTimer(
  agentId: number,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = waitingTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    waitingTimers.delete(agentId);
  }
}

export function startWaitingTimer(
  agentId: number,
  delayMs: number,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  const timer = setTimeout(() => {
    waitingTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (agent) {
      agent.isWaiting = true;
    }
    agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
      // Heuristic text-idle timer: the turn ended without a clear idle signal,
      // so this is "Done", not "Waiting for input".
      awaitingInput: false,
    });
  }, delayMs);
  waitingTimers.set(agentId, timer);
}

export function cancelPermissionTimer(
  agentId: number,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = permissionTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    permissionTimers.delete(agentId);
  }
}

export function startPermissionTimer(
  agentId: number,
  agents: AgentStateStore,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionExemptTools: ReadonlySet<string>,
): void {
  cancelPermissionTimer(agentId, permissionTimers);
  const timer = setTimeout(() => {
    permissionTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (!agent) return;

    // Only flag if there are still active non-exempt tools
    let hasNonExempt = false;
    for (const toolId of agent.activeToolIds) {
      const toolName = agent.activeToolNames.get(toolId);
      if (!permissionExemptTools.has(toolName || '')) {
        hasNonExempt = true;
        break;
      }
    }

    if (hasNonExempt) {
      agent.permissionSent = true;
      console.log(`[cc-monitor] Timer: Agent ${agentId} - possible permission wait detected`);
      agents.broadcast({
        type: 'agentToolPermission',
        id: agentId,
      });
    }
  }, PERMISSION_TIMER_DELAY_MS);
  permissionTimers.set(agentId, timer);
}
