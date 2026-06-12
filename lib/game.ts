import { supabase } from './supabase'
import type { Bet, Conversation, RoundQuestion, Speaker, GameState, Player } from './types'

export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

// One-off / non-guessable speakers: never offered as answers, and any conversation
// containing a line by them is skipped entirely (that line would be unguessable).
export const OMITTED_SPEAKERS = ['11 yr old girl in movie', 'Omegle Person']
const omittedSet = new Set(OMITTED_SPEAKERS.map((n) => n.toLowerCase()))
function isOmitted(name: string): boolean {
  return omittedSet.has(name.trim().toLowerCase())
}

// One fetch of the full (unfiltered) speakers table per session, shared by
// fetchSpeakers and the omitted-conversation lookup so neither re-queries.
let _speakersRaw: Speaker[] | null = null
async function fetchSpeakersRaw(): Promise<Speaker[]> {
  if (_speakersRaw) return _speakersRaw
  const { data, error } = await supabase.from('speakers').select('id, name').order('name')
  if (error) throw error
  _speakersRaw = data ?? []
  return _speakersRaw
}

export async function fetchSpeakers(): Promise<Speaker[]> {
  return (await fetchSpeakersRaw()).filter((s) => !isOmitted(s.name))
}

// Cache the set of conversations that contain an omitted speaker (stable per session).
let _omittedConvIds: number[] | null = null
async function getOmittedConversationIds(): Promise<number[]> {
  if (_omittedConvIds) return _omittedConvIds
  const spk = await fetchSpeakersRaw()
  const omittedIds = spk.filter((s) => isOmitted(s.name)).map((s) => s.id)
  if (omittedIds.length === 0) { _omittedConvIds = []; return _omittedConvIds }
  const { data: lines } = await supabase.from('dialogue_lines').select('conversation_id').in('speaker_id', omittedIds)
  _omittedConvIds = [...new Set((lines ?? []).map((l) => l.conversation_id))]
  return _omittedConvIds
}

export async function fetchRandomConversation(excludeIds: number[] = []): Promise<Conversation | null> {
  const omitted = await getOmittedConversationIds()
  const exclude = [...new Set([...excludeIds, ...omitted])]

  // Count available conversations
  let countQuery = supabase.from('conversations').select('*', { count: 'exact', head: true })
  if (exclude.length > 0) countQuery = countQuery.not('id', 'in', `(${exclude.join(',')})`)
  const { count, error: countError } = await countQuery
  if (countError) throw countError
  if (!count || count === 0) return null

  const offset = Math.floor(Math.random() * count)

  let query = supabase
    .from('conversations')
    .select('id, happened_at, context, dialogue_lines(id, conversation_id, line_order, speaker_id, action_text, line_text)')
    .order('line_order', { referencedTable: 'dialogue_lines', ascending: true })
    .range(offset, offset)
  if (exclude.length > 0) query = query.not('id', 'in', `(${exclude.join(',')})`)

  const { data, error } = await query
  if (error) throw error
  return data?.[0] ?? null
}

export function buildRoundQuestion(conv: Conversation): RoundQuestion {
  const correctAnswers: Record<number, number> = {}
  const lines = conv.dialogue_lines.map((line) => {
    correctAnswers[line.id] = line.speaker_id
    return {
      lineId: line.id,
      lineOrder: line.line_order,
      lineText: line.line_text,
      actionText: line.action_text,
    }
  })
  return {
    conversationId: conv.id,
    context: conv.context,
    happenedAt: conv.happened_at,
    lines,
    correctAnswers,
  }
}

export const TIMER_DURATION_MS = 20_000
export const POINTS_MAX = 1000
export const POINTS_MIN = 100

export function calculateScore(correctLines: number, totalLines: number, elapsedMs: number, timerDuration: number = TIMER_DURATION_MS): number {
  if (correctLines === 0) return 0
  const accuracy = correctLines / totalLines
  // Speed bonus scales to the actual round length the host configured (10s / 20s / 30s).
  const timeBonus = Math.max(0, 1 - elapsedMs / timerDuration)
  const raw = POINTS_MIN + (POINTS_MAX - POINTS_MIN) * timeBonus
  return Math.round(raw * accuracy)
}

