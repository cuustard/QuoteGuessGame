// Lightweight Web Audio sound effects — no audio files needed.
// Must be unlocked by a user gesture first (call unlockAudio() on a click).

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

export function unlockAudio() {
  const c = getCtx()
  if (c && c.state === 'suspended') c.resume()
}

function tone(freq: number, startOffset: number, duration: number, type: OscillatorType = 'sine', gain = 0.15) {
  const c = getCtx()
  if (!c) return
  const osc = c.createOscillator()
  const g = c.createGain()
  const t = c.currentTime + startOffset
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(t)
  osc.stop(t + duration + 0.02)
}

// Soft tick during the final countdown seconds
export function playTick() {
  tone(880, 0, 0.06, 'square', 0.06)
}

// Rising two-note ding for a correct answer
export function playCorrect() {
  tone(660, 0, 0.12, 'sine', 0.18)
  tone(990, 0.1, 0.18, 'sine', 0.18)
}

// Low buzz for a wrong answer
export function playWrong() {
  tone(160, 0, 0.28, 'sawtooth', 0.12)
}

// Little fanfare when the host reveals the answer
export function playReveal() {
  tone(523, 0, 0.12, 'triangle', 0.16)
  tone(659, 0.1, 0.12, 'triangle', 0.16)
  tone(784, 0.2, 0.22, 'triangle', 0.16)
}

// Celebratory arpeggio for the final podium
export function playFanfare() {
  const notes = [523, 659, 784, 1046]
  notes.forEach((n, i) => tone(n, i * 0.12, 0.25, 'triangle', 0.18))
}
