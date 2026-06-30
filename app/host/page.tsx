'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import {
  generateRoomCode, fetchSpeakers, fetchRandomConversation,
  buildRoundQuestion, scoreRound, applyScoreDeltas, createInitialGameState,
  computeRoundDrinks, computeRfDrink, drinkResultText, roundDrinkCallouts,
  buildRfClaim, resolveSurvivalRound, aliveIds, SURVIVAL_LIVES, survivalTimerMs,
  TIMER_DURATION_MS, REVEAL_DURATION_MS,
} from '@/lib/game'
import { unlockAudio, playTick, playReveal } from '@/lib/sounds'
import type { GameState, GameMode, Player, RoundQuestion, ChannelMessage } from '@/lib/types'
import { RealtimeChannel } from '@supabase/supabase-js'
import { ContextBar } from './components/ContextBar'
import { Typewriter, TYPE_SPEED_MS } from './components/Typewriter'
import { ReactionsOverlay, type FloatingReaction } from './components/ReactionsOverlay'
import { Podium } from './components/Podium'
import { JoinQR } from './components/JoinQR'
import { LiveLeaderboard } from './components/LiveLeaderboard'
import { TimerBar } from './components/TimerBar'
import { TVScaleWrapper } from './components/TVScaleWrapper'
import { Avatar } from '../components/Avatar'
import { Hearts } from '../components/Hearts'

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
  const [revealCountdown, setRevealCountdown] = useState<number | null>(null)
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

    // Real or Cap: score like a one-line classic round where "voted correctly" = "perfect",
    // so it reuses the full confidence-bet system (Safe/Risky/All-In/Swap, streaks, speed bonus).
    if (cur.mode === 'realfake') {
      if (!cur.rfClaim) return
      const truth: 'real' | 'fake' = cur.rfClaim.isReal ? 'real' : 'fake'
      const lid = cur.rfClaim.lineId
      const CORRECT = 1 // synthetic "right answer" marker; a wrong/absent vote maps to 0
      const syntheticQ: RoundQuestion = {
        conversationId: cur.question.conversationId, context: null, happenedAt: null,
        lines: [{ lineId: lid, lineOrder: 0, lineText: '', actionText: null }],
        correctAnswers: { [lid]: CORRECT },
      }
      const syntheticGuesses: GameState['guesses'] = {
        [lid]: Object.fromEntries(cur.players.map((p) => [p.id, cur.rfVotes[p.id] === truth ? CORRECT : 0])),
      }
      const { deltas, streakBonuses, perfectRound, executedSwaps, blockedSwaps } = scoreRound(syntheticQ, syntheticGuesses, cur.players, cur.timerStart ?? Date.now(), cur.timerDuration, cur.lockTimes, cur.bets, cur.swapTargets)
      const updatedPlayers = applyScoreDeltas(cur.players, deltas, perfectRound, executedSwaps)
      broadcast({
        ...cur, phase: 'reveal', revealedAnswers, question: questionWithNames,
        scores: deltas, streakBonuses, perfectRound, executedSwaps, blockedSwaps, players: updatedPlayers,
      })
      return
    }

    // Survival has NO points — lives are the only currency. Scaled life loss + hot-streak regen.
    if (cur.mode === 'survival') {
      const { lives, perfectRound, players, lifeDeltas } = resolveSurvivalRound(cur.lives, cur.question, cur.guesses, cur.players)
      broadcast({
        ...cur, phase: 'reveal', revealedAnswers, question: questionWithNames,
        scores: {}, streakBonuses: {}, perfectRound, executedSwaps: [], blockedSwaps: [], players, lives, lifeDeltas,
      })
      return
    }

    // Classic guessing scoring (bets/swaps/streaks).
    const { deltas, streakBonuses, perfectRound, executedSwaps, blockedSwaps } = scoreRound(cur.question, cur.guesses, cur.players, cur.timerStart ?? Date.now(), cur.timerDuration, cur.lockTimes, cur.bets, cur.swapTargets)
    const updatedPlayers = applyScoreDeltas(cur.players, deltas, perfectRound, executedSwaps)
    broadcast({
      ...cur, phase: 'reveal', revealedAnswers, question: questionWithNames,
      scores: deltas, streakBonuses, perfectRound, executedSwaps, blockedSwaps, players: updatedPlayers,
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
      const now = Date.now() // vote time → drives the speed bonus, same as a classic guess
      const next = commitState((c) => ({
        ...c,
        rfVotes: { ...c.rfVotes, [payload.playerId]: payload.vote },
        lockTimes: c.lockTimes[payload.playerId] === undefined ? { ...c.lockTimes, [payload.playerId]: now } : c.lockTimes,
      }))
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
    // Recover the survival base timer (older saves lack it) and restore timerDuration to that base,
    // so a host reload mid-survival resumes the ramp from the right value instead of a shrunk one.
    const survivalBaseTimer = resumable.state.survivalBaseTimer ?? resumable.state.timerDuration
    const resumedState: GameState = {
      ...resumable.state,
      phase: 'lobby',
      speakers: spkrs,
      mode,
      drinking: resumable.state.drinking ?? legacyMode === 'drinking',
      autoAdvance: resumable.state.autoAdvance ?? false,
      survivalBaseTimer,
      timerDuration: survivalBaseTimer,
      blockedSwaps: resumable.state.blockedSwaps ?? [],
      rfClaim: resumable.state.rfClaim ?? null,
      rfVotes: resumable.state.rfVotes ?? {},
      lives: resumable.state.lives ?? {},
      lifeDeltas: resumable.state.lifeDeltas ?? {},
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
    // Keep the base in lockstep with the lobby pick so survival ramps from the right value.
    broadcast({ ...cur, timerDuration: ms, survivalBaseTimer: ms })
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

  function setAutoAdvance(autoAdvance: boolean) {
    const cur = stateRef.current
    if (!cur || cur.phase !== 'lobby') return
    broadcast({ ...cur, autoAdvance })
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
    const nextRound = advance ? cur.currentRound + 1 : cur.currentRound
    // Survival: every player keeps their current lives; anyone without an entry yet (fresh game,
    // or a late joiner) is dealt a full set. This preserves elimination progress across a host
    // resume (which routes back through the lobby) instead of resetting everyone to full.
    const lives = cur.mode === 'survival'
      ? Object.fromEntries(cur.players.map((p) => [p.id, cur.lives[p.id] ?? SURVIVAL_LIVES]))
      : cur.lives
    // Survival's guessing window shrinks each round, computed from the persisted base
    // (survives a host reload); other modes keep the fixed lobby timer.
    const timerDuration = cur.mode === 'survival'
      ? survivalTimerMs(cur.survivalBaseTimer, nextRound)
      : cur.timerDuration
    const contextChars = question.context?.length ?? 0
    // True or False now shows the whole multi-part quote, so time it against every line.
    const quoteChars = question.lines.reduce((a, l) => a + l.lineText.length, 0)
    const promptMs = Math.min(PROMPT_MAX_MS, Math.max(PROMPT_MIN_MS, (contextChars + quoteChars) * TYPE_SPEED_MS + PROMPT_BUFFER_MS))
    // eslint-disable-next-line react-hooks/purity -- event-driven, not a render path
    const promptEnd = Date.now() + promptMs
    const nextState: GameState = {
      ...cur,
      phase: 'prompt',
      currentRound: nextRound,
      promptEnd,
      timerDuration,
      question, guesses: {}, lockTimes: {}, timerStart: null, revealedAnswers: {}, scores: {}, streakBonuses: {}, perfectRound: {}, bets: {}, swapTargets: {}, executedSwaps: [], blockedSwaps: [],
      rfClaim, rfVotes: {}, lives, lifeDeltas: {},
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
    // Survival runs infinitely until one (or zero) players remain — totalRounds doesn't apply.
    if (cur.mode === 'survival') {
      if (aliveIds(cur.lives).length <= 1) broadcast({ ...cur, phase: 'leaderboard' })
      else startNextRound(true)
      return
    }
    if (cur.currentRound >= cur.totalRounds) broadcast({ ...cur, phase: 'leaderboard' })
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
      // Restore the lobby's base timer (survival ramps cur.timerDuration down during play).
      timerDuration: cur.survivalBaseTimer,
      survivalBaseTimer: cur.survivalBaseTimer,
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

  // Auto-advance: when enabled, the reveal screen counts down and rolls to the next round itself.
  useEffect(() => {
    if (state?.phase !== 'reveal' || !state.autoAdvance) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRevealCountdown(null)
      return
    }
    const end = Date.now() + REVEAL_DURATION_MS
    setRevealCountdown(Math.ceil(REVEAL_DURATION_MS / 1000))
    const iv = setInterval(() => setRevealCountdown(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 250)
    const to = setTimeout(() => continueAfterReveal(), REVEAL_DURATION_MS)
    return () => { clearInterval(iv); clearTimeout(to) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.autoAdvance, state?.question?.conversationId])

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
          <h1 className="text-6xl font-black" style={{ color: 'var(--primary-light)' }}>Who Said It?</h1>
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
            Resume game {resumable.state.roomCode} (round {resumable.state.currentRound}/{resumable.state.totalRounds})
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
        <div className="text-4xl font-black flex items-center gap-3" style={{ color: 'var(--primary-light)' }}>
          Who Said It?
          {state.drinking && <span className="text-lg font-bold rounded-md px-2 py-0.5" style={{ background: 'var(--accent)', color: '#000' }}>TIPSY</span>}
        </div>
        <div className="flex items-center gap-5 sm:gap-8">
          {state.phase !== 'lobby' && state.phase !== 'leaderboard' && (
            <span className="text-2xl font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>
              Round {state.currentRound}{state.mode === 'survival' ? '' : `/${state.totalRounds}`}
            </span>
          )}
          {(state.phase === 'prompt' || state.phase === 'guessing') && (
            <button onClick={skipRound}
              className="rounded-lg px-5 py-2.5 text-xl font-bold transition-all hover:scale-105"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              Skip
            </button>
          )}
          <div className="rounded-xl px-5 py-3 text-4xl font-black tracking-widest" style={{ background: 'var(--surface)' }}>
            {state.roomCode}
          </div>
        </div>
      </div>

      <div className="flex-1 flex gap-6 min-h-0 w-full">
        <div className="flex-1 flex flex-col min-w-0">

      {/* Lobby — two columns: join (QR/code) on the left, settings + players + start on the right */}
      {state.phase === 'lobby' && (
        <div className="flex-1 flex items-center justify-center gap-16 animate-slide-up min-h-0">
          {/* Left: join */}
          <div className="flex flex-col items-center gap-4 shrink-0">
            <JoinQR roomCode={state.roomCode} />
            <div className="text-7xl font-black tracking-[0.3em]" style={{ color: 'var(--accent)' }}>{state.roomCode}</div>
            <p className="text-xl" style={{ color: 'var(--muted)' }}>Scan or enter the code to join</p>
          </div>

          {/* Right: lobby controls */}
          <div className="flex flex-col gap-5 w-[44rem] shrink-0">
            <h2 className="text-4xl font-black">Waiting for players…</h2>

            {/* Joined players */}
            <div className="flex flex-wrap gap-2 min-h-[3.25rem] content-start max-h-32 overflow-hidden">
              {state.players.length === 0
                ? <span className="text-xl self-center" style={{ color: 'var(--muted)' }}>No one&apos;s joined yet…</span>
                : state.players.map((p) => {
                    const off = presenceReady && !presentIds.has(p.id)
                    return (
                      <div key={p.id} className="rounded-full px-4 py-2 text-xl font-bold animate-bounce-in flex items-center gap-2"
                        style={{ background: 'var(--surface)', border: `2px solid ${off ? 'var(--muted)' : 'var(--primary)'}`, opacity: off ? 0.5 : 1 }}>
                        <Avatar name={p.name} id={p.id} size={26} />{p.name}{off && <span className="text-sm" style={{ color: 'var(--muted)' }}>(away)</span>}
                      </div>
                    )
                  })}
            </div>

            {/* Rounds — survival is infinite (until one remains), so no fixed count */}
            <div className="flex items-center gap-3">
              <span className="text-2xl w-28 shrink-0" style={{ color: 'var(--muted)' }}>Rounds</span>
              {state.mode === 'survival'
                ? <span className="text-xl font-bold px-2" style={{ color: 'var(--accent)' }}>∞ — until one survivor remains</span>
                : ROUND_OPTIONS.map((n) => (
                    <button key={n} onClick={() => setRoundCount(n)}
                      className="rounded-lg px-5 py-2.5 text-xl font-bold transition-all"
                      style={{ background: state.totalRounds === n ? 'var(--primary)' : 'var(--surface)', color: state.totalRounds === n ? '#fff' : 'var(--muted)' }}>{n}</button>
                  ))}
            </div>

            {/* Timer (survival: this is the STARTING window — it shrinks each round) */}
            <div className="flex items-center gap-3">
              <span className="text-2xl w-28 shrink-0" style={{ color: 'var(--muted)' }}>{state.mode === 'survival' ? 'Start' : 'Timer'}</span>
              {TIMER_OPTIONS_SEC.map((s) => (
                <button key={s} onClick={() => setTimerDuration(s * 1000)}
                  className="rounded-lg px-5 py-2.5 text-xl font-bold transition-all"
                  style={{ background: state.timerDuration === s * 1000 ? 'var(--primary)' : 'var(--surface)', color: state.timerDuration === s * 1000 ? '#fff' : 'var(--muted)' }}>{s}s</button>
              ))}
              {state.mode === 'survival' && <span className="text-sm" style={{ color: 'var(--muted)' }}>shrinks each round</span>}
            </div>

            {/* Mode */}
            <div className="flex items-start gap-3">
              <span className="text-2xl w-28 shrink-0 pt-2.5" style={{ color: 'var(--muted)' }}>Mode</span>
              <div className="flex-1 space-y-2">
                <div className="flex gap-2">
                  {([
                    { m: 'classic' as GameMode, label: 'Classic' },
                    { m: 'realfake' as GameMode, label: 'True or False' },
                    { m: 'survival' as GameMode, label: 'Survival' },
                  ]).map(({ m, label }) => (
                    <button key={m} onClick={() => setMode(m)}
                      className="rounded-lg px-4 py-2.5 text-lg font-bold transition-all"
                      style={{ background: state.mode === m ? 'var(--primary)' : 'var(--surface)', color: state.mode === m ? '#fff' : 'var(--muted)' }}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-base" style={{ color: 'var(--muted)' }}>
                  {state.mode === 'classic' && 'Guess who said it — points, streaks & confidence bets.'}
                  {state.mode === 'realfake' && 'A quote appears with a name on it. Place a confidence bet, then vote True or False.'}
                  {state.mode === 'survival' && `Everyone starts with ${SURVIVAL_LIVES} lives. Miss a round = lose a life; ${SURVIVAL_LIVES} perfect in a row regenerates one. Last one standing wins.`}
                </p>
              </div>
            </div>

            {/* Tipsy overlay */}
            <div className="flex items-center gap-3">
              <span className="text-2xl w-28 shrink-0" style={{ color: 'var(--muted)' }}>Tipsy</span>
              <button onClick={() => setDrinking(!state.drinking)}
                className="rounded-lg px-5 py-2.5 text-lg font-bold transition-all"
                style={{ background: state.drinking ? 'var(--accent)' : 'var(--surface)', color: state.drinking ? '#000' : 'var(--muted)' }}>
                {state.drinking ? 'ON' : 'OFF'}
              </button>
              {state.drinking && <span className="text-sm" style={{ color: 'var(--muted)' }}>Wrong = sip · whiff it all = shot · 21+, know your limits</span>}
            </div>

            {/* Auto-advance rounds */}
            <div className="flex items-center gap-3">
              <span className="text-2xl w-28 shrink-0" style={{ color: 'var(--muted)' }}>Auto-next</span>
              <button onClick={() => setAutoAdvance(!state.autoAdvance)}
                className="rounded-lg px-5 py-2.5 text-lg font-bold transition-all"
                style={{ background: state.autoAdvance ? 'var(--primary)' : 'var(--surface)', color: state.autoAdvance ? '#fff' : 'var(--muted)' }}>
                {state.autoAdvance ? 'ON' : 'OFF'}
              </button>
              <span className="text-sm" style={{ color: 'var(--muted)' }}>
                {state.autoAdvance ? `Rounds advance ${Math.round(REVEAL_DURATION_MS / 1000)}s after each reveal` : 'Host clicks Next each round'}
              </span>
            </div>

            {/* Start */}
            <button onClick={() => startNextRound(true)} disabled={state.players.length === 0}
              className="rounded-2xl py-5 text-3xl font-black transition-all hover:scale-[1.02] mt-1"
              style={{ background: state.players.length === 0 ? 'var(--surface)' : 'var(--primary)', color: state.players.length === 0 ? 'var(--muted)' : '#fff', cursor: state.players.length === 0 ? 'not-allowed' : 'pointer', opacity: state.players.length === 0 ? 0.6 : 1 }}>
              {state.players.length === 0 ? 'Waiting for players…' : `Start Game (${state.players.length} player${state.players.length !== 1 ? 's' : ''})`}
            </button>
          </div>
        </div>
      )}

      {/* Prompt Phase */}
      {state.phase === 'prompt' && state.question && (() => {
        const conv = state.question
        const hasContext = !!conv.context
        const contextDone = !hasContext || contextDoneForConv === conv.conversationId
        // True or False shows the WHOLE quote for context; the claimed name attaches to its line.
        const rfLabel = state.mode === 'realfake' && state.rfClaim
          ? (lid: number) => (lid === state.rfClaim!.lineId ? state.rfClaim!.claimedSpeakerName : null)
          : undefined
        return (
          <div className="flex-1 flex flex-col items-center justify-center gap-8 animate-slide-up max-w-6xl mx-auto w-full">
            <ContextBar context={null} happenedAt={conv.happenedAt} />
            {hasContext && (
              <Typewriter
                key={`ctx-${conv.conversationId}`}
                plain
                plainClassName="text-2xl italic w-full text-center"
                lines={[{ lineId: -1, lineText: conv.context!, actionText: null }]}
                onComplete={() => setContextDoneForConv(conv.conversationId)}
              />
            )}
            {contextDone && (
              <Typewriter key={conv.conversationId} lines={conv.lines} speakerLabel={rfLabel} />
            )}
            {contextDone && state.mode === 'realfake' && state.rfClaim && (
              <div className="rounded-2xl px-10 py-5 text-center animate-slide-up" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
                <p className="text-4xl font-black" style={{ color: 'var(--accent)' }}>True or False?</p>
              </div>
            )}
            <div className="flex items-center gap-4">
              <p className="text-3xl font-bold animate-pulse" style={{ color: 'var(--accent)' }}>
                {state.mode === 'realfake' ? 'Get ready to vote…' : 'Get ready to guess…'}
              </p>
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
            {state.question.lines.map((line) => {
              // True or False: spotlight the ONE judged line, dim the rest as context.
              const isRf = state.mode === 'realfake' && !!state.rfClaim
              const isClaim = isRf && line.lineId === state.rfClaim!.lineId
              const isContext = isRf && !isClaim
              const label = isRf ? (isClaim ? state.rfClaim!.claimedSpeakerName : null) : '???'
              return (
                <div key={line.lineId} className="rounded-2xl p-7 transition-all"
                  style={{
                    background: 'var(--surface)',
                    border: isClaim ? '3px solid var(--accent)' : '2px solid transparent',
                    opacity: isContext ? 0.45 : 1,
                  }}>
                  {isContext && <p className="text-sm uppercase tracking-widest mb-2" style={{ color: 'var(--muted)' }}>context</p>}
                  {line.actionText && <p className="text-lg italic mb-2" style={{ color: 'var(--muted)' }}>*{line.actionText}*</p>}
                  <p className="text-4xl leading-relaxed">&ldquo;{line.lineText}&rdquo;{' '}
                    {label !== null && (
                      <span className="text-3xl font-bold" style={{ color: isRf ? 'var(--accent)' : 'var(--primary-light)' }}>
                        — {label}{isClaim ? '?' : ''}
                      </span>
                    )}
                  </p>
                </div>
              )
            })}
          </div>
          {state.mode === 'realfake' && state.rfClaim && (
            <p className="text-3xl font-black text-center animate-pulse" style={{ color: 'var(--accent)' }}>
              Did {state.rfClaim.claimedSpeakerName} really say the highlighted line? Vote on your phone!
            </p>
          )}
          {state.mode === 'survival' && (
            <p className="text-2xl font-bold text-center" style={{ color: 'var(--incorrect)' }}>
              {Math.round(state.timerDuration / 1000)}s to answer — miss and you lose a life
            </p>
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
                    <Avatar name={p.name} id={p.id} size={20} />{p.name}{off ? ' (away)' : done ? ' · in' : ''}
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
              // True or False: mark the one line that was actually judged.
              const isRf = state.mode === 'realfake' && !!state.rfClaim
              const multiRf = isRf && state.question!.lines.length > 1
              const rfClaimLine = isRf && state.rfClaim!.lineId === line.lineId
              const rfContextLine = multiRf && !rfClaimLine
              // Who guessed what for this line
              const lineGuesses = state.players.map((p) => ({
                player: p,
                guessId: state.guesses[line.lineId]?.[p.id],
              }))
              return (
                <div key={line.lineId} className="rounded-2xl p-7 transition-all"
                  style={{
                    background: 'var(--surface)',
                    border: `3px solid ${rfClaimLine ? 'var(--accent)' : shown ? 'var(--correct)' : 'transparent'}`,
                    opacity: rfContextLine ? 0.5 : 1,
                  }}>
                  {rfClaimLine && multiRf && <p className="text-sm uppercase tracking-widest mb-2 font-bold" style={{ color: 'var(--accent)' }}>the line in question</p>}
                  {/* Context + Quote + Author inline */}
                  {idx === 0 && state.question?.context && <p className="text-lg italic mb-2" style={{ color: 'var(--muted)' }}>{state.question.context}</p>}
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
                                <span key={player.id} className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xl font-bold"
                                  style={{ background: 'var(--correct)', color: '#fff' }}>
                                  <Avatar name={player.name} id={player.id} size={26} />{player.name}
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
                                  <span key={player.id} className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xl font-bold border"
                                    style={{ background: 'rgba(30,41,59,0.5)', borderColor: 'rgba(51,65,85,1)' }}>
                                    <Avatar name={player.name} id={player.id} size={26} />
                                    <span style={{ color: 'rgb(203,213,225)' }}>{player.name}</span>
                                    <span style={{ color: 'rgb(100,116,139)' }}>guessed {guessName}</span>
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

          {/* Score this round (small screens; large screens use the live sidebar). Survival has no points. */}
          {state.mode !== 'survival' && (
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
                      <Avatar name={p.name} id={p.id} size={22} />{p.name}
                      {bet === 'swap' && <span className="text-xs font-black" style={{ color: 'var(--accent)' }}>SWAP</span>}
                      {bet === 'shield' && <span className="text-xs font-black" style={{ color: '#60a5fa' }}>🛡 SHIELD</span>}
                      {bet === 3 && <span className="text-xs font-black" style={{ color: 'var(--incorrect)' }}>ALL-IN</span>}
                      {bet === 2 && <span className="text-xs font-black" style={{ color: 'var(--incorrect)' }}>×2</span>}
                      {bet === 0.5 && <span className="text-xs font-black" style={{ color: 'var(--muted)' }}>×0.5</span>}
                      {p.streak > 1 && <span className="text-xs" style={{ color: 'var(--accent)' }}>streak {p.streak}</span>}
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
          )}

          {/* True or False verdict */}
          {state.mode === 'realfake' && state.rfClaim && (
            <div className="rounded-2xl p-6 space-y-3 animate-slide-up" style={{ background: 'var(--surface)', border: `3px solid ${state.rfClaim.isReal ? 'var(--correct)' : 'var(--incorrect)'}` }}>
              <p className="text-4xl font-black text-center" style={{ color: state.rfClaim.isReal ? 'var(--correct)' : 'var(--incorrect)' }}>
                {state.rfClaim.isReal ? 'TRUE — they really said it!' : `FALSE — it was actually ${state.question.lines.find((l) => l.lineId === state.rfClaim!.lineId)?.speakerName ?? '???'}`}
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                {state.players.map((p) => {
                  const vote = state.rfVotes[p.id]
                  const right = state.perfectRound[p.id] === true
                  return (
                    <span key={p.id} className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xl font-bold"
                      style={{ background: right ? 'var(--correct)' : 'rgba(30,41,59,0.5)', color: right ? '#fff' : 'rgb(148,163,184)', border: right ? 'none' : '1px solid rgba(51,65,85,1)' }}>
                      <Avatar name={p.name} id={p.id} size={26} />{p.name} — {vote === undefined ? 'no vote' : vote === 'real' ? 'True' : 'False'}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Survival lives (no points — lives are the only currency) */}
          {state.mode === 'survival' && (
            <div className="rounded-2xl p-6 animate-slide-up" style={{ background: 'var(--surface)', border: '2px solid var(--incorrect)' }}>
              <p className="text-lg uppercase tracking-widest mb-3 font-black" style={{ color: 'var(--incorrect)' }}>Lives</p>
              <div className="flex flex-wrap gap-3">
                {state.players.map((p) => {
                  const n = state.lives[p.id] ?? 0
                  const d = state.lifeDeltas[p.id] ?? 0
                  return (
                    <span key={p.id} className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-2xl font-bold"
                      style={{ background: n > 0 ? 'rgba(255,255,255,0.06)' : 'rgba(239,68,68,0.18)', opacity: n > 0 ? 1 : 0.7 }}>
                      <Avatar name={p.name} id={p.id} size={28} /> {p.name}{' '}
                      {n > 0 ? <Hearts n={n} /> : <span style={{ color: 'var(--incorrect)' }}>OUT</span>}
                      {d < 0 && <span className="text-base" style={{ color: 'var(--incorrect)' }}>{d}</span>}
                      {d > 0 && <span className="text-base" style={{ color: 'var(--correct)' }}>+{d} life!</span>}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Point swap callouts */}
          {state.executedSwaps.length > 0 && (
            <div className="rounded-2xl p-5 space-y-2" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
              <p className="text-lg uppercase tracking-widest font-black" style={{ color: 'var(--accent)' }}>Point Swap!</p>
              {state.executedSwaps.map(({ winnerId, loserId }) => {
                const winner = state.players.find((p) => p.id === winnerId)
                const loser = state.players.find((p) => p.id === loserId)
                if (!winner || !loser) return null
                return (
                  <p key={winnerId} className="text-2xl font-bold flex items-center gap-2 flex-wrap">
                    <Avatar name={winner.name} id={winner.id} size={26} />{winner.name} swapped points with
                    <Avatar name={loser.name} id={loser.id} size={26} />{loser.name}!
                  </p>
                )
              })}
            </div>
          )}

          {/* Shield block callouts */}
          {(state.blockedSwaps?.length ?? 0) > 0 && (
            <div className="rounded-2xl p-5 space-y-2" style={{ background: 'var(--surface)', border: '2px solid #3b82f6' }}>
              <p className="text-lg uppercase tracking-widest font-black" style={{ color: '#60a5fa' }}>🛡 Shield Block!</p>
              {state.blockedSwaps.map(({ attackerId, defenderId }) => {
                const attacker = state.players.find((p) => p.id === attackerId)
                const defender = state.players.find((p) => p.id === defenderId)
                if (!attacker || !defender) return null
                return (
                  <p key={attackerId} className="text-2xl font-bold flex items-center gap-2 flex-wrap">
                    <Avatar name={defender.name} id={defender.id} size={26} />{defender.name} blocked
                    <Avatar name={attacker.name} id={attacker.id} size={26} />{attacker.name}&rsquo;s swap — they lose 750!
                  </p>
                )
              })}
            </div>
          )}

          {/* Drinks this round (Tipsy Edition overlay) */}
          {state.drinking && (
            <div className="rounded-2xl p-6" style={{ background: 'var(--surface)', border: '2px solid var(--accent)' }}>
              <p className="text-lg uppercase tracking-widest mb-3 font-black" style={{ color: 'var(--accent)' }}>Drink Up</p>
              <div className="space-y-2">
                {state.players.map((p) => {
                  const result = state.mode === 'realfake'
                    ? computeRfDrink(state.rfVotes[p.id], state.perfectRound[p.id] === true)
                    : computeRoundDrinks(state.question!, (lid) => state.guesses[lid]?.[p.id])
                  return (
                    <div key={p.id} className="flex justify-between items-center text-2xl">
                      <span className="font-bold flex items-center gap-2"><Avatar name={p.name} id={p.id} size={26} />{p.name}</span>
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

          <div className="flex flex-col items-center gap-2">
            {state.autoAdvance && revealCountdown !== null && (
              <p className="text-xl font-bold" style={{ color: 'var(--muted)' }}>
                {state.currentRound >= state.totalRounds || (state.mode === 'survival' && aliveIds(state.lives).length <= 1)
                  ? `Final results in ${revealCountdown}s`
                  : `Next round in ${revealCountdown}s`}
              </p>
            )}
            <button onClick={continueAfterReveal}
              className="rounded-2xl py-6 px-12 text-3xl font-black transition-all hover:scale-105"
              style={{ background: 'var(--primary)', color: '#fff' }}>
              {state.currentRound >= state.totalRounds || (state.mode === 'survival' && aliveIds(state.lives).length <= 1) ? 'See Final Results' : 'Next Round'}
            </button>
          </div>
        </div>
      )}

      {/* Leaderboard */}
      {state.phase === 'leaderboard' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-8">
          <h2 className="text-6xl font-black text-center animate-bounce-in" style={{ color: 'var(--accent)' }}>Final Results</h2>
          <Podium players={state.players} drinking={state.drinking} lives={state.mode === 'survival' ? state.lives : undefined} />
          <div className="flex flex-col items-center gap-4">
            <button onClick={playAgain}
              className="rounded-2xl px-12 py-5 text-2xl font-black transition-all hover:scale-105"
              style={{ background: 'var(--primary)', color: '#fff' }}>
              New Game (same players)
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
