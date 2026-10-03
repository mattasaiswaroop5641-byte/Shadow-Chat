/**
 * Real-time notification and audio chime system for Shadow Chat.
 * Uses Web Audio API for zero-dependency synthesized audio pinging
 * and HTML5 Notification API for desktop notifications.
 */

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (AudioContextClass) {
        audioCtx = new AudioContextClass()
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      void audioCtx.resume()
    }
    return audioCtx
  } catch {
    return null
  }
}

/**
 * Play a high-fidelity synthesized notification chime.
 * Normal: gentle soft chime (523Hz -> 659Hz)
 * Mention: double-chime with high-priority accent (587Hz -> 880Hz)
 */
export function playNotificationSound(isMention = false): void {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    const now = ctx.currentTime

    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)

    if (isMention) {
      // High-priority dual tone for mentions (@everyone, @username)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(587.33, now) // D5
      osc.frequency.setValueAtTime(880.0, now + 0.08) // A5
      gain.gain.setValueAtTime(0.18, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38)
      osc.start(now)
      osc.stop(now + 0.38)
    } else {
      // Gentle, pleasant communication tap ping (C5 -> E5)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(523.25, now) // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.07) // E5
      gain.gain.setValueAtTime(0.12, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26)
      osc.start(now)
      osc.stop(now + 0.26)
    }
  } catch {
    // Autoplay policy or unsupported audio context
  }
}

/**
 * Request desktop notification permissions from the user.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied'
  }
  if (Notification.permission === 'default') {
    return await Notification.requestPermission()
  }
  return Notification.permission
}

/**
 * Display a desktop notification if permitted.
 */
export function showDesktopNotification(
  title: string,
  options?: {
    body?: string
    icon?: string
    tag?: string
    onClick?: () => void
  },
): Notification | null {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null
  }
  if (Notification.permission !== 'granted') {
    return null
  }

  try {
    const notif = new Notification(title, {
      body: options?.body || 'New message in Shadow Chat',
      icon: options?.icon || '/shadow-chat-3d-glass.png',
      tag: options?.tag,
      silent: true, // We trigger our synthesized chime separately
    })

    if (options?.onClick) {
      notif.onclick = () => {
        window.focus()
        options.onClick?.()
        notif.close()
      }
    }
    return notif
  } catch {
    return null
  }
}

/**
 * Curated tactical rapid smart sentences.
 * Stealth, professional communication snippets.
 */
const DEFAULT_SMART_SENTENCES = [
  'Understood, on it.',
  'Sounds good to me!',
  'I will review this and follow up.',
  'Could you share more details?',
  'All set on my end, thank you!',
  'Let us connect shortly on this.',
  'Checking the latest update now.',
  'Acknowledged, working through it.',
]

const QUESTION_RESPONSES = [
  'Yes, absolutely.',
  'Not yet, looking into it now.',
  'Give me a few minutes to confirm.',
  'Working on this right now.',
  'Let me verify and get right back.',
]

const GRATITUDE_RESPONSES = [
  'You are welcome!',
  'Anytime! Glad to help.',
  'Always happy to assist.',
  'No problem at all.',
]

export function getSmartSentenceSuggestions(lastMessageText?: string | null): string[] {
  if (!lastMessageText || !lastMessageText.trim()) {
    return DEFAULT_SMART_SENTENCES.slice(0, 5)
  }

  const clean = lastMessageText.trim().toLowerCase()
  if (clean.endsWith('?') || clean.includes('can you') || clean.includes('could you') || clean.includes('are you')) {
    return [...QUESTION_RESPONSES.slice(0, 3), 'Understood, on it.', 'I will check and report back.']
  }

  if (clean.includes('thank') || clean.includes('thx') || clean.includes('appreciate')) {
    return [...GRATITUDE_RESPONSES.slice(0, 3), 'Understood, on it.', 'Sounds good to me!']
  }

  if (clean.includes('hello') || clean.includes('hey') || clean.includes('hi ')) {
    return ['Hey there! How can I help?', 'Hello! Ready when you are.', 'Hey, on it now.', 'Sounds good to me!']
  }

  return DEFAULT_SMART_SENTENCES.slice(0, 5)
}
