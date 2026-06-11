'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { computeRoundDrinks, drinkResultText } from '@/lib/game'
import { unlockAudio, playCorrect, playWrong, playTick } from '@/lib/sounds'
import { haptics } from '@/lib/haptics'
import { burstConfetti } from '@/lib/confetti'
import { loadPlayerSession, savePlayerSession } from '@/lib/session'
import type { GameState, Bet, Speaker, ChannelMessage } from '@/lib/types'
import { RealtimeChannel } from '@supabase/supabase-js'

const CONNECT_TIMEOUT_MS = 6000
const REACTION_EMOJIS = ['😂', '💀', '🤭', '🔥', '😳', '👏']

function PlayerController() {
  const params = useSearchParams()
  const roomCode = params.get('room')?.toUpperCase() ?? ''
  const playerName = params.get('name') ?? ''
  const avatar = params.get('avatar') ?? '😎'
  // Reuse the saved id when rejoining the same room+name so the host recognises us
  // as the exact same session (preserves answers, skips the duplicate-name guard).
  const [playerId] = useState(() => {
    const s = loadPlayerSession()
    if (s && s.room === roomCode && s.name.toLowerCase() === playerName.toLowerCase()) return s.id
    return `player_${Math.random().toString(36).slice(2, 9)}`
  })

  const [gameState, setGameState] = useState<GameState | null>(null)
  const [speakers, setSpeakers] = useState<Speaker[]>([]) // cached once from speakers_sync (kept out of state_update)
  const [myGuesses, setMyGuesses] = useState<Record<number, number>>({}) // lineId -> speakerId
  const [lockedIn, setLockedIn] = useState(false)
  const [bet, setBetState] = useState<Bet>(1)
  const [swapTarget, setSwapTargetState] = useState<string | null>(null)
  const [activeLineId, setActiveLineId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [promptCountdown, setPromptCountdown] = useState<number | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const joinedRef = useRef(false)
  const lastPhaseRef = useRef<string | null>(null)
  const sessionSavedRef = useRef(false)
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!roomCode || !playerName) return
    unlockAudio()
    const channel = supabase.channel(`room:${roomCode}`, { config: { presence: { key: playerId } } })

    // The state_update handler clears this; if it fires, no host answered in time.
    // (Don't read gameState here — this closure only ever sees the initial null.)
    const connectTimeout = setTimeout(() => {
      setError(`No game found for room ${roomCode}. Double-check the code with your host.`)
    }, CONNECT_TIMEOUT_MS)

    channel.on('broadcast', { event: 'state_update' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'state_update') return
      clearTimeout(connectTimeout)
      setError('')
      setGameState(payload.state)
      // Remember this session (once the room confirms it's live) for reconnects.
      if (!sessionSavedRef.current) {
        sessionSavedRef.current = true
        savePlayerSession({ room: roomCode, name: playerName, avatar, id: playerId })
      }
      // Reset guesses, lock, bet & active line for new round
      if (payload.state.phase === 'prompt' || payload.state.phase === 'lobby') {
        setMyGuesses({})
        setLockedIn(false)
        setBetState(1)
        setSwapTargetState(null)
        setActiveLineId(null)
      }
    })

    channel.on('broadcast', { event: 'speakers_sync' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'speakers_sync') return
      setSpeakers(payload.speakers)
    })

    channel.on('broadcast', { event: 'join_rejected' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'join_rejected' || payload.playerId !== playerId) return
      clearTimeout(connectTimeout)
      setError(payload.reason)
    })

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED' && !joinedRef.current) {
        joinedRef.current = true
        await channel.send({
          type: 'broadcast',
          event: 'player_join',
          payload: {
            type: 'player_join',
            playerId,
            playerName,
            avatar,
          } satisfies ChannelMessage,
        })
        // Mark ourselves present so the host can see live connect/disconnect.
        await channel.track({ name: playerName })
      } else if (status === 'CHANNEL_ERROR') {
        setError('Could not connect to room. Check the code and try again.')
      }
    })

    channelRef.current = channel
    return () => { clearTimeout(connectTimeout); channel.unsubscribe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, playerName])

  // Sound / haptics / confetti when results arrive
  useEffect(() => {
    if (!gameState) return
    // Left reveal early — kill any pending payoff so it can't buzz into the next phase.
    if (gameState.phase !== 'reveal' && revealTimerRef.current) {
      clearTimeout(revealTimerRef.current); revealTimerRef.current = null
      haptics.stopAnticipationPulse()
    }
    if (gameState.phase === 'reveal' && lastPhaseRef.current !== 'reveal') {
      const lines = gameState.question?.lines ?? []
      const allRight = lines.length > 0 && lines.every((l) => myGuesses[l.lineId] === gameState.revealedAnswers[l.lineId])
      // Heartbeat tension during the host's staged reveal, then the payoff buzz on unmask.
      haptics.startAnticipationPulse()
      const revealMs = Math.min(2500, Math.max(1, lines.length) * 900)
      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null
        haptics.stopAnticipationPulse()
        if (allRight) { playCorrect(); haptics.correct(); burstConfetti() }
        else { playWrong(); haptics.wrong() }
      }, revealMs)
    }
    if (gameState.phase === 'prompt' && lastPhaseRef.current !== 'prompt') playTick()
    lastPhaseRef.current = gameState.phase
  }, [gameState, myGuesses])

  useEffect(() => {
    if (gameState?.phase !== 'prompt' || !gameState.promptEnd) { setPromptCountdown(null); return }
    const tick = () => setPromptCountdown(Math.max(0, Math.ceil((gameState.promptEnd! - Date.now()) / 1000)))
    tick()
    const iv = setInterval(tick, 250)
    return () => clearInterval(iv)
  }, [gameState?.phase, gameState?.promptEnd])

  // Stop the pulse / pending payoff if the player navigates away mid-reveal.
  useEffect(() => () => {
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
    haptics.stopAnticipationPulse()
  }, [])

  async function assignSpeaker(speakerId: number) {
    if (lockedIn || !gameState?.question || gameState.phase !== 'guessing') return
    const lines = gameState.question.lines
    const target = (activeLineId != null && lines.some((l) => l.lineId === activeLineId))
      ? activeLineId
      : (lines.find((l) => myGuesses[l.lineId] === undefined)?.lineId ?? lines[0].lineId)
    haptics.tap()
    const updated = { ...myGuesses, [target]: speakerId }
    setMyGuesses(updated)
    // Move focus to the next still-unassigned line (or stay if all done)
    const next = lines.find((l) => updated[l.lineId] === undefined)
    setActiveLineId(next ? next.lineId : target)
    await channelRef.current?.send({
      type: 'broadcast',
      event: 'submit_guess',
      payload: { type: 'submit_guess', playerId, lineId: target, speakerId } satisfies ChannelMessage,
    })
  }

  async function chooseBet(b: Bet) {
    if (lockedIn || !gameState || gameState.phase !== 'guessing') return
    haptics.tap()
    setBetState(b)
    await channelRef.current?.send({
      type: 'broadcast',
      event: 'set_bet',
      payload: { type: 'set_bet', playerId, bet: b } satisfies ChannelMessage,
    })
  }

  async function chooseSwapTarget(targetId: string) {
    if (lockedIn || !gameState || gameState.phase !== 'guessing') return
    haptics.tap()
    setSwapTargetState(targetId)
    await channelRef.current?.send({
      type: 'broadcast',
      event: 'set_swap_target',
      payload: { type: 'set_swap_target', playerId, targetId } satisfies ChannelMessage,
    })
  }

  async function sendReaction(emoji: string) {
    haptics.tap()
    await channelRef.current?.send({
      type: 'broadcast',
      event: 'reaction',
      payload: { type: 'reaction', playerId, emoji } satisfies ChannelMessage,
    })
  }

  async function lockIn(guesses = myGuesses) {
    if (lockedIn) return
    haptics.lockIn()
    setLockedIn(true)
    await channelRef.current?.send({
      type: 'broadcast',
      event: 'lock_in',
      payload: { type: 'lock_in', playerId } satisfies ChannelMessage,
    })
    // Re-send all guesses to ensure host has them
    const question = gameState?.question
    if (question) {
      for (const line of question.lines) {
        if (guesses[line.lineId] !== undefined) {
          await channelRef.current?.send({
            type: 'broadcast',
            event: 'submit_guess',
            payload: { type: 'submit_guess', playerId, lineId: line.lineId, speakerId: guesses[line.lineId] } satisfies ChannelMessage,
          })
        }
      }
    }
  }

  if (!roomCode || !playerName) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="text-center space-y-4">
          <p style={{ color: 'var(--incorrect)' }}>Missing room code or name.</p>
          <Link href="/" className="underline" style={{ color: 'var(--primary-light)' }}>Go back</Link>
        </div>
      </main>
    )
  }

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="text-center space-y-4">
          <p style={{ color: 'var(--incorrect)' }}>{error}</p>
          <Link href="/" className="underline" style={{ color: 'var(--primary-light)' }}>Try again</Link>
        </div>
      </main>
    )
  }

  if (!gameState) {
    return (
      <main className="flex min-h-dvh items-center justify-center flex-col gap-4">
        <div className="text-4xl animate-spin">⏳</div>
        <p style={{ color: 'var(--muted)' }}>Connecting to room {roomCode}…</p>
      </main>
    )
  }

  const isMe = gameState.players.find((p) => p.id === playerId)
  const myScore = isMe?.score ?? 0
  const myStreak = isMe?.streak ?? 0
  const myRank = gameState.players.slice().sort((a, b) => b.score - a.score).findIndex((p) => p.id === playerId) + 1

  // Reveal-phase: honest per-correct-line credit derived from the authoritative round delta
  // (mirrors scorePlayerRound.perLine — zero when the round was a net loss).
  const rDelta = gameState.scores[playerId] ?? 0
  const rCorrect = gameState.question?.lines.filter((l) => myGuesses[l.lineId] === gameState.revealedAnswers[l.lineId]).length ?? 0
  const rPerLine = rCorrect > 0 && rDelta > 0 ? Math.round(rDelta / rCorrect) : 0

  // Point-swap targets: players currently ahead of me, highest first.
  const swapTargets = gameState.players
    .filter((p) => p.id !== playerId && p.score > myScore)
    .sort((a, b) => b.score - a.score)

  // Guessing-phase derived values (single shared grid targets the active line)
  const gLines = gameState.question?.lines ?? []
  const gMulti = gLines.length > 1
  const gActiveLine = (activeLineId != null && gLines.some((l) => l.lineId === activeLineId))
    ? activeLineId
    : (gLines.find((l) => myGuesses[l.lineId] === undefined)?.lineId ?? gLines[0]?.lineId)
  const gActiveIdx = gLines.findIndex((l) => l.lineId === gActiveLine)
  const gActiveLineObj = gLines[gActiveIdx]
  const gAssignedCount = gLines.filter((l) => myGuesses[l.lineId] !== undefined).length

  return (
    <main className="flex min-h-dvh flex-col p-4 pb-8 gap-4">
      {/* Mini header */}
      <div className="flex justify-between items-center">
        <span className="font-black text-lg flex items-center gap-1" style={{ color: 'var(--primary-light)' }}>
          <span>{avatar}</span>{playerName}
        </span>
        {gameState.phase !== 'lobby' && (
          <div className="text-sm flex items-center gap-2" style={{ color: 'var(--muted)' }}>
            {myStreak > 1 && <span style={{ color: 'var(--accent)' }}>🔥{myStreak}</span>}
            <span>{myScore} pts {myRank > 0 && `· #${myRank}`}</span>
          </div>
        )}
        <div className="rounded-lg px-3 py-1 font-mono font-bold text-sm" style={{ background: 'var(--surface)' }}>
          {roomCode}
        </div>
      </div>

      {/* Lobby */}
      {gameState.phase === 'lobby' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 animate-slide-up">
          <div className="text-6xl">🎉</div>
          <h2 className="text-2xl font-black text-center">You&apos;re in!</h2>
          {gameState.mode === 'drinking' && (
            <div className="rounded-full px-4 py-1 text-sm font-black" style={{ background: 'var(--accent)', color: '#000' }}>
              🍺 Tipsy Edition — wrong = drink!
            </div>
          )}
          <p className="text-center" style={{ color: 'var(--muted)' }}>
            Waiting for the host to start the game…
          </p>
          <div className="flex flex-wrap gap-2 justify-center mt-4">
            {gameState.players.map((p) => (
              <div key={p.id} className="rounded-full px-4 py-1 text-sm font-bold flex items-center gap-1"
                style={{
                  background: p.id === playerId ? 'var(--primary)' : 'var(--surface)',
                  color: p.id === playerId ? '#fff' : 'var(--text)',
                }}>
                <span>{p.avatar}</span>{p.name}{p.id === playerId ? ' (you)' : ''}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Prompt — context + get-ready countdown (read the quote on the host screen) */}
      {gameState.phase === 'prompt' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-5 animate-slide-up">
          <div className="text-5xl animate-bounce">👀</div>
          <h2 className="text-2xl font-black text-center">Round {gameState.currentRound}</h2>
          {gameState.question?.context && (
            <div className="rounded-xl p-4 text-center italic text-sm w-full"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              📍 {gameState.question.context}
            </div>
          )}
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Reading the quote… look at the host screen.</p>
          {promptCountdown !== null && promptCountdown > 0 && (
            <div className="flex flex-col items-center gap-1">
              <span className="text-5xl font-black tabular-nums" style={{ color: 'var(--accent)' }}>{promptCountdown}</span>
              <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--muted)' }}>guessing starts in</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="w-3 h-3 rounded-full animate-bounce" style={{ background: 'var(--accent)', animationDelay: '0ms' }} />
            <span className="w-3 h-3 rounded-full animate-bounce" style={{ background: 'var(--accent)', animationDelay: '150ms' }} />
            <span className="w-3 h-3 rounded-full animate-bounce" style={{ background: 'var(--accent)', animationDelay: '300ms' }} />
          </div>
        </div>
      )}

      {/* Guessing Phase — one shared speaker grid, tap a line to target it */}
      {gameState.phase === 'guessing' && gameState.question && gActiveLineObj && (
        <div className="flex-1 flex flex-col gap-3 animate-slide-up">
          {/* Multi-line: compact line picker */}
          {gMulti && (
            <>
              <div className="flex items-center justify-between text-xs uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                <span>Tap a line, then pick who said it</span>
                <span>{gAssignedCount}/{gLines.length}</span>
              </div>
              <div className="space-y-1.5">
                {gLines.map((line, idx) => {
                  const assignedName = speakers.find((s) => s.id === myGuesses[line.lineId])?.name
                  const active = line.lineId === gActiveLine
                  return (
                    <button key={line.lineId} onClick={() => setActiveLineId(line.lineId)} disabled={lockedIn}
                      className="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-left transition-all"
                      style={{ background: 'var(--surface)', border: active ? '2px solid var(--primary-light)' : '2px solid transparent' }}>
                      <span className="text-xs font-black w-4 shrink-0" style={{ color: active ? 'var(--primary-light)' : 'var(--muted)' }}>{idx + 1}</span>
                      <span className="flex-1 text-sm truncate">&ldquo;{line.lineText}&rdquo;</span>
                      <span className="text-xs font-bold shrink-0 rounded-full px-2 py-0.5 max-w-[42%] truncate"
                        style={{ background: assignedName ? 'var(--primary)' : 'rgba(255,255,255,0.07)', color: assignedName ? '#fff' : 'var(--muted)' }}>
                        {assignedName ?? 'tap to set'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {!lockedIn ? (
            <>
              {/* Active line prompt */}
              <div className="rounded-xl p-3 text-center" style={{ background: gMulti ? 'rgba(124,58,237,0.12)' : 'var(--surface)' }}>
                {gMulti && <p className="text-[10px] uppercase tracking-widest mb-1 font-bold" style={{ color: 'var(--primary-light)' }}>Who said line {gActiveIdx + 1}?</p>}
                {gActiveLineObj.actionText && <p className="text-xs italic mb-0.5" style={{ color: 'var(--muted)' }}>*{gActiveLineObj.actionText}*</p>}
                <p className="text-sm font-bold">&ldquo;{gActiveLineObj.lineText}&rdquo;</p>
              </div>

              {/* Shared speaker grid */}
              <div className="grid grid-cols-2 gap-2">
                {speakers.map((spk) => {
                  const selected = myGuesses[gActiveLine] === spk.id
                  return (
                    <button key={spk.id} onClick={() => assignSpeaker(spk.id)}
                      className="flex items-center justify-center text-center min-h-[48px] rounded-xl py-2 px-2 text-sm font-bold leading-tight break-words transition-all active:scale-95"
                      style={{
                        background: selected ? 'var(--primary)' : 'rgba(255,255,255,0.07)',
                        color: selected ? '#fff' : 'var(--text)',
                        border: selected ? '2px solid var(--primary-light)' : '2px solid transparent',
                      }}>
                      {spk.name}
                    </button>
                  )
                })}
              </div>

              {/* Confidence bet */}
              <div className="rounded-2xl p-3" style={{ background: 'var(--surface)' }}>
                <p className="text-xs uppercase tracking-widest text-center mb-2" style={{ color: 'var(--muted)' }}>Confidence bet</p>
                <div className="grid grid-cols-2 gap-2">
                  {([0.5, 1, 2, 3] as const).map((b) => {
                    const labels = { 0.5: '🛡 Safe ×0.5', 1: '😐 Normal', 2: '🔥 Risky ×2', 3: '💀 All-In ×3' } as const
                    const activeBg = { 0.5: 'var(--correct)', 1: 'var(--primary)', 2: 'var(--incorrect)', 3: '#b91c1c' } as const
                    const active = bet === b
                    return (
                      <button key={b} onClick={() => chooseBet(b)}
                        className="rounded-xl py-2.5 px-1 text-sm font-bold leading-tight transition-all active:scale-95"
                        style={{
                          background: active ? activeBg[b] : 'rgba(255,255,255,0.07)',
                          color: active ? '#fff' : 'var(--muted)',
                          border: active && b === 3 ? '2px solid var(--incorrect)' : '2px solid transparent',
                        }}>
                        {labels[b]}
                      </button>
                    )
                  })}
                  {/* Point Swap — only shown when someone is ahead */}
                  {swapTargets.length > 0 && (
                    <button onClick={() => chooseBet('swap')}
                      className="col-span-2 rounded-xl py-2.5 px-1 text-sm font-bold leading-tight transition-all active:scale-95"
                      style={{
                        background: bet === 'swap' ? 'var(--accent)' : 'rgba(255,255,255,0.07)',
                        color: bet === 'swap' ? '#000' : 'var(--muted)',
                        border: bet === 'swap' ? '2px solid var(--accent)' : '2px solid transparent',
                      }}>
                      🔀 Point Swap
                    </button>
                  )}
                </div>
                {bet === 2 && <p className="text-[11px] text-center mt-2" style={{ color: 'var(--muted)' }}>Need a <b>perfect</b> round to win ×2 — miss any line and you lose <b style={{ color: 'var(--incorrect)' }}>500</b>.</p>}
                {bet === 3 && <p className="text-[11px] text-center mt-2" style={{ color: 'var(--muted)' }}>Perfect round = ×3. Miss and you lose <b style={{ color: 'var(--incorrect)' }}>half your total score</b>. 😬</p>}
                {bet === 'swap' && <p className="text-[11px] text-center mt-2" style={{ color: 'var(--muted)' }}>Perfect round = steal their score. Miss and you lose <b style={{ color: 'var(--incorrect)' }}>750 pts</b>.</p>}
              </div>

              {/* Swap target picker */}
              {bet === 'swap' && (
                <div className="rounded-2xl p-3" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
                  <p className="text-xs uppercase tracking-widest text-center mb-2 font-black" style={{ color: 'var(--accent)' }}>Who do you want to swap with?</p>
                  <div className="flex flex-col gap-2">
                    {swapTargets.map((t) => (
                      <button key={t.id} onClick={() => chooseSwapTarget(t.id)}
                        className="flex items-center justify-between rounded-xl px-3 py-2.5 font-bold transition-all active:scale-95"
                        style={{
                          background: swapTarget === t.id ? 'var(--accent)' : 'rgba(255,255,255,0.07)',
                          color: swapTarget === t.id ? '#000' : 'var(--text)',
                          border: swapTarget === t.id ? '2px solid var(--accent)' : '2px solid transparent',
                        }}>
                        <span>{t.avatar} {t.name}</span>
                        <span className="font-black tabular-nums">{t.score} pts</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Lock in */}
              {gAssignedCount > 0 && (
                <button onClick={() => lockIn()}
                  className="w-full rounded-2xl py-4 text-lg font-black transition-all active:scale-95"
                  style={{ background: 'var(--accent)', color: '#000' }}>
                  {gAssignedCount === gLines.length ? 'Lock In!' : `Lock In (${gAssignedCount}/${gLines.length} set)`}
                </button>
              )}
            </>
          ) : (
            <div className="text-center rounded-2xl py-4 font-black text-lg" style={{ background: 'var(--surface)', color: 'var(--correct)' }}>
              ✓ Locked in! Waiting for others…
            </div>
          )}

          {/* Reaction bar */}
          <div className="flex justify-center gap-2 mt-1">
            {REACTION_EMOJIS.map((e) => (
              <button key={e} onClick={() => sendReaction(e)}
                className="text-2xl rounded-full w-11 h-11 flex items-center justify-center transition-all active:scale-90"
                style={{ background: 'var(--surface)' }}>
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Reveal Phase — show the player's own answers, no spoiler of correct names */}
      {gameState.phase === 'reveal' && gameState.question && (
        <div className="flex-1 flex flex-col gap-4 animate-slide-up">
          <h2 className="text-2xl font-black text-center">Results</h2>
          <div className="space-y-3">
            {gameState.question.lines.map((line) => {
              const myGuess = myGuesses[line.lineId]
              const correct = gameState.revealedAnswers[line.lineId]
              const isCorrect = myGuess === correct
              const guessSpeaker = speakers.find((s) => s.id === myGuess)
              return (
                <div key={line.lineId} className="rounded-2xl p-4 space-y-2"
                  style={{
                    background: 'var(--surface)',
                    border: `2px solid ${isCorrect ? 'var(--correct)' : 'var(--incorrect)'}`,
                  }}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{isCorrect ? '✅' : '❌'}</span>
                    <div className="flex-1">
                      <p className="font-bold" style={{ color: isCorrect ? 'var(--correct)' : 'var(--incorrect)' }}>
                        {guessSpeaker?.name ?? '—'}
                      </p>
                      {!isCorrect && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>your answer</p>
                      )}
                    </div>
                    {isCorrect && rPerLine > 0 && (
                      <span className="font-bold text-sm" style={{ color: 'var(--correct)' }}>
                        +{rPerLine}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Drink prompt (Tipsy Edition) */}
          {gameState.mode === 'drinking' && (() => {
            const result = computeRoundDrinks(gameState.question!, (lid) => myGuesses[lid])
            const safe = result.kind === 'safe'
            return (
              <div className="rounded-2xl p-5 text-center animate-bounce-in"
                style={{ background: safe ? 'var(--surface)' : 'var(--accent)', color: safe ? 'var(--correct)' : '#000', border: safe ? '2px solid var(--correct)' : 'none' }}>
                <p className="text-2xl font-black">{drinkResultText(result)}</p>
              </div>
            )
          })()}

          <div className="rounded-2xl p-4 text-center" style={{ background: 'var(--surface)' }}>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--muted)' }}>Your score</p>
            {(() => {
              const delta = gameState.scores[playerId] ?? 0
              const usedBet = gameState.bets[playerId] ?? 1
              return (
                <>
                  <p className="text-4xl font-black">{myScore}</p>
                  <p className="text-sm mt-1 font-bold" style={{ color: delta >= 0 ? 'var(--correct)' : 'var(--incorrect)' }}>
                    {delta >= 0 ? '+' : ''}{delta} this round{usedBet !== 1 && usedBet !== 'swap' && <span style={{ color: 'var(--muted)' }}> · ×{usedBet} bet</span>}
                  </p>
                </>
              )
            })()}
            {myRank > 0 && <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>#{myRank} of {gameState.players.length}</p>}
          </div>
          <p className="text-center text-sm animate-pulse" style={{ color: 'var(--muted)' }}>
            Waiting for host…
          </p>
        </div>
      )}

      {/* Leaderboard */}
      {gameState.phase === 'leaderboard' && (() => {
        const ranked = gameState.players.slice().sort((a, b) => b.score - a.score)
        const amLast = gameState.mode === 'drinking' && ranked.length > 1 && ranked[ranked.length - 1].id === playerId
        return (
        <div className="flex-1 flex flex-col items-center justify-center gap-6 animate-bounce-in">
          <div className="text-6xl">{myRank === 1 ? '🏆' : myRank === 2 ? '🥈' : myRank === 3 ? '🥉' : '🎮'}</div>
          <h2 className="text-3xl font-black">
            {myRank === 1 ? 'You won!' : `#${myRank} place`}
          </h2>
          {amLast && (
            <div className="rounded-full px-5 py-2 text-sm font-black" style={{ background: 'var(--incorrect)', color: '#fff' }}>
              🏴 Finish your drink!
            </div>
          )}
          <div className="w-full space-y-2">
            {ranked.map((p, i) => (
                <div key={p.id}
                  className="flex justify-between items-center rounded-xl px-5 py-3"
                  style={{
                    background: p.id === playerId ? 'var(--primary)' : 'var(--surface)',
                    fontWeight: p.id === playerId ? 900 : 400,
                  }}>
                  <span className="flex items-center gap-1">{['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`} <span>{p.avatar}</span> {p.name}</span>
                  <span className="font-black">{p.score}</span>
                </div>
              ))}
          </div>
          <p className="text-center text-sm animate-pulse" style={{ color: 'var(--muted)' }}>
            Keep this open — the host can start another game and you&apos;ll jump straight back in.
          </p>
        </div>
        )
      })()}
    </main>
  )
}

export default function PlayPage() {
  return (
    <Suspense fallback={
      <main className="flex min-h-dvh items-center justify-center">
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      </main>
    }>
      <PlayerController />
    </Suspense>
  )
}
