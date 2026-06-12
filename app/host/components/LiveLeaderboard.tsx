import type { GameState } from '@/lib/types'

// Persistent standings shown beside the action during play (large screens only).
export function LiveLeaderboard({ state, present, presenceReady }: { state: GameState; present: Set<string>; presenceReady: boolean }) {
  const ranked = state.players.slice().sort((a, b) => b.score - a.score)
  const lineIds = state.question?.lines.map((l) => l.lineId) ?? []
  return (
    <aside className="hidden lg:flex flex-col gap-3 w-96 shrink-0 rounded-2xl p-5 self-start" style={{ background: 'var(--surface)' }}>
      <p className="text-lg uppercase tracking-widest mb-1 font-bold" style={{ color: 'var(--muted)' }}>Leaderboard</p>
      {ranked.map((p, i) => {
        const delta = state.phase === 'reveal' ? (state.scores[p.id] ?? 0) : null
        const bet = state.bets[p.id] ?? 1
        const locked = state.phase === 'guessing' && (state.mode === 'realfake'
          ? state.rfVotes[p.id] !== undefined
          : lineIds.length > 0 && lineIds.every((lid) => state.guesses[lid]?.[p.id] !== undefined))
        const off = presenceReady && !present.has(p.id)
        const hearts = state.mode === 'survival' ? ('❤️'.repeat(state.lives[p.id] ?? 0) || '💀') : null
        return (
          <div key={p.id} className="flex items-center gap-3 rounded-xl px-3 py-3 transition-all"
            style={{ background: i === 0 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.04)', opacity: off ? 0.45 : 1 }}>
            <span className="font-black w-8 text-center text-2xl" style={{ color: i === 0 ? 'var(--accent)' : 'var(--muted)' }}>{i + 1}</span>
            <span className="text-4xl">{p.avatar}</span>
            <div className="flex-1 min-w-0">
              <div className="font-bold truncate text-2xl flex items-center gap-1.5">
                {p.name}
                {off && <span className="text-base" title="disconnected">📴</span>}
                {p.streak > 1 && <span className="text-base" style={{ color: 'var(--accent)' }}>🔥{p.streak}</span>}
              </div>
              {hearts && <div className="text-base mt-0.5">{hearts}</div>}
              {(state.phase === 'guessing' || state.phase === 'reveal') && ((state.mode === 'classic' && bet !== 1) || locked) && (
                <div className="text-base flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--muted)' }}>
                  {locked && <span style={{ color: 'var(--correct)' }}>✓ locked</span>}
                  {state.mode === 'classic' && bet === 'swap' && <span style={{ color: 'var(--accent)' }}>🔀 swap</span>}
                  {state.mode === 'classic' && bet === 3 && <span style={{ color: 'var(--incorrect)' }}>💀 all-in</span>}
                  {state.mode === 'classic' && bet === 2 && <span style={{ color: 'var(--incorrect)' }}>🔥 ×2</span>}
                  {state.mode === 'classic' && bet === 0.5 && <span>🛡 safe</span>}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="font-black tabular-nums text-3xl">{p.score}</div>
              {delta !== null && delta !== 0 && (
                <div className="text-lg font-bold tabular-nums" style={{ color: delta > 0 ? 'var(--correct)' : 'var(--incorrect)' }}>
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
