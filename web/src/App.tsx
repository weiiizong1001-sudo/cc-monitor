import { useEffect, useState } from 'react';

import { SessionDetail } from './components/SessionDetail.js';
import { SessionList } from './components/SessionList.js';
import { useBallMessages } from './hooks/useBallMessages.js';
import { isRunning } from './state.js';

function App() {
  const { sessions, loadHistory, setGroup, rename } = useBallMessages();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Auto-select the first active session (or the most recent historical one)
  // on load so the right pane isn't empty.
  useEffect(() => {
    if (selectedId !== null) return;
    const first = sessions.find(isRunning) ?? sessions[0];
    if (first) setSelectedId(first.id);
  }, [sessions, selectedId]);

  // Whenever the selected session changes, ask the server for its transcript
  // (loadHistory is a no-op for active sessions that are already streaming).
  useEffect(() => {
    if (selectedId !== null) loadHistory(selectedId);
  }, [selectedId, loadHistory]);

  const selected = selectedId !== null ? sessions.find((s) => s.id === selectedId) : undefined;

  return (
    <div className="flex h-full w-full bg-[var(--ball-bg)]">
      <aside className="flex h-full w-72 shrink-0 flex-col border-r border-[var(--ball-border)]">
        <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>
      <main className="flex h-full min-w-0 flex-1 flex-col">
        {selected ? (
          <SessionDetail session={selected} onRename={rename} onSetGroup={setGroup} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ball-text-muted)]">
            选择一个会话查看详情
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
