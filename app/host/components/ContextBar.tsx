import { formatHappenedAt, relativeTime } from '@/lib/game'

export function ContextBar({ context, happenedAt, small }: { context: string | null; happenedAt: string | null; small?: boolean }) {
  const date = formatHappenedAt(happenedAt)
  const ago = relativeTime(happenedAt)
  if (!context && !date) return null
  return (
    <div className={`rounded-xl ${small ? 'p-3 text-sm' : 'p-4'} text-center italic`} style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
      {date && (
        <span className="not-italic font-bold mr-2" style={{ color: 'var(--accent)' }}>
          {date}{ago && <span className="font-normal opacity-70"> ({ago})</span>}
        </span>
      )}
      {context && <>📍 {context}</>}
    </div>
  )
}
