import { FormEvent, useEffect, useState } from 'react'
import {
  ApiError,
  addMember,
  createConversation,
  fetchHealth,
  listConversations,
  listMembers,
  listMessages,
  login,
  logout,
  openConversationSocket,
  register,
  resendVerification,
  restoreSession,
  searchUsers,
  sendMessage,
  setSessionExpiredHandler,
  verifyEmail,
} from './lib/api'
import type { Conversation, ConversationMember, Message, NavItem, ServerItem, User, UserSummary } from './types'

const navItems: NavItem[] = [
  { id: 'messages', label: 'Messages', badge: '3', active: true },
  { id: 'discover', label: 'Discover' },
  { id: 'calls', label: 'Calls' },
  { id: 'settings', label: 'Settings' },
]

const serverList: ServerItem[] = [
  { id: 'core', name: 'Core', accent: 'bg-emerald-500', unread: 3 },
  { id: 'design', name: 'Design', accent: 'bg-violet-500' },
  { id: 'ops', name: 'Ops', accent: 'bg-cyan-500', unread: 5 },
]

type AuthMode = 'login' | 'register'

function AuthPanel({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
      setError(resendError instanceof ApiError ? resendError.message : 'Unable to resend the verification code.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0b1020] px-6 text-slate-100">
      <section className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#101827] p-8 shadow-soft">
        <div className="mb-8 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-violet-500 font-bold text-slate-950">
          S
        </div>
        <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Shadow Chat</p>
        <h1 className="mt-2 text-2xl font-semibold text-white">
          {verificationRequired ? 'Verify your email' : mode === 'login' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          {verificationRequired ? 'Email verification is required before you can enter the chat.' : 'Use your Shadow Chat account to continue.'}
        </p>

        {message ? <p className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{message}</p> : null}
        {error ? <p role="alert" className="mt-5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p> : null}

        {verificationRequired ? (
          <form className="mt-6 space-y-4" onSubmit={handleVerification}>
            <label className="block text-sm text-slate-300">
              Verification code
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-emerald-400"
              />
            </label>
            <button disabled={busy} className="w-full rounded-lg bg-emerald-500 px-4 py-2 font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-50" type="submit">
              {busy ? 'Verifying...' : 'Verify email'}
            </button>
            <button disabled={busy} className="w-full rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 disabled:opacity-50" type="button" onClick={handleResend}>
              Resend code
            </button>
          </form>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <label className="block text-sm text-slate-300">
              Email
              <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-emerald-400" />
            </label>
            {mode === 'register' ? (
              <label className="block text-sm text-slate-300">
                Username
                <input required minLength={3} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-emerald-400" />
              </label>
            ) : null}
            <label className="block text-sm text-slate-300">
              Password
              <input required minLength={8} maxLength={128} type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-emerald-400" />
            </label>
            <button disabled={busy} className="w-full rounded-lg bg-emerald-500 px-4 py-2 font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-50" type="submit">
              {busy ? 'Working...' : mode === 'login' ? 'Log in' : 'Create account'}
            </button>
            <button
              className="w-full text-sm text-emerald-400 hover:text-emerald-300"
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login')
                setError('')
                setMessage('')
              }}
            >
              {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Log in'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}

export default function App() {
  const [backendStatus, setBackendStatus] = useState('Checking')
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [conversationLoading, setConversationLoading] = useState(false)
  const [conversationError, setConversationError] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState('')
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [socketStatus, setSocketStatus] = useState<'connected' | 'disconnected'>('disconnected')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  // Participant & Member states
  const [members, setMembers] = useState<ConversationMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersDrawerOpen, setMembersDrawerOpen] = useState(false)

  // Create Conversation Modal state
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createKind, setCreateKind] = useState<'direct' | 'group'>('direct')
  const [createTitle, setCreateTitle] = useState('')
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [userSearchResults, setUserSearchResults] = useState<UserSummary[]>([])
  const [userSearching, setUserSearching] = useState(false)
  const [selectedGroupParticipants, setSelectedGroupParticipants] = useState<UserSummary[]>([])
  const [createError, setCreateError] = useState('')
  const [createBusy, setCreateBusy] = useState(false)

  // Invite Member Modal state
  const [inviteModalOpen, setInviteModalOpen] = useState(false)
  const [inviteQuery, setInviteQuery] = useState('')
  const [inviteSearchResults, setInviteSearchResults] = useState<UserSummary[]>([])
  const [inviteSearching, setInviteSearching] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [inviteSuccess, setInviteSuccess] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)

  useEffect(() => {
    restoreSession().then(setUser).finally(() => setAuthLoading(false))
    fetchHealth()
      .then((result) => setBackendStatus(`${result.status} • ${result.service}`))
      .catch(() => setBackendStatus('Backend unavailable'))
  }, [])

  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null))
    return () => setSessionExpiredHandler(null)
  }, [])

  useEffect(() => {
    if (!user) return
    let active = true
    setConversationLoading(true)
    setConversationError('')
    listConversations()
      .then((items) => {
        if (!active) return
        setConversations(items)
        setSelectedConversationId((current) => current ?? items[0]?.id ?? null)
      })
      .catch((error: unknown) => {
        if (active) setConversationError(error instanceof ApiError ? error.message : 'Unable to load conversations.')
      })
      .finally(() => {
        if (active) setConversationLoading(false)
      })
    return () => {
      active = false
    }
  }, [user])

  useEffect(() => {
    if (!user || !selectedConversationId) {
      setMessages([])
      setMembers([])
      return
    }
    let active = true
    setMessagesLoading(true)
    setMessagesError('')
    setHasOlderMessages(false)
    listMessages(selectedConversationId)
      .then((items) => {
        if (!active) return
        setMessages(items)
        setHasOlderMessages(items.length === 50)
      })
      .catch((error: unknown) => {
        if (active) setMessagesError(error instanceof ApiError ? error.message : 'Unable to load messages.')
      })
      .finally(() => {
        if (active) setMessagesLoading(false)
      })

    setMembersLoading(true)
    listMembers(selectedConversationId)
      .then((items) => {
        if (active) setMembers(items)
      })
      .catch(() => {
        // Fallback silently if member fetch fails
      })
      .finally(() => {
        if (active) setMembersLoading(false)
      })

    return () => {
      active = false
    }
  }, [user, selectedConversationId])

  useEffect(() => {
    if (!user) return
    let active = true
    let socketControl: { subscribe: (id: string) => void; close: () => void } | null = null
    void openConversationSocket(
      (message) => {
        if (!active) return
        setMessages((current) => {
          if (current.some((item) => item.id === message.id || item.client_id === message.client_id)) return current
          if (selectedConversationId !== message.conversation_id) return current
          return [...current, message].sort(
            (left, right) =>
              new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
          )
        })
      },
      setSocketStatus,
      (event) => {
        if (!active) return
        if (selectedConversationId === event.conversation_id) {
          void listMembers(selectedConversationId).then(setMembers)
        }
      },
    ).then((control) => {
      if (!active) {
        control.close()
        return
      }
      socketControl = control
      if (selectedConversationId) control.subscribe(selectedConversationId)
    })
    return () => {
      active = false
      socketControl?.close()
    }
  }, [user, selectedConversationId])

  // User search for conversation creation
  useEffect(() => {
    const query = userSearchQuery.trim()
    if (!createModalOpen || query.length < 1) {
      setUserSearchResults([])
      return
    }
    const timer = setTimeout(async () => {
      setUserSearching(true)
      try {
        const results = await searchUsers(query)
        setUserSearchResults(results)
      } catch {
        setUserSearchResults([])
      } finally {
        setUserSearching(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [userSearchQuery, createModalOpen])

  // User search for invite member
  useEffect(() => {
    const query = inviteQuery.trim()
    if (!inviteModalOpen || query.length < 1) {
      setInviteSearchResults([])
      return
    }
    const timer = setTimeout(async () => {
      setInviteSearching(true)
      try {
        const results = await searchUsers(query)
        setInviteSearchResults(results)
      } catch {
        setInviteSearchResults([])
      } finally {
        setInviteSearching(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [inviteQuery, inviteModalOpen])

  async function handleCreateDirect(recipient: UserSummary) {
    setCreateBusy(true)
    setCreateError('')
    try {
      const conv = await createConversation({ kind: 'direct', recipient_id: recipient.id })
      setConversations((current) => {
        const exists = current.some((c) => c.id === conv.id)
        return exists ? current : [conv, ...current]
      })
      setSelectedConversationId(conv.id)
      setCreateModalOpen(false)
      setUserSearchQuery('')
      setUserSearchResults([])
    } catch (error) {
      setCreateError(error instanceof ApiError ? error.message : 'Unable to create direct conversation.')
    } finally {
      setCreateBusy(false)
    }
  }

  async function handleCreateGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreateBusy(true)
    setCreateError('')
    try {
      const conv = await createConversation({
        kind: 'group',
        participant_ids: selectedGroupParticipants.map((p) => p.id),
        title: createTitle.trim() || undefined,
      })
      setConversations((current) => [conv, ...current])
      setSelectedConversationId(conv.id)
      setCreateModalOpen(false)
      setCreateTitle('')
      setSelectedGroupParticipants([])
      setUserSearchQuery('')
      setUserSearchResults([])
    } catch (error) {
      setCreateError(error instanceof ApiError ? error.message : 'Unable to create group conversation.')
    } finally {
      setCreateBusy(false)
    }
  }

  async function handleInviteMember(target: { user_id?: string; username?: string }) {
    if (!selectedConversationId) return
    setInviteBusy(true)
    setInviteError('')
    setInviteSuccess('')
    try {
      const newMember = await addMember(selectedConversationId, target)
      setMembers((current) => {
        if (current.some((m) => m.id === newMember.id || m.user_id === newMember.user_id)) return current
        return [...current, newMember]
      })
      setInviteSuccess(`Added @${newMember.username} to group!`)
      setInviteQuery('')
      setInviteSearchResults([])
      setTimeout(() => {
        setInviteModalOpen(false)
        setInviteSuccess('')
      }, 1200)
    } catch (error) {
      setInviteError(error instanceof ApiError ? error.message : 'Failed to add member.')
    } finally {
      setInviteBusy(false)
    }
  }

  async function loadOlderMessages() {
    if (!selectedConversationId || messages.length === 0) return
    setMessagesLoading(true)
    try {
      const older = await listMessages(selectedConversationId, messages[0].created_at)
      setMessages((current) => {
        const known = new Set(current.map((item) => item.id))
        return [...older.filter((item) => !known.has(item.id)), ...current]
      })
      setHasOlderMessages(older.length === 50)
    } catch (error) {
      setMessagesError(error instanceof ApiError ? error.message : 'Unable to load older messages.')
    } finally {
      setMessagesLoading(false)
    }
  }

  async function handleSend() {
    const content = draft.trim()
    if (!selectedConversationId || !content || sending) return
    setSending(true)
    setMessagesError('')
    try {
      const message = await sendMessage(selectedConversationId, content)
      setMessages((current) => {
        if (current.some((item) => item.id === message.id || item.client_id === message.client_id)) {
          return current
        }
        return [...current, message].sort(
          (left, right) =>
            new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
        )
      })
      setDraft('')
    } catch (error) {
      setMessagesError(error instanceof ApiError ? error.message : 'Unable to send message.')
    } finally {
      setSending(false)
    }
  }

  if (authLoading) {
    return <main className="flex min-h-screen items-center justify-center bg-[#0b1020] text-sm text-slate-400">Restoring session...</main>
  }

  if (!user) {
    return <AuthPanel onAuthenticated={setUser} />
  }

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId) || null
  const directPartner = selectedConversation?.kind === 'direct'
    ? members.find((m) => m.user_id !== user.id)?.username
    : null

  const activeChannelTitle = selectedConversation
    ? selectedConversation.kind === 'direct'
      ? directPartner ? `@${directPartner}` : `Direct ${selectedConversation.id.slice(-6)}`
      : selectedConversation.title || `Group ${selectedConversation.id.slice(-6)}`
    : 'No conversation'

  return (
    <div className="min-h-screen bg-[#0b1020] text-slate-100">
      <div className="flex min-h-screen">
        <aside className="w-20 border-r border-slate-800 bg-[#0d1424] p-3">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-violet-500 font-bold text-slate-950 shadow-soft">
            S
          </div>
          <nav className="space-y-3">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`flex w-full items-center justify-center rounded-xl px-2 py-3 text-xs font-medium transition ${
                  item.active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                }`}
                type="button"
              >
                {item.label.charAt(0)}
                {item.badge ? (
                  <span className="ml-1 rounded-full bg-emerald-500 px-1.5 text-[10px] text-slate-950">{item.badge}</span>
                ) : null}
              </button>
            ))}
          </nav>
        </aside>

        <aside className="w-72 border-r border-slate-800 bg-[#101827] p-4">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Teams</p>
              <h2 className="mt-1 text-lg font-semibold text-white">Shadow Chat</h2>
            </div>
            <button
              onClick={() => {
                setCreateError('')
                setCreateModalOpen(true)
              }}
              type="button"
              className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
            >
              + New
            </button>
          </div>

          <div className="space-y-3">
            {serverList.map((server) => (
              <button
                key={server.id}
                type="button"
                className="flex w-full items-center gap-3 rounded-xl bg-slate-900/60 px-3 py-2 text-left transition hover:bg-slate-800"
              >
                <span className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold text-white ${server.accent}`}>
                  {server.name.charAt(0)}
                </span>
                <span className="flex-1 text-sm text-slate-200">{server.name}</span>
                {server.unread ? (
                  <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-semibold text-slate-950">
                    {server.unread}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="mt-8">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Channels</p>
              <button
                onClick={() => {
                  setCreateError('')
                  setCreateModalOpen(true)
                }}
                type="button"
                className="text-xs text-emerald-400 hover:text-emerald-300"
              >
                + add
              </button>
            </div>
            <div className="space-y-2">
              {conversationLoading ? <p className="text-sm text-slate-500">Loading conversations...</p> : null}
              {!conversationLoading && conversations.length === 0 ? <p className="text-sm text-slate-500">No conversations yet.</p> : null}
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  onClick={() => setSelectedConversationId(conversation.id)}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    conversation.id === selectedConversationId ? 'bg-slate-800 text-white font-medium' : 'text-slate-300 hover:bg-slate-900'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase font-semibold ${
                      conversation.kind === 'direct' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    }`}>
                      {conversation.kind === 'direct' ? 'DM' : 'GRP'}
                    </span>
                    <span className="truncate">
                      {conversation.title || `#${conversation.kind} ${conversation.id.slice(-6)}`}
                    </span>
                  </div>
                </button>
              ))}
              {conversationError ? <p className="text-sm text-rose-300">{conversationError}</p> : null}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-[#0b1220]">
          <header className="flex items-center justify-between border-b border-slate-800 bg-[#0d1424]/80 px-6 py-4 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              {selectedConversation ? (
                <span className={`rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${
                  selectedConversation.kind === 'direct'
                    ? 'border border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
                    : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                }`}>
                  {selectedConversation.kind}
                </span>
              ) : null}
              <div>
                <h1 className="text-xl font-semibold text-white flex items-center gap-2">
                  {activeChannelTitle}
                </h1>
                {selectedConversation ? (
                  <p className="text-xs text-slate-400">
                    ID: {selectedConversation.id.slice(-8)}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {selectedConversation?.kind === 'group' ? (
                <button
                  type="button"
                  onClick={() => {
                    setInviteError('')
                    setInviteSuccess('')
                    setInviteQuery('')
                    setInviteSearchResults([])
                    setInviteModalOpen(true)
                  }}
                  className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
                >
                  + Invite Member
                </button>
              ) : null}

              {selectedConversation ? (
                <button
                  type="button"
                  onClick={() => setMembersDrawerOpen(!membersDrawerOpen)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    membersDrawerOpen ? 'border-slate-600 bg-slate-800 text-white' : 'border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  Participants ({members.length})
                </button>
              ) : null}

              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                {socketStatus === 'connected' ? 'Live connected' : 'Live reconnecting'}
              </span>

              <div className="flex items-center gap-2 border-l border-slate-800 pl-3">
                <span className="text-sm font-medium text-slate-300">{user.username}</span>
                <button
                  type="button"
                  className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
                  onClick={async () => {
                    await logout()
                    setUser(null)
                  }}
                >
                  Log out
                </button>
              </div>
            </div>
          </header>

          <div className="flex flex-1 overflow-hidden">
            <div className="flex flex-1 flex-col">
              <div className="border-b border-slate-800 bg-[#0d1424]/60 px-6 py-2.5 text-xs text-slate-400 flex items-center justify-between">
                <span>{backendStatus}</span>
                {selectedConversation ? (
                  <span>
                    Created: {new Date(selectedConversation.created_at).toLocaleDateString()}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
                {messagesError ? <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{messagesError}</p> : null}
                {messagesLoading && messages.length === 0 ? <p className="text-sm text-slate-500">Loading messages...</p> : null}
                {!messagesLoading && messages.length === 0 ? (
                  <div className="m-auto text-center">
                    <p className="text-base text-slate-400 font-medium">No messages yet.</p>
                    <p className="mt-1 text-xs text-slate-500">Send a message below to start chatting.</p>
                  </div>
                ) : null}
                {hasOlderMessages ? (
                  <div className="text-center">
                    <button onClick={() => void loadOlderMessages()} className="text-xs text-emerald-400 hover:underline" type="button">
                      Load older messages
                    </button>
                  </div>
                ) : null}
                {messages.map((message) => {
                  const isSelf = message.sender_id === user.id
                  const senderMember = members.find((m) => m.user_id === message.sender_id)
                  const senderLabel = isSelf ? 'You' : senderMember?.username || 'Member'

                  return (
                    <div key={message.id} className={`flex ${isSelf ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-xl rounded-2xl border px-4 py-3 shadow-soft ${
                          isSelf
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-50'
                            : 'border-slate-700 bg-slate-900/80 text-slate-100'
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-4 text-[11px] uppercase tracking-[0.18em] text-slate-400">
                          <span className="font-semibold text-slate-300">{senderLabel}</span>
                          <span>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <p className="text-sm leading-6 whitespace-pre-wrap break-words">{message.content}</p>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="border-t border-slate-800 bg-[#0d1424] p-4">
                <div className="flex items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/80 px-3 py-3">
                  <button
                    onClick={() => {
                      setCreateError('')
                      setCreateModalOpen(true)
                    }}
                    type="button"
                    title="Create new conversation"
                    className="rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700"
                  >
                    +
                  </button>
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void handleSend()
                      }
                    }}
                    disabled={!selectedConversationId || sending}
                    className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
                    placeholder={selectedConversationId ? `Message ${activeChannelTitle}...` : 'Select or create a conversation first'}
                  />
                  <button
                    onClick={() => void handleSend()}
                    disabled={!selectedConversationId || !draft.trim() || sending}
                    type="button"
                    className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                </div>
              </div>
            </div>

            {/* Participants Sidebar */}
            {membersDrawerOpen && selectedConversation ? (
              <aside className="w-64 border-l border-slate-800 bg-[#101827] p-4 flex flex-col">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                  <h3 className="text-sm font-semibold text-white">Participants</h3>
                  <button
                    type="button"
                    onClick={() => setMembersDrawerOpen(false)}
                    className="text-slate-400 hover:text-white text-xs"
                  >
                    ✕
                  </button>
                </div>
                {membersLoading ? <p className="text-xs text-slate-500">Loading members...</p> : null}
                <div className="space-y-2 overflow-y-auto flex-1">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between rounded-lg bg-slate-900/70 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-800 text-[11px] font-bold text-slate-300">
                          {member.username.charAt(0).toUpperCase()}
                        </span>
                        <span className="truncate text-slate-200">
                          {member.username} {member.user_id === user.id ? '(You)' : ''}
                        </span>
                      </div>
                      <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${
                        member.role === 'owner' ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-800 text-slate-400'
                      }`}>
                        {member.role}
                      </span>
                    </div>
                  ))}
                </div>
              </aside>
            ) : null}
          </div>
        </main>
      </div>

      {/* Create Conversation Modal */}
      {createModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#101827] p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <h2 className="text-lg font-semibold text-white">New Conversation</h2>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 flex gap-2 rounded-xl bg-slate-900 p-1">
              <button
                type="button"
                onClick={() => {
                  setCreateKind('direct')
                  setCreateError('')
                }}
                className={`flex-1 rounded-lg py-2 text-xs font-semibold transition ${
                  createKind === 'direct' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
              >
                Direct Message
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreateKind('group')
                  setCreateError('')
                }}
                className={`flex-1 rounded-lg py-2 text-xs font-semibold transition ${
                  createKind === 'group' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
              >
                Group Chat
              </button>
            </div>

            {createError ? (
              <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {createError}
              </p>
            ) : null}

            {createKind === 'direct' ? (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Find user to chat with
                  </label>
                  <input
                    type="text"
                    value={userSearchQuery}
                    onChange={(e) => setUserSearchQuery(e.target.value)}
                    placeholder="Search by username..."
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                    autoFocus
                  />
                </div>

                <div className="max-h-48 overflow-y-auto space-y-1">
                  {userSearching ? <p className="text-xs text-slate-400 py-2">Searching...</p> : null}
                  {!userSearching && userSearchQuery.trim() && userSearchResults.length === 0 ? (
                    <p className="text-xs text-slate-500 py-2">No users found.</p>
                  ) : null}
                  {userSearchResults.map((result) => (
                    <button
                      key={result.id}
                      type="button"
                      disabled={createBusy}
                      onClick={() => void handleCreateDirect(result)}
                      className="flex w-full items-center justify-between rounded-lg bg-slate-900/60 p-2 text-left hover:bg-slate-800 transition"
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300">
                          {result.username.charAt(0).toUpperCase()}
                        </span>
                        <span className="text-sm font-medium text-slate-200">@{result.username}</span>
                      </div>
                      <span className="text-xs text-emerald-400">Start Chat →</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateGroup} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Group Name (optional)
                  </label>
                  <input
                    type="text"
                    value={createTitle}
                    onChange={(e) => setCreateTitle(e.target.value)}
                    placeholder="e.g. Project Apollo"
                    maxLength={100}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Add Participants ({selectedGroupParticipants.length} selected)
                  </label>
                  <input
                    type="text"
                    value={userSearchQuery}
                    onChange={(e) => setUserSearchQuery(e.target.value)}
                    placeholder="Search users to add..."
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                  />
                </div>

                {selectedGroupParticipants.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 p-2 rounded-lg bg-slate-900/50 border border-slate-800">
                    {selectedGroupParticipants.map((p) => (
                      <span
                        key={p.id}
                        className="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-200"
                      >
                        @{p.username}
                        <button
                          type="button"
                          onClick={() => setSelectedGroupParticipants((prev) => prev.filter((item) => item.id !== p.id))}
                          className="text-slate-400 hover:text-white"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}

                <div className="max-h-36 overflow-y-auto space-y-1">
                  {userSearchResults
                    .filter((r) => !selectedGroupParticipants.some((p) => p.id === r.id))
                    .map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        onClick={() => setSelectedGroupParticipants((prev) => [...prev, result])}
                        className="flex w-full items-center justify-between rounded-lg bg-slate-900/60 p-2 text-left hover:bg-slate-800 transition"
                      >
                        <span className="text-xs text-slate-200">@{result.username}</span>
                        <span className="text-xs text-emerald-400">+ Add</span>
                      </button>
                    ))}
                </div>

                <button
                  type="submit"
                  disabled={createBusy}
                  className="w-full rounded-lg bg-emerald-500 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                >
                  {createBusy ? 'Creating Group...' : 'Create Group'}
                </button>
              </form>
            )}
          </div>
        </div>
      ) : null}

      {/* Invite Member Modal */}
      {inviteModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#101827] p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <h2 className="text-lg font-semibold text-white">Invite to Group</h2>
              <button
                type="button"
                onClick={() => setInviteModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            {inviteSuccess ? (
              <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                {inviteSuccess}
              </p>
            ) : null}
            {inviteError ? (
              <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {inviteError}
              </p>
            ) : null}

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Search username to invite
                </label>
                <input
                  type="text"
                  value={inviteQuery}
                  onChange={(e) => setInviteQuery(e.target.value)}
                  placeholder="Type username..."
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                  autoFocus
                />
              </div>

              <div className="max-h-48 overflow-y-auto space-y-1">
                {inviteSearching ? <p className="text-xs text-slate-400 py-2">Searching...</p> : null}
                {!inviteSearching && inviteQuery.trim() && inviteSearchResults.length === 0 ? (
                  <div className="p-3 text-center">
                    <p className="text-xs text-slate-400">No matching user found via prefix.</p>
                    <button
                      type="button"
                      onClick={() => void handleInviteMember({ username: inviteQuery.trim() })}
                      className="mt-2 text-xs font-medium text-emerald-400 hover:underline"
                    >
                      Try inviting exact username "@{inviteQuery.trim()}"
                    </button>
                  </div>
                ) : null}
                {inviteSearchResults.map((result) => {
                  const alreadyMember = members.some((m) => m.user_id === result.id)
                  return (
                    <button
                      key={result.id}
                      type="button"
                      disabled={inviteBusy || alreadyMember}
                      onClick={() => void handleInviteMember({ user_id: result.id })}
                      className={`flex w-full items-center justify-between rounded-lg p-2 text-left transition ${
                        alreadyMember ? 'bg-slate-900/30 opacity-50 cursor-not-allowed' : 'bg-slate-900/60 hover:bg-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300">
                          {result.username.charAt(0).toUpperCase()}
                        </span>
                        <span className="text-sm font-medium text-slate-200">@{result.username}</span>
                      </div>
                      <span className="text-xs text-emerald-400">
                        {alreadyMember ? 'Already member' : '+ Invite'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
