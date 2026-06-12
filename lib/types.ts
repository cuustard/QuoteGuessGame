export interface Speaker {
  id: number
  name: string
}

export interface DialogueLine {
  id: number
  conversation_id: number
  line_order: number
  speaker_id: number
  action_text: string | null
  line_text: string
}

export interface Conversation {
  id: number
  happened_at: string | null
  context: string | null
  dialogue_lines: DialogueLine[]
}

// A single "round" question sent to clients
export interface RoundQuestion {
  conversationId: number
  context: string | null
  happenedAt: string | null
  lines: {
    lineId: number
    lineOrder: number
    lineText: string
    actionText: string | null
    // speaker revealed only after reveal phase
    speakerId?: number
    speakerName?: string
  }[]
  // distinct speaker ids that appear in this conversation (for multi-line rounds)
  correctAnswers: Record<number, number> // lineId -> speakerId
}

export type GamePhase = 'lobby' | 'prompt' | 'guessing' | 'reveal' | 'leaderboard'

// 'normal' = points only; 'drinking' = Tipsy Edition with drink penalties
export type GameMode = 'normal' | 'drinking'

export interface Player {
  id: string
  name: string
  avatar: string // emoji avatar
  score: number
  streak: number // consecutive perfect rounds
}

// Confidence bet multiplier for a round (3 = All-In; 'swap' = Point Swap)
export type Bet = 0.5 | 1 | 2 | 3 | 'swap'

export interface GameState {
  phase: GamePhase
  mode: GameMode
  roomCode: string
  // Guessable speakers, loaded once by the host at game creation.
  // Players read this from broadcast state instead of querying the DB themselves.
  speakers: Speaker[]
  players: Player[]
  currentRound: number
  totalRounds: number
  question: RoundQuestion | null
  // lineId -> { playerId -> speakerId }
  guesses: Record<number, Record<string, number>>
  // playerId -> epoch ms when they finished answering every line (drives the individual speed bonus)
  lockTimes: Record<string, number>
  timerStart: number | null // epoch ms
  timerDuration: number // ms — configurable by host in lobby
  promptEnd: number | null // epoch ms when prompt phase ends and guessing begins
  // revealed: lineId -> speakerId (set during reveal phase)
  revealedAnswers: Record<number, number>
  scores: Record<string, number> // playerId -> score delta this round
  streakBonuses: Record<string, number> // playerId -> streak bonus portion this round
  perfectRound: Record<string, boolean> // playerId -> got every line right this round
  bets: Record<string, Bet> // playerId -> confidence bet this round
  swapTargets: Record<string, string> // playerId -> targetPlayerId (only for 'swap' bet)
  executedSwaps: Array<{ winnerId: string; loserId: string }> // swaps that fired this round
}

// Messages sent over the Supabase Realtime channel
export type ChannelMessage =
  | { type: 'player_join'; playerId: string; playerName: string; avatar: string }
  | { type: 'state_update'; state: GameState }
  | { type: 'submit_guess'; playerId: string; lineId: number; speakerId: number }
  | { type: 'lock_in'; playerId: string }
  | { type: 'set_bet'; playerId: string; bet: Bet }
  | { type: 'set_swap_target'; playerId: string; targetId: string }
  | { type: 'speakers_sync'; speakers: Speaker[] }
  | { type: 'reaction'; playerId: string; emoji: string }
  | { type: 'join_rejected'; playerId: string; reason: string }
