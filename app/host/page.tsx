'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import {
  generateRoomCode, fetchSpeakers, fetchRandomConversation,
  buildRoundQuestion, scoreRound, applyScoreDeltas, createInitialGameState,
  computeRoundDrinks, computeRfDrink, drinkResultText, roundDrinkCallouts,
  buildRfClaim, scoreRfRound, applyLifeLoss, aliveIds, SURVIVAL_LIVES,
  TIMER_DURATION_MS,
} from '@/lib/game'
import { unlockAudio, playTick, playReveal } from '@/lib/sounds'
import type { GameState, GameMode, Player, ChannelMessage } from '@/lib/types'
import { RealtimeChannel } from '@supabase/supabase-js'
import { ContextBar } from './components/ContextBar'
import { Typewriter, TYPE_SPEED_MS } from './components/Typewriter'
import { ReactionsOverlay, type FloatingReaction } from './components/ReactionsOverlay'
import { Podium } from './components/Podium'
import { JoinQR } from './components/JoinQR'
import { LiveLeaderboard } from './components/LiveLeaderboard'
import { TimerBar } from './components/TimerBar'
import { TVScaleWrapper } from './components/TVScaleWrapper'

const ROUND_OPTIONS = [5, 10, 15, 20]
const TIMER_OPTIONS_SEC = [10, 20, 30]
// Extra time after the quote finishes typing: read it, decide, and place a bet before guessing.
const PROMPT_BUFFER_MS = 1600 + 11000 // 1600ms typing finish + 11s read/think/bet pause
const PROMPT_MIN_MS = 14000
const PROMPT_MAX_MS = 32000
const REVEAL_STEP_MS = 900
const STORAGE_KEY = 'wsi_host_game'

type SavedGame = { state: GameState; usedConvIds: number[] }

