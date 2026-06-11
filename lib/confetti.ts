// Tiny dependency-free confetti burst. Spawns DOM particles that fall and fade,
// then cleans itself up. Safe to call repeatedly.
const COLORS = ['#7c3aed', '#a78bfa', '#f59e0b', '#10b981', '#ef4444', '#38bdf8', '#ec4899']

export function burstConfetti(count = 80) {
  if (typeof document === 'undefined') return

  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;'
  document.body.appendChild(container)

  const styleId = 'confetti-keyframes'
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent =
      '@keyframes confetti-fall{0%{transform:translateY(-10vh) rotate(0deg);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}'
    document.head.appendChild(style)
  }

  for (let i = 0; i < count; i++) {
    const p = document.createElement('div')
    const size = 6 + Math.random() * 8
    const left = Math.random() * 100
    const duration = 1.6 + Math.random() * 1.4
    const delay = Math.random() * 0.4
    const color = COLORS[Math.floor(Math.random() * COLORS.length)]
    p.style.cssText = `position:absolute;top:-10vh;left:${left}vw;width:${size}px;height:${size * 0.6}px;background:${color};border-radius:2px;animation:confetti-fall ${duration}s ${delay}s ease-in forwards;`
    container.appendChild(p)
  }

  setTimeout(() => container.remove(), 3600)
}
