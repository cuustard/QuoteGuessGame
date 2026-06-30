'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { loadPlayerSession, clearPlayerSession, type PlayerSession } from '@/lib/session'

export default function JoinPage() {
  const router = useRouter()
  const [roomCode, setRoomCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [returning, setReturning] = useState<PlayerSession | null>(null)

  // Prefill the code when arriving from the host's QR code (/?room=ABCD).
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get('room')
    /* eslint-disable react-hooks/set-state-in-effect */
    if (fromQuery) setRoomCode(fromQuery.toUpperCase().slice(0, 4))
    setReturning(loadPlayerSession())
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    const code = roomCode.trim().toUpperCase()
    const playerName = name.trim()
    if (code.length !== 4) { setError('Enter a 4-character room code'); return }
    if (!playerName) { setError('Enter your name'); return }
    router.push(`/play?room=${code}&name=${encodeURIComponent(playerName)}`)
  }

  function rejoin() {
    if (!returning) return
    router.push(`/play?room=${returning.room}&name=${encodeURIComponent(returning.name)}`)
  }

  function dismissReturning() {
    clearPlayerSession()
    setReturning(null)
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8 animate-slide-up">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-black tracking-tight" style={{ color: 'var(--primary-light)' }}>
            Who Said It?
          </h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>The party quote guessing game</p>
        </div>

        {returning && (
          <div className="rounded-2xl p-4 space-y-3 animate-bounce-in" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
            <p className="text-sm font-bold text-center">
              Looks like you got disconnected from room <span style={{ color: 'var(--accent)' }}>{returning.room}</span>.
            </p>
            <button onClick={rejoin}
              className="w-full rounded-xl py-3 text-lg font-black transition-all active:scale-95"
              style={{ background: 'var(--accent)', color: '#000' }}>
              Rejoin as {returning.name}
            </button>
            <button onClick={dismissReturning} className="w-full text-xs underline" style={{ color: 'var(--muted)' }}>
              Not you? Start fresh
            </button>
          </div>
        )}

        <form onSubmit={handleJoin} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
              Room Code
            </label>
            <input
              type="text"
              value={roomCode}
              onChange={(e) => { setRoomCode(e.target.value.toUpperCase().slice(0, 4)); setError('') }}
              placeholder="ABCD"
              maxLength={4}
              className="w-full rounded-xl px-4 py-3 text-center text-3xl font-black uppercase tracking-[0.4em] outline-none transition-all"
              style={{ background: 'var(--surface)', border: '2px solid var(--primary)', color: 'var(--text)' }}
              autoCapitalize="characters"
              autoCorrect="off"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
              Your Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError('') }}
              placeholder="e.g. Jake"
              maxLength={20}
              className="w-full rounded-xl px-4 py-3 text-xl font-bold outline-none transition-all"
              style={{ background: 'var(--surface)', border: '2px solid var(--primary)', color: 'var(--text)' }}
            />
          </div>

          {error && <p className="text-sm text-center" style={{ color: 'var(--incorrect)' }}>{error}</p>}

          <button
            type="submit"
            className="w-full rounded-xl py-4 text-xl font-black transition-all active:scale-95"
            style={{ background: 'var(--primary)', color: '#fff' }}
          >
            Join Game
          </button>
        </form>

        <div className="text-center pt-4">
          <a
            href="/host"
            className="text-sm underline"
            style={{ color: 'var(--muted)' }}
          >
            Hosting? Open host screen instead
          </a>
        </div>
      </div>
    </main>
  )
}
