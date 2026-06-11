// Mobile vibration helpers. No-op on devices/browsers without support.
function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(pattern) } catch { /* ignore */ }
  }
}

let pulseTimer: ReturnType<typeof setInterval> | null = null

export const haptics = {
  tap: () => vibrate(15),
  lockIn: () => vibrate(30),
  correct: () => vibrate([20, 40, 20]),
  wrong: () => vibrate([90, 50, 90]),
  // Heartbeat-style anticipation loop: a brief 40ms buzz every 500ms until stopped.
  startAnticipationPulse: () => {
    if (pulseTimer) return
    vibrate(40)
    pulseTimer = setInterval(() => vibrate(40), 500)
  },
  stopAnticipationPulse: () => {
    if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null }
    vibrate(0) // cancel any in-flight buzz
  },
}
