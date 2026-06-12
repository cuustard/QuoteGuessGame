'use client'

import { useEffect, useRef, useState } from 'react'

// Per-character typing cadence. Owned here because the typewriter is the source of truth
// for typing speed; the host's prompt countdown imports it to outlast the animation.
export const TYPE_SPEED_MS = 80

interface TypewriterProps {
  lines: { lineId: number; lineText: string; actionText: string | null }[]
  onComplete?: () => void
  // plain=true: renders bare text with no card/??? wrapper (used for context strings)
  plain?: boolean
  plainClassName?: string
}

// Types the quote out character-by-character. Keyed by conversationId so it remounts each round.
export function Typewriter({ lines, onComplete, plain, plainClassName }: TypewriterProps) {
  const total = lines.reduce((a, l) => a + l.lineText.length, 0)
  const [shown, setShown] = useState(0)

  const onCompleteRef = useRef(onComplete)
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])

  useEffect(() => {
    const iv = setInterval(() => setShown((s) => {
      if (s >= total) { clearInterval(iv); return s }
      return s + 1
    }), TYPE_SPEED_MS)
    return () => clearInterval(iv)
  }, [total])

  // Fire onComplete once when typing finishes, outside the state updater.
  useEffect(() => {
    if (shown >= total && total > 0) onCompleteRef.current?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown >= total])

  if (plain) {
    const visible = Math.min(total, shown)
    const text = lines.map((l) => l.lineText).join('')
    const typing = shown < total
    return (
      <p className={plainClassName}>
        {text.slice(0, visible)}{typing && <span className="cursor-blink">▋</span>}
      </p>
    )
  }

  return (
    <div className="w-full space-y-4">
      {lines.map((line, i) => {
        const start = lines.slice(0, i).reduce((a, l) => a + l.lineText.length, 0)
        const reached = shown >= start
        if (!reached) return null
        const visible = Math.min(line.lineText.length, shown - start)
        const typing = shown < start + line.lineText.length
        return (
          <div key={line.lineId} className="rounded-2xl p-8 space-y-1 animate-slide-up" style={{ background: 'var(--surface)' }}>
            {line.actionText && <p className="text-xl italic" style={{ color: 'var(--muted)' }}>*{line.actionText}*</p>}
            <p className="text-4xl leading-snug">
              &ldquo;{line.lineText.slice(0, visible)}&rdquo;{typing && <span className="cursor-blink">▋</span>}{' '}
              {!typing && <span className="text-2xl font-bold" style={{ color: 'var(--primary-light)' }}>— ???</span>}
            </p>
          </div>
        )
      })}
    </div>
  )
}
