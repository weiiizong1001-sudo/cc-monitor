import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { SessionView } from '../state.js';
import { displayName } from '../state.js';
import { TOKEN_SOFT_LIMIT } from '../constants.js';
import { OutputStream } from './OutputStream.js';
import { TokenBar } from './TokenBar.js';

interface SessionDetailProps {
  session: SessionView;
  onRename: (id: number, title: string) => void;
  onSetGroup: (id: number, group?: string) => void;
}

function modeLabel(mode: string | undefined): string {
  if (!mode) return 'default';
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

function statusLabel(s: SessionView): { text: string; color: string } {
  if (s.permissionPending) return { text: '等待批准', color: 'var(--ball-permission)' };
  if (s.stuck) return { text: '疑似卡死', color: 'var(--ball-stuck)' };
  switch (s.status) {
    case 'active':
      return { text: '运行中', color: 'var(--ball-active)' };
    case 'waiting':
      return { text: '等待输入', color: 'var(--ball-success)' };
    default:
      return { text: '已结束', color: 'var(--ball-text-muted)' };
  }
}

function MgmtButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'cursor-pointer rounded px-1.5 py-0.5 text-[11px] ' +
        (active
          ? 'bg-[var(--ball-bg-card)] text-[var(--ball-text)]'
          : 'text-[var(--ball-text-muted)] hover:text-[var(--ball-text)]')
      }
    >
      {children}
    </button>
  );
}

export function SessionDetail({ session: s, onRename, onSetGroup }: SessionDetailProps) {
  const st = statusLabel(s);
  const projectBase = s.projectDir
    ? s.projectDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || s.projectDir
    : undefined;

  const [renameOpen, setRenameOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [showPath, setShowPath] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [groupDraft, setGroupDraft] = useState('');

  const mgmtRef = useRef<HTMLDivElement>(null);

  const openRename = () => {
    setRenameDraft(displayName(s));
    setRenameOpen(true);
    setGroupOpen(false);
  };
  const commitRename = () => {
    const next = renameDraft.trim();
    if (next && next !== displayName(s)) onRename(s.id, next);
    setRenameOpen(false);
  };

  const openGroup = () => {
    setGroupDraft(s.group ?? '');
    setGroupOpen(true);
    setRenameOpen(false);
  };
  const commitGroup = () => {
    const next = groupDraft.trim();
    onSetGroup(s.id, next || undefined);
    setGroupOpen(false);
  };

  // Close all panels when switching sessions.
  useEffect(() => {
    setRenameOpen(false);
    setGroupOpen(false);
    setShowPath(false);
  }, [s.id]);

  // Click-outside: commit rename/group (so edits aren't lost) and hide path.
  useEffect(() => {
    if (!renameOpen && !groupOpen && !showPath) return;
    const handler = (e: MouseEvent) => {
      const el = mgmtRef.current;
      if (!el || el.contains(e.target as Node)) return;
      if (renameOpen) {
        const n = renameDraft.trim();
        if (n && n !== displayName(s)) onRename(s.id, n);
      }
      if (groupOpen) {
        const n = groupDraft.trim();
        onSetGroup(s.id, n || undefined);
      }
      setRenameOpen(false);
      setGroupOpen(false);
      setShowPath(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [renameOpen, groupOpen, showPath, renameDraft, groupDraft, s, onRename, onSetGroup]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-[var(--ball-border)] px-4 py-3">
        <div className="min-w-0 truncate text-base font-semibold text-[var(--ball-text)]">
          {displayName(s)}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ball-text-muted)]">
          <span style={{ color: st.color }}>● {st.text}</span>
          <span>·</span>
          <span>{modeLabel(s.permissionMode)}</span>
          {projectBase && (
            <>
              <span>·</span>
              <span className="truncate">{projectBase}</span>
            </>
          )}
          {s.group && (
            <>
              <span>·</span>
              <span className="truncate text-[var(--ball-accent-soft)]">🗂 {s.group}</span>
            </>
          )}
        </div>
      </div>

      {/* Management row: rename / group / jsonl path — grouped on the left */}
      <div ref={mgmtRef} className="border-b border-[var(--ball-border)] px-4 py-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <MgmtButton active={renameOpen} onClick={openRename}>
            ✏ 重命名
          </MgmtButton>
          <MgmtButton active={groupOpen} onClick={openGroup}>
            🗂 分组
          </MgmtButton>
          <MgmtButton active={showPath} onClick={() => setShowPath((v) => !v)}>
            🗑 路径
          </MgmtButton>
        </div>

        {renameOpen && (
          <div className="mt-1.5 flex items-center gap-2">
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') setRenameOpen(false);
              }}
              placeholder="新标题"
              className="min-w-0 flex-1 rounded border border-[var(--ball-border)] bg-[var(--ball-bg-dark)] px-2 py-1 text-xs text-[var(--ball-text)] outline-none focus:border-[var(--ball-accent)]"
            />
            <button
              onClick={commitRename}
              className="shrink-0 rounded bg-[var(--ball-accent)] px-2 py-1 text-[11px] text-white"
            >
              确定
            </button>
          </div>
        )}

        {groupOpen && (
          <div className="mt-1.5 flex items-center gap-2">
            <input
              autoFocus
              value={groupDraft}
              onChange={(e) => setGroupDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitGroup();
                else if (e.key === 'Escape') setGroupOpen(false);
              }}
              placeholder="组名（留空移出分组）"
              className="min-w-0 flex-1 rounded border border-[var(--ball-border)] bg-[var(--ball-bg-dark)] px-2 py-1 text-xs text-[var(--ball-text)] outline-none focus:border-[var(--ball-accent)]"
            />
            <button
              onClick={commitGroup}
              className="shrink-0 rounded bg-[var(--ball-accent)] px-2 py-1 text-[11px] text-white"
            >
              确定
            </button>
          </div>
        )}

        {showPath && (
          <div className="mt-1.5">
            <div className="selectable break-all rounded border border-[var(--ball-border)] bg-[var(--ball-bg-dark)] px-2 py-1 text-[11px] text-[var(--ball-accent-soft)]">
              {s.jsonlFile || '（未知）'}
            </div>
            <div className="mt-1 text-[10px] text-[var(--ball-text-muted)]">
              如需删除：在终端 <code className="text-[var(--ball-text)]">rm</code> 该文件后重启
              cc-monitor（<code className="text-[var(--ball-text)]">~/ccm.sh restart</code>）。
            </div>
          </div>
        )}
      </div>

      {/* Token bar */}
      <div className="border-b border-[var(--ball-border)] px-4 py-2">
        <TokenBar
          inputTokens={s.inputTokens}
          outputTokens={s.outputTokens}
          softLimit={TOKEN_SOFT_LIMIT}
        />
      </div>

      {/* Current tool */}
      {s.currentTool && (
        <div className="border-b border-[var(--ball-border)] px-4 py-2 text-sm text-[var(--ball-text-muted)]">
          🔧 <span className="text-[var(--ball-text)]">{s.currentTool}</span>
        </div>
      )}

      {/* Output stream */}
      <div className="min-h-0 flex-1 bg-[var(--ball-bg-dark)]">
        <OutputStream output={s.output} scrollNonce={s.scrollNonce} />
      </div>
    </div>
  );
}
