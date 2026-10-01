import { FormEvent, useEffect, useState } from 'react'
import { ApiError, fetchHealth, login, register, resendVerification, verifyEmail } from './lib/api'
import type { User } from './types'

type AuthMode = 'login' | 'register'

export function GlassAuthModal({
  isOpen,
  onClose,
  initialMode = 'login',
  onAuthenticated,
}: {
  isOpen: boolean
  onClose: () => void
  initialMode?: AuthMode
  onAuthenticated: (user: User) => void
}) {
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setMode(initialMode)
    setError('')
    setMessage('')
  }, [initialMode, isOpen])

  if (!isOpen) return null

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (mode === 'login') {
        try {
          const user = await login(email, password)
          onAuthenticated(user)
        } catch (loginError) {
          if (loginError instanceof ApiError && loginError.status === 403) {
            setVerificationRequired(true)
            setMessage('Verify your email to finish signing in.')
          } else {
            throw loginError
          }
        }
      } else {
        await register(email, username, password)
        setVerificationRequired(true)
        setMessage('Account created. Enter the six-digit code sent to your email.')
      }
    } catch (submissionError) {
      setError(submissionError instanceof ApiError ? submissionError.message : 'Unable to complete the request.')
    } finally {
      setBusy(false)
    }
  }

  async function handleVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const user = await verifyEmail(code)
      onAuthenticated(user)
    } catch (verificationError) {
      setError(verificationError instanceof ApiError ? verificationError.message : 'Unable to verify your email.')
    } finally {
      setBusy(false)
    }
  }

  async function handleResend() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await resendVerification()
      setMessage('A new verification code has been sent.')
    } catch (resendError) {
      setError(resendError instanceof ApiError ? resendError.message : 'Unable to resend verification code.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-xl bg-black/60 transition-opacity animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Ambient background glows inside modal viewport */}
      <div className="absolute h-96 w-96 rounded-full bg-emerald-500/10 blur-[120px] pointer-events-none -top-12 -left-12" />
      <div className="absolute h-96 w-96 rounded-full bg-cyan-500/10 blur-[120px] pointer-events-none -bottom-12 -right-12" />

      <div
        className="relative w-full max-w-md rounded-3xl border border-white/[0.12] bg-[#0c1322]/85 p-8 shadow-[0_20px_70px_rgba(0,0,0,0.7)] backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 right-5 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:bg-white/10 hover:text-white transition"
          title="Close modal"
        >
          ✕
        </button>

        {/* Brand Logo & Subtitle */}
        <div className="flex items-center gap-3.5 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-emerald-500/30 p-2 shadow-[0_0_20px_rgba(16,185,129,0.2)]">
            <img src="/shadow-chat-logo.png" alt="Shadow Chat" className="h-full w-full object-contain" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-wider text-white">SHADOW CHAT</span>
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/30">
                E2EE
              </span>
            </div>
            <p className="text-xs text-slate-400">Zero-Knowledge Stealth Platform</p>
          </div>
        </div>

        {/* Mode Toggle Tabs (if not in verification mode) */}
        {!verificationRequired && (
          <div className="mb-6 flex rounded-xl border border-white/10 bg-white/[0.03] p-1 backdrop-blur-md">
            <button
              type="button"
              onClick={() => {
                setMode('login')
                setError('')
                setMessage('')
              }}
              className={`flex-1 rounded-lg py-2 text-xs font-semibold transition ${
                mode === 'login'
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 shadow-md'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register')
                setError('')
                setMessage('')
              }}
              className={`flex-1 rounded-lg py-2 text-xs font-semibold transition ${
                mode === 'register'
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 shadow-md'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>
        )}

        <h2 className="text-xl font-semibold text-white">
          {verificationRequired
            ? 'Verify your identity'
            : mode === 'login'
            ? 'Access your encrypted vault'
            : 'Initialize stealth credentials'}
        </h2>
        <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
          {verificationRequired
            ? 'Enter the 6-digit confirmation code transmitted to your email address.'
            : mode === 'login'
            ? 'Enter your credentials to derive local cryptographic keys and access conversations.'
            : 'Create an account protected by client-side ECDH P-256 identity key pairs.'}
        </p>

        {message ? (
          <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-300 flex items-center gap-2 backdrop-blur-md">
            <span>✓</span>
            <span>{message}</span>
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300 flex items-center gap-2 backdrop-blur-md">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        ) : null}

        {verificationRequired ? (
          <form className="mt-6 space-y-4" onSubmit={handleVerification}>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Verification Code
              </label>
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="w-full text-center tracking-[0.3em] font-mono text-lg rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-white placeholder:text-slate-600 focus:border-emerald-400 focus:bg-white/[0.08] focus:outline-none focus:ring-1 focus:ring-emerald-400/40 transition"
                autoFocus
              />
            </div>
            <button
              disabled={busy}
              className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 py-3 font-semibold text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.35)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] transition hover:brightness-105 active:scale-[0.99] disabled:opacity-50"
              type="submit"
            >
              {busy ? 'Verifying...' : 'Confirm & Unlock Vault'}
            </button>
            <button
              disabled={busy}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] py-2.5 text-xs text-slate-300 hover:bg-white/[0.07] hover:text-white transition disabled:opacity-50"
              type="button"
              onClick={handleResend}
            >
              Resend verification code
            </button>
          </form>
        ) : (
          <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Email Address
              </label>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operative@shadowchat.net"
                className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-400 focus:bg-white/[0.08] focus:outline-none focus:ring-1 focus:ring-emerald-400/40 transition"
              />
            </div>

            {mode === 'register' ? (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Stealth Handle (Username)
                </label>
                <input
                  required
                  minLength={3}
                  maxLength={32}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. ghost_operative"
                  className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-400 focus:bg-white/[0.08] focus:outline-none focus:ring-1 focus:ring-emerald-400/40 transition"
                />
              </div>
            ) : null}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Passphrase
              </label>
              <input
                required
                minLength={8}
                maxLength={128}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-400 focus:bg-white/[0.08] focus:outline-none focus:ring-1 focus:ring-emerald-400/40 transition"
              />
            </div>

            <button
              disabled={busy}
              className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 py-3 font-semibold text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.35)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] transition hover:brightness-105 active:scale-[0.99] disabled:opacity-50 mt-2"
              type="submit"
            >
              {busy ? 'Authenticating...' : mode === 'login' ? 'Enter Shadow Vault →' : 'Generate Keypair & Register →'}
            </button>
          </form>
        )}

        <div className="mt-6 flex items-center justify-between border-t border-white/[0.08] pt-4 text-[11px] text-slate-500">
          <span>🔒 Web Crypto SubtleCrypto API</span>
          <span>Zero Server Plaintext</span>
        </div>
      </div>
    </div>
  )
}

