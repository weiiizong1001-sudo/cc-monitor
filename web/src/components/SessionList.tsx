import type { SessionView } from '../state.js';
import { displayName, isRunning } from '../state.js';

interface SessionListProps {
  sessions: SessionView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

/** Row-level status icon + accent color. */
function statusVisual(s: SessionView): { icon: string; color: string } {
  if (s.permissionPending) return { icon: '⏳', color: 'var(--ball-permission)' };
  if (s.stuck) return { icon: '⚠', color: 'var(--ball-stuck)' };
  switch (s.status) {
    case 'active':
      return { icon: '🔧', color: 'var(--ball-active)' };
    case 'waiting':
      return { icon: '💬', color: 'var(--ball-success)' };
    default:
      return { icon: '•', color: 'var(--ball-text-muted)' };
  }
}

function modeChip(mode: string | undefined): string | null {
  if (!mode || mode === 'default') return null;
  switch (mode) {
    case 'plan':
      return '📋 plan';
    case 'acceptEdits':
      return '✏ acceptEdits';
    case 'bypassPermissions':
      return '🔓 bypass';
    default:
      return mode;
  }
}

function relTime(ms: number): string {
  if (!ms) return '';
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return 'now';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/** Sort sessions by last activity, most-recent first. */
function byRecency(a: SessionView, b: SessionView): number {
  return (b.lastDataAt ?? 0) - (a.lastDataAt ?? 0);
}

function SessionRow({
  s,
  selected,
  onSelect,
}: {
  s: SessionView;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const v = statusVisual(s);
  const chip = modeChip(s.permissionMode);
  return (
    <button
      onClick={() => onSelect(s.id)}
      className={
        'flex w-full items-center gap-2 border-b border-[var(--ball-border)] px-3 py-2 text-left hover:bg-[var(--ball-bg-card)] ' +
        (selected
          ? 'bg-[var(--ball-bg-card)] border-l-2 border-l-[var(--ball-accent)]'
          : 'border-l-2 border-l-transparent')
      }
    >
      <span className="text-lg leading-none" style={{ color: v.color }}>
        {v.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] text-[var(--ball-text)]">{displayName(s)}</div>
        <div className="truncate text-xs text-[var(--ball-text-muted)]">
          {s.currentTool || relTime(s.lastDataAt)}
        </div>
      </div>
      {chip && (
        <span className="shrink-0 rounded-sm bg-[var(--ball-bg-dark)] px-1.5 py-0.5 text-[11px] text-[var(--ball-text-muted)]">
          {chip}
        </span>
      )}
      {s.group && (
        <span className="shrink-0 rounded-sm bg-[var(--ball-bg-dark)] px-1.5 py-0.5 text-[11px] text-[var(--ball-accent-soft)]">
          {s.group}
        </span>
      )}
    </button>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between bg-[var(--ball-bg)] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--ball-text-muted)]">
      <span className="truncate">{title}</span>
      <span>{count}</span>
    </div>
  );
}

export function SessionList({ sessions, selectedId, onSelect }: SessionListProps) {
  // Split into grouped (by group label) and ungrouped (active/inactive).
  const grouped = new Map<string, SessionView[]>();
  const ungrouped: SessionView[] = [];
  for (const s of sessions) {
    if (s.group) {
      const arr = grouped.get(s.group) ?? [];
      arr.push(s);
      grouped.set(s.group, arr);
    } else {
      ungrouped.push(s);
    }
  }
  // Group order: by each group's most-recent activity, descending.
  const groupSections = [...grouped.entries()]
    .map(([name, arr]) => ({
      name,
      arr: arr.sort(byRecency),
      top: arr.reduce((m, s) => Math.max(m, s.lastDataAt ?? 0), 0),
    }))
    .sort((a, b) => b.top - a.top);

  const active = ungrouped.filter(isRunning).sort(byRecency);
  const inactive = ungrouped.filter((s) => !isRunning(s)).sort(byRecency);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--ball-border)] px-3 py-2">
        <span className="text-base font-semibold text-[var(--ball-text)]">会话列表</span>
        <span className="text-sm text-[var(--ball-text-muted)]">
          {sessions.filter(isRunning).length}/{sessions.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[var(--ball-text-muted)]">
            没有会话
          </div>
        ) : (
          <>
            {groupSections.map((g) => (
              <div key={g.name}>
                <SectionHeader title={`🗂 ${g.name}`} count={g.arr.length} />
                {g.arr.map((s) => (
                  <SessionRow key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} />
                ))}
              </div>
            ))}
            <SectionHeader title="已激活" count={active.length} />
            {active.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-[var(--ball-text-muted)]">
                没有正在运行的会话
              </div>
            ) : (
              active.map((s) => (
                <SessionRow key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} />
              ))
            )}
            <SectionHeader title="未激活" count={inactive.length} />
            {inactive.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-[var(--ball-text-muted)]">无历史会话</div>
            ) : (
              inactive.map((s) => (
                <SessionRow key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
