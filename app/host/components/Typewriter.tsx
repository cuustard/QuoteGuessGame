'use client'

import { useEffect, useState } from 'react'

// Per-character typing cadence. Owned here because the typewriter is the source of truth
// for typing speed; the host's prompt countdown imports it to outlast the animation.
export const TYPE_SPEED_MS = 28

// Types the quote out character-by-character. Keyed by conversationId so it remounts each round.
export function Typewriter({ lines }: { lines: { lineId: number; lineText: string; actionText: string | null }[] }) {
  const total = lines.reduce((a, l) => a + l.lineText.length, 0)
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setShown((s) => {
      if (s >= total) { clearInterval(iv); return s }
      return s + 1
    }), TYPE_SPEED_MS)
    return () => clearInterval(iv)
  }, [total])

  return (
    <div className="w-full space-y-4">
      {lines.map((line, i) => {
        const start = lines.slice(0, i).reduce((a, l) => a + l.lineText.length, 0)
        const reached = shown >= start
        if (!reached) return null
        const visible = Math.min(line.lineText.length, shown - start)
        const typing = shown < start + line.lineText.length
        return (
          <div key={line.lineId} className="rounded-2xl p-6 space-y-1 animate-slide-up" style={{ background: 'var(--surface)' }}>
            {line.actionText && <p className="text-sm italic" style={{ color: 'var(--muted)' }}>*{line.actionText}*</p>}
            <div className="flex gap-3 items-start">
              <span className="font-black text-xl" style={{ color: 'var(--primary-light)' }}>???</span>
              <p className="text-xl flex-1">&ldquo;{line.lineText.slice(0, visible)}&rdquo;{typing && <span className="cursor-blink">▋</span>}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
