// Survival lives, rendered as heart emojis (the one emoji kept app-wide).
// Supports fractional lives: a 0.5 life shows as a half-clipped heart.
export function Hearts({ n, className, style }: { n: number; className?: string; style?: React.CSSProperties }) {
  if (n <= 0) return null
  const full = Math.floor(n)
  const half = n - full >= 0.5
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: '1px', ...style }}>
      {Array.from({ length: full }).map((_, i) => <span key={i}>❤️</span>)}
      {half && (
        <span style={{ display: 'inline-block', width: '0.58em', overflow: 'hidden', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>❤️</span>
      )}
    </span>
  )
}
