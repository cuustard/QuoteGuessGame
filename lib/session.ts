// Remembers the player's current game on their own device so a refresh/disconnect
// can offer a one-tap rejoin. Purely client-side (localStorage) — no backend needed.
export const PLAYER_SESSION_KEY = 'wsi_player_session'
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000 // forget sessions older than 6h

export interface PlayerSession {
  room: string
  name: string
  avatar: string
  id: string
  ts: number
}

export function loadPlayerSession(): PlayerSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(PLAYER_SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as PlayerSession
    if (!s.room || !s.name || !s.id) return null
    if (Date.now() - s.ts > SESSION_TTL_MS) { localStorage.removeItem(PLAYER_SESSION_KEY); return null }
    return s
  } catch {
    return null
  }
}

export function savePlayerSession(s: Omit<PlayerSession, 'ts'>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify({ ...s, ts: Date.now() }))
  } catch { /* ignore */ }
}

export function clearPlayerSession() {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(PLAYER_SESSION_KEY)
  } catch { /* ignore */ }
}
