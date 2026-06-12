'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { computeRoundDrinks, computeRfDrink, drinkResultText, ALLIN_MIN_BUYIN, SWAP_MIN_BUYIN } from '@/lib/game'
import { TYPE_SPEED_MS } from '@/app/host/components/Typewriter'
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
  const [rfVote, setRfVote] = useState<'real' | 'fake' | null>(null)
  const [activeLineId, setActiveLineId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [promptCountdown, setPromptCountdown] = useState<number | null>(null)
  const [promptTyped, setPromptTyped] = useState(0) // quote chars revealed so far, synced to the TV
  const promptTypeRef = useRef<{ conv: number; start: number } | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const joinedRef = useRef(false)
  const lastPhaseRef = useRef<string | null>(null)
  const sessionSavedRef = useRef(false)
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const betSentRef = useRef(false)                  // bet transmitted once when guessing opens
  const roundResetRef = useRef<number | null>(null) // conversationId we've already reset local state for

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
      // Reset local round state ONCE per question. Doing it on every prompt re-broadcast would
      // wipe a bet the player already placed when, e.g., another player joins mid-prompt.
      const convId = payload.state.question?.conversationId ?? null
      if (payload.state.phase === 'lobby') {
        setMyGuesses({}); setLockedIn(false); setBetState(1); setSwapTargetState(null); setActiveLineId(null); setRfVote(null)
        roundResetRef.current = null
        betSentRef.current = false
      } else if (payload.state.phase === 'prompt' && convId !== null && roundResetRef.current !== convId) {
        roundResetRef.current = convId
        betSentRef.current = false
        setMyGuesses({}); setLockedIn(false); setBetState(1); setSwapTargetState(null); setActiveLineId(null); setRfVote(null)
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
      // Authoritative across all modes (classic lines, RF vote, survival) — host computed it.
      const allRight = gameState.perfectRound[playerId] === true
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
  }, [gameState, myGuesses, playerId])

  useEffect(() => {
    const active = gameState?.phase === 'prompt' && !!gameState.promptEnd
    const secsLeft = () => Math.max(0, Math.ceil((gameState!.promptEnd! - Date.now()) / 1000))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPromptCountdown(active ? secsLeft() : null)
    if (!active) return
    const iv = setInterval(() => setPromptCountdown(secsLeft()), 250)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState?.phase, gameState?.promptEnd])

  // Type the quote onto the phone in lockstep with the host's TV typewriter. Anchored to the local
  // moment this round's prompt arrived (not the host clock), so device clock-skew can't desync it.
  // The host types the context first, then the quote — so we hold the quote for that same delay.
  useEffect(() => {
    const q = gameState?.phase === 'prompt' ? gameState.question : null
    const conv = q?.conversationId
    if (q && conv !== undefined && promptTypeRef.current?.conv !== conv) {
      promptTypeRef.current = { conv, start: Date.now() }
    }
    const compute = () => {
      if (!q || !promptTypeRef.current) return 0
      const claim = gameState?.rfClaim
      const lines = gameState?.mode === 'realfake' && claim ? q.lines.filter((l) => l.lineId === claim.lineId) : q.lines
      const contextDelay = (q.context ? `📍 ${q.context}`.length : 0) * TYPE_SPEED_MS
      const quoteLen = lines.reduce((a, l) => a + l.lineText.length, 0)
      const elapsed = Date.now() - promptTypeRef.current.start - contextDelay
      return Math.max(0, Math.min(quoteLen, Math.floor(elapsed / TYPE_SPEED_MS)))
    }
    setPromptTyped(compute())
    if (!q) return
    const iv = setInterval(() => setPromptTyped(compute()), 40)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState?.phase, gameState?.question?.conversationId])

  // Blind Confidence: the bet is chosen during the prompt phase and transmitted the instant
  // guessing opens — before any guess can end the round — so no one is mid-bet at round end.
  useEffect(() => {
    if (gameState?.phase !== 'guessing' || gameState.mode !== 'classic' || betSentRef.current) return
    betSentRef.current = true
    const ch = channelRef.current
    if (!ch) return
    ch.send({ type: 'broadcast', event: 'set_bet', payload: { type: 'set_bet', playerId, bet } satisfies ChannelMessage })
    if (bet === 'swap' && swapTarget) {
      ch.send({ type: 'broadcast', event: 'set_swap_target', payload: { type: 'set_swap_target', playerId, targetId: swapTarget } satisfies ChannelMessage })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState?.phase])

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

  // Bet selection happens during the prompt phase and is stored locally only — the host rejects
  // set_bet outside the guessing phase, so it's transmitted later by the guessing-start effect.
  function chooseBet(b: Bet) {
    if (gameState?.phase !== 'prompt') return
    if (b === 3 && myScore < ALLIN_MIN_BUYIN) return // All-In requires the buy-in
    if (b === 'swap' && myScore < SWAP_MIN_BUYIN) return // Point Swap requires the buy-in
    haptics.tap()
    setBetState(b)
    // Default the swap target to the top player so picking 'swap' is never a silent miss.
    if (b === 'swap') { if (!swapTarget && swapTargets.length > 0) setSwapTargetState(swapTargets[0].id) }
    else setSwapTargetState(null)
  }

  function chooseSwapTarget(targetId: string) {
    if (gameState?.phase !== 'prompt') return
    haptics.tap()
    setSwapTargetState(targetId)
  }

  // Real or Cap: voting IS the lock-in (one tap, no take-backs).
  async function voteRf(vote: 'real' | 'fake') {
    if (rfVote || gameState?.phase !== 'guessing' || gameState.mode !== 'realfake') return
    haptics.lockIn()
    setRfVote(vote)
    await channelRef.current?.send({
      type: 'broadcast',
      event: 'rf_vote',
      payload: { type: 'rf_vote', playerId, vote } satisfies ChannelMessage,
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
    // Re-assert the bet first (a dropped set_bet must not cost the player), then lock + re-send guesses.
    await channelRef.current?.send({
      type: 'broadcast',
      event: 'set_bet',
      payload: { type: 'set_bet', playerId, bet } satisfies ChannelMessage,
    })
    if (bet === 'swap' && swapTarget) {
      await channelRef.current?.send({
        type: 'broadcast',
        event: 'set_swap_target',
        payload: { type: 'set_swap_target', playerId, targetId: swapTarget } satisfies ChannelMessage,
      })
    }
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

  // Read-only label for the bet locked in during the prompt phase.
  const betLabel = bet === 'swap' ? '🔀 Point Swap' : bet === 3 ? '💀 All-In' : bet === 2 ? '🔥 Risky ×2' : bet === 0.5 ? '🛡 Safe ×0.5' : '😐 No bet'

  // Mode-derived: RF rounds show only the claimed line; survival tracks my lives.
  const promptLines = gameState.mode === 'realfake' && gameState.rfClaim
    ? (gameState.question?.lines ?? []).filter((l) => l.lineId === gameState.rfClaim!.lineId)
    : gameState.question?.lines ?? []
  const myLives = gameState.lives[playerId] ?? 0
  const amEliminated = gameState.mode === 'survival' && gameState.phase !== 'lobby' && myLives <= 0 && Object.keys(gameState.lives).length > 0

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
          <div className="flex flex-wrap gap-2 justify-center">
            {gameState.mode === 'realfake' && (
              <div className="rounded-full px-4 py-1 text-sm font-black" style={{ background: 'var(--primary)', color: '#fff' }}>
                🕵 Real or Cap — spot the fakes!
              </div>
            )}
            {gameState.mode === 'survival' && (
              <div className="rounded-full px-4 py-1 text-sm font-black" style={{ background: 'var(--incorrect)', color: '#fff' }}>
                💀 Survival — 3 lives, last one standing
              </div>
            )}
            {gameState.drinking && (
              <div className="rounded-full px-4 py-1 text-sm font-black" style={{ background: 'var(--accent)', color: '#000' }}>
                🍺 Tipsy Edition — wrong = drink!
              </div>
            )}
          </div>
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

      {/* Prompt — place your bet now (Blind Confidence), read the quote on the host screen */}
      {gameState.phase === 'prompt' && (
        <div className="flex-1 flex flex-col gap-4 animate-slide-up">
          <div className="text-center">
            <div className="text-4xl animate-bounce">👀</div>
            <h2 className="text-2xl font-black mt-1">Round {gameState.currentRound}</h2>
          </div>
          {gameState.question?.context && (
            <div className="rounded-xl p-3 text-center italic text-sm w-full"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              📍 {gameState.question.context}
            </div>
          )}

          {/* The quote, typed in sync with the host's TV typewriter so you can read + bet without looking up */}
          {gameState.question && (
            <div className="rounded-2xl p-4 space-y-2 min-h-[3.5rem]" style={{ background: 'var(--surface)' }}>
              {promptLines.map((line, i) => {
                const startOffset = promptLines.slice(0, i).reduce((a, l) => a + l.lineText.length, 0)
                if (promptTyped <= startOffset) return null
                const visible = Math.min(line.lineText.length, promptTyped - startOffset)
                const typing = promptTyped < startOffset + line.lineText.length
                return (
                  <div key={line.lineId} className="animate-slide-up">
                    {line.actionText && <p className="text-xs italic mb-0.5" style={{ color: 'var(--muted)' }}>*{line.actionText}*</p>}
                    <p className="leading-snug">
                      <span className="font-black" style={{ color: gameState.mode === 'realfake' ? 'var(--accent)' : 'var(--primary-light)' }}>
                        {gameState.mode === 'realfake' && gameState.rfClaim ? gameState.rfClaim.claimedSpeakerName : '???'}
                      </span>{' '}
                      &ldquo;{line.lineText.slice(0, visible)}&rdquo;{typing && <span className="cursor-blink">▋</span>}
                    </p>
                  </div>
                )
              })}
              {promptTyped === 0 && <p className="leading-snug" style={{ color: 'var(--muted)' }}><span className="cursor-blink">▋</span></p>}
            </div>
          )}

          {/* Real or Cap: the claim is the whole game — get ready to vote */}
          {gameState.mode === 'realfake' && gameState.rfClaim && (
            <div className="rounded-2xl p-3 text-center" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
              <p className="font-black" style={{ color: 'var(--accent)' }}>
                🕵 Did {gameState.rfClaim.claimedSpeakerName} really say this?
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Voting opens when the countdown ends — +500 for the right call.</p>
            </div>
          )}

          {/* Survival: your lives */}
          {gameState.mode === 'survival' && (
            <div className="rounded-2xl p-3 text-center" style={{ background: 'var(--surface)', border: '2px solid var(--incorrect)' }}>
              {amEliminated
                ? <p className="font-black" style={{ color: 'var(--incorrect)' }}>💀 You&apos;re out — spectating</p>
                : <p className="font-black">{'❤️'.repeat(myLives)} <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>miss a round, lose a life</span></p>}
            </div>
          )}

          {/* Place your bet — classic mode only (RF votes / survival lives are the stakes) */}
          {gameState.mode === 'classic' && (
          <div className="rounded-2xl p-3 space-y-2" style={{ background: 'var(--surface)' }}>
            <p className="text-xs uppercase tracking-widest text-center" style={{ color: 'var(--muted)' }}>Place your bet</p>

            {/* Default — no bet, neutral */}
            <button onClick={() => chooseBet(1)}
              className="w-full rounded-xl py-3 px-2 font-bold leading-tight transition-all active:scale-95"
              style={{
                background: bet === 1 ? 'var(--primary)' : 'rgba(255,255,255,0.07)',
                color: bet === 1 ? '#fff' : 'var(--text)',
                border: bet === 1 ? '2px solid var(--primary-light)' : '2px solid transparent',
              }}>
              😐 NO BET
              <span className="block text-[10px] font-normal opacity-80 mt-0.5">Full points if perfect — but <b>−100</b> if you miss a line</span>
            </button>

            {/* Separator */}
            <div className="flex items-center gap-2 py-0.5">
              <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.1)' }} />
              <span className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--muted)' }}>or take a risk</span>
              <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.1)' }} />
            </div>

            {/* Stake bets */}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => chooseBet(0.5)}
                className="rounded-xl py-2.5 px-1 text-sm font-bold leading-tight transition-all active:scale-95"
                style={{
                  background: bet === 0.5 ? 'var(--correct)' : 'rgba(255,255,255,0.07)',
                  color: bet === 0.5 ? '#fff' : 'var(--muted)',
                  border: '2px solid transparent',
                }}>
                🛡 Safe ×0.5
              </button>
              <button onClick={() => chooseBet(2)}
                className="rounded-xl py-2.5 px-1 text-sm font-bold leading-tight transition-all active:scale-95"
                style={{
                  background: bet === 2 ? 'var(--incorrect)' : 'rgba(255,255,255,0.07)',
                  color: bet === 2 ? '#fff' : 'var(--muted)',
                  border: '2px solid transparent',
                }}>
                🔥 Risky ×2
              </button>
              {/* All-In — locked until the player banks the buy-in */}
              <button onClick={() => chooseBet(3)} disabled={myScore < ALLIN_MIN_BUYIN}
                className="col-span-2 rounded-xl py-2.5 px-1 text-sm font-bold leading-tight transition-all active:scale-95"
                style={{
                  background: bet === 3 ? '#b91c1c' : 'rgba(255,255,255,0.07)',
                  color: myScore < ALLIN_MIN_BUYIN ? 'var(--muted)' : bet === 3 ? '#fff' : 'var(--text)',
                  border: bet === 3 ? '2px solid var(--incorrect)' : '2px solid transparent',
                  opacity: myScore < ALLIN_MIN_BUYIN ? 0.45 : 1,
                  cursor: myScore < ALLIN_MIN_BUYIN ? 'not-allowed' : 'pointer',
                }}>
                💀 All-In — Double or Nothing
                {myScore < ALLIN_MIN_BUYIN && <span className="block text-[10px] font-normal mt-0.5">(Requires 1,000 pts)</span>}
              </button>
              {/* Point Swap — only shown when someone is ahead; locked until the buy-in is banked */}
              {swapTargets.length > 0 && (
                <button onClick={() => chooseBet('swap')} disabled={myScore < SWAP_MIN_BUYIN}
                  className="col-span-2 rounded-xl py-2.5 px-1 text-sm font-bold leading-tight transition-all active:scale-95"
                  style={{
                    background: bet === 'swap' ? 'var(--accent)' : 'rgba(255,255,255,0.07)',
                    color: myScore < SWAP_MIN_BUYIN ? 'var(--muted)' : bet === 'swap' ? '#000' : 'var(--text)',
                    border: bet === 'swap' ? '2px solid var(--accent)' : '2px solid transparent',
                    opacity: myScore < SWAP_MIN_BUYIN ? 0.45 : 1,
                    cursor: myScore < SWAP_MIN_BUYIN ? 'not-allowed' : 'pointer',
                  }}>
                  🔀 Point Swap
                  {myScore < SWAP_MIN_BUYIN && <span className="block text-[10px] font-normal mt-0.5">(Requires 500 pts)</span>}
                </button>
              )}
            </div>

            {/* Selected-bet explainer */}
            {bet === 0.5 && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Half the points you earn — but <b>zero risk</b>. A safe hedge.</p>}
            {bet === 2 && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Need a <b>perfect</b> round to win ×2 — miss any line and you lose <b style={{ color: 'var(--incorrect)' }}>500</b>.</p>}
            {bet === 3 && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Perfect round = <b style={{ color: 'var(--correct)' }}>DOUBLE your total score</b>. Miss any line = <b style={{ color: 'var(--incorrect)' }}>lose EVERYTHING</b>. 💀</p>}
            {bet === 'swap' && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Perfect round = steal their score. Miss and you lose <b style={{ color: 'var(--incorrect)' }}>750 pts</b>.</p>}
          </div>
          )}

          {/* Swap target picker */}
          {gameState.mode === 'classic' && bet === 'swap' && (
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

          {/* Countdown + reading hint */}
          <div className="mt-auto flex flex-col items-center gap-2 pt-2">
            {promptCountdown !== null && promptCountdown > 0 && (
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-4xl font-black tabular-nums" style={{ color: 'var(--accent)' }}>{promptCountdown}</span>
                <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--muted)' }}>guessing starts in</span>
              </div>
            )}
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              {gameState.mode === 'classic' && 'Lock in a bet — guessing opens when the timer hits zero'}
              {gameState.mode === 'realfake' && 'Think it over — voting opens when the timer hits zero'}
              {gameState.mode === 'survival' && (amEliminated ? 'Watch the chaos unfold 🍿' : 'Get it right or lose a life — guessing opens soon')}
            </p>
          </div>
        </div>
      )}

      {/* Guessing Phase — Real or Cap: one quote, two buttons */}
      {gameState.phase === 'guessing' && gameState.mode === 'realfake' && gameState.question && gameState.rfClaim && (
        <div className="flex-1 flex flex-col gap-4 animate-slide-up">
          <div className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
            <p className="leading-snug">
              <span className="font-black" style={{ color: 'var(--accent)' }}>{gameState.rfClaim.claimedSpeakerName}</span>{' '}
              &ldquo;{promptLines[0]?.lineText}&rdquo;
            </p>
          </div>
          {!rfVote ? (
            <div className="grid grid-cols-2 gap-3 flex-1 max-h-72">
              <button onClick={() => voteRf('real')}
                className="rounded-2xl text-3xl font-black transition-all active:scale-95"
                style={{ background: 'var(--correct)', color: '#fff' }}>
                ✅<br />REAL
              </button>
              <button onClick={() => voteRf('fake')}
                className="rounded-2xl text-3xl font-black transition-all active:scale-95"
                style={{ background: 'var(--incorrect)', color: '#fff' }}>
                🧢<br />CAP
              </button>
            </div>
          ) : (
            <div className="text-center rounded-2xl py-6 font-black text-lg" style={{ background: 'var(--surface)', color: 'var(--correct)' }}>
              ✓ Voted {rfVote === 'real' ? '✅ REAL' : '🧢 CAP'} — waiting for others…
            </div>
          )}
          <div className="flex justify-center gap-2 mt-auto">
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

      {/* Guessing Phase — Survival spectator (eliminated) */}
      {gameState.phase === 'guessing' && gameState.mode === 'survival' && amEliminated && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 animate-slide-up">
          <div className="text-6xl">💀</div>
          <p className="text-xl font-black">You&apos;re out!</p>
          <p className="text-sm text-center" style={{ color: 'var(--muted)' }}>Spectate, heckle, and fire reactions at the survivors.</p>
          <div className="flex justify-center gap-2">
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

      {/* Guessing Phase — one shared speaker grid, tap a line to target it */}
      {gameState.phase === 'guessing' && gameState.mode !== 'realfake' && !amEliminated && gameState.question && gActiveLineObj && (
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

              {/* Bet locked during prompt (Blind Confidence) — read-only reminder (classic only) */}
              {gameState.mode === 'classic' && (
                <div className="rounded-xl px-3 py-2 flex items-center justify-center gap-2 text-xs" style={{ background: 'var(--surface)' }}>
                  <span style={{ color: 'var(--muted)' }}>Bet locked:</span>
                  <span className="font-bold" style={{ color: 'var(--text)' }}>{betLabel}</span>
                  {bet === 'swap' && swapTarget && (
                    <span className="font-bold" style={{ color: 'var(--accent)' }}>→ {gameState.players.find((p) => p.id === swapTarget)?.name}</span>
                  )}
                </div>
              )}
              {/* Survival: lives reminder */}
              {gameState.mode === 'survival' && (
                <div className="rounded-xl px-3 py-2 text-center text-xs font-bold" style={{ background: 'var(--surface)' }}>
                  {'❤️'.repeat(myLives)} <span style={{ color: 'var(--muted)' }}>— a single wrong line costs a life</span>
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

      {/* Reveal Phase — Real or Cap verdict */}
      {gameState.phase === 'reveal' && gameState.mode === 'realfake' && gameState.rfClaim && (() => {
        const right = gameState.perfectRound[playerId] === true
        const truthName = gameState.question?.lines.find((l) => l.lineId === gameState.rfClaim!.lineId)?.speakerName ?? '???'
        return (
          <div className="flex-1 flex flex-col gap-4 animate-slide-up">
            <h2 className="text-2xl font-black text-center">Results</h2>
            <div className="rounded-2xl p-5 text-center space-y-2"
              style={{ background: 'var(--surface)', border: `2px solid ${gameState.rfClaim.isReal ? 'var(--correct)' : 'var(--incorrect)'}` }}>
              <p className="text-3xl font-black" style={{ color: gameState.rfClaim.isReal ? 'var(--correct)' : 'var(--incorrect)' }}>
                {gameState.rfClaim.isReal ? '✅ It was REAL' : '🧢 It was CAP'}
              </p>
              {!gameState.rfClaim.isReal && <p className="text-sm" style={{ color: 'var(--muted)' }}>It was actually <b style={{ color: 'var(--text)' }}>{truthName}</b></p>}
              <p className="text-lg font-bold" style={{ color: right ? 'var(--correct)' : 'var(--incorrect)' }}>
                {rfVote === null ? '😴 You didn’t vote' : right ? `You called it! +${gameState.scores[playerId] ?? 0}` : 'You got played 💀'}
              </p>
            </div>
            {gameState.drinking && (
              <div className="rounded-2xl p-5 text-center animate-bounce-in"
                style={{ background: right ? 'var(--surface)' : 'var(--accent)', color: right ? 'var(--correct)' : '#000', border: right ? '2px solid var(--correct)' : 'none' }}>
                <p className="text-2xl font-black">{drinkResultText(computeRfDrink(rfVote ?? undefined, right))}</p>
              </div>
            )}
            <div className="rounded-2xl p-4 text-center" style={{ background: 'var(--surface)' }}>
              <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--muted)' }}>Your score</p>
              <p className="text-4xl font-black">{myScore}</p>
              {myRank > 0 && <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>#{myRank} of {gameState.players.length}</p>}
            </div>
            <p className="text-center text-sm animate-pulse" style={{ color: 'var(--muted)' }}>Waiting for host…</p>
          </div>
        )
      })()}

      {/* Reveal Phase — show the player's own answers, no spoiler of correct names */}
      {gameState.phase === 'reveal' && gameState.mode !== 'realfake' && gameState.question && (
        <div className="flex-1 flex flex-col gap-4 animate-slide-up">
          <h2 className="text-2xl font-black text-center">Results</h2>
          {gameState.mode === 'survival' && (
            <div className="rounded-2xl p-3 text-center font-black" style={{ background: 'var(--surface)', border: '2px solid var(--incorrect)' }}>
              {myLives > 0 ? <>{'❤️'.repeat(myLives)} {gameState.perfectRound[playerId] === false && <span style={{ color: 'var(--incorrect)' }}>−1 life!</span>}</> : <span style={{ color: 'var(--incorrect)' }}>💀 ELIMINATED</span>}
            </div>
          )}
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

          {/* Drink prompt (Tipsy Edition overlay) */}
          {gameState.drinking && (() => {
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
                    {delta >= 0 ? '+' : ''}{delta} this round{(usedBet === 0.5 || usedBet === 2) && <span style={{ color: 'var(--muted)' }}> · ×{usedBet} bet</span>}{usedBet === 3 && <span style={{ color: 'var(--muted)' }}> · all-in</span>}
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
        // Survival ranks by lives remaining (score as tiebreak); other modes by score.
        const ranked = gameState.players.slice().sort((a, b) =>
          gameState.mode === 'survival'
            ? ((gameState.lives[b.id] ?? 0) - (gameState.lives[a.id] ?? 0)) || (b.score - a.score)
            : b.score - a.score)
        const myPos = ranked.findIndex((p) => p.id === playerId) + 1
        const amLast = gameState.drinking && ranked.length > 1 && ranked[ranked.length - 1].id === playerId
        return (
        <div className="flex-1 flex flex-col items-center justify-center gap-6 animate-bounce-in">
          <div className="text-6xl">{myPos === 1 ? '🏆' : myPos === 2 ? '🥈' : myPos === 3 ? '🥉' : amEliminated ? '💀' : '🎮'}</div>
          <h2 className="text-3xl font-black">
            {myPos === 1 ? (gameState.mode === 'survival' ? 'You survived!' : 'You won!') : `#${myPos} place`}
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
                  <span className="font-black">{gameState.mode === 'survival' ? ('❤️'.repeat(gameState.lives[p.id] ?? 0) || '💀') : p.score}</span>
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
