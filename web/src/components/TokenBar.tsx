interface TokenBarProps {
  inputTokens: number;
  outputTokens: number;
  softLimit: number;
}

/** Horizontal input/output token split bar. Turns red near the soft limit. */
export function TokenBar({ inputTokens, outputTokens, softLimit }: TokenBarProps) {
  const total = inputTokens + outputTokens;
  if (total <= 0) return null;
  const inputPct = Math.min(100, (inputTokens / softLimit) * 100);
  const outputPct = Math.min(100 - inputPct, (outputTokens / softLimit) * 100);
  const nearLimit = total >= softLimit * 0.85;
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-2.5 w-full overflow-hidden rounded-sm bg-[var(--ball-bg-dark)]">
        <div
          className="h-full"
          style={{
            width: `${inputPct}%`,
            background: nearLimit ? 'var(--ball-danger)' : 'var(--ball-active)',
          }}
        />
        <div
          className="h-full"
          style={{
            width: `${outputPct}%`,
            background: nearLimit ? 'var(--ball-danger)' : 'var(--ball-accent)',
          }}
        />
      </div>
      <div className="flex justify-between text-xs text-[var(--ball-text-muted)]">
        <span>↓ {fmt(inputTokens)}</span>
        <span>↑ {fmt(outputTokens)}</span>
      </div>
    </div>
  );
}
