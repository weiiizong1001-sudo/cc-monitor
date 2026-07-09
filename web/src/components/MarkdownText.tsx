import { marked } from 'marked';
import { useMemo } from 'react';

// GFM + single-line-breaks so Claude's replies read like the cc terminal,
// where a newline inside a paragraph still renders as a line break.
marked.setOptions({ gfm: true, breaks: true });

/**
 * Render an assistant message as markdown. The result is injected via
 * dangerouslySetInnerHTML — safe here because the input is Claude's own
 * output in a local monitoring tool, not untrusted user content.
 *
 * Inline `code` is tinted with --ball-accent (the cc terminal's blue) via the
 * .markdown CSS in index.css, so `like this` stands out from plain prose
 * instead of melting into white text.
 */
export function MarkdownText({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text) as string, [text]);
  return (
    <div
      className="markdown mb-2 break-words text-[var(--ball-text)]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
