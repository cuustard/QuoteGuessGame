// A single floating emoji reaction in flight on the host screen.
export type FloatingReaction = { id: number; emoji: string; left: number }

export function ReactionsOverlay({ reactions }: { reactions: FloatingReaction[] }) {
  if (reactions.length === 0) return null
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-40">
      {reactions.map((r) => (
        <div key={r.id} className="absolute bottom-24 text-6xl animate-float-up" style={{ left: `${r.left}%` }}>
          {r.emoji}
        </div>
      ))}
    </div>
  )
}