export const STREAK_BONUS_PER_LEVEL = 100 // extra points per consecutive perfect round
export const NO_BET_MISS_PENALTY = 100 // flat points lost on NO BET if you miss a line (gives Safe its value)
export const RISKY_MISS_PENALTY = 500 // flat points lost if you bet Risky and miss any line
export const ALLIN_MIN_BUYIN = 1000 // minimum banked score required to bet All-In
export const SWAP_MISS_PENALTY = 750 // flat points lost if you bet Swap and miss
export const SWAP_MIN_BUYIN = 500 // minimum banked score required to bet Point Swap

export interface RoundScoring {
  deltas: Record<string, number> // total points awarded this round (base*bet + streak bonus, +/- penalties)
  streakBonuses: Record<string, number> // just the streak-bonus portion
  perfectRound: Record<string, boolean> // true if player got every line right
  executedSwaps: Array<{ winnerId: string; loserId: string }> // point swaps that fired
}

// Exact per-player scoring for one round, derived from primitives only (no GameState).
// This is the single source of truth for *both* the host's authoritative scoring and any
// per-player visual breakdown the frontend wants to show.
export interface PlayerRoundScore {
  correct: number        // lines answered correctly
  total: number          // lines in the round
  perfect: boolean       // every line correct
  base: number           // accuracy + speed scaled points, pre-bet (full base on a perfect round)
  earned: number         // points from the guess itself (base*bet, or a penalty), pre-streak
  streakBonus: number    // streak-bonus portion (0 unless perfect)
  delta: number          // exact total score change this round (earned + streakBonus)
  perLine: number        // honest credit per correct line (0 when the round delta is a loss)
  swapFired: boolean     // true when bet=swap and guess was perfect
}

export function scorePlayerRound(
  question: RoundQuestion,
  getGuess: (lineId: number) => number | undefined,
  elapsedMs: number,
  bet: Bet,
  currentScore: number,
  streak: number,
  timerDuration: number = TIMER_DURATION_MS
): PlayerRoundScore {
  const total = question.lines.length
  let correct = 0
  for (const line of question.lines) {
    if (getGuess(line.lineId) === question.correctAnswers[line.lineId]) correct++
  }
  const base = calculateScore(correct, total, elapsedMs, timerDuration)
  const perfect = correct === total && total > 0

  // Safe (0.5):  half the (partial-credit) base, never negative — the hedge.
  // NO BET (1):  full base on a perfect round, else a flat -NO_BET_MISS_PENALTY (no partial credit).
  // High tiers are all-or-nothing on a PERFECT round:
  //   Risky (2):  +2x if perfect, else flat -RISKY_MISS_PENALTY (forfeits partial credit)
  //   All-In (3): perfect DOUBLES the banked total; any miss wipes it to 0 (no streak bonus)
  //   Swap:       0 delta (swap handled separately), else flat -SWAP_MISS_PENALTY; no streak bonus
  let earned: number
  let swapFired = false
  if (bet === 'swap') {
    if (perfect) { earned = 0; swapFired = true }
    else earned = -SWAP_MISS_PENALTY
  } else if (bet === 2) {
    // Risky: +2x on a perfect round, else a flat penalty (forfeits partial credit).
    if (perfect) earned = Math.round(base * 2)
    else earned = -RISKY_MISS_PENALTY
  } else if (bet === 3) {
    // All-In: true double-or-nothing on the banked total. Perfect → add the whole total
    // again (doubles it); any miss → subtract it all (drops to 0).
    earned = perfect ? currentScore : -currentScore
  } else if (bet === 0.5) {
    // Safe: half of the (partial-credit) base, never negative.
    earned = Math.round(base * 0.5)
  } else {
    // NO BET (1): full base on a perfect round, flat penalty on any miss (forfeits partial credit).
    earned = perfect ? base : -NO_BET_MISS_PENALTY
  }

  // Streak bonus: not awarded on swap or All-In (their reward is the swap / the doubling).
  const streakBonus = perfect && bet !== 'swap' && bet !== 3 ? streak * STREAK_BONUS_PER_LEVEL : 0
  const delta = earned + streakBonus
  const perLine = correct > 0 && delta > 0 ? Math.round(delta / correct) : 0

  return { correct, total, perfect, base, earned, streakBonus, delta, perLine, swapFired }
}