export default function HostPage() {
  const [state, setState] = useState<GameState | null>(null)
  const usedConvIdsRef = useRef<number[]>([])
  const [timeLeft, setTimeLeft] = useState(TIMER_DURATION_MS) // display only; real source is state.timerDuration
  const [revealStep, setRevealStep] = useState(0)
  const [resumable, setResumable] = useState<SavedGame | null>(null)
  const [reactions, setReactions] = useState<FloatingReaction[]>([])
  const [presentIds, setPresentIds] = useState<Set<string>>(new Set())
  const [presenceReady, setPresenceReady] = useState(false)
  const [promptCountdown, setPromptCountdown] = useState<number | null>(null)
  // Tracks which conversationId's context has finished typing, so the quote only starts after.
  const [contextDoneForConv, setContextDoneForConv] = useState<number | null>(null)

  const channelRef = useRef<RealtimeChannel | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const promptRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef<GameState | null>(null)
  const lastTickRef = useRef<number>(-1)
  const reactionIdRef = useRef(0)

  // ---- persistence ----
  const persist = useCallback((s: GameState) => {
    if (typeof window === 'undefined') return
    if (s.phase === 'leaderboard') { localStorage.removeItem(STORAGE_KEY); return }
    const payload: SavedGame = { state: s, usedConvIds: usedConvIdsRef.current }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as SavedGame
      if (parsed.state && parsed.state.phase !== 'leaderboard') {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setResumable(parsed)
        // Prefer the server-side checkpoint if one exists (survives a wiped localStorage / new device).
        supabase.from('game_sessions').select('snapshot').eq('room_code', parsed.state.roomCode).maybeSingle()
          .then(({ data }) => {
            const snap = data?.snapshot as GameState | undefined
            if (snap && snap.phase !== 'leaderboard') setResumable({ state: snap, usedConvIds: parsed.usedConvIds })
          })
      }
    } catch { /* ignore */ }
  }, [])

  // Single safe writer: keeps React state and the stale-closure-proof ref in lockstep.
  // Accepts a value or an updater derived from the latest committed state; returns the result.
  const commitState = useCallback((update: GameState | ((prev: GameState) => GameState)): GameState => {
    const next = typeof update === 'function' ? update(stateRef.current!) : update
    stateRef.current = next
    setState(next)
    return next
  }, [])

  // Fire-and-forget DB checkpoint so a closed/crashed host tab can be recovered.
  const checkpointSession = useCallback((s: GameState) => {
    supabase.from('game_sessions')
      .upsert({ room_code: s.roomCode, snapshot: s, updated_at: new Date().toISOString() }, { onConflict: 'room_code' })
      .then(({ error }) => { if (error) console.warn('checkpoint failed:', error.message) })
  }, [])

  // Local commit + push to peers + persist. The only path that leaves this host.
  // speakers is static, so it's stripped from the payload (players cache it from speakers_sync).
  const broadcast = useCallback((newState: GameState) => {
    const next = commitState(newState)
    channelRef.current?.send({
      type: 'broadcast',
      event: 'state_update',
      payload: { type: 'state_update', state: { ...next, speakers: [] } },
    })
    persist(next)
    // Checkpoint at round boundaries only (new round / round end / game over).
    if (next.phase === 'prompt' || next.phase === 'reveal' || next.phase === 'leaderboard') checkpointSession(next)
  }, [commitState, persist, checkpointSession])

  const revealAnswers = useCallback((cur: GameState) => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (!cur.question || cur.phase === 'reveal' || cur.phase === 'leaderboard') return
    const revealedAnswers = { ...cur.question.correctAnswers }
    const questionWithNames = {
      ...cur.question,
      lines: cur.question.lines.map((l) => ({
        ...l,
        speakerId: revealedAnswers[l.lineId],
        speakerName: cur.speakers.find((s) => s.id === revealedAnswers[l.lineId])?.name ?? '???',
      })),
    }

    // Real or Cap: flat points for a correct vote; no bets, streaks, or swaps.
    if (cur.mode === 'realfake') {
      if (!cur.rfClaim) return
      const { deltas, perfectRound } = scoreRfRound(cur.rfClaim, cur.rfVotes, cur.players)
      const updatedPlayers = cur.players.map((p) => ({ ...p, score: p.score + (deltas[p.id] ?? 0) }))
      broadcast({
        ...cur, phase: 'reveal', revealedAnswers, question: questionWithNames,
        scores: deltas, streakBonuses: {}, perfectRound, executedSwaps: [], players: updatedPlayers,
      })
      return
    }

    // Classic & Survival share line-guess scoring; survival has no bets/swaps (lives are the stakes).
    const bets = cur.mode === 'survival' ? {} : cur.bets
    const swapTargets = cur.mode === 'survival' ? {} : cur.swapTargets
    const { deltas, streakBonuses, perfectRound, executedSwaps } = scoreRound(cur.question, cur.guesses, cur.players, cur.timerStart ?? Date.now(), cur.timerDuration, cur.lockTimes, bets, swapTargets)

    if (cur.mode === 'survival') {
      // Eliminated players spectate: scores frozen, no further life loss (applyLifeLoss floors at 0).
      for (const p of cur.players) {
        if ((cur.lives[p.id] ?? 0) <= 0) { deltas[p.id] = 0; streakBonuses[p.id] = 0 }
      }
      const lives = applyLifeLoss(cur.lives, perfectRound)
      const updatedPlayers = applyScoreDeltas(cur.players, deltas, perfectRound, [])
      broadcast({
        ...cur, phase: 'reveal', revealedAnswers, question: questionWithNames,
        scores: deltas, streakBonuses, perfectRound, executedSwaps: [], players: updatedPlayers, lives,
      })
      return
    }

    const updatedPlayers = applyScoreDeltas(cur.players, deltas, perfectRound, executedSwaps)
    broadcast({
      ...cur, phase: 'reveal', revealedAnswers, question: questionWithNames,
      scores: deltas, streakBonuses, perfectRound, executedSwaps, players: updatedPlayers,
    })
  }, [broadcast])

  const checkAllGuessed = useCallback((cur: GameState) => {
    if (!cur.question || cur.players.length === 0) return
    if (cur.mode === 'realfake') {
      if (cur.players.every((p) => cur.rfVotes[p.id] !== undefined)) revealAnswers(cur)
      return
    }
    // Survival: only living players need to answer (eliminated spectate).
    const active = cur.mode === 'survival' ? cur.players.filter((p) => (cur.lives[p.id] ?? 0) > 0) : cur.players
    if (active.length === 0) return
    const lineIds = cur.question.lines.map((l) => l.lineId)
    const allDone = active.every((p) => lineIds.every((lid) => cur.guesses[lid]?.[p.id] !== undefined))
    if (allDone) revealAnswers(cur)
  }, [revealAnswers])

  // ---- channel setup (shared by create + resume) ----
  const setupChannel = useCallback((roomCode: string): RealtimeChannel => {
    const channel = supabase.channel(`room:${roomCode}`, { config: { broadcast: { self: true } } })

    channel.on('broadcast', { event: 'player_join' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'player_join') return
      const cur = stateRef.current
      if (!cur) return
      // Send the static speakers list once per join (kept out of state_update payloads).
      channel.send({ type: 'broadcast', event: 'speakers_sync', payload: { type: 'speakers_sync', speakers: cur.speakers } })
      // Same session id reconnecting — just resend state
      if (cur.players.find((p) => p.id === payload.playerId)) { broadcast(cur); return }
      const sameName = cur.players.find((p) => p.name.toLowerCase() === payload.playerName.toLowerCase())
      if (sameName) {
        if (cur.phase === 'lobby') {
          // Duplicate name while still in lobby — reject
          channel.send({
            type: 'broadcast', event: 'join_rejected',
            payload: { type: 'join_rejected', playerId: payload.playerId, reason: 'That name is taken — pick another.' },
          })
          return
        }
        // Mid-game rejoin — adopt the new session id + avatar, keep score/streak
        const next = { ...cur, players: cur.players.map((p) => p.name.toLowerCase() === payload.playerName.toLowerCase() ? { ...p, id: payload.playerId, avatar: payload.avatar } : p) }
        broadcast(next)
        return
      }
      const newPlayer: Player = { id: payload.playerId, name: payload.playerName, avatar: payload.avatar, score: 0, streak: 0 }
      broadcast({ ...cur, players: [...cur.players, newPlayer] })
    })

    channel.on('broadcast', { event: 'set_bet' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'set_bet') return
      const cur = stateRef.current
      if (cur?.phase !== 'guessing') return
      if (!cur.players.find((p) => p.id === payload.playerId)) return
      commitState((c) => ({ ...c, bets: { ...c.bets, [payload.playerId]: payload.bet } }))
    })

    channel.on('broadcast', { event: 'set_swap_target' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'set_swap_target') return
      const cur = stateRef.current
      if (cur?.phase !== 'guessing') return
      if (!cur.players.find((p) => p.id === payload.playerId)) return
      commitState((c) => ({ ...c, swapTargets: { ...c.swapTargets, [payload.playerId]: payload.targetId } }))
    })

    channel.on('broadcast', { event: 'rf_vote' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'rf_vote') return
      const cur = stateRef.current
      if (cur?.phase !== 'guessing' || cur.mode !== 'realfake') return
      if (!cur.players.find((p) => p.id === payload.playerId)) return
      const next = commitState((c) => ({ ...c, rfVotes: { ...c.rfVotes, [payload.playerId]: payload.vote } }))
      checkAllGuessed(next)
    })

    channel.on('broadcast', { event: 'reaction' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'reaction') return
      const id = reactionIdRef.current++
      const left = 8 + Math.random() * 84
      setReactions((r) => [...r, { id, emoji: payload.emoji, left }])
      setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 2400)
    })

    channel.on('broadcast', { event: 'submit_guess' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'submit_guess') return
      const cur0 = stateRef.current
      if (cur0?.phase !== 'guessing') return
      if (!cur0.players.find((p) => p.id === payload.playerId)) return
      if (cur0.mode === 'survival' && (cur0.lives[payload.playerId] ?? 0) <= 0) return // eliminated spectate
      const now = Date.now() // event-time, captured outside the render-pure updater
      const next = commitState((cur) => {
        const guesses = { ...cur.guesses, [payload.lineId]: { ...(cur.guesses[payload.lineId] ?? {}), [payload.playerId]: payload.speakerId } }
        // Stamp this player's individual lock-in time the first moment they've answered every line.
        const lineIds = cur.question?.lines.map((l) => l.lineId) ?? []
        const done = lineIds.length > 0 && lineIds.every((lid) => guesses[lid]?.[payload.playerId] !== undefined)
        const lockTimes = done && cur.lockTimes[payload.playerId] === undefined
          ? { ...cur.lockTimes, [payload.playerId]: now }
          : cur.lockTimes
        return { ...cur, guesses, lockTimes }
      })
      checkAllGuessed(next)
    })

    channel.on('broadcast', { event: 'lock_in' }, ({ payload }: { payload: ChannelMessage }) => {
      if (payload.type !== 'lock_in') return
      const cur = stateRef.current
      if (!cur || cur.phase !== 'guessing') return
      if (!cur.players.find((p) => p.id === payload.playerId)) return
      // Stamp lock-in time for a player who locks in before answering every line
      // (the all-answered path stamps it in submit_guess; whichever fires first wins).
      if (cur.lockTimes[payload.playerId] === undefined) {
        const now = Date.now()
        commitState((c) => ({ ...c, lockTimes: { ...c.lockTimes, [payload.playerId]: now } }))
      }
      checkAllGuessed(stateRef.current!)
    })

    // Presence: players track() themselves keyed by playerId; sync tells us who's live.
    channel.on('presence', { event: 'sync' }, () => {
      setPresentIds(new Set(Object.keys(channel.presenceState())))
      setPresenceReady(true)
    })

    return channel
  }, [broadcast, checkAllGuessed, commitState])

  // Resolves once the channel has actually joined the socket, so the first
  // broadcast goes over the WebSocket instead of falling back to REST.
  function subscribeAndWait(channel: RealtimeChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') reject(new Error(status))
      })
    })
  }

  async function createGame() {
    unlockAudio()
    const spkrs = await fetchSpeakers()
    const roomCode = generateRoomCode()
    usedConvIdsRef.current = []
    const initialState = createInitialGameState(roomCode, 10, spkrs)
    const channel = setupChannel(roomCode)
    channelRef.current = channel
    try {
      await subscribeAndWait(channel)
      broadcast(initialState)
    } catch (e) {
      console.error('Failed to open room channel:', e)
    }
  }

  async function resumeGame() {
    if (!resumable) return
    unlockAudio()
    const spkrs = await fetchSpeakers()
    usedConvIdsRef.current = resumable.usedConvIds
    const channel = setupChannel(resumable.state.roomCode)
    channelRef.current = channel
    // Drop back to the lobby of the in-progress game so the host can re-sync players, keeping
    // scores. Re-set speakers so saves from before speakers lived in GameState still work.
    // Migrate pre-modes saves: old mode 'normal'/'drinking' → classic (+ drinking flag),
    // and default the fields those snapshots don't have.
    const legacyMode = resumable.state.mode as GameMode | 'normal' | 'drinking'
    const mode: GameMode = legacyMode === 'normal' || legacyMode === 'drinking' ? 'classic' : legacyMode
    const resumedState: GameState = {
      ...resumable.state,
      phase: 'lobby',
      speakers: spkrs,
      mode,
      drinking: resumable.state.drinking ?? legacyMode === 'drinking',
      rfClaim: resumable.state.rfClaim ?? null,
      rfVotes: resumable.state.rfVotes ?? {},
      lives: resumable.state.lives ?? {},
      lockTimes: resumable.state.lockTimes ?? {},
    }
    try {
      await subscribeAndWait(channel)
      setResumable(null)
      broadcast(resumedState)
    } catch (e) {
      console.error('Failed to resume room channel:', e)
    }
  }

  function setRoundCount(n: number) {
    const cur = stateRef.current
    if (!cur || cur.phase !== 'lobby') return
    broadcast({ ...cur, totalRounds: n })
  }

  function setTimerDuration(ms: number) {
    const cur = stateRef.current
    if (!cur || cur.phase !== 'lobby') return
    broadcast({ ...cur, timerDuration: ms })
  }

  function setMode(mode: GameMode) {
    const cur = stateRef.current
    if (!cur || cur.phase !== 'lobby') return
    broadcast({ ...cur, mode })
  }

  function setDrinking(drinking: boolean) {
    const cur = stateRef.current
    if (!cur || cur.phase !== 'lobby') return
    broadcast({ ...cur, drinking })
  }

  // advance=false re-rolls the current round (used by Skip)
  async function startNextRound(advance = true) {
    const cur = stateRef.current
    if (!cur) return
    if (promptRef.current) clearTimeout(promptRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    const conv = await fetchRandomConversation(usedConvIdsRef.current)
    if (!conv) { broadcast({ ...cur, phase: 'leaderboard' }); return }
    usedConvIdsRef.current = [...usedConvIdsRef.current, conv.id]
    const question = buildRoundQuestion(conv)
    // Real or Cap: attribute one line to a claimed speaker (50/50 truth or cap).
    const rfClaim = cur.mode === 'realfake' ? buildRfClaim(question, cur.speakers) : null
    // Survival: deal everyone their lives when the game starts (first round out of the lobby).
    const lives = cur.mode === 'survival' && cur.phase === 'lobby'
      ? Object.fromEntries(cur.players.map((p) => [p.id, SURVIVAL_LIVES]))
      : cur.lives
    const contextChars = question.context?.length ?? 0
    const quoteChars = (cur.mode === 'realfake' && rfClaim
      ? question.lines.filter((l) => l.lineId === rfClaim.lineId)
      : question.lines
    ).reduce((a, l) => a + l.lineText.length, 0)
    const promptMs = Math.min(PROMPT_MAX_MS, Math.max(PROMPT_MIN_MS, (contextChars + quoteChars) * TYPE_SPEED_MS + PROMPT_BUFFER_MS))
    // eslint-disable-next-line react-hooks/purity -- event-driven, not a render path
    const promptEnd = Date.now() + promptMs
    const nextState: GameState = {
      ...cur,
      phase: 'prompt',
      currentRound: advance ? cur.currentRound + 1 : cur.currentRound,
      promptEnd,
      question, guesses: {}, lockTimes: {}, timerStart: null, revealedAnswers: {}, scores: {}, streakBonuses: {}, perfectRound: {}, bets: {}, swapTargets: {}, executedSwaps: [],
      rfClaim, rfVotes: {}, lives,
    }
    setTimeLeft(nextState.timerDuration)
    broadcast(nextState)
    beginPromptCountdown()
  }

  // Fires when the pre-calculated promptEnd timestamp is reached.
  function beginPromptCountdown() {
    if (promptRef.current) clearTimeout(promptRef.current)
    // eslint-disable-next-line react-hooks/purity -- event-driven, not a render path
    const remaining = Math.max(0, (stateRef.current?.promptEnd ?? 0) - Date.now())
    promptRef.current = setTimeout(() => {
      const cur = stateRef.current
      if (!cur) return
      const guessingState: GameState = { ...cur, phase: 'guessing', timerStart: Date.now() }
      setTimeLeft(guessingState.timerDuration)
      broadcast(guessingState)
      startTimer(guessingState)
    }, remaining)
  }

  function startTimer(gameState: GameState) {
    if (timerRef.current) clearInterval(timerRef.current)
    const start = gameState.timerStart!
    lastTickRef.current = -1
    timerRef.current = setInterval(() => {
      const remaining = gameState.timerDuration - (Date.now() - start)
      if (remaining <= 0) {
        clearInterval(timerRef.current!)
        setTimeLeft(0)
        revealAnswers(stateRef.current!)
      } else {
        setTimeLeft(remaining)
        const secs = Math.ceil(remaining / 1000)
        if (secs <= 5 && secs !== lastTickRef.current) { lastTickRef.current = secs; playTick() }
      }
    }, 100)
  }

  function skipRound() {
    startNextRound(false)
  }

  function continueAfterReveal() {
    const cur = stateRef.current
    if (!cur) return
    // Survival ends early once one (or zero) players are left standing.
    const survivalOver = cur.mode === 'survival' && aliveIds(cur.lives).length <= 1
    if (survivalOver || cur.currentRound >= cur.totalRounds) broadcast({ ...cur, phase: 'leaderboard' })
    else startNextRound(true)
  }

  // Reset to the lobby on the SAME room/channel, keeping everyone connected.
  function playAgain() {
    const cur = stateRef.current
    if (!cur) return
    if (timerRef.current) clearInterval(timerRef.current)
    if (promptRef.current) clearTimeout(promptRef.current)
    usedConvIdsRef.current = [] // fresh pool of quotes for the new game
    const resetPlayers = cur.players.map((p) => ({ ...p, score: 0, streak: 0 }))
    broadcast({
      ...createInitialGameState(cur.roomCode, cur.totalRounds, cur.speakers),
      mode: cur.mode,
      drinking: cur.drinking,
      timerDuration: cur.timerDuration,
      players: resetPlayers,
    })
  }

  // Staged reveal animation + reveal sound
  useEffect(() => {
    if (state?.phase !== 'reveal' || !state.question) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRevealStep(0)
    playReveal()
    const total = state.question.lines.length
    let step = 0
    const iv = setInterval(() => {
      step += 1
      setRevealStep(step)
      if (step >= total) clearInterval(iv)
    }, REVEAL_STEP_MS)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.question?.conversationId])

  useEffect(() => {
    const active = state?.phase === 'prompt' && !!state.promptEnd
    const secsLeft = () => Math.max(0, Math.ceil((state!.promptEnd! - Date.now()) / 1000))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPromptCountdown(active ? secsLeft() : null)
    if (!active) return
    const iv = setInterval(() => setPromptCountdown(secsLeft()), 250)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.promptEnd])

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (promptRef.current) clearTimeout(promptRef.current)
    channelRef.current?.unsubscribe()
  }, [])

  // ---------- Landing ----------
  if (!state) {
    return (
      <TVScaleWrapper>
      <main className="flex min-h-dvh items-center justify-center flex-col gap-8" style={{ width: '1920px', height: '1080px' }}>
        <div className="text-center space-y-4">
          <div className="text-8xl">🎤</div>
          <h1 className="text-5xl font-black" style={{ color: 'var(--primary-light)' }}>Who Said It?</h1>
          <p className="text-lg" style={{ color: 'var(--muted)' }}>Host Screen — display this on the TV</p>
        </div>
        <button onClick={createGame}
          className="rounded-2xl px-12 py-5 text-2xl font-black transition-all hover:scale-105 active:scale-95"
          style={{ background: 'var(--primary)', color: '#fff' }}>
          Create Game
        </button>
        {resumable && (
          <button onClick={resumeGame}
            className="rounded-2xl px-8 py-3 text-lg font-bold transition-all hover:scale-105"
            style={{ background: 'var(--surface)', border: '2px solid var(--accent)', color: 'var(--accent)' }}>
            ↻ Resume game {resumable.state.roomCode} (round {resumable.state.currentRound}/{resumable.state.totalRounds})
          </button>
        )}
      </main>
      </TVScaleWrapper>
    )
  }

  const showSidebar = (state.phase === 'prompt' || state.phase === 'guessing' || state.phase === 'reveal') && state.players.length > 0

  return (
    <TVScaleWrapper>
    <main className="p-8 flex flex-col gap-6" style={{ width: '1920px', height: '1080px', overflow: 'hidden' }}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-4xl font-black flex items-center gap-2" style={{ color: 'var(--primary-light)' }}>
          Who Said It?
          {state.drinking && <span className="text-2xl" title="Tipsy Edition">🍺</span>}
        </div>
        <div className="flex items-center gap-5 sm:gap-8">
          {state.phase !== 'lobby' && state.phase !== 'leaderboard' && (
            <span className="text-2xl font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>Round {state.currentRound}/{state.totalRounds}</span>
          )}
          {(state.phase === 'prompt' || state.phase === 'guessing') && (
            <button onClick={skipRound}
              className="rounded-lg px-5 py-2.5 text-xl font-bold transition-all hover:scale-105"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              Skip ⏭
            </button>
          )}
          <div className="rounded-xl px-5 py-3 text-4xl font-black tracking-widest" style={{ background: 'var(--surface)' }}>
            {state.roomCode}
          </div>
        </div>
      </div>

      <div className="flex-1 flex gap-6 min-h-0 w-full">
        <div className="flex-1 flex flex-col min-w-0">

      {/* Lobby */}
      {state.phase === 'lobby' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-8 animate-slide-up">
          <div className="text-center space-y-3">
            <h2 className="text-5xl font-black">Waiting for players…</h2>
            <p className="text-2xl" style={{ color: 'var(--muted)' }}>Scan the code or enter it manually</p>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-10">
            <JoinQR roomCode={state.roomCode} />
            <div className="text-8xl font-black tracking-[0.3em]" style={{ color: 'var(--accent)' }}>{state.roomCode}</div>
          </div>

          <div className="flex flex-wrap gap-3 justify-center max-w-4xl min-h-[3rem]">
            {state.players.map((p) => {
              const off = presenceReady && !presentIds.has(p.id)
              return (
                <div key={p.id} className="rounded-full px-6 py-3 text-2xl font-bold animate-bounce-in flex items-center gap-2"
                  style={{ background: 'var(--surface)', border: `2px solid ${off ? 'var(--muted)' : 'var(--primary)'}`, opacity: off ? 0.5 : 1 }}>
                  <span>{p.avatar}</span>{p.name}{off && <span title="disconnected">📴</span>}
                </div>
              )
            })}
          </div>

          {/* Round count selector */}
          <div className="flex items-center gap-4">
            <span className="text-2xl" style={{ color: 'var(--muted)' }}>Rounds:</span>
            {ROUND_OPTIONS.map((n) => (
              <button key={n} onClick={() => setRoundCount(n)}
                className="rounded-lg px-6 py-3 text-xl font-bold transition-all"
                style={{
                  background: state.totalRounds === n ? 'var(--primary)' : 'var(--surface)',
                  color: state.totalRounds === n ? '#fff' : 'var(--muted)',
                }}>{n}</button>
            ))}
          </div>

          {/* Timer duration selector */}
          <div className="flex items-center gap-4">
            <span className="text-2xl" style={{ color: 'var(--muted)' }}>Timer:</span>
            {TIMER_OPTIONS_SEC.map((s) => (
              <button key={s} onClick={() => setTimerDuration(s * 1000)}
                className="rounded-lg px-6 py-3 text-xl font-bold transition-all"
                style={{
                  background: state.timerDuration === s * 1000 ? 'var(--primary)' : 'var(--surface)',
                  color: state.timerDuration === s * 1000 ? '#fff' : 'var(--muted)',
                }}>{s}s</button>
            ))}
          </div>

          {/* Game mode selector */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-4">
              <span className="text-2xl" style={{ color: 'var(--muted)' }}>Mode:</span>
              {([
                { m: 'classic' as GameMode, label: '🏆 Classic' },
                { m: 'realfake' as GameMode, label: '🕵 Real or Cap' },
                { m: 'survival' as GameMode, label: '💀 Survival' },
              ]).map(({ m, label }) => (
                <button key={m} onClick={() => setMode(m)}
                  className="rounded-lg px-6 py-3 text-xl font-bold transition-all"
                  style={{ background: state.mode === m ? 'var(--primary)' : 'var(--surface)', color: state.mode === m ? '#fff' : 'var(--muted)' }}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-lg text-center max-w-2xl" style={{ color: 'var(--muted)' }}>
              {state.mode === 'classic' && 'Guess who said it — points, streaks & confidence bets.'}
              {state.mode === 'realfake' && 'A quote appears with a name on it. Vote REAL or CAP — flat 500 points per correct call.'}
              {state.mode === 'survival' && `Everyone starts with ${SURVIVAL_LIVES} lives. Miss a round = lose one. Last one standing wins.`}
            </p>
          </div>

          {/* Drinking overlay toggle — stacks on any mode */}
          <div className="flex flex-col items-center gap-3">
            <button onClick={() => setDrinking(!state.drinking)}
              className="rounded-lg px-6 py-3 text-xl font-bold transition-all"
              style={{ background: state.drinking ? 'var(--accent)' : 'var(--surface)', color: state.drinking ? '#000' : 'var(--muted)' }}>
              🍺 Tipsy Edition: {state.drinking ? 'ON' : 'OFF'}
            </button>
            {state.drinking && (
              <p className="text-lg text-center max-w-xl" style={{ color: 'var(--muted)' }}>
                Wrong = a sip · whiff it all = a shot · 21+, drink responsibly, know your limits.
              </p>
            )}
          </div>

          {state.players.length > 0 && (
            <button onClick={() => startNextRound(true)}
              className="rounded-2xl px-16 py-6 text-3xl font-black transition-all hover:scale-105"
              style={{ background: 'var(--primary)', color: '#fff' }}>
              Start Game ({state.players.length} player{state.players.length !== 1 ? 's' : ''})
            </button>
          )}
        </div>
      )}

      {/* Prompt Phase */}
      {state.phase === 'prompt' && state.question && (() => {
        const conv = state.question
        const hasContext = !!conv.context
        const contextDone = !hasContext || contextDoneForConv === conv.conversationId
        // Real or Cap shows ONLY the claimed line (the rest of the convo would give it away).
        const promptLines = state.mode === 'realfake' && state.rfClaim
          ? conv.lines.filter((l) => l.lineId === state.rfClaim!.lineId)
          : conv.lines
        return (
          <div className="flex-1 flex flex-col items-center justify-center gap-8 animate-slide-up max-w-6xl mx-auto w-full">
            <ContextBar context={null} happenedAt={conv.happenedAt} />
            {hasContext && (
              <Typewriter
                key={`ctx-${conv.conversationId}`}
                plain
                plainClassName="text-2xl italic w-full text-center"
                lines={[{ lineId: -1, lineText: `📍 ${conv.context}`, actionText: null }]}
                onComplete={() => setContextDoneForConv(conv.conversationId)}
              />
            )}
            {contextDone && (
              <Typewriter key={conv.conversationId} lines={promptLines} />
            )}
            {contextDone && state.mode === 'realfake' && state.rfClaim && (
              <div className="rounded-2xl px-8 py-5 text-center animate-slide-up" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
                <p className="text-3xl font-black" style={{ color: 'var(--accent)' }}>
                  🕵 {state.rfClaim.claimedSpeakerName} said this… <span className="text-white">REAL or CAP?</span>
                </p>
              </div>
            )}
            <div className="flex items-center gap-4">
              <p className="text-3xl font-bold animate-pulse" style={{ color: 'var(--accent)' }}>Get ready to guess…</p>
              {promptCountdown !== null && promptCountdown > 0 && (
                <span className="text-5xl font-black tabular-nums" style={{ color: 'var(--accent)' }}>{promptCountdown}</span>
              )}
            </div>
          </div>
        )
      })()}

      {/* Guessing Phase */}
      {state.phase === 'guessing' && state.question && (
        <div className="flex-1 flex flex-col gap-8 max-w-6xl mx-auto w-full">
          <TimerBar timeLeft={timeLeft} total={state.timerDuration} />
          <ContextBar context={state.question.context} happenedAt={state.question.happenedAt} small />
          <div className="space-y-5">
            {(state.mode === 'realfake' && state.rfClaim
              ? state.question.lines.filter((l) => l.lineId === state.rfClaim!.lineId)
              : state.question.lines
            ).map((line) => (
              <div key={line.lineId} className="rounded-2xl p-7" style={{ background: 'var(--surface)' }}>
                {line.actionText && <p className="text-lg italic mb-2" style={{ color: 'var(--muted)' }}>*{line.actionText}*</p>}
                <p className="text-4xl leading-relaxed">&ldquo;{line.lineText}&rdquo;{' '}
                  <span className="text-3xl font-bold" style={{ color: state.mode === 'realfake' ? 'var(--accent)' : 'var(--primary-light)' }}>
                    — {state.mode === 'realfake' && state.rfClaim ? state.rfClaim.claimedSpeakerName : '???'}
                  </span>
                </p>
              </div>
            ))}
          </div>
          {state.mode === 'realfake' && (
            <p className="text-3xl font-black text-center animate-pulse" style={{ color: 'var(--accent)' }}>REAL or CAP? Vote on your phone!</p>
          )}
          <div className="mt-auto lg:hidden">
            <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Answers in</p>
            <div className="flex flex-wrap gap-2">
              {state.players.map((p) => {
                const lineIds = state.question!.lines.map((l) => l.lineId)
                const done = lineIds.every((lid) => state.guesses[lid]?.[p.id] !== undefined)
                const off = presenceReady && !presentIds.has(p.id)
                return (
                  <div key={p.id} className="rounded-full px-4 py-1 text-sm font-bold transition-all flex items-center gap-1"
                    style={{ background: done && !off ? 'var(--correct)' : 'var(--surface)', color: done && !off ? '#fff' : 'var(--muted)', opacity: off ? 0.35 : done ? 1 : 0.5 }}>
                    <span>{p.avatar}</span>{p.name}{off ? ' 📴' : done ? ' ✓' : ''}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Reveal Phase */}
      {state.phase === 'reveal' && state.question && (
        <div className="flex-1 flex flex-col gap-6 max-w-6xl mx-auto w-full animate-slide-up">
          <h2 className="text-5xl font-black text-center">The Answer!</h2>
          <ContextBar context={null} happenedAt={state.question.happenedAt} small />

          <div className="space-y-4">
            {state.question.lines.map((line, idx) => {
              const shown = idx < revealStep
              // Who guessed what for this line
              const lineGuesses = state.players.map((p) => ({
                player: p,
                guessId: state.guesses[line.lineId]?.[p.id],
              }))
              return (
                <div key={line.lineId} className="rounded-2xl p-7 transition-all"
                  style={{ background: 'var(--surface)', border: `2px solid ${shown ? 'var(--correct)' : 'transparent'}` }}>
                  {/* Context + Quote + Author inline */}
                  {idx === 0 && state.question?.context && <p className="text-lg italic mb-2" style={{ color: 'var(--muted)' }}>📍 {state.question.context}</p>}
                  {line.actionText && <p className="text-lg italic mb-2" style={{ color: 'var(--muted)' }}>*{line.actionText}*</p>}
                  <p className="text-3xl leading-relaxed font-medium" style={{ color: 'var(--text)' }}>
                    &ldquo;{line.lineText}&rdquo;{' '}
                    <span className="text-2xl font-bold" style={{ color: shown ? '#f59e0b' : 'var(--muted)' }}>
                      — {shown ? line.speakerName : '???'}
                    </span>
                  </p>

                  {/* Guesses (not in Real or Cap — votes are shown in the verdict panel) */}
                  {shown && state.mode !== 'realfake' && lineGuesses.length > 0 && (() => {
                    const correctGuesses = lineGuesses.filter(({ guessId }) => guessId === line.speakerId)
                    const incorrectGuesses = lineGuesses.filter(({ guessId }) => guessId !== line.speakerId)
                    return (
                      <div className="animate-slide-up" style={{ borderTop: '1px solid rgba(148,163,184,0.15)', marginTop: '0.75rem', paddingTop: '0.75rem' }}>
                        {correctGuesses.length > 0 && (
                          <div className="mb-3">
                            <p className="text-sm uppercase tracking-widest mb-2 font-bold" style={{ color: 'rgba(74,222,128,0.8)' }}>Correct</p>
                            <div className="flex flex-wrap gap-2">
                              {correctGuesses.map(({ player }) => (
                                <span key={player.id} className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xl font-bold"
                                  style={{ background: 'var(--correct)', color: '#fff' }}>
                                  {player.avatar} {player.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {incorrectGuesses.length > 0 && (
                          <div>
                            <p className="text-sm uppercase tracking-widest mb-2 font-bold" style={{ color: 'rgba(100,116,139,0.8)' }}>Incorrect</p>
                            <div className="flex flex-wrap gap-2">
                              {incorrectGuesses.map(({ player, guessId }) => {
                                const guessName = state.speakers.find((s) => s.id === guessId)?.name ?? '—'
                                return (
                                  <span key={player.id} className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xl font-bold border"
                                    style={{ background: 'rgba(30,41,59,0.5)', borderColor: 'rgba(51,65,85,1)' }}>
                                    <span style={{ color: 'rgb(203,213,225)' }}>{player.avatar} {player.name}</span>
                                    <span style={{ color: 'rgb(100,116,139)' }}> ➔ {guessName}</span>
                                  </span>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>

          {/* Score this round (small screens; large screens use the live sidebar) */}
          <div className="rounded-2xl p-5 lg:hidden" style={{ background: 'var(--surface)' }}>
            <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>This Round</p>
            <div className="space-y-2">
              {state.players.slice().sort((a, b) => b.score - a.score).map((p) => {
                const delta = state.scores[p.id] ?? 0
                const bonus = state.streakBonuses[p.id] ?? 0
                const bet = state.bets[p.id] ?? 1
                return (
                  <div key={p.id} className="flex justify-between items-center">
                    <span className="font-bold flex items-center gap-2">
                      <span>{p.avatar}</span>{p.name}
                      {bet === 'swap' && <span className="text-xs font-black" style={{ color: 'var(--accent)' }}>🔀 SWAP</span>}
                      {bet === 3 && <span className="text-xs font-black" style={{ color: 'var(--incorrect)' }}>💀 ALL-IN</span>}
                      {bet === 2 && <span className="text-xs font-black" style={{ color: 'var(--incorrect)' }}>🔥×2</span>}
                      {bet === 0.5 && <span className="text-xs font-black" style={{ color: 'var(--muted)' }}>🛡×0.5</span>}
                      {p.streak > 1 && <span className="text-xs" style={{ color: 'var(--accent)' }}>🔥{p.streak}</span>}
                    </span>
                    <div className="flex gap-3 items-center">
                      {bonus > 0 && <span className="text-xs font-bold" style={{ color: 'var(--accent)' }}>+{bonus} streak</span>}
                      {delta !== 0 && <span className="text-sm font-bold" style={{ color: delta > 0 ? 'var(--correct)' : 'var(--incorrect)' }}>{delta > 0 ? '+' : ''}{delta}</span>}
                      <span className="font-black text-lg">{p.score}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Real or Cap verdict */}
          {state.mode === 'realfake' && state.rfClaim && (
            <div className="rounded-2xl p-6 space-y-3 animate-slide-up" style={{ background: 'var(--surface)', border: `3px solid ${state.rfClaim.isReal ? 'var(--correct)' : 'var(--incorrect)'}` }}>
              <p className="text-4xl font-black text-center" style={{ color: state.rfClaim.isReal ? 'var(--correct)' : 'var(--incorrect)' }}>
                {state.rfClaim.isReal ? '✅ REAL — they really said it!' : `🧢 CAP! That was ${state.question.lines.find((l) => l.lineId === state.rfClaim!.lineId)?.speakerName ?? '???'}`}
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                {state.players.map((p) => {
                  const vote = state.rfVotes[p.id]
                  const right = state.perfectRound[p.id] === true
                  return (
                    <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xl font-bold"
                      style={{ background: right ? 'var(--correct)' : 'rgba(30,41,59,0.5)', color: right ? '#fff' : 'rgb(148,163,184)', border: right ? 'none' : '1px solid rgba(51,65,85,1)' }}>
                      {p.avatar} {p.name} — {vote === undefined ? '😴 no vote' : vote === 'real' ? 'REAL' : 'CAP'}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Survival lives */}
          {state.mode === 'survival' && (
            <div className="rounded-2xl p-6 animate-slide-up" style={{ background: 'var(--surface)', border: '2px solid var(--incorrect)' }}>
              <p className="text-lg uppercase tracking-widest mb-3 font-black" style={{ color: 'var(--incorrect)' }}>💀 Lives</p>
              <div className="flex flex-wrap gap-3">
                {state.players.map((p) => {
                  const n = state.lives[p.id] ?? 0
                  const lostThisRound = state.perfectRound[p.id] === false && n > 0
                  return (
                    <span key={p.id} className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-2xl font-bold"
                      style={{ background: n > 0 ? 'rgba(255,255,255,0.06)' : 'rgba(239,68,68,0.18)', opacity: n > 0 ? 1 : 0.7 }}>
                      {p.avatar} {p.name} {n > 0 ? '❤️'.repeat(n) : '💀 OUT'}
                      {lostThisRound && <span className="text-base" style={{ color: 'var(--incorrect)' }}>−1</span>}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Point swap callouts */}
          {state.executedSwaps.length > 0 && (
            <div className="rounded-2xl p-5 space-y-2" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
              <p className="text-lg uppercase tracking-widest font-black" style={{ color: 'var(--accent)' }}>🔀 Point Swap!</p>
              {state.executedSwaps.map(({ winnerId, loserId }) => {
                const winner = state.players.find((p) => p.id === winnerId)
                const loser = state.players.find((p) => p.id === loserId)
                if (!winner || !loser) return null
                return (
                  <p key={winnerId} className="text-2xl font-bold">
                    {winner.avatar} {winner.name} swapped points with {loser.avatar} {loser.name}!
                  </p>
                )
              })}
            </div>
          )}

          {/* Drinks this round (Tipsy Edition overlay) */}
          {state.drinking && (
            <div className="rounded-2xl p-6" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
              <p className="text-lg uppercase tracking-widest mb-3 font-black" style={{ color: 'var(--accent)' }}>🍺 Drink Up</p>
              <div className="space-y-2">
                {state.players.map((p) => {
                  const result = state.mode === 'realfake'
                    ? computeRfDrink(state.rfVotes[p.id], state.perfectRound[p.id] === true)
                    : computeRoundDrinks(state.question!, (lid) => state.guesses[lid]?.[p.id])
                  return (
                    <div key={p.id} className="flex justify-between items-center text-2xl">
                      <span className="font-bold flex items-center gap-2"><span>{p.avatar}</span>{p.name}</span>
                      <span className="font-bold" style={{ color: result.kind === 'safe' ? 'var(--correct)' : 'var(--accent)' }}>
                        {drinkResultText(result)}
                      </span>
                    </div>
                  )
                })}
              </div>
              {roundDrinkCallouts(state).map((c, i) => (
                <p key={i} className="text-xl font-bold mt-3 text-center" style={{ color: 'var(--accent)' }}>{c}</p>
              ))}
            </div>
          )}

          <button onClick={continueAfterReveal}
            className="rounded-2xl py-6 text-3xl font-black transition-all hover:scale-105"
            style={{ background: 'var(--primary)', color: '#fff' }}>
            {state.currentRound >= state.totalRounds || (state.mode === 'survival' && aliveIds(state.lives).length <= 1) ? 'See Final Results' : 'Next Round →'}
          </button>
        </div>
      )}

      {/* Leaderboard */}
      {state.phase === 'leaderboard' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-8">
          <h2 className="text-6xl font-black text-center animate-bounce-in" style={{ color: 'var(--accent)' }}>🏆 Final Results</h2>
          <Podium players={state.players} drinking={state.drinking} lives={state.mode === 'survival' ? state.lives : undefined} />
          <div className="flex flex-col items-center gap-4">
            <button onClick={playAgain}
              className="rounded-2xl px-12 py-5 text-2xl font-black transition-all hover:scale-105"
              style={{ background: 'var(--primary)', color: '#fff' }}>
              🔄 New Game (same players)
            </button>
            <button onClick={() => { localStorage.removeItem(STORAGE_KEY); window.location.reload() }}
              className="text-lg underline" style={{ color: 'var(--muted)' }}>
              End session &amp; reset
            </button>
          </div>
        </div>
      )}

        </div>
        {showSidebar && <LiveLeaderboard state={state} present={presentIds} presenceReady={presenceReady} />}
      </div>

      {/* Floating reactions overlay */}
      <ReactionsOverlay reactions={reactions} />
    </main>
    </TVScaleWrapper>
  )
}
