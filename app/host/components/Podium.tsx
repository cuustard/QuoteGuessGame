'use client'

import { useEffect, useState } from 'react'
import { playTick, playFanfare } from '@/lib/sounds'
import { burstConfetti } from '@/lib/confetti'
import type { Player } from '@/lib/types'

export function Podium({ players, drinking, lives }: { players: Player[]; drinking: boolean; lives?: Record<string, number> }) {
  // Survival ranks by lives remaining first (score as tiebreak); other modes by score.
  const ranked = players.slice().sort((a, b) =>
    lives ? ((lives[b.id] ?? 0) - (lives[a.id] ?? 0)) || (b.score - a.score) : b.score - a.score
  )
  const top3 = ranked.slice(0, 3)
  const rest = ranked.slice(3)
  const last = ranked.length > 1 ? ranked[ranked.length - 1] : null
  const [step, setStep] = useState(0) // reveals 3rd(1) -> 2nd(2) -> 1st(3)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (let s = 1; s <= 3; s++) {
      timers.push(setTimeout(() => {
        setStep(s)
        if (s < 3) playTick()
        else { playFanfare(); burstConfetti() }
      }, 500 + (s - 1) * 950))
    }
    return () => timers.forEach(clearTimeout)
  }, [])

  // Display columns left→right: 2nd, 1st, 3rd
  const slots = [
    { p: top3[1], place: 2, barH: 165, reveal: 2 },
    { p: top3[0], place: 1, barH: 240, reveal: 3 },
    { p: top3[2], place: 3, barH: 120, reveal: 1 },
  ].filter((s) => s.p)
  const medals: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' }

  return (
    <div className="w-full max-w-4xl flex flex-col items-center gap-8">
      <div className="flex items-end justify-center gap-6 sm:gap-10 w-full">
        {slots.map(({ p, place, barH, reveal }) => {
          const visible = step >= reveal
          return (
            <div key={p!.id} className="flex flex-col items-center justify-end transition-all duration-500"
              style={{ opacity: visible ? 1 : 0, transform: visible ? 'translateY(0)' : 'translateY(24px)' }}>
              <div className="text-6xl sm:text-7xl">{p!.avatar}</div>
              <div className="font-black text-2xl text-center max-w-[12rem] truncate" style={{ color: place === 1 ? 'var(--accent)' : 'var(--text)' }}>{p!.name}</div>
              <div className="text-4xl font-black">{lives ? '❤️'.repeat(lives[p!.id] ?? 0) || '💀' : p!.score}</div>
              <div className="w-32 sm:w-44 rounded-t-xl flex items-start justify-center pt-3 mt-2"
                style={{ height: barH, background: place === 1 ? 'var(--accent)' : 'var(--surface)', color: place === 1 ? '#000' : 'var(--text)' }}>
                <span className="text-5xl">{medals[place]}</span>
              </div>
            </div>
          )
        })}
      </div>

      {rest.length > 0 && step >= 3 && (
        <div className="w-full max-w-xl space-y-2 animate-slide-up">
          {rest.map((p, i) => (
            <div key={p.id} className="flex items-center gap-3 rounded-xl px-5 py-3 text-2xl" style={{ background: 'var(--surface)' }}>
              <span className="font-bold" style={{ color: 'var(--muted)' }}>{i + 4}.</span>
              <span>{p.avatar}</span>
              <span className="flex-1 font-bold">{p.name}</span>
              <span className="font-black">{lives ? '❤️'.repeat(lives[p.id] ?? 0) || '💀' : p.score}</span>
            </div>
          ))}
        </div>
      )}

      {drinking && step >= 3 && last && (
        <p className="text-lg text-center animate-slide-up" style={{ color: 'var(--muted)' }}>
          🏴 <span className="font-bold" style={{ color: 'var(--incorrect)' }}>{last.name}</span> finishes their drink · 👑 winner stays (allegedly) sober · get home safe.
        </p>
      )}
    </div>
  )
}