export function scoreRound(
  question: RoundQuestion,
  allGuesses: GameState['guesses'],
  players: Player[],
  timerStart: number,
  timerDuration: number,
  lockTimes: GameState['lockTimes'] = {},
  bets: GameState['bets'] = {},
  swapTargets: GameState['swapTargets'] = {}
): RoundScoring {
  const deltas: Record<string, number> = {}
  const streakBonuses: Record<string, number> = {}
  const perfectRound: Record<string, boolean> = {}
  const executedSwaps: Array<{ winnerId: string; loserId: string }> = []
  // A player can be in at most one swap per round — prevents the leader's score being
  // duplicated to multiple attackers (which would inject points and break conservation).
  const swapInvolved = new Set<string>()

  // Snapshot pre-round scores so swap amounts are deterministic regardless of delta order.
  const preRoundScores: Record<string, number> = Object.fromEntries(players.map((p) => [p.id, p.score]))
  // Players who never locked in fall back to the full duration → minimum (floor) speed bonus.
  const fallbackLock = timerStart + timerDuration

  for (const player of players) {
    const lockedAt = lockTimes[player.id] ?? fallbackLock
    const elapsed = Math.max(0, Math.min(timerDuration, lockedAt - timerStart))
    const r = scorePlayerRound(
      question,
      (lineId) => allGuesses[lineId]?.[player.id],
      elapsed,
      bets[player.id] ?? 1,
      player.score,
      player.streak,
      timerDuration
    )
    perfectRound[player.id] = r.perfect
    streakBonuses[player.id] = r.streakBonus
    deltas[player.id] = r.delta

    if (r.swapFired) {
      const targetId = swapTargets[player.id]
      const target = targetId ? players.find((p) => p.id === targetId) : undefined
      const targetAhead = !!target && preRoundScores[target.id] > preRoundScores[player.id]
      if (targetAhead && !swapInvolved.has(player.id) && !swapInvolved.has(target!.id)) {
        swapInvolved.add(player.id)
        swapInvolved.add(target!.id)
        executedSwaps.push({ winnerId: player.id, loserId: target!.id })
      } else if (targetAhead) {
        // Target valid, but this player or the target is already in a swap this round —
        // this swap can't fire. The perfect swapper falls back to standard base points
        // (no swap, no streak bonus, no penalty).
        deltas[player.id] = r.base
      }
      // else: target not ahead / unset → silent miss, delta stays 0 (no penalty).
    }
  }

  return { deltas, streakBonuses, perfectRound, executedSwaps }
}

export function applyScoreDeltas(
  players: Player[],
  deltas: Record<string, number>,
  perfectRound: Record<string, boolean>,
  executedSwaps: Array<{ winnerId: string; loserId: string }> = []
): Player[] {
  // Apply deltas first, then execute swaps on the post-delta scores.
  const afterDeltas = players.map((p) => ({
    ...p,
    score: p.score + (deltas[p.id] ?? 0),
    streak: perfectRound[p.id] ? p.streak + 1 : 0,
  }))

  if (executedSwaps.length === 0) return afterDeltas

  // Build a mutable score map; multiple swaps are resolved simultaneously
  // from the same post-delta snapshot so they can't chain off each other.
  const snapshot = Object.fromEntries(afterDeltas.map((p) => [p.id, p.score]))
  const finalScores = { ...snapshot }
  for (const { winnerId, loserId } of executedSwaps) {
    finalScores[winnerId] = snapshot[loserId]
    finalScores[loserId] = snapshot[winnerId]
  }

  return afterDeltas.map((p) => ({ ...p, score: finalScores[p.id] ?? p.score }))
}