export default function LandingPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [backendHealth, setBackendHealth] = useState<string>('Live')

  useEffect(() => {
    fetchHealth()
      .then((res) => setBackendHealth(`${res.status} • 99.9% Uptime`))
      .catch(() => setBackendHealth('API Offline'))
  }, [])

  function openAuth(mode: AuthMode) {
    setAuthMode(mode)
    setAuthModalOpen(true)
  }

  return (
    <div className="relative min-h-screen bg-[#070b14] text-slate-100 overflow-x-hidden selection:bg-emerald-500 selection:text-slate-950">
      {/* Cyber Ambient Glowing Orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/4 h-[500px] w-[500px] rounded-full bg-emerald-500/10 blur-[140px]" />
        <div className="absolute top-1/3 -right-40 h-[600px] w-[600px] rounded-full bg-cyan-500/10 blur-[160px]" />
        <div className="absolute bottom-10 left-10 h-[500px] w-[500px] rounded-full bg-indigo-500/10 blur-[140px]" />
        <div className="absolute inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:32px_32px] opacity-25" />
      </div>

      {/* Sticky Frosted Glass Navigation Bar */}
      <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-[#070b14]/75 backdrop-blur-xl px-6 py-4 transition-all">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 border border-emerald-500/30 p-1.5 shadow-[0_0_15px_rgba(16,185,129,0.25)]">
              <img src="/shadow-chat-logo.png" alt="Shadow Chat Logo" className="h-full w-full object-contain" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold tracking-wider text-white text-base">SHADOW CHAT</span>
                <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                  v2.0 E2EE
                </span>
              </div>
              <p className="text-[10px] text-slate-400">End-to-End Encrypted Stealth Platform</p>
            </div>
          </div>

          <nav className="hidden md:flex items-center gap-8 text-sm text-slate-300">
            <a href="#features" className="hover:text-emerald-400 transition">Features</a>
            <a href="#security" className="hover:text-emerald-400 transition">Security Architecture</a>
            <a href="#comparison" className="hover:text-emerald-400 transition">Comparison</a>
            <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 font-mono">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)] animate-pulse" />
              <span>{backendHealth}</span>
            </div>
          </nav>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => openAuth('login')}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-200 hover:border-white/20 hover:bg-white/10 hover:text-white transition"
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => openAuth('register')}
              className="rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 px-4 py-2 text-xs font-semibold text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_25px_rgba(16,185,129,0.5)] transition hover:brightness-105 active:scale-[0.98]"
            >
              Get Started →
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative px-6 pt-20 pb-28 text-center max-w-6xl mx-auto">
        {/* Glow badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-xs font-medium text-emerald-300 shadow-[0_0_20px_rgba(16,185,129,0.15)] mb-8">
          <span className="text-sm">🔒</span>
          <span>Zero-Knowledge Cryptography • Web Crypto AES-256-GCM</span>
        </div>

        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-white leading-[1.15]">
          Communicate in the Shadows.{' '}
          <br className="hidden sm:inline" />
          <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
            Zero Traces Left Behind.
          </span>
        </h1>

        <p className="mt-6 max-w-2xl mx-auto text-base sm:text-lg text-slate-400 leading-relaxed">
          The next-generation encrypted messaging platform built for privacy purists, security teams, and stealth collaboration. Client-side ECDH key derivation, zero plaintext stored on the server, and ultra-fast real-time WebSockets.
        </p>

        {/* Hero CTA buttons */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <button
            type="button"
            onClick={() => openAuth('register')}
            className="flex items-center gap-2.5 rounded-2xl bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400 px-7 py-4 text-sm font-bold text-slate-950 shadow-[0_0_35px_rgba(16,185,129,0.4)] hover:shadow-[0_0_45px_rgba(16,185,129,0.6)] hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            <span>Launch Shadow Chat</span>
            <span className="text-base">→</span>
          </button>
          <button
            type="button"
            onClick={() => openAuth('login')}
            className="flex items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.04] px-6 py-4 text-sm font-semibold text-slate-200 hover:bg-white/[0.08] hover:border-white/30 hover:text-white backdrop-blur-xl transition"
          >
            <span>Existing Operative Login</span>
          </button>
        </div>

        {/* Interactive Live Chat Mockup (Glassmorphism Preview) */}
        <div className="mt-16 relative mx-auto max-w-4xl rounded-3xl border border-white/[0.12] bg-[#0c1322]/80 p-3 sm:p-5 shadow-[0_25px_80px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
          {/* Mock Window Controls & Top bar */}
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-3 mb-4 px-2">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-rose-500/80" />
              <span className="h-3 w-3 rounded-full bg-amber-500/80" />
              <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
              <span className="ml-2 font-mono text-[11px] text-slate-500">shadow-chat://session-vault#e2ee-active</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-teal-500/20 border border-teal-500/40 px-2.5 py-0.5 font-mono text-[11px] text-teal-300">
                🔒 AES-256-GCM
              </span>
              <span className="rounded-full bg-emerald-500/20 border border-emerald-500/40 px-2.5 py-0.5 text-[11px] text-emerald-400">
                ● Live 0ms
              </span>
            </div>
          </div>

          {/* Mock Conversation View */}
          <div className="space-y-4 text-left p-2 sm:p-4">
            {/* Message 1 (Peer) */}
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-700 flex items-center justify-center text-xs font-bold text-white shadow-inner">
                S
              </div>
              <div className="max-w-md rounded-2xl border border-white/10 bg-slate-900/80 p-3.5 shadow-lg backdrop-blur-md">
                <div className="flex items-center justify-between gap-4 mb-1 text-[10px] text-slate-400">
                  <span className="font-semibold text-slate-200">@sai (Stealth Operative)</span>
                  <span>16:42</span>
                </div>
                <p className="text-xs text-slate-200 leading-relaxed">
                  Keys negotiated via ECDH P-256. Are our message payloads encrypted before reaching the database?
                </p>
                <div className="mt-2 flex items-center gap-1.5 text-[10px] text-teal-400 font-mono">
                  <span>🔒 E2EE Active</span>
                  <span>•</span>
                  <span>Safety #8492-4910</span>
                </div>
              </div>
            </div>

            {/* Message 2 (You) */}
            <div className="flex items-start justify-end gap-3">
              <div className="max-w-md rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 shadow-lg backdrop-blur-md text-right">
                <div className="flex items-center justify-between gap-4 mb-1 text-[10px] text-slate-400">
                  <span className="flex items-center gap-1 text-teal-300">
                    <span>✓✓ Read</span>
                    <span>16:43</span>
                  </span>
                  <span className="font-semibold text-emerald-300">You (Verified)</span>
                </div>
                <p className="text-xs text-emerald-50 leading-relaxed text-left">
                  Affirmative. Plaintext never touches Render or MongoDB Atlas. Only ciphertext and 96-bit nonces are stored. Server has zero decryption capability.
                </p>
                <div className="mt-2 flex justify-end gap-1.5">
                  <span className="rounded-full bg-slate-800/80 border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300">
                    🔥 3
                  </span>
                  <span className="rounded-full bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[10px] text-emerald-300 font-semibold">
                    👍 2
                  </span>
                </div>
              </div>
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center text-xs font-bold text-white shadow-inner">
                Y
              </div>
            </div>

            {/* Message 3 with Attachment (Peer) */}
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-700 flex items-center justify-center text-xs font-bold text-white shadow-inner">
                S
              </div>
              <div className="max-w-md rounded-2xl border border-white/10 bg-slate-900/80 p-3.5 shadow-lg backdrop-blur-md">
                <div className="flex items-center justify-between gap-4 mb-1 text-[10px] text-slate-400">
                  <span className="font-semibold text-slate-200">@sai</span>
                  <span>16:44</span>
                </div>
                <p className="text-xs text-slate-200 mb-2">Here is the cryptographic specification protocol document:</p>
                <div className="flex items-center gap-2.5 rounded-xl border border-slate-700 bg-slate-800/80 p-2.5 text-xs text-slate-200">
                  <span className="text-lg">📄</span>
                  <div className="flex-1 truncate">
                    <div className="font-semibold truncate">e2ee_zero_knowledge_audit.pdf</div>
                    <div className="text-[10px] text-slate-400">1.8 MB • Encrypted Blob</div>
                  </div>
                  <span className="rounded-lg bg-emerald-500/20 px-2 py-1 text-[10px] text-emerald-400 font-bold">
                    VERIFIED
                  </span>
                </div>
              </div>
            </div>

            {/* Mock Typing & Composer */}
            <div className="pt-2">
              <div className="flex items-center gap-2 text-xs text-teal-300 mb-2 pl-2">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-ping" />
                <span className="italic text-[11px]">@sai is typing...</span>
              </div>
              <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2 backdrop-blur-md">
                <span className="px-2 text-slate-400">📎</span>
                <span className="flex-1 text-xs text-slate-500">Type an encrypted stealth message...</span>
                <button
                  type="button"
                  onClick={() => openAuth('register')}
                  className="rounded-xl bg-emerald-500 px-4 py-1.5 text-xs font-bold text-slate-950 hover:bg-emerald-400 transition"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Core Architectural Pillars */}
      <section id="features" className="relative px-6 py-24 max-w-7xl mx-auto border-t border-white/[0.06]">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-400 mb-3">Architectural Highlights</p>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
            Security Without Compromise
          </h2>
          <p className="mt-4 text-sm sm:text-base text-slate-400">
            Engineered from the ground up for strict confidentiality, ephemeral privacy, and zero server trust.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            {
              icon: '🛡️',
              title: 'Military-Grade E2EE',
              desc: 'Client-side SubtleCrypto Web Crypto API. Elliptic Curve Diffie-Hellman (ECDH P-256) key exchange coupled with AES-256-GCM symmetric ciphering.',
              tag: 'Web Crypto API',
            },
            {
              icon: '🧠',
              title: 'Zero-Knowledge Server',
              desc: 'The backend database only stores encrypted ciphertexts and nonces. Plaintext keys never leave your device, eliminating cloud exposure risk.',
              tag: 'Zero-Trust',
            },
            {
              icon: '⚡',
              title: 'Real-Time WebSocket Engine',
              desc: 'Sub-50ms message propagation, live ephemeral typing broadcasts, live online presence tracking, and triple-state read receipts (Sent, Delivered, Read).',
              tag: 'WebSockets',
            },
            {
              icon: '📎',
              title: 'Encrypted Media Vault',
              desc: 'Upload files and images up to 15MB with client-side preview thumbnails and a high-resolution darkroom Lightbox modal.',
              tag: 'Media Vault',
            },
            {
              icon: '🔑',
              title: 'Safety Fingerprints',
              desc: 'Verify the cryptographic identity of your peers using 60-digit safety numbers to mathematically eliminate Man-in-the-Middle eavesdropping.',
              tag: 'Anti-MITM',
            },
            {
              icon: '🥷',
              title: 'Stealth Personas & Tombstones',
              desc: 'Custom stealth avatars, real-time status messages, and permanent tombstone deletion that completely purges sensitive data from storage.',
              tag: 'Stealth UX',
            },
          ].map((feature) => (
            <div
              key={feature.title}
              className="group relative rounded-3xl border border-white/[0.08] bg-[#0c1322]/60 p-7 shadow-lg backdrop-blur-xl transition hover:-translate-y-1 hover:border-emerald-500/40 hover:bg-[#0c1322]/90 hover:shadow-[0_15px_40px_rgba(16,185,129,0.12)]"
            >
              <div className="flex items-center justify-between mb-5">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.05] border border-white/10 text-2xl group-hover:scale-110 transition">
                  {feature.icon}
                </span>
                <span className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 text-[10px] font-semibold text-emerald-400">
                  {feature.tag}
                </span>
              </div>
              <h3 className="text-lg font-bold text-white group-hover:text-emerald-300 transition">
                {feature.title}
              </h3>
              <p className="mt-2.5 text-xs sm:text-sm text-slate-400 leading-relaxed">
                {feature.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Security Architecture & Protocol Flow */}
      <section id="security" className="relative px-6 py-24 max-w-7xl mx-auto border-t border-white/[0.06]">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-400 mb-3">Cryptographic Pipeline</p>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
            How Zero-Knowledge E2EE Works
          </h2>
          <p className="mt-4 text-sm sm:text-base text-slate-400">
            Messages are transformed into opaque mathematical ciphertext before leaving your browser.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {[
            {
              step: '01',
              title: 'Local Key Generation',
              desc: 'Client browser generates an ECDH P-256 keypair via Web Crypto API. Private key never leaves device storage (IndexedDB).',
            },
            {
              step: '02',
              title: 'Public SPKI Exchange',
              desc: 'Only the public SPKI key is uploaded to the server for discovery by conversation participants.',
            },
            {
              step: '03',
              title: 'ECDH Shared Secret',
              desc: 'Alice derives a symmetric AES-256-GCM key using her Private Key and Bob’s Public Key without transmitting secret material.',
            },
            {
              step: '04',
              title: 'Nonces & Zero Plaintext',
              desc: 'Each message is ciphered with a fresh 96-bit random nonce. Server stores only ciphertext. Only Bob can decrypt.',
            },
          ].map((item) => (
            <div
              key={item.step}
              className="rounded-3xl border border-white/[0.08] bg-[#0c1322]/50 p-6 backdrop-blur-xl"
            >
              <span className="font-mono text-2xl font-black text-emerald-400/80 mb-3 block">
                {item.step}
              </span>
              <h3 className="text-base font-bold text-white mb-2">{item.title}</h3>
              <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Comparison Matrix */}
      <section id="comparison" className="relative px-6 py-24 max-w-5xl mx-auto border-t border-white/[0.06]">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-400 mb-3">Privacy Integrity</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Shadow Chat vs Legacy Messengers
          </h2>
        </div>

        <div className="overflow-hidden rounded-3xl border border-white/[0.1] bg-[#0c1322]/80 backdrop-blur-2xl shadow-2xl">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="border-b border-white/10 bg-white/[0.03] text-slate-300">
              <tr>
                <th className="p-4 sm:p-5 font-semibold">Security Capability</th>
                <th className="p-4 sm:p-5 font-semibold text-rose-400">Legacy Apps (Slack, Discord)</th>
                <th className="p-4 sm:p-5 font-semibold text-emerald-400 bg-emerald-500/10">Shadow Chat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-slate-300">
              <tr>
                <td className="p-4 sm:p-5 font-medium text-white">Server-side Plaintext Access</td>
                <td className="p-4 sm:p-5 text-rose-400">❌ Full server visibility & indexing</td>
                <td className="p-4 sm:p-5 text-emerald-300 font-semibold bg-emerald-500/[0.05]">✅ Zero plaintext (Math guaranteed)</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-medium text-white">Client-side Key Exchange</td>
                <td className="p-4 sm:p-5 text-rose-400">❌ Server manages all keys</td>
                <td className="p-4 sm:p-5 text-emerald-300 font-semibold bg-emerald-500/[0.05]">✅ Web Crypto SubtleCrypto ECDH</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-medium text-white">Advertiser Tracking & Profiling</td>
                <td className="p-4 sm:p-5 text-rose-400">❌ Ubiquitous data telemetry</td>
                <td className="p-4 sm:p-5 text-emerald-300 font-semibold bg-emerald-500/[0.05]">✅ Zero trackers, zero ads</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-medium text-white">Man-in-the-Middle Verification</td>
                <td className="p-4 sm:p-5 text-rose-400">❌ Impossible / hidden</td>
                <td className="p-4 sm:p-5 text-emerald-300 font-semibold bg-emerald-500/[0.05]">✅ 60-digit Safety Number verification</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-medium text-white">Encrypted File Uploads (up to 15MB)</td>
                <td className="p-4 sm:p-5 text-rose-400">❌ Scanned on cloud servers</td>
                <td className="p-4 sm:p-5 text-emerald-300 font-semibold bg-emerald-500/[0.05]">✅ Isolated encrypted attachments</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-medium text-white">Tombstone Data Deletion</td>
                <td className="p-4 sm:p-5 text-rose-400">❌ Soft delete, archives kept</td>
                <td className="p-4 sm:p-5 text-emerald-300 font-semibold bg-emerald-500/[0.05]">✅ Irreversible data purge</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Call to Action Banner */}
      <section className="relative px-6 py-20 max-w-5xl mx-auto">
        <div className="relative rounded-3xl border border-emerald-500/30 bg-gradient-to-r from-emerald-950/40 via-slate-900/80 to-teal-950/40 p-8 sm:p-14 text-center shadow-[0_0_50px_rgba(16,185,129,0.15)] backdrop-blur-2xl overflow-hidden">
          <div className="absolute -top-24 -right-24 h-64 w-64 rounded-full bg-emerald-500/20 blur-[90px]" />
          <div className="relative z-10">
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white">
              Take Your Privacy Completely Off The Grid.
            </h2>
            <p className="mt-3 max-w-xl mx-auto text-sm sm:text-base text-slate-300">
              Create your cryptographic keypair in seconds. No telephone number required. Zero logs kept.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <button
                type="button"
                onClick={() => openAuth('register')}
                className="rounded-2xl bg-gradient-to-r from-emerald-400 to-teal-400 px-8 py-3.5 text-sm font-bold text-slate-950 shadow-[0_0_30px_rgba(16,185,129,0.4)] hover:shadow-[0_0_40px_rgba(16,185,129,0.6)] hover:scale-105 active:scale-95 transition"
              >
                Create Account in 10 Seconds →
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.08] bg-[#070b14]/80 py-10 px-6 text-center text-xs text-slate-500 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <img src="/shadow-chat-logo.png" alt="Shadow Chat" className="h-6 w-6 object-contain" />
            <span className="font-bold text-slate-300">SHADOW CHAT</span>
            <span>— The Zero-Knowledge Stealth Messenger</span>
          </div>
          <div className="flex items-center gap-6">
            <a
              href="https://github.com/mattasaiswaroop5641-byte/Shadow-Chat"
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 hover:text-emerald-400 transition"
            >
              GitHub Source Code
            </a>
            <a
              href="https://shadow-chat-api.onrender.com/health"
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 hover:text-emerald-400 transition"
            >
              API Health Monitor
            </a>
            <button
              type="button"
              onClick={() => openAuth('login')}
              className="text-emerald-400 hover:underline"
            >
              Operative Sign In
            </button>
          </div>
        </div>
      </footer>

      {/* Frosted Glass Auth Modal */}
      <GlassAuthModal
        isOpen={authModalOpen}
        initialMode={authMode}
        onClose={() => setAuthModalOpen(false)}
        onAuthenticated={onAuthenticated}
      />
    </div>
  )
}
