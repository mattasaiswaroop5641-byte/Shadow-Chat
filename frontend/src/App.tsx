import { FormEvent, useEffect, useRef, useState } from 'react'
import {
  calculateSafetyNumber,
  decryptMessage,
  deriveConversationKey,
  encryptMessage,
  exportPublicKeySpki,
  getOrGenerateIdentityKeyPair,
  importPublicKeySpki,
} from './lib/crypto'
import {
  ApiError,
  addMember,
  createConversation,
  deleteMessage,
  editMessage,
  fetchHealth,
  getAttachmentFileUrl,
  getUserPublicKey,
  getUsersPresence,
  listConversations,
  listMembers,
  listMessages,
  login,
  logout,
  markMessagesRead,
  openConversationSocket,
  register,
  resendVerification,
  restoreSession,
  searchUsers,
  sendMessage,
  setSessionExpiredHandler,
  toggleReaction,
  updateUserProfile,
  uploadAttachment,
  uploadAvatar,
  uploadPublicKey,
  verifyEmail,
} from './lib/api'
import type {
  Attachment,
  Conversation,
  ConversationMember,
  Message,
  NavItem,
  ServerItem,
  User,
  UserSummary,
} from './types'
import LandingPage from './LandingPage'

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



function UserAvatar({
  username,
  avatarUrl,
  size = 'md',
  isOnline,
}: {
  username: string
  avatarUrl?: string | null
  size?: 'sm' | 'md' | 'lg'
  isOnline?: boolean
}) {
  const sizeClasses = {
    sm: 'h-6 w-6 text-[10px]',
    md: 'h-8 w-8 text-xs',
    lg: 'h-12 w-12 text-base',
  }[size]

  const initial = (username || '?').charAt(0).toUpperCase()
  const gradients = [
    'from-emerald-500 to-teal-700',
    'from-indigo-500 to-purple-700',
    'from-cyan-500 to-blue-700',
    'from-rose-500 to-pink-700',
    'from-amber-500 to-orange-700',
  ]
  const charCode = username ? username.charCodeAt(0) : 0
  const gradient = gradients[charCode % gradients.length]
  const fullAvatarUrl = avatarUrl ? getAttachmentFileUrl(avatarUrl) : null

  return (
    <div className="relative inline-flex flex-shrink-0">
      {fullAvatarUrl ? (
        <img
          src={fullAvatarUrl}
          alt={username}
          className={`${sizeClasses} rounded-full object-cover border border-slate-700/80 shadow-inner`}
        />
      ) : (
        <div
          className={`${sizeClasses} rounded-full bg-gradient-to-br ${gradient} flex items-center justify-center font-bold text-white shadow-inner uppercase tracking-wider`}
        >
          {initial}
        </div>
      )}
      {typeof isOnline === 'boolean' ? (
        <span
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[#0b1020] ${
            size === 'sm' ? 'h-2 w-2' : size === 'lg' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5'
          } ${
            isOnline
              ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
              : 'bg-slate-600'
          }`}
          title={isOnline ? 'Online' : 'Offline'}
        />
      ) : null}
    </div>
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

  // E2EE Cryptographic State
  const [myKeyPair, setMyKeyPair] = useState<CryptoKeyPair | null>(null)
  const [myPublicKeySpki, setMyPublicKeySpki] = useState<string | null>(null)
  const [conversationAesKey, setConversationAesKey] = useState<CryptoKey | null>(null)
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null)
  const [safetyModalOpen, setSafetyModalOpen] = useState(false)
  const [decryptedCache, setDecryptedCache] = useState<Record<string, string>>({})

  // Real-Time UX States: Presence, Typing, and Read Receipts
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set())
  const [typingUsers, setTypingUsers] = useState<Record<string, { username: string; expiresAt: number }>>({})
  const socketControlRef = useRef<{
    subscribe: (id: string) => void
    sendTyping: (id: string, isTyping: boolean) => void
    sendRead: (id: string) => void
    close: () => void
  } | null>(null)
  const typingTimeoutRef = useRef<number | null>(null)
  const isTypingRef = useRef(false)

  // Message Capabilities States: Attachments, Replies, Reactions, Edit & Delete, Image Preview
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([])
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // User Profile Settings State
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [profileAvatarUrl, setProfileAvatarUrl] = useState('')
  const [profileStatusMessage, setProfileStatusMessage] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileUploadingAvatar, setProfileUploadingAvatar] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileSuccess, setProfileSuccess] = useState('')
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId) || null

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

  // Initialize E2EE Keys on user authentication
  useEffect(() => {
    if (!user) {
      setMyKeyPair(null)
      setMyPublicKeySpki(null)
      return
    }
    let active = true
    void getOrGenerateIdentityKeyPair(user.id).then(async (keyPair) => {
      if (!active) return
      setMyKeyPair(keyPair)
      try {
        const spki = await exportPublicKeySpki(keyPair.publicKey)
        if (!active) return
        setMyPublicKeySpki(spki)
        void uploadPublicKey(spki).catch(() => {})
      } catch {
        // Ignore key export failures
      }
    })
    return () => {
      active = false
    }
  }, [user])

  // Derive conversation key & safety number for Direct Messages
  useEffect(() => {
    if (!user || !myKeyPair || !myPublicKeySpki || !selectedConversation) {
      setConversationAesKey(null)
      setSafetyNumber(null)
      return
    }

    if (selectedConversation.kind === 'direct') {
      const peer = members.find((m) => m.user_id !== user.id)
      const peerKeySpki = peer?.public_key

      if (peerKeySpki) {
        let active = true
        importPublicKeySpki(peerKeySpki)
          .then((peerPubKey) =>
            deriveConversationKey(myKeyPair.privateKey, peerPubKey, selectedConversation.id),
          )
          .then(async (aesKey) => {
            if (!active) return
            setConversationAesKey(aesKey)
            const safety = await calculateSafetyNumber(myPublicKeySpki, peerKeySpki)
            if (active) setSafetyNumber(safety)
          })
          .catch(() => {
            if (active) {
              setConversationAesKey(null)
              setSafetyNumber(null)
            }
          })
        return () => {
          active = false
        }
      } else {
        if (peer?.user_id) {
          let active = true
          getUserPublicKey(peer.user_id).then((key) => {
            if (active && key) {
              setMembers((prev) =>
                prev.map((m) => (m.user_id === peer.user_id ? { ...m, public_key: key } : m)),
              )
            }
          })
          return () => {
            active = false
          }
        }
        setConversationAesKey(null)
        setSafetyNumber(null)
      }
    } else {
      setConversationAesKey(null)
      setSafetyNumber(null)
    }
  }, [user, myKeyPair, myPublicKeySpki, selectedConversation, members])

  // Decrypt encrypted messages
  useEffect(() => {
    if (!conversationAesKey || messages.length === 0) return
    let active = true
    const toDecrypt = messages.filter(
      (m) => m.is_encrypted && m.nonce && !decryptedCache[m.id],
    )
    if (toDecrypt.length === 0) return

    Promise.all(
      toDecrypt.map(async (m) => {
        try {
          const text = await decryptMessage(m.content, m.nonce!, conversationAesKey)
          return { id: m.id, text }
        } catch {
          return { id: m.id, text: '[Unable to decrypt: key mismatch]' }
        }
      }),
    ).then((results) => {
      if (!active) return
      setDecryptedCache((current) => {
        const next = { ...current }
        for (const item of results) {
          next[item.id] = item.text
        }
        return next
      })
    })

    return () => {
      active = false
    }
  }, [messages, conversationAesKey, decryptedCache])


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
    if (!user) {
      socketControlRef.current?.close()
      socketControlRef.current = null
      return
    }
    let active = true
    void openConversationSocket({
      onMessage: (message) => {
        if (!active) return
        setMessages((current) => {
          if (current.some((item) => item.id === message.id || item.client_id === message.client_id)) return current
          if (selectedConversationId !== message.conversation_id) return current
          return [...current, message].sort(
            (left, right) =>
              new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
          )
        })
        if (selectedConversationId === message.conversation_id) {
          socketControlRef.current?.sendRead(message.conversation_id)
          void markMessagesRead(message.conversation_id).catch(() => {})
        }
      },
      onStatus: setSocketStatus,
      onMemberJoined: (event) => {
        if (!active) return
        if (selectedConversationId === event.conversation_id) {
          void listMembers(selectedConversationId).then(setMembers)
        }
      },
      onTyping: (event) => {
        if (!active) return
        if (event.conversation_id === selectedConversationId && event.user_id !== user.id) {
          setTypingUsers((current) => {
            const next = { ...current }
            if (event.is_typing) {
              next[event.user_id] = { username: event.username, expiresAt: Date.now() + 3500 }
            } else {
              delete next[event.user_id]
            }
            return next
          })
        }
      },
      onReadReceipt: (event) => {
        if (!active) return
        if (event.conversation_id === selectedConversationId) {
          setMessages((current) =>
            current.map((m) => (m.sender_id === user.id ? { ...m, status: 'read' } : m)),
          )
        }
      },
      onMessageDelivered: (event) => {
        if (!active) return
        if (event.conversation_id === selectedConversationId) {
          setMessages((current) =>
            current.map((m) =>
              m.id === event.message_id && m.status !== 'read' ? { ...m, status: 'delivered' } : m,
            ),
          )
        }
      },
      onPresence: (event) => {
        if (!active) return
        setOnlineUserIds((current) => {
          const next = new Set(current)
          if (event.status === 'online') {
            next.add(event.user_id)
          } else {
            next.delete(event.user_id)
          }
          return next
        })
      },
      onMessageReaction: (event) => {
        if (!active) return
        if (event.conversation_id === selectedConversationId) {
          setMessages((current) =>
            current.map((m) =>
              m.id === event.message_id ? { ...m, reactions: event.reactions } : m,
            ),
          )
        }
      },
      onMessageEdited: (event) => {
        if (!active) return
        if (event.message.conversation_id === selectedConversationId) {
          setDecryptedCache((current) => {
            const next = { ...current }
            delete next[event.message.id]
            return next
          })
          setMessages((current) =>
            current.map((m) => (m.id === event.message.id ? event.message : m)),
          )
        }
      },
      onMessageDeleted: (event) => {
        if (!active) return
        if (event.conversation_id === selectedConversationId) {
          setDecryptedCache((current) => {
            const next = { ...current }
            delete next[event.message_id]
            return next
          })
          setMessages((current) =>
            current.map((m) =>
              m.id === event.message_id
                ? {
                    ...m,
                    is_deleted: true,
                    content: '[This message was deleted]',
                    nonce: null,
                    is_encrypted: false,
                    attachments: [],
                    reactions: {},
                  }
                : m,
            ),
          )
        }
      },
      onUserProfileUpdated: (event) => {
        if (!active) return
        if (user && event.user_id === user.id) {
          setUser((prev) =>
            prev
              ? {
                  ...prev,
                  avatar_url: event.avatar_url,
                  status_message: event.status_message,
                }
              : null,
          )
        }
        setMembers((current) =>
          current.map((m) =>
            m.user_id === event.user_id
              ? { ...m, avatar_url: event.avatar_url, status_message: event.status_message }
              : m,
          ),
        )
        setConversations((current) =>
          current.map((c) =>
            c.recipient_id === event.user_id
              ? {
                  ...c,
                  recipient_avatar_url: event.avatar_url,
                  recipient_status_message: event.status_message,
                }
              : c,
          ),
        )
      },
    }).then((control) => {
      if (!active) {
        control.close()
        return
      }
      socketControlRef.current = control
      if (selectedConversationId) {
        control.subscribe(selectedConversationId)
        control.sendRead(selectedConversationId)
      }
    })
    return () => {
      active = false
      socketControlRef.current?.close()
      socketControlRef.current = null
    }
  }, [user, selectedConversationId])

  // Periodic cleanup of expired typing indicators
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setTypingUsers((current) => {
        let changed = false
        const next: Record<string, { username: string; expiresAt: number }> = {}
        for (const [id, info] of Object.entries(current)) {
          if (info.expiresAt > now) {
            next[id] = info
          } else {
            changed = true
          }
        }
        return changed ? next : current
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])

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
    if (!selectedConversationId || (!content && pendingAttachments.length === 0) || sending) return

    // Clear typing indicator on send
    if (isTypingRef.current && selectedConversationId) {
      isTypingRef.current = false
      socketControlRef.current?.sendTyping(selectedConversationId, false)
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)

    setSending(true)
    setMessagesError('')
    try {
      let message: Message
      const textToSend = content || (pendingAttachments.length > 0 ? pendingAttachments.map((a) => a.filename).join(', ') : '[Attachment]')
      const replyId = replyingTo?.id || null
      const attachmentsToSend = [...pendingAttachments]

      if (conversationAesKey) {
        const { ciphertext, nonce } = await encryptMessage(textToSend, conversationAesKey)
        message = await sendMessage(
          selectedConversationId,
          ciphertext,
          nonce,
          true,
          replyId,
          attachmentsToSend,
        )
        setDecryptedCache((current) => ({ ...current, [message.id]: textToSend }))
      } else {
        message = await sendMessage(
          selectedConversationId,
          textToSend,
          null,
          false,
          replyId,
          attachmentsToSend,
        )
      }

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
      setPendingAttachments([])
      setReplyingTo(null)
    } catch (error) {
      setMessagesError(error instanceof ApiError ? error.message : 'Unable to send message.')
    } finally {
      setSending(false)
    }
  }

  async function handleAttachmentSelect(file: File) {
    if (!selectedConversationId) return
    if (file.size > 15 * 1024 * 1024) {
      setMessagesError('File is too large (maximum 15MB)')
      return
    }
    setUploadingAttachment(true)
    setMessagesError('')
    try {
      const att = await uploadAttachment(selectedConversationId, file)
      setPendingAttachments((prev) => [...prev, att])
    } catch (error) {
      setMessagesError(error instanceof ApiError ? error.message : 'Failed to upload attachment.')
    } finally {
      setUploadingAttachment(false)
    }
  }

  async function handleToggleReaction(message: Message, emoji: string) {
    if (!user || !selectedConversationId) return
    // Optimistic UI update
    setMessages((current) =>
      current.map((m) => {
        if (m.id !== message.id) return m
        const rx = { ...(m.reactions || {}) }
        const currentUsers = rx[emoji] ? [...rx[emoji]] : []
        if (currentUsers.includes(user.id)) {
          const filtered = currentUsers.filter((id) => id !== user.id)
          if (filtered.length === 0) delete rx[emoji]
          else rx[emoji] = filtered
        } else {
          rx[emoji] = [...currentUsers, user.id]
        }
        return { ...m, reactions: rx }
      }),
    )

    try {
      const updatedReactions = await toggleReaction(selectedConversationId, message.id, emoji)
      setMessages((current) =>
        current.map((m) => (m.id === message.id ? { ...m, reactions: updatedReactions } : m)),
      )
    } catch {
      // Revert is handled automatically on next socket/REST refresh
    }
  }

  function startEditing(message: Message) {
    setEditingMessageId(message.id)
    const currentText = message.is_encrypted
      ? decryptedCache[message.id] || message.content
      : message.content
    setEditDraft(currentText)
  }

  async function handleSaveEdit(message: Message) {
    if (!selectedConversationId || !editDraft.trim()) return
    try {
      let updated: Message
      if (message.is_encrypted && conversationAesKey) {
        const { ciphertext, nonce } = await encryptMessage(editDraft.trim(), conversationAesKey)
        updated = await editMessage(selectedConversationId, message.id, ciphertext, nonce, true)
        setDecryptedCache((prev) => ({ ...prev, [message.id]: editDraft.trim() }))
      } else {
        updated = await editMessage(selectedConversationId, message.id, editDraft.trim())
      }
      setMessages((current) => current.map((m) => (m.id === updated.id ? updated : m)))
      setEditingMessageId(null)
      setEditDraft('')
    } catch (error) {
      setMessagesError(error instanceof ApiError ? error.message : 'Unable to edit message.')
    }
  }

  async function handleDeleteMessage(message: Message) {
    if (!selectedConversationId) return
    if (!window.confirm('Are you sure you want to delete this message?')) return
    try {
      await deleteMessage(selectedConversationId, message.id)
      setDecryptedCache((prev) => {
        const next = { ...prev }
        delete next[message.id]
        return next
      })
      setMessages((current) =>
        current.map((m) =>
          m.id === message.id
            ? {
                ...m,
                is_deleted: true,
                content: '[This message was deleted]',
                nonce: null,
                is_encrypted: false,
                attachments: [],
                reactions: {},
              }
            : m,
        ),
      )
    } catch (error) {
      setMessagesError(error instanceof ApiError ? error.message : 'Unable to delete message.')
    }
  }

  function openProfileModal() {
    if (!user) return
    setProfileAvatarUrl(user.avatar_url || '')
    setProfileStatusMessage(user.status_message || '')
    setProfileError('')
    setProfileSuccess('')
    setProfileModalOpen(true)
  }

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault()
    if (!user) return
    setProfileSaving(true)
    setProfileError('')
    setProfileSuccess('')
    try {
      const updated = await updateUserProfile({
        avatar_url: profileAvatarUrl.trim() || null,
        status_message: profileStatusMessage.trim() || null,
      })
      setUser(updated)
      setProfileSuccess('Profile updated successfully!')
      setTimeout(() => setProfileModalOpen(false), 1200)
    } catch (error) {
      setProfileError(error instanceof ApiError ? error.message : 'Unable to update profile.')
    } finally {
      setProfileSaving(false)
    }
  }

  async function handleAvatarUpload(file: File) {
    if (!user) return
    if (file.size > 5 * 1024 * 1024) {
      setProfileError('Avatar image must be smaller than 5MB')
      return
    }
    setProfileUploadingAvatar(true)
    setProfileError('')
    try {
      const updated = await uploadAvatar(file)
      setUser(updated)
      setProfileAvatarUrl(updated.avatar_url || '')
      setProfileSuccess('Avatar uploaded successfully!')
    } catch (error) {
      setProfileError(error instanceof ApiError ? error.message : 'Failed to upload avatar.')
    } finally {
      setProfileUploadingAvatar(false)
    }
  }

  function handleDraftChange(value: string) {
    setDraft(value)
    if (!selectedConversationId) return

    if (value.trim().length > 0) {
      if (!isTypingRef.current) {
        isTypingRef.current = true
        socketControlRef.current?.sendTyping(selectedConversationId, true)
      }
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = window.setTimeout(() => {
        isTypingRef.current = false
        if (selectedConversationId) {
          socketControlRef.current?.sendTyping(selectedConversationId, false)
        }
      }, 2500)
    } else {
      if (isTypingRef.current) {
        isTypingRef.current = false
        socketControlRef.current?.sendTyping(selectedConversationId, false)
      }
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    }
  }

  if (authLoading) {
    return <main className="flex min-h-screen items-center justify-center bg-[#0b1020] text-sm text-slate-400">Restoring session...</main>
  }

  if (!user) {
    return <LandingPage onAuthenticated={setUser} />
  }

  const directPartnerMember = selectedConversation?.kind === 'direct'
    ? members.find((m) => m.user_id !== user.id)
    : null
  const directPartner = directPartnerMember?.username || selectedConversation?.recipient_username || null
  const directPartnerAvatarUrl = directPartnerMember?.avatar_url ?? selectedConversation?.recipient_avatar_url ?? null
  const directPartnerStatus = directPartnerMember?.status_message ?? selectedConversation?.recipient_status_message ?? null
  const isDirectPartnerOnline = directPartnerMember
    ? onlineUserIds.has(directPartnerMember.user_id)
    : selectedConversation?.recipient_id
    ? onlineUserIds.has(selectedConversation.recipient_id)
    : false

  const activeTypingNames = Object.values(typingUsers)
    .filter((u) => Date.now() < u.expiresAt)
    .map((u) => u.username)

  const activeChannelTitle = selectedConversation
    ? selectedConversation.kind === 'direct'
      ? directPartner ? `@${directPartner}` : `Direct ${selectedConversation.id.slice(-6)}`
      : selectedConversation.title || `Group ${selectedConversation.id.slice(-6)}`
    : 'No conversation'

  return (
    <div className="relative min-h-screen bg-[#070b14] text-slate-100 overflow-hidden">
      {/* Cyber Ambient Glowing Orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/4 h-[450px] w-[450px] rounded-full bg-emerald-500/10 blur-[130px]" />
        <div className="absolute top-1/2 -right-32 h-[500px] w-[500px] rounded-full bg-cyan-500/10 blur-[150px]" />
        <div className="absolute bottom-0 left-1/3 h-[400px] w-[400px] rounded-full bg-indigo-500/10 blur-[140px]" />
        <div className="absolute inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:28px_28px] opacity-20" />
      </div>

      <div className="relative flex min-h-screen z-10">
        <aside className="w-20 border-r border-white/[0.08] bg-[#090e1a]/85 backdrop-blur-xl p-3 flex flex-col justify-between">
          <div>
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 border border-emerald-500/30 p-1.5 shadow-[0_0_15px_rgba(16,185,129,0.2)]">
              <img src="/shadow-chat-logo.png" alt="Shadow Chat" className="h-full w-full object-contain" />
            </div>
            <nav className="space-y-3">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  className={`flex w-full items-center justify-center rounded-xl px-2 py-3 text-xs font-medium transition ${
                    item.active
                      ? 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm'
                      : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-100'
                  }`}
                  type="button"
                >
                  {item.label.charAt(0)}
                  {item.badge ? (
                    <span className="ml-1 rounded-full bg-emerald-500 px-1.5 text-[10px] text-slate-950 font-bold">{item.badge}</span>
                  ) : null}
                </button>
              ))}
            </nav>
          </div>
        </aside>

        <aside className="w-72 border-r border-white/[0.08] bg-[#0b1220]/75 backdrop-blur-xl p-4">
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
              {conversations.map((conversation) => {
                const isSelected = conversation.id === selectedConversationId
                const isDirect = conversation.kind === 'direct'
                const partnerName = conversation.recipient_username || (conversation.title ? conversation.title.replace(/^@/, '') : null)
                const isPartnerOnline = conversation.recipient_id ? onlineUserIds.has(conversation.recipient_id) : false

                return (
                  <button
                    key={conversation.id}
                    onClick={() => setSelectedConversationId(conversation.id)}
                    type="button"
                    className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-sm transition ${
                      isSelected ? 'bg-slate-800 text-white font-medium shadow-sm' : 'text-slate-300 hover:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
                      {isDirect ? (
                        <UserAvatar
                          username={partnerName || 'User'}
                          avatarUrl={conversation.recipient_avatar_url}
                          size="sm"
                          isOnline={isPartnerOnline}
                        />
                      ) : (
                        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/20 text-[11px] font-bold text-emerald-400 border border-emerald-500/30">
                          #
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-semibold text-slate-200">
                            {isDirect
                              ? (partnerName ? `@${partnerName}` : `Direct ${conversation.id.slice(-6)}`)
                              : (conversation.title || `Group ${conversation.id.slice(-6)}`)}
                          </span>
                        </div>
                        {isDirect && conversation.recipient_status_message ? (
                          <p className="truncate text-[10px] text-slate-400 font-normal">
                            {conversation.recipient_status_message}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </button>
                )
              })}
              {conversationError ? <p className="text-sm text-rose-300">{conversationError}</p> : null}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-[#0b1220]">
          <header className="flex items-center justify-between border-b border-slate-800 bg-[#0d1424]/80 px-6 py-3 backdrop-blur-sm">
            <div className="flex items-center gap-3 min-w-0">
              {selectedConversation ? (
                selectedConversation.kind === 'direct' ? (
                  <UserAvatar
                    username={directPartner || 'User'}
                    avatarUrl={directPartnerAvatarUrl}
                    size="md"
                    isOnline={isDirectPartnerOnline}
                  />
                ) : (
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold text-sm">
                    #
                  </div>
                )
              ) : null}

              <div className="min-w-0">
                <h1 className="text-base font-semibold text-white flex items-center gap-2">
                  <span className="truncate">{activeChannelTitle}</span>
                  {selectedConversation?.kind === 'direct' ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-normal">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          isDirectPartnerOnline
                            ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                            : 'bg-slate-600'
                        }`}
                      />
                      <span className={isDirectPartnerOnline ? 'text-emerald-400 text-xs' : 'text-slate-500 text-xs'}>
                        {isDirectPartnerOnline ? 'Online' : 'Offline'}
                      </span>
                    </span>
                  ) : selectedConversation?.kind === 'group' ? (
                    <span className="text-xs text-slate-400 font-normal">
                      • {members.filter((m) => onlineUserIds.has(m.user_id)).length} online
                    </span>
                  ) : null}
                </h1>
                {selectedConversation ? (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    {selectedConversation.kind === 'direct' && directPartnerStatus ? (
                      <span className="truncate max-w-sm text-slate-300 font-normal">
                        {directPartnerStatus}
                      </span>
                    ) : (
                      <span>ID: {selectedConversation.id.slice(-8)}</span>
                    )}
                  </div>
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

              {conversationAesKey ? (
                <button
                  type="button"
                  onClick={() => setSafetyModalOpen(true)}
                  title="End-to-End Encrypted. Click to verify Safety Number."
                  className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/40 bg-teal-500/10 px-3 py-1 text-xs font-medium text-teal-300 hover:bg-teal-500/20 transition cursor-pointer"
                >
                  <span className="text-xs">🔒</span>
                  <span>E2EE Active</span>
                </button>
              ) : selectedConversation?.kind === 'direct' ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1 text-xs text-slate-400">
                  <span className="text-xs">🔓</span>
                  <span>Syncing Keys...</span>
                </span>
              ) : null}

              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                {socketStatus === 'connected' ? 'Live connected' : 'Live reconnecting'}
              </span>

              {/* User Profile Pill button */}
              <div className="flex items-center gap-2 border-l border-slate-800 pl-3">
                <button
                  type="button"
                  onClick={openProfileModal}
                  title="Click to view & edit your profile"
                  className="flex items-center gap-2.5 rounded-xl border border-slate-800 bg-slate-900/80 px-2.5 py-1 text-left transition hover:border-emerald-500/40 hover:bg-slate-800 cursor-pointer"
                >
                  <UserAvatar
                    username={user.username}
                    avatarUrl={user.avatar_url}
                    size="sm"
                    isOnline={true}
                  />
                  <div className="hidden sm:block text-left">
                    <span className="block text-xs font-semibold text-slate-200">@{user.username}</span>
                    <span className="block max-w-[110px] truncate text-[10px] text-slate-400">
                      {user.status_message || 'Set status'}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400">⚙️</span>
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-slate-800 px-3 py-1.5 text-xs text-slate-400 hover:border-slate-700 hover:bg-slate-800 hover:text-slate-200 transition cursor-pointer"
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
                  const isDeleted = Boolean(message.is_deleted)
                  const isEdited = Boolean(message.is_edited)
                  const isEditing = editingMessageId === message.id
                  const displayContent = isDeleted
                    ? 'This message was deleted'
                    : message.is_encrypted
                    ? decryptedCache[message.id] || '[Decrypting...]'
                    : message.content

                  return (
                    <div
                      key={message.id}
                      className={`group relative flex ${isSelf ? 'justify-end' : 'justify-start'}`}
                    >
                      {/* Floating Action Bar on Hover */}
                      {!isDeleted && (
                        <div
                          className={`absolute -top-3.5 ${
                            isSelf ? 'right-2' : 'left-2'
                          } z-10 flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/95 px-2 py-0.5 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 backdrop-blur-sm`}
                        >
                          {(['👍', '❤️', '😂', '🔥', '🎉'] as const).map((emoji) => (
                            <button
                              key={emoji}
                              type="button"
                              title={`React ${emoji}`}
                              onClick={() => void handleToggleReaction(message, emoji)}
                              className="text-xs hover:scale-125 transition-transform px-0.5 cursor-pointer"
                            >
                              {emoji}
                            </button>
                          ))}
                          <div className="h-3 w-px bg-slate-700 mx-0.5" />
                          <button
                            type="button"
                            title="Reply"
                            onClick={() => setReplyingTo(message)}
                            className="text-slate-400 hover:text-emerald-400 text-xs px-1 cursor-pointer"
                          >
                            ↩️
                          </button>
                          {isSelf && (
                            <>
                              <button
                                type="button"
                                title="Edit"
                                onClick={() => startEditing(message)}
                                className="text-slate-400 hover:text-teal-400 text-xs px-1 cursor-pointer"
                              >
                                ✏️
                              </button>
                              <button
                                type="button"
                                title="Delete"
                                onClick={() => void handleDeleteMessage(message)}
                                className="text-slate-400 hover:text-rose-400 text-xs px-1 cursor-pointer"
                              >
                                🗑️
                              </button>
                            </>
                          )}
                        </div>
                      )}

                      <div
                        className={`max-w-xl rounded-2xl border px-4 py-3 shadow-soft backdrop-blur-md transition-all ${
                          isDeleted
                            ? 'border-white/5 bg-slate-900/30 text-slate-500'
                            : isSelf
                            ? 'border-emerald-500/30 bg-gradient-to-br from-emerald-500/15 via-emerald-500/10 to-teal-500/10 text-emerald-50 shadow-[0_4px_20px_rgba(16,185,129,0.08)]'
                            : 'border-white/[0.08] bg-[#0c1322]/85 text-slate-100 shadow-[0_4px_20px_rgba(0,0,0,0.3)]'
                        }`}
                      >
                        {/* Quoted Reply Banner */}
                        {message.reply_to && !isDeleted ? (
                          <div className="mb-2 rounded-lg border-l-2 border-emerald-400/80 bg-slate-800/70 px-2.5 py-1 text-xs">
                            <span className="font-semibold text-emerald-300">
                              @{message.reply_to.sender_username || 'Member'}
                            </span>
                            <p className="truncate text-slate-400 mt-0.5">
                              {message.reply_to.content}
                            </p>
                          </div>
                        ) : null}

                        <div className="mb-1 flex items-center justify-between gap-4 text-[11px] text-slate-400">
                          <div className="flex items-center gap-1.5">
                            <UserAvatar
                              username={isSelf ? user.username : (senderMember?.username || 'User')}
                              avatarUrl={isSelf ? user.avatar_url : senderMember?.avatar_url}
                              size="sm"
                              isOnline={senderMember ? onlineUserIds.has(senderMember.user_id) : isSelf ? true : undefined}
                            />
                            <span className="font-semibold text-slate-300 uppercase tracking-[0.18em] text-[11px]">{senderLabel}</span>
                          </div>
                          <span className="flex items-center gap-1.5 lowercase">
                            {isEdited && !isDeleted ? (
                              <span className="text-[10px] text-slate-500 font-normal italic tracking-normal">(edited)</span>
                            ) : null}
                            <span>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            {isSelf && !isDeleted ? (
                              message.status === 'read' ? (
                                <span className="text-teal-400 font-bold text-xs tracking-tighter" title="Read">✓✓</span>
                              ) : message.status === 'delivered' ? (
                                <span className="text-slate-400 font-medium text-xs tracking-tighter" title="Delivered">✓✓</span>
                              ) : (
                                <span className="text-slate-500 font-medium text-xs" title="Sent">✓</span>
                              )
                            ) : null}
                          </span>
                        </div>

                        {/* Content or Inline Edit Form */}
                        {isEditing ? (
                          <div className="mt-2 flex flex-col gap-2">
                            <textarea
                              value={editDraft}
                              onChange={(e) => setEditDraft(e.target.value)}
                              className="w-full rounded-lg border border-slate-700 bg-slate-950/80 p-2.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                              rows={2}
                            />
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setEditingMessageId(null)}
                                className="rounded px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleSaveEdit(message)}
                                className="rounded bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        ) : isDeleted ? (
                          <p className="text-sm italic text-slate-500 flex items-center gap-1.5">
                            <span className="text-xs">🚫</span>
                            <span>This message was deleted</span>
                          </p>
                        ) : (
                          <p className="text-sm leading-6 whitespace-pre-wrap break-words">{displayContent}</p>
                        )}

                        {/* Attachments Section */}
                        {message.attachments && message.attachments.length > 0 && !isDeleted ? (
                          <div className="mt-2.5 flex flex-wrap gap-2">
                            {message.attachments.map((att) => {
                              const isImg = att.content_type.startsWith('image/')
                              const fileUrl = getAttachmentFileUrl(att.url)
                              if (isImg) {
                                return (
                                  <button
                                    key={att.id}
                                    type="button"
                                    onClick={() => setPreviewImageUrl(fileUrl)}
                                    className="group/img relative overflow-hidden rounded-xl border border-slate-700/80 max-w-[240px] max-h-[180px] cursor-pointer hover:border-emerald-500/50 transition"
                                  >
                                    <img
                                      src={fileUrl}
                                      alt={att.filename}
                                      className="object-cover w-full h-full transition group-hover/img:scale-105"
                                    />
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition flex items-center justify-center text-white text-xs font-medium">
                                      🔍 Expand
                                    </div>
                                  </button>
                                )
                              }
                              return (
                                <a
                                  key={att.id}
                                  href={fileUrl}
                                  download={att.filename}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700/80 transition"
                                >
                                  <span className="text-base">📄</span>
                                  <div className="text-left">
                                    <div className="font-medium truncate max-w-[180px]">{att.filename}</div>
                                    <div className="text-[10px] text-slate-400">
                                      {(att.size_bytes / 1024).toFixed(1)} KB
                                    </div>
                                  </div>
                                  <span className="text-xs text-emerald-400 ml-1">⬇</span>
                                </a>
                              )
                            })}
                          </div>
                        ) : null}

                        {/* Emoji Reaction Badges */}
                        {message.reactions && Object.keys(message.reactions).length > 0 && !isDeleted ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {Object.entries(message.reactions).map(([emoji, userIds]) => {
                              const hasReacted = userIds.includes(user.id)
                              return (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={() => void handleToggleReaction(message, emoji)}
                                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition cursor-pointer ${
                                    hasReacted
                                      ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300 font-medium'
                                      : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700'
                                  }`}
                                >
                                  <span>{emoji}</span>
                                  <span className="text-[11px]">{userIds.length}</span>
                                </button>
                              )
                            })}
                          </div>
                        ) : null}

                        {message.is_encrypted && !isDeleted ? (
                          <div className="mt-1.5 flex items-center justify-end gap-1 text-[10px] text-teal-400/90 font-medium">
                            <span>🔒 E2EE</span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Ephemeral Typing Indicators Banner */}
              {activeTypingNames.length > 0 ? (
                <div className="flex items-center gap-2 border-t border-slate-800/80 bg-[#0c1322] px-6 py-2 text-xs text-teal-300">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-bounce" />
                    <span className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-bounce [animation-delay:0.15s]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-bounce [animation-delay:0.3s]" />
                  </div>
                  <span className="italic">
                    {activeTypingNames.join(', ')} {activeTypingNames.length === 1 ? 'is' : 'are'} typing...
                  </span>
                </div>
              ) : null}

              {/* Message Draft Input Area */}
              <div className="border-t border-white/[0.08] bg-[#090e1a]/85 p-4 backdrop-blur-xl">
                {/* Replying Banner */}
                {replyingTo ? (
                  <div className="flex items-center justify-between rounded-t-2xl bg-white/[0.04] px-4 py-2.5 text-xs text-slate-300 border border-b-0 border-white/10 backdrop-blur-md">
                    <span className="flex items-center gap-1.5 truncate">
                      <span className="text-emerald-400 font-medium">↩ Replying to</span>
                      <span className="font-semibold text-slate-200">
                        @{members.find((m) => m.user_id === replyingTo.sender_id)?.username || 'User'}
                      </span>
                      <span className="truncate text-slate-400 max-w-[280px]">
                        — {replyingTo.is_encrypted ? decryptedCache[replyingTo.id] || '[Encrypted]' : replyingTo.content}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setReplyingTo(null)}
                      className="text-slate-400 hover:text-white ml-2 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                ) : null}

                {/* Pending Attachments List */}
                {pendingAttachments.length > 0 ? (
                  <div className="flex flex-wrap gap-2 px-3 py-2 bg-white/[0.03] border border-b-0 border-white/10 rounded-t-2xl backdrop-blur-md">
                    {pendingAttachments.map((att) => (
                      <div
                        key={att.id}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-800/80 px-2.5 py-1 text-xs text-slate-300"
                      >
                        <span>📎</span>
                        <span className="truncate max-w-[160px]">{att.filename}</span>
                        <span className="text-[10px] text-slate-400">
                          ({(att.size_bytes / 1024).toFixed(0)} KB)
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setPendingAttachments((prev) => prev.filter((item) => item.id !== att.id))
                          }
                          className="ml-1 text-slate-400 hover:text-rose-400 font-bold"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div
                  className={`flex items-center gap-3 border border-white/10 bg-white/[0.03] backdrop-blur-md px-3.5 py-3 focus-within:border-emerald-500/50 focus-within:bg-white/[0.06] focus-within:shadow-[0_0_25px_rgba(16,185,129,0.15)] transition-all ${
                    replyingTo || pendingAttachments.length > 0 ? 'rounded-b-2xl' : 'rounded-2xl'
                  }`}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        void handleAttachmentSelect(file)
                        e.target.value = ''
                      }
                    }}
                  />
                  <button
                    onClick={() => {
                      setCreateError('')
                      setCreateModalOpen(true)
                    }}
                    type="button"
                    title="Create new conversation"
                    className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-slate-200 hover:bg-white/10 hover:text-white transition"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!selectedConversationId || uploadingAttachment}
                    title="Attach file or image (max 15MB)"
                    className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-slate-300 hover:bg-white/10 hover:text-white disabled:opacity-50 transition"
                  >
                    {uploadingAttachment ? '⏳' : '📎'}
                  </button>
                  <input
                    value={draft}
                    onChange={(event) => handleDraftChange(event.target.value)}
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
                    disabled={!selectedConversationId || (!draft.trim() && pendingAttachments.length === 0) || sending}
                    type="button"
                    className="rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 px-5 py-2 text-sm font-semibold text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.35)] hover:shadow-[0_0_25px_rgba(16,185,129,0.5)] transition hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
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
                      className="flex items-center justify-between rounded-xl bg-slate-900/70 p-2.5 text-xs border border-slate-800/60"
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <UserAvatar
                          username={member.username}
                          avatarUrl={member.avatar_url}
                          size="sm"
                          isOnline={onlineUserIds.has(member.user_id)}
                        />
                        <div className="truncate min-w-0 flex-1 text-left">
                          <p className="truncate text-slate-200 font-medium">
                            @{member.username} {member.user_id === user.id ? '(You)' : ''}
                          </p>
                          {member.status_message ? (
                            <p className="truncate text-[10px] text-slate-400">
                              {member.status_message}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ml-2 flex-shrink-0 ${
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xl">
          <div className="w-full max-w-md rounded-3xl border border-white/[0.12] bg-[#0c1322]/85 p-6 shadow-[0_20px_70px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xl">
          <div className="w-full max-w-md rounded-3xl border border-white/[0.12] bg-[#0c1322]/85 p-6 shadow-[0_20px_70px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
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

      {/* Safety Number / Fingerprint Modal */}
      {safetyModalOpen && safetyNumber ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xl p-4">
          <div className="w-full max-w-md rounded-3xl border border-white/[0.12] bg-[#0c1322]/85 p-6 shadow-[0_20px_70px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">🔒</span>
                <h2 className="text-lg font-semibold text-white">E2EE Safety Number</h2>
              </div>
              <button
                type="button"
                onClick={() => setSafetyModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <p className="mt-4 text-xs text-slate-400 leading-relaxed">
              Verify that your end-to-end encryption is authentic and secure. Compare this safety number with the other participant. If the numbers match on both screens, your conversation cannot be intercepted or modified by anyone, including the server.
            </p>
            <div className="mt-5 rounded-xl border border-teal-500/30 bg-teal-500/10 p-4 text-center font-mono text-base font-semibold tracking-wider text-teal-300">
              {safetyNumber}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setSafetyModalOpen(false)}
                className="rounded-lg bg-teal-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-teal-400 transition"
              >
                Close & Confirm Verified
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Image Preview Lightbox Modal */}
      {previewImageUrl ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 cursor-pointer"
          onClick={() => setPreviewImageUrl(null)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setPreviewImageUrl(null)}
              className="absolute -top-10 right-0 text-white hover:text-emerald-400 text-sm font-semibold transition"
            >
              ✕ Close
            </button>
            <img
              src={previewImageUrl}
              alt="Attachment preview"
              className="max-h-[85vh] max-w-[85vw] rounded-xl object-contain shadow-2xl border border-slate-700"
            />
          </div>
        </div>
      ) : null}

      {/* User Profile Settings Modal */}
      {profileModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xl">
          <div className="w-full max-w-lg rounded-3xl border border-white/[0.12] bg-[#0c1322]/85 p-6 shadow-[0_20px_70px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div className="flex items-center gap-2.5">
                <span className="text-xl">👤</span>
                <div>
                  <h2 className="text-lg font-semibold text-white">Profile Settings</h2>
                  <p className="text-xs text-slate-400">Manage your avatar, status, and identity</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setProfileModalOpen(false)}
                className="text-slate-400 hover:text-white text-base"
              >
                ✕
              </button>
            </div>

            {profileSuccess ? (
              <p className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                {profileSuccess}
              </p>
            ) : null}
            {profileError ? (
              <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {profileError}
              </p>
            ) : null}

            <form onSubmit={handleSaveProfile} className="mt-5 space-y-5">
              {/* Avatar Preview & Upload */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Avatar
                </label>
                <div className="flex items-center gap-4">
                  <UserAvatar
                    username={user.username}
                    avatarUrl={profileAvatarUrl}
                    size="lg"
                    isOnline={true}
                  />
                  <div className="space-y-2 flex-1">
                    <input
                      type="file"
                      ref={avatarInputRef}
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          void handleAvatarUpload(file)
                          e.target.value = ''
                        }
                      }}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={profileUploadingAvatar}
                        onClick={() => avatarInputRef.current?.click()}
                        className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50 transition"
                      >
                        {profileUploadingAvatar ? 'Uploading...' : 'Upload Image'}
                      </button>
                      {profileAvatarUrl ? (
                        <button
                          type="button"
                          onClick={() => setProfileAvatarUrl('')}
                          className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 hover:text-rose-300 transition"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-slate-500">Max size 5MB (PNG, JPG, WebP, GIF)</p>
                  </div>
                </div>

                {/* Avatar Presets */}
                <div className="mt-3">
                  <p className="text-[11px] text-slate-400 mb-1.5">Or choose a preset style:</p>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { name: 'Ninja', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=ninja' },
                      { name: 'Agent', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=agent' },
                      { name: 'Cyber', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=cyber' },
                      { name: 'Shadow', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=shadow' },
                      { name: 'Ghost', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=ghost' },
                    ].map((preset) => (
                      <button
                        key={preset.name}
                        type="button"
                        onClick={() => setProfileAvatarUrl(preset.url)}
                        className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                          profileAvatarUrl === preset.url
                            ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                            : 'border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Status Message */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                  Custom Status Message
                </label>
                <input
                  type="text"
                  maxLength={140}
                  value={profileStatusMessage}
                  onChange={(e) => setProfileStatusMessage(e.target.value)}
                  placeholder="e.g. ⚡ Coding in stealth mode"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[
                    '⚡ Active & coding',
                    '🥷 In stealth mode',
                    '☕ AFK',
                    '🎧 Focused with tunes',
                    '🚀 Shipping features',
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setProfileStatusMessage(preset)}
                      className="rounded-full border border-slate-800 bg-slate-900/60 px-2.5 py-0.5 text-[11px] text-slate-400 hover:border-slate-700 hover:text-slate-200 transition"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Account Overview */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 space-y-2 text-xs">
                <div className="flex justify-between items-center text-slate-300">
                  <span className="text-slate-400">Username:</span>
                  <span className="font-semibold text-white">@{user.username}</span>
                </div>
                <div className="flex justify-between items-center text-slate-300">
                  <span className="text-slate-400">Email:</span>
                  <span className="flex items-center gap-1.5 font-medium text-slate-200">
                    {user.email}
                    <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.2 text-[10px] text-emerald-400 border border-emerald-500/30">
                      ✓ Verified
                    </span>
                  </span>
                </div>
                <div className="flex justify-between items-center text-slate-300">
                  <span className="text-slate-400">E2EE Identity:</span>
                  <span className="text-teal-400 font-mono text-[11px]">
                    {myPublicKeySpki ? 'SPKI Key Active' : 'Generating...'}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setProfileModalOpen(false)}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={profileSaving}
                  className="rounded-lg bg-emerald-500 px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition"
                >
                  {profileSaving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  )
}