export function createInitialGameState(roomCode: string, totalRounds: number, speakers: Speaker[] = []): GameState {
  return {
    phase: 'lobby',
    mode: 'normal',
    roomCode,
    speakers,
    players: [],
    currentRound: 0,
    totalRounds,
    question: null,
    guesses: {},
    lockTimes: {},
    timerStart: null,
    timerDuration: TIMER_DURATION_MS,
    promptEnd: null,
    revealedAnswers: {},
    scores: {},
    streakBonuses: {},
    perfectRound: {},
    bets: {},
    swapTargets: {},
    executedSwaps: [],
  }
}

// ---- Tipsy Edition (drinking mode) ----
export const STREAK_DRINK_THRESHOLD = 3

export type DrinkResult =
  | { kind: 'safe' }
  | { kind: 'sips'; sips: number }
  | { kind: 'shot' }
  | { kind: 'afk'; sips: number }

// Compute a single player's drink penalty for the round.
// getGuess(lineId) returns the speakerId the player picked, or undefined if they didn't answer.
export function computeRoundDrinks(
  question: RoundQuestion,
  getGuess: (lineId: number) => number | undefined
): DrinkResult {
  const total = question.lines.length
  if (total === 0) return { kind: 'safe' }
  let wrong = 0
  let answered = 0
  for (const line of question.lines) {
    const g = getGuess(line.lineId)
    if (g === undefined) { wrong++; continue }
    answered++
    if (g !== question.correctAnswers[line.lineId]) wrong++
  }
  if (answered === 0) return { kind: 'afk', sips: 2 }
  if (wrong === 0) return { kind: 'safe' }
  if (total >= 2 && wrong === total) return { kind: 'shot' } // whiffed a whole dialogue
  return { kind: 'sips', sips: wrong }
}

export function drinkResultText(r: DrinkResult): string {
  switch (r.kind) {
    case 'safe': return '😎 Safe — no drink!'
    case 'sips': return `🥤 Take ${r.sips} sip${r.sips !== 1 ? 's' : ''}`
    case 'shot': return '🥃 Whiffed it — take a SHOT!'
    case 'afk': return `😴 AFK — ${r.sips} sips`
  }
}

// Table-wide callouts shown on the host screen during reveal.
export function roundDrinkCallouts(state: GameState): string[] {
  const out: string[] = []
  if (state.players.length === 0) return out
  const anyonePerfect = state.players.some((p) => state.perfectRound[p.id])
  if (!anyonePerfect) out.push('🍻 Group drink — nobody nailed it. Everyone sips!')
  for (const p of state.players) {
    if (state.perfectRound[p.id] && p.streak >= STREAK_DRINK_THRESHOLD) {
      out.push(`🔥 ${p.name} is on a ${p.streak}-round streak — hand out ${p.streak} sips to anyone!`)
    }
  }
  return out
}

// "2022-03-14" / ISO timestamp -> "March 2022"
// "2022-03-14T21:30:00Z" -> "March 14, 2022 · 9:30 PM"
export function formatHappenedAt(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (isNaN(d.getTime())) return value
  const date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}

// "2022-03-14..." -> "3 years ago" / "2 months ago" / "yesterday"
export function relativeTime(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (isNaN(d.getTime())) return null
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 0) return null
  const sec = diffMs / 1000
  const min = sec / 60
  const hr = min / 60
  const day = hr / 24
  const month = day / 30.44
  const year = day / 365.25
  if (day < 1) return 'today'
  if (day < 2) return 'yesterday'
  if (day < 30) return `${Math.round(day)} days ago`
  if (month < 12) { const m = Math.round(month); return `${m} month${m !== 1 ? 's' : ''} ago` }
  const y = Math.floor(year)
  return `${y} year${y !== 1 ? 's' : ''} ago`
}
