// Letter-monogram avatar (replaces the old emoji avatars). Colour is derived
// deterministically from the player's id/name so each player is visually distinct.
const COLORS = ['#7c3aed', '#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#9333ea', '#0d9488', '#ca8a04']

function colorFor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]
}

export function Avatar({ name, id, size = 32 }: { name: string; id?: string; size?: number }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: '9999px', flexShrink: 0,
        background: colorFor(id || name), color: '#fff', fontWeight: 800, fontSize: Math.round(size * 0.5),
        lineHeight: 1,
      }}
    >
      {initial}
    </span>
  )
}
