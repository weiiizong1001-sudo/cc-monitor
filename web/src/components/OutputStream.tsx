import { useEffect, useRef, useState } from 'react';

import type { OutputChunk } from '../state.js';
import { MarkdownText } from './MarkdownText.js';

interface OutputStreamProps {
  output: OutputChunk[];
  /** Bumped by the reducer when a transcript replay lands. Watching this
   *  forces a scroll-to-bottom so opening a session shows the latest line,
   *  not the first — the plain nearBottom auto-scroll won't fire because the
   *  pane starts at scrollTop=0. */
  scrollNonce?: number;
}

/**
 * Scrollable live output area styled like a Claude Code terminal.
 *
 * Chunk roles:
 *  - user:        gray ❯ prompt (what you typed)
 *  - assistant:   plain white text (the model's reply)
 *  - thinking:    collapsed gray italic, click to expand
 *  - tool_use:    blue ⏵ ToolName · status line
 *  - tool_result: muted gray, collapsed by default, click to expand
 */
export function OutputStream({ output, scrollNonce }: OutputStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Auto-scroll to bottom on new output (only if already near the bottom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [output, expanded]);

  // Force-scroll to the latest line whenever a transcript replay lands.
  // Deferred to the next frame so the freshly-rendered chunks are laid out
  // before we measure scrollHeight.
  useEffect(() => {
    if (scrollNonce === undefined) return;
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollNonce]);

  if (output.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[15px] text-[var(--ball-text-muted)]">
        等待输出…
      </div>
    );
  }

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div
      ref={scrollRef}
      className="selectable h-full overflow-y-auto px-4 py-3 text-[15px] leading-relaxed"
    >
      {output.map((chunk, i) => {
        if (chunk.role === 'thinking') {
          const isOpen = expanded.has(i);
          const preview = chunk.text.slice(0, 80).replace(/\n/g, ' ');
          return (
            <div key={i} className="mb-1">
              <button
                onClick={() => toggle(i)}
                className="flex w-full items-start gap-1.5 rounded border border-[var(--ball-border)] bg-[var(--ball-bg-card)] px-2 py-1 text-left text-xs italic text-[var(--ball-text-muted)]"
              >
                <span className="shrink-0">🧠</span>
                <span className={isOpen ? 'whitespace-pre-wrap' : 'truncate'}>
                  {isOpen ? chunk.text : preview + (chunk.text.length > 80 ? '…' : '')}
                </span>
              </button>
            </div>
          );
        }

        if (chunk.role === 'user') {
          return (
            <div
              key={i}
              className="mb-2 flex gap-1.5 whitespace-pre-wrap break-words text-[var(--ball-text-muted)]"
            >
              <span className="shrink-0 select-none">❯</span>
              <span>{chunk.text}</span>
            </div>
          );
        }

        if (chunk.role === 'tool_use') {
          const name = chunk.toolName || 'tool';
          return (
            <div
              key={i}
              className="mb-2 flex items-start gap-1.5 rounded border border-[var(--ball-border)] bg-[var(--ball-bg-card)] px-2 py-1 text-[13px] text-[var(--ball-accent)]"
            >
              <span className="shrink-0 select-none">⏵</span>
              <span className="font-medium">{name}</span>
              {chunk.text ? (
                <span className="min-w-0 truncate text-[var(--ball-text-muted)]">
                  · {chunk.text}
                </span>
              ) : null}
            </div>
          );
        }

        if (chunk.role === 'tool_result') {
          const isOpen = expanded.has(i);
          const preview = chunk.text.slice(0, 80).replace(/\n/g, ' ');
          return (
            <div key={i} className="mb-2">
              <button
                onClick={() => toggle(i)}
                className="flex w-full items-start gap-1.5 rounded border border-[var(--ball-border)] bg-[var(--ball-bg-card)] px-2 py-1 text-left text-xs text-[var(--ball-text-muted)]"
              >
                <span className="shrink-0 select-none">{isOpen ? '▾' : '▸'}</span>
                <span className={isOpen ? 'whitespace-pre-wrap break-words' : 'truncate'}>
                  {isOpen ? chunk.text : preview + (chunk.text.length > 80 ? '…' : '')}
                </span>
              </button>
            </div>
          );
        }

        // assistant — markdown reply (bold, inline code, lists, code blocks).
        return <MarkdownText key={i} text={chunk.text} />;
      })}
    </div>
  );
}
