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
import { Avatar } from '@/app/components/Avatar'
import { Hearts } from '@/app/components/Hearts'

const CONNECT_TIMEOUT_MS = 6000
const REACTION_EMOJIS = ['😂', '💀', '🤭', '🔥', '😳', '👏']

function PlayerController() {
  const params = useSearchParams()
  const roomCode = params.get('room')?.toUpperCase() ?? ''
  const playerName = params.get('name') ?? ''
  const avatar = params.get('avatar') ?? '' // retained for session compatibility; not displayed
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
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPhaseRef = useRef<string | null>(null)
  const sessionSavedRef = useRef(false)
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const betSentRef = useRef(false)                  // bet transmitted once when guessing opens
  const roundResetRef = useRef<number | null>(null) // conversationId we've already reset local state for

  useEffect(() => {
    if (!roomCode || !playerName) return
    unlockAudio()
    let disposed = false

    const clearConnectTimer = () => {
      if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
    }

    const connect = () => {
      // Tear down any previous channel so reconnects don't pile up duplicates.
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
      clearConnectTimer()
      // If no state arrives in time, the room is genuinely unreachable (wrong/closed code).
      connectTimeoutRef.current = setTimeout(() => {
        if (!disposed) setError(`No game found for room ${roomCode}. Double-check the code with your host.`)
      }, CONNECT_TIMEOUT_MS)

      const channel = supabase.channel(`room:${roomCode}`, { config: { presence: { key: playerId } } })

      channel.on('broadcast', { event: 'state_update' }, ({ payload }: { payload: ChannelMessage }) => {
        if (payload.type !== 'state_update') return
        clearConnectTimer()
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
        clearConnectTimer()
        setError(payload.reason)
      })

      channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          // (Re)announce on every (re)subscribe. The host treats a known id as a reconnect and
          // just resends current state, so this transparently resyncs us after a drop.
          await channel.send({
            type: 'broadcast', event: 'player_join',
            payload: { type: 'player_join', playerId, playerName, avatar } satisfies ChannelMessage,
          })
          await channel.track({ name: playerName })
        }
        // CHANNEL_ERROR / TIMED_OUT / CLOSED are transient (e.g. the phone backgrounded the
        // socket). Supabase retries, and we also reconnect on refocus — so no dead-end error here.
      })

      channelRef.current = channel
    }

    connect()

    // Mobile browsers suspend the WebSocket when the tab is backgrounded; reconnect on return.
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !disposed) { setError(''); connect() }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      clearConnectTimer()
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    }
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
      // Whole quote types in every mode now (True or False shows full context).
      const contextDelay = (q.context ? q.context.length : 0) * TYPE_SPEED_MS
      const quoteLen = q.lines.reduce((a, l) => a + l.lineText.length, 0)
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
    if (gameState?.phase !== 'guessing' || gameState.mode === 'survival' || betSentRef.current) return
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
        <div className="w-10 h-10 rounded-full animate-spin" style={{ border: '4px solid var(--surface)', borderTopColor: 'var(--primary)' }} />
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
  const betLabel = bet === 'swap' ? 'Point Swap' : bet === 'shield' ? '🛡 Shield' : bet === 3 ? 'All-In' : bet === 2 ? 'Risky ×2' : bet === 0.5 ? 'Safe ×0.5' : 'No bet'

  // Confidence betting is available in classic and True or False (survival's stakes are lives).
  const betsEnabled = gameState.mode === 'classic' || gameState.mode === 'realfake'
  // True or False now shows the WHOLE quote for context (the claimed name attaches to its line).
  const promptLines = gameState.question?.lines ?? []
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
        <span className="font-black text-lg flex items-center gap-2" style={{ color: 'var(--primary-light)' }}>
          <Avatar name={playerName} id={playerId} size={28} />{playerName}
        </span>
        {gameState.phase !== 'lobby' && (
          <div className="text-sm flex items-center gap-2" style={{ color: 'var(--muted)' }}>
            {myStreak > 1 && <span style={{ color: 'var(--accent)' }}>streak {myStreak}</span>}
            {gameState.mode === 'survival'
              ? (myLives > 0 ? <Hearts n={myLives} /> : <span style={{ color: 'var(--incorrect)' }}>OUT</span>)
              : <span>{myScore} pts {myRank > 0 && `· #${myRank}`}</span>}
          </div>
        )}
        <div className="rounded-lg px-3 py-1 font-mono font-bold text-sm" style={{ background: 'var(--surface)' }}>
          {roomCode}
        </div>
      </div>

      {/* Lobby */}
      {gameState.phase === 'lobby' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 animate-slide-up">
          <h2 className="text-2xl font-black text-center">You&apos;re in!</h2>
          <div className="flex flex-wrap gap-2 justify-center">
            {gameState.mode === 'realfake' && (
              <div className="rounded-full px-4 py-1 text-sm font-black" style={{ background: 'var(--primary)', color: '#fff' }}>
                True or False — spot the fakes!
              </div>
            )}
            {gameState.mode === 'survival' && (
              <div className="rounded-full px-4 py-1 text-sm font-black" style={{ background: 'var(--incorrect)', color: '#fff' }}>
                Survival — 3 lives, last one standing
              </div>
            )}
            {gameState.drinking && (
              <div className="rounded-full px-4 py-1 text-sm font-black" style={{ background: 'var(--accent)', color: '#000' }}>
                Tipsy Edition — wrong = drink!
              </div>
            )}
          </div>
          <p className="text-center" style={{ color: 'var(--muted)' }}>
            Waiting for the host to start the game…
          </p>
          <div className="flex flex-wrap gap-2 justify-center mt-4">
            {gameState.players.map((p) => (
              <div key={p.id} className="rounded-full px-4 py-1 text-sm font-bold flex items-center gap-2"
                style={{
                  background: p.id === playerId ? 'var(--primary)' : 'var(--surface)',
                  color: p.id === playerId ? '#fff' : 'var(--text)',
                }}>
                <Avatar name={p.name} id={p.id} size={20} />{p.name}{p.id === playerId ? ' (you)' : ''}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Prompt — place your bet now (Blind Confidence), read the quote on the host screen */}
      {gameState.phase === 'prompt' && (
        <div className="flex-1 flex flex-col gap-4 animate-slide-up">
          <div className="text-center">
            <h2 className="text-2xl font-black mt-1">Round {gameState.currentRound}</h2>
          </div>
          {gameState.question?.context && (
            <div className="rounded-xl p-3 text-center italic text-sm w-full"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              {gameState.question.context}
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
                // True or False: claimed line shows the claimed name; other lines stay context-only.
                const label = gameState.mode === 'realfake' && gameState.rfClaim
                  ? (line.lineId === gameState.rfClaim.lineId ? gameState.rfClaim.claimedSpeakerName : null)
                  : '???'
                return (
                  <div key={line.lineId} className="animate-slide-up">
                    {line.actionText && <p className="text-xs italic mb-0.5" style={{ color: 'var(--muted)' }}>*{line.actionText}*</p>}
                    <p className="leading-snug">
                      &ldquo;{line.lineText.slice(0, visible)}&rdquo;{typing && <span className="cursor-blink">▋</span>}
                      {!typing && label !== null && (
                        <span className="font-black" style={{ color: gameState.mode === 'realfake' ? 'var(--accent)' : 'var(--primary-light)' }}> — {label}</span>
                      )}
                    </p>
                  </div>
                )
              })}
              {promptTyped === 0 && <p className="leading-snug" style={{ color: 'var(--muted)' }}><span className="cursor-blink">▋</span></p>}
            </div>
          )}

          {/* True or False: the claim is the whole game — get ready to vote */}
          {gameState.mode === 'realfake' && gameState.rfClaim && (
            <div className="rounded-2xl p-3 text-center" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
              <p className="font-black" style={{ color: 'var(--accent)' }}>
                Did {gameState.rfClaim.claimedSpeakerName} really say it?
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Place your bet, then vote True or False when voting opens.</p>
            </div>
          )}

          {/* Survival: your lives */}
          {gameState.mode === 'survival' && (
            <div className="rounded-2xl p-3 text-center" style={{ background: 'var(--surface)', border: '2px solid var(--incorrect)' }}>
              {amEliminated
                ? <p className="font-black" style={{ color: 'var(--incorrect)' }}>You&apos;re out — spectating</p>
                : <p className="font-black flex items-center justify-center gap-2"><Hearts n={myLives} /> <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>miss a round, lose a life</span></p>}
            </div>
          )}

          {/* Place your bet — classic & Real or Cap (survival's stakes are lives) */}
          {betsEnabled && (
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
              NO BET
              <span className="block text-[10px] font-normal opacity-80 mt-0.5">Full points if you nail it — but <b>−100</b> if you&apos;re wrong</span>
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
                Safe ×0.5
              </button>
              <button onClick={() => chooseBet(2)}
                className="rounded-xl py-2.5 px-1 text-sm font-bold leading-tight transition-all active:scale-95"
                style={{
                  background: bet === 2 ? 'var(--incorrect)' : 'rgba(255,255,255,0.07)',
                  color: bet === 2 ? '#fff' : 'var(--muted)',
                  border: '2px solid transparent',
                }}>
                Risky ×2
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
                All-In — Double or Nothing
                {myScore < ALLIN_MIN_BUYIN && <span className="block text-[10px] font-normal mt-0.5">(Requires 1,000 pts)</span>}
              </button>
              {/* Shield — defensive: blocks incoming Point Swaps. Always available (the leader needs it most). */}
              <button onClick={() => chooseBet('shield')}
                className="col-span-2 rounded-xl py-2.5 px-1 text-sm font-bold leading-tight transition-all active:scale-95"
                style={{
                  background: bet === 'shield' ? '#2563eb' : 'rgba(255,255,255,0.07)',
                  color: bet === 'shield' ? '#fff' : 'var(--text)',
                  border: bet === 'shield' ? '2px solid #60a5fa' : '2px solid transparent',
                }}>
                🛡 Shield
                <span className="block text-[10px] font-normal opacity-80 mt-0.5">Blocks incoming Swaps (1× points)</span>
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
                  Point Swap
                  {myScore < SWAP_MIN_BUYIN && <span className="block text-[10px] font-normal mt-0.5">(Requires 500 pts)</span>}
                </button>
              )}
            </div>

            {/* Selected-bet explainer */}
            {bet === 0.5 && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Half the points you earn — but <b>zero risk</b>. A safe hedge.</p>}
            {bet === 2 && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Nail it to win <b>×2</b> — get it wrong and you lose <b style={{ color: 'var(--incorrect)' }}>500</b>.</p>}
            {bet === 3 && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Nail it = <b style={{ color: 'var(--correct)' }}>DOUBLE your total score</b>. Wrong = <b style={{ color: 'var(--incorrect)' }}>lose EVERYTHING</b>.</p>}
            {bet === 'swap' && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Nail it = steal their score. Wrong and you lose <b style={{ color: 'var(--incorrect)' }}>750 pts</b>.</p>}
            {bet === 'shield' && <p className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>Same points as NO BET — and if you <b>nail the round</b>, any Point Swap aimed at you <b style={{ color: '#60a5fa' }}>bounces back</b> (the attacker loses 750).</p>}
          </div>
          )}

          {/* Swap target picker */}
          {betsEnabled && bet === 'swap' && (
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
                    <span className="flex items-center gap-2"><Avatar name={t.name} id={t.id} size={22} />{t.name}</span>
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
              {gameState.mode === 'realfake' && 'Lock in a bet — voting opens when the timer hits zero'}
              {gameState.mode === 'survival' && (amEliminated ? 'Watch the chaos unfold' : 'Get it right or lose a life — guessing opens soon')}
            </p>
          </div>
        </div>
      )}

      {/* Guessing Phase — True or False: full quote, two buttons */}
      {gameState.phase === 'guessing' && gameState.mode === 'realfake' && gameState.question && gameState.rfClaim && (
        <div className="flex-1 flex flex-col gap-4 animate-slide-up">
          <div className="rounded-2xl p-4" style={{ background: 'var(--surface)' }}>
            {promptLines.length > 1 && (
              <p className="text-[10px] uppercase tracking-widest mb-2 text-center" style={{ color: 'var(--muted)' }}>Only judge the highlighted line</p>
            )}
            <div className="space-y-2">
              {promptLines.map((line) => {
                const isClaim = line.lineId === gameState.rfClaim!.lineId
                return (
                  <div key={line.lineId} className="rounded-xl px-3 py-2 transition-all"
                    style={{
                      background: isClaim ? 'rgba(245,158,11,0.15)' : 'transparent',
                      border: isClaim ? '2px solid var(--accent)' : '2px solid transparent',
                      opacity: isClaim ? 1 : 0.5,
                    }}>
                    <p className="leading-snug text-sm">
                      &ldquo;{line.lineText}&rdquo;
                      {isClaim && <span className="font-black block mt-1" style={{ color: 'var(--accent)' }}>— {gameState.rfClaim!.claimedSpeakerName}?</span>}
                    </p>
                  </div>
                )
              })}
            </div>
            <p className="text-sm font-black text-center pt-2" style={{ color: 'var(--accent)' }}>
              Did {gameState.rfClaim!.claimedSpeakerName} really say {promptLines.length > 1 ? 'the highlighted line' : 'it'}?
            </p>
          </div>
          <div className="rounded-xl px-3 py-2 flex items-center justify-center gap-2 text-xs" style={{ background: 'var(--surface)' }}>
            <span style={{ color: 'var(--muted)' }}>Bet locked:</span>
            <span className="font-bold" style={{ color: 'var(--text)' }}>{betLabel}</span>
            {bet === 'swap' && swapTarget && (
              <span className="font-bold" style={{ color: 'var(--accent)' }}>→ {gameState.players.find((p) => p.id === swapTarget)?.name}</span>
            )}
          </div>
          {!rfVote ? (
            <div className="grid grid-cols-2 gap-3 flex-1 max-h-72">
              <button onClick={() => voteRf('real')}
                className="rounded-2xl text-4xl font-black transition-all active:scale-95"
                style={{ background: 'var(--correct)', color: '#fff' }}>
                TRUE
              </button>
              <button onClick={() => voteRf('fake')}
                className="rounded-2xl text-4xl font-black transition-all active:scale-95"
                style={{ background: 'var(--incorrect)', color: '#fff' }}>
                FALSE
              </button>
            </div>
          ) : (
            <div className="text-center rounded-2xl py-6 font-black text-lg" style={{ background: 'var(--surface)', color: 'var(--correct)' }}>
              Voted {rfVote === 'real' ? 'TRUE' : 'FALSE'} — waiting for others…
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
          <p className="text-3xl font-black" style={{ color: 'var(--incorrect)' }}>You&apos;re out!</p>
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
                <div className="rounded-xl px-3 py-2 text-center text-xs font-bold flex items-center justify-center gap-2" style={{ background: 'var(--surface)' }}>
                  <Hearts n={myLives} /> <span style={{ color: 'var(--muted)' }}>— a wrong line costs a life</span>
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
              Locked in! Waiting for others…
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

      {/* Reveal Phase — True or False verdict (colour reflects whether YOU were right) */}
      {gameState.phase === 'reveal' && gameState.mode === 'realfake' && gameState.rfClaim && (() => {
        const right = gameState.perfectRound[playerId] === true
        const truthName = gameState.question?.lines.find((l) => l.lineId === gameState.rfClaim!.lineId)?.speakerName ?? '???'
        return (
          <div className="flex-1 flex flex-col gap-4 animate-slide-up">
            <h2 className="text-2xl font-black text-center">Results</h2>
            <div className="rounded-2xl p-5 text-center space-y-2"
              style={{ background: 'var(--surface)', border: `2px solid ${right ? 'var(--correct)' : 'var(--incorrect)'}` }}>
              <p className="text-3xl font-black" style={{ color: right ? 'var(--correct)' : 'var(--incorrect)' }}>
                {rfVote === null ? 'No vote' : right ? 'Correct!' : 'Incorrect'}
              </p>
              <p className="text-lg font-bold" style={{ color: 'var(--text)' }}>
                It was {gameState.rfClaim.isReal ? 'TRUE' : 'FALSE'}
                {!gameState.rfClaim.isReal && <span style={{ color: 'var(--muted)' }} className="font-normal"> — actually {truthName}</span>}
              </p>
              {(() => {
                const delta = gameState.scores[playerId] ?? 0
                const usedBet = gameState.bets[playerId] ?? 1
                return (
                  <p className="text-sm font-bold" style={{ color: delta >= 0 ? 'var(--correct)' : 'var(--incorrect)' }}>
                    {delta >= 0 ? '+' : ''}{delta} this round
                    {(usedBet === 0.5 || usedBet === 2) && <span style={{ color: 'var(--muted)' }}> · ×{usedBet} bet</span>}
                    {usedBet === 3 && <span style={{ color: 'var(--muted)' }}> · all-in</span>}
                    {usedBet === 'swap' && <span style={{ color: 'var(--muted)' }}> · swap</span>}
                  </p>
                )
              })()}
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
          {gameState.mode === 'survival' && (() => {
            const d = gameState.lifeDeltas[playerId] ?? 0
            return (
              <div className="rounded-2xl p-3 text-center font-black flex items-center justify-center gap-2" style={{ background: 'var(--surface)', border: '2px solid var(--incorrect)' }}>
                {myLives > 0 ? <Hearts n={myLives} /> : <span style={{ color: 'var(--incorrect)' }}>ELIMINATED</span>}
                {d < 0 && <span style={{ color: 'var(--incorrect)' }}>{d} life</span>}
                {d > 0 && <span style={{ color: 'var(--correct)' }}>+{d} life!</span>}
              </div>
            )
          })()}
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
                    <span className="text-xs font-black uppercase tracking-wide px-2 py-1 rounded shrink-0"
                      style={{ background: isCorrect ? 'var(--correct)' : 'var(--incorrect)', color: '#fff' }}>
                      {isCorrect ? 'Correct' : 'Incorrect'}
                    </span>
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

          {gameState.mode !== 'survival' && (
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
          )}
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
          <h2 className="text-4xl font-black">
            {myPos === 1 ? (gameState.mode === 'survival' ? 'You survived!' : 'You won!') : `#${myPos} place`}
          </h2>
          {amLast && (
            <div className="rounded-full px-5 py-2 text-sm font-black" style={{ background: 'var(--incorrect)', color: '#fff' }}>
              Finish your drink!
            </div>
          )}
          <div className="w-full space-y-2">
            {ranked.map((p, i) => {
              const lives = gameState.lives[p.id] ?? 0
              return (
                <div key={p.id}
                  className="flex justify-between items-center rounded-xl px-5 py-3"
                  style={{
                    background: p.id === playerId ? 'var(--primary)' : 'var(--surface)',
                    fontWeight: p.id === playerId ? 900 : 400,
                  }}>
                  <span className="flex items-center gap-2"><span className="font-bold opacity-70">{i + 1}.</span> <Avatar name={p.name} id={p.id} size={22} /> {p.name}</span>
                  <span className="font-black">{gameState.mode === 'survival' ? (lives > 0 ? <Hearts n={lives} /> : 'OUT') : p.score}</span>
                </div>
              )
            })}
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
