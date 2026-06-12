export function TimerBar({ timeLeft, total }: { timeLeft: number; total: number }) {
  const pct = Math.max(0, timeLeft / total)
  const secs = Math.ceil(timeLeft / 1000)
  const color = pct > 0.5 ? 'var(--correct)' : pct > 0.25 ? 'var(--accent)' : 'var(--incorrect)'
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-2xl font-bold" style={{ color }}>
        <span>Time left</span><span>{secs}s</span>
      </div>
      <div className="w-full rounded-full h-5" style={{ background: 'var(--surface)' }}>
        <div className="h-5 rounded-full transition-all duration-100" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
    </div>
  )
}
