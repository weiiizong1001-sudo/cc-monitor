/**
 * cc-monitor runs as a pure web app served by the Fastify server (no Electron).
 * The browser connects via WebSocket to `window.location.host`.
 */

/**
 * Best-effort browser notification. Used to surface permission prompts when
 * the monitor tab is in the background. Silently no-ops if the browser does
 * not support notifications or permission has not been granted.
 */
export function showNotification(title: string, body: string): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  try {
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {
    /* ignore */
  }
}
