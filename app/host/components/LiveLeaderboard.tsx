import type { GameState } from '@/lib/types'

// Persistent standings shown beside the action during play (large screens only).
export function LiveLeaderboard({ state, present, presenceReady }: { state: GameState; present: Set<string>; presenceReady: boolean }) {
  const ranked = state.players.slice().sort((a, b) => b.score - a.score)
  const lineIds = state.question?.lines.map((l) => l.lineId) ?? []
  return (
    <aside className="hidden lg:flex flex-col gap-2 w-72 shrink-0 rounded-2xl p-4 self-start" style={{ background: 'var(--surface)' }}>
      <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--muted)' }}>Leaderboard</p>
      {ranked.map((p, i) => {
        const delta = state.phase === 'reveal' ? (state.scores[p.id] ?? 0) : null
        const bet = state.bets[p.id] ?? 1
        const locked = state.phase === 'guessing' && lineIds.length > 0 && lineIds.every((lid) => state.guesses[lid]?.[p.id] !== undefined)
        const off = presenceReady && !present.has(p.id)
        return (
          <div key={p.id} className="flex items-center gap-2 rounded-xl px-2 py-2 transition-all"
            style={{ background: i === 0 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.04)', opacity: off ? 0.45 : 1 }}>
            <span className="font-black w-5 text-center text-sm" style={{ color: i === 0 ? 'var(--accent)' : 'var(--muted)' }}>{i + 1}</span>
            <span className="text-xl">{p.avatar}</span>
            <div className="flex-1 min-w-0">
              <div className="font-bold truncate text-sm flex items-center gap-1">
                {p.name}
                {off && <span className="text-[10px]" title="disconnected">📴</span>}
                {p.streak > 1 && <span className="text-[10px]" style={{ color: 'var(--accent)' }}>🔥{p.streak}</span>}
              </div>
              {(state.phase === 'guessing' || state.phase === 'reveal') && (bet !== 1 || locked) && (
                <div className="text-[10px] flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                  {locked && <span style={{ color: 'var(--correct)' }}>✓ locked</span>}
                  {bet === 'swap' && <span style={{ color: 'var(--accent)' }}>🔀 swap</span>}
                  {bet === 3 && <span style={{ color: 'var(--incorrect)' }}>💀 all-in</span>}
                  {bet === 2 && <span style={{ color: 'var(--incorrect)' }}>🔥 ×2</span>}
                  {bet === 0.5 && <span>🛡 safe</span>}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="font-black tabular-nums">{p.score}</div>
              {delta !== null && delta !== 0 && (
                <div className="text-[11px] font-bold tabular-nums" style={{ color: delta > 0 ? 'var(--correct)' : 'var(--incorrect)' }}>
                  {delta > 0 ? '+' : ''}{delta}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </aside>
  )
}
