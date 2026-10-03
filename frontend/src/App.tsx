import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  calculateSafetyNumber,
  decryptMessage,
  deriveConversationKey,
  encryptMessage,
  exportPublicKeySpki,
  getOrGenerateIdentityKeyPair,
  importPublicKeySpki,
  clearConversationKeyCache,
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
  deleteConversation,
  parseOAuthUrlParams,
} from './lib/api'
import type {
  Attachment,
  Conversation,
  ConversationMember,
  Message,
  User,
  UserSummary,
} from './types'
import LandingPage from './LandingPage'
import {
  SmileIcon,
  ReplyIcon,
  PencilIcon,
  TrashIcon,
  CopyIcon,
  PaperclipIcon,
  SendIcon,
  SparklesIcon,
  BellIcon,
  BellSlashIcon,
  Volume2Icon,
  VolumeXIcon,
  AtSignIcon,
  CheckIcon,
  DoubleCheckIcon,
  CloseIcon,
} from './components/Icons'
import {
  playNotificationSound,
  requestNotificationPermission,
  showDesktopNotification,
  getSmartSentenceSuggestions,
} from './lib/notifications'



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
  const [imgError, setImgError] = useState(false)
  const sizeClasses = {
    sm: 'h-6 w-6 text-[10px]',
    md: 'h-8 w-8 text-xs',
    lg: 'h-12 w-12 text-base',
  }[size]

  useEffect(() => {
    setImgError(false)
  }, [avatarUrl])

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
  const fullAvatarUrl = avatarUrl && !imgError ? getAttachmentFileUrl(avatarUrl) : null

  return (
    <div className="relative inline-flex flex-shrink-0">
      {fullAvatarUrl ? (
        <img
          src={fullAvatarUrl}
          alt={username}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className={`${sizeClasses} rounded-full object-cover border border-slate-700/80 shadow-inner`}
        />
      ) : (
        <div
          className={`${sizeClasses} rounded-full bg-gradient-to-br ${gradient} flex items-center justify-center font-bold text-white shadow-inner uppercase tracking-wider select-none`}
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

function formatDiscordTimestamp(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const isYesterday = d.toDateString() === yesterday.toDateString()
    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

    if (isToday) return `Today at ${timeStr}`
    if (isYesterday) return `Yesterday at ${timeStr}`
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeStr}`
  } catch {
    return dateStr
  }
}

function FormattedMessageText({
  content,
  currentUsername,
  onMentionClick,
}: {
  content: string
  currentUsername?: string
  onMentionClick?: (username: string) => void
}) {
  const mentionRegex = /(@everyone|@all|@[a-zA-Z0-9_-]+)/g
  const parts = content.split(mentionRegex)

  return (
    <span>
      {parts.map((part, index) => {
        if (part === '@everyone' || part === '@all') {
          return (
            <span
              key={index}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30"
              title="Notifies all members in this conversation"
            >
              {part}
            </span>
          )
        }
        if (part.startsWith('@') && part.length > 1) {
          const uname = part.slice(1)
          const isCurrentUser = currentUsername && uname.toLowerCase() === currentUsername.toLowerCase()
          return (
            <button
              key={index}
              type="button"
              onClick={() => onMentionClick?.(uname)}
              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold transition ${
                isCurrentUser
                  ? 'bg-emerald-500/30 text-emerald-200 border border-emerald-500/50 font-bold'
                  : 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 border border-indigo-500/30 cursor-pointer'
              }`}
            >
              {part}
            </button>
          )
        }
        return <span key={index}>{part}</span>
      })}
    </span>
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
  const [activeCategory, setActiveCategory] = useState<'all' | 'direct' | 'group'>('all')
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [oauthConfigNeeded, setOauthConfigNeeded] = useState<string | null>(null)

  // Notifications & Sound State
  const [audioEnabled, setAudioEnabled] = useState<boolean>(() => {
    return localStorage.getItem('shadow_audio_enabled') !== 'false'
  })
  const [desktopNotifications, setDesktopNotifications] = useState<NotificationPermission>(() => {
    return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied'
  })
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({})

  // Mentions, Autocomplete & Smart Sentences State
  const [smartSentencesOpen, setSmartSentencesOpen] = useState(true)
  const [activeReactionPickerMsgId, setActiveReactionPickerMsgId] = useState<string | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Synchronization Refs for WebSocket Events
  const selectedConversationIdRef = useRef(selectedConversationId)
  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId
  }, [selectedConversationId])

  const conversationsRef = useRef(conversations)
  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  const userRef = useRef(user)
  useEffect(() => {
    userRef.current = user
  }, [user])

  const audioEnabledRef = useRef(audioEnabled)
  useEffect(() => {
    audioEnabledRef.current = audioEnabled
  }, [audioEnabled])

  // Update window title on unread count change
  useEffect(() => {
    const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0)
    if (totalUnread > 0) {
      document.title = `(${totalUnread}) Shadow Chat`
    } else {
      document.title = 'Shadow Chat'
    }
  }, [unreadCounts])

  // Helper to mark conversation read and wipe its unread badge
  const clearCurrentUnreads = (convId = selectedConversationId) => {
    if (!convId) return
    setUnreadCounts((prev) => {
      if (!prev[convId]) return prev
      const next = { ...prev }
      delete next[convId]
      return next
    })
    void markMessagesRead(convId).catch(() => {})
  }

  // Clear unreads when switching to conversation
  useEffect(() => {
    if (selectedConversationId) {
      clearCurrentUnreads(selectedConversationId)
    }
  }, [selectedConversationId])

  // Clear unreads when returning to tab or window focus
  useEffect(() => {
    const handleFocusOrVisible = () => {
      if (!document.hidden && selectedConversationId) {
        clearCurrentUnreads(selectedConversationId)
      }
    }

    window.addEventListener('focus', handleFocusOrVisible)
    document.addEventListener('visibilitychange', handleFocusOrVisible)
    return () => {
      window.removeEventListener('focus', handleFocusOrVisible)
      document.removeEventListener('visibilitychange', handleFocusOrVisible)
    }
  }, [selectedConversationId])

  // Clear unreads whenever active conversation messages update while viewing
  useEffect(() => {
    if (!document.hidden && selectedConversationId && messages.length > 0) {
      clearCurrentUnreads(selectedConversationId)
    }
  }, [messages.length, selectedConversationId])

  useEffect(() => {
    const oauth = parseOAuthUrlParams()
    if (oauth.authError) {
      setOauthError(oauth.authError)
    }
    if (oauth.oauthConfigNeeded) {
      setOauthConfigNeeded(oauth.oauthConfigNeeded)
    }
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

  // Proactively fetch & verify latest peer public key whenever direct conversation is selected
  useEffect(() => {
    if (!selectedConversation || selectedConversation.kind !== 'direct' || !user) return
    const peer = members.find((m) => m.user_id !== user.id)
    if (!peer?.user_id) return
    let active = true
    getUserPublicKey(peer.user_id).then((freshKey) => {
      if (active && freshKey && freshKey !== peer.public_key) {
        setMembers((prev) =>
          prev.map((m) => (m.user_id === peer.user_id ? { ...m, public_key: freshKey } : m)),
        )
        clearConversationKeyCache(selectedConversation.id)
      }
    }).catch(() => {})
    return () => {
      active = false
    }
  }, [selectedConversation?.id, user?.id])

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
            deriveConversationKey(myKeyPair.privateKey, peerPubKey, selectedConversation.id, peerKeySpki),
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

  // Decrypt encrypted messages with auto-recovery on key rotation
  useEffect(() => {
    if (!conversationAesKey || messages.length === 0) return
    let active = true
    const toDecrypt = messages.filter(
      (m) => m.is_encrypted && m.nonce && (!decryptedCache[m.id] || decryptedCache[m.id] === '[Unable to decrypt: key mismatch]'),
    )
    if (toDecrypt.length === 0) return

    Promise.all(
      toDecrypt.map(async (m) => {
        try {
          const text = await decryptMessage(m.content, m.nonce!, conversationAesKey)
          return { id: m.id, text }
        } catch {
          // If direct decryption failed with current key, check if sender's public key was rotated
          if (m.sender_id && myKeyPair && selectedConversation) {
            try {
              const freshKey = await getUserPublicKey(m.sender_id)
              if (freshKey) {
                const importedKey = await importPublicKeySpki(freshKey)
                const freshAesKey = await deriveConversationKey(
                  myKeyPair.privateKey,
                  importedKey,
                  selectedConversation.id,
                  freshKey,
                )
                const text = await decryptMessage(m.content, m.nonce!, freshAesKey)
                if (active) {
                  setConversationAesKey(freshAesKey)
                  setMembers((prev) =>
                    prev.map((mem) => (mem.user_id === m.sender_id ? { ...mem, public_key: freshKey } : mem)),
                  )
                }
                return { id: m.id, text }
              }
            } catch {
              // fall through to mismatch error
            }
          }
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
  }, [messages, conversationAesKey, decryptedCache, myKeyPair, selectedConversation])


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
          if (selectedConversationIdRef.current !== message.conversation_id) return current
          return [...current, message].sort(
            (left, right) =>
              new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
          )
        })

        // Real-Time Notification Logic
        if (userRef.current && message.sender_id !== userRef.current.id) {
          const isMention =
            message.content.includes('@everyone') ||
            message.content.includes('@all') ||
            Boolean(userRef.current.username && message.content.includes(`@${userRef.current.username}`))

          // Audio chime
          if (audioEnabledRef.current) {
            playNotificationSound(isMention)
          }

          // Desktop notification & unread counters if background or different conversation
          const isBackground = document.hidden || selectedConversationIdRef.current !== message.conversation_id
          if (isBackground) {
            setUnreadCounts((prev) => ({
              ...prev,
              [message.conversation_id]: (prev[message.conversation_id] || 0) + 1,
            }))

            const conv = conversationsRef.current.find((c) => c.id === message.conversation_id)
            const senderName = message.sender_username || (conv?.kind === 'direct' ? conv.recipient_username : null) || 'Someone'
            const convTitle = conv?.kind === 'direct' ? `@${senderName}` : conv?.title || 'channel'

            const notifTitle = isMention
              ? `@${senderName} mentioned you in #${convTitle}`
              : `@${senderName} in #${convTitle}`

            const notifBody = message.is_encrypted
              ? '🔒 Encrypted message'
              : message.content.length > 90
              ? message.content.slice(0, 90) + '...'
              : message.content

            showDesktopNotification(notifTitle, {
              body: notifBody,
              onClick: () => {
                setSelectedConversationId(message.conversation_id)
              },
            })
          }
        }

        if (selectedConversationIdRef.current === message.conversation_id) {
          socketControlRef.current?.sendRead(message.conversation_id)
          void markMessagesRead(message.conversation_id).catch(() => {})
          if (!document.hidden) {
            setUnreadCounts((prev) => {
              if (!prev[message.conversation_id]) return prev
              const next = { ...prev }
              delete next[message.conversation_id]
              return next
            })
          }
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
      onConversationDeleted: (event) => {
        if (!active) return
        setConversations((current) => current.filter((c) => c.id !== event.conversation_id))
        setSelectedConversationId((current) => (current === event.conversation_id ? null : current))
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
        title: createTitle.trim() || 'Stealth Group',
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

  async function handleResyncKeys() {
    if (!selectedConversation || selectedConversation.kind !== 'direct' || !user || !myKeyPair) return
    const peer = members.find((m) => m.user_id !== user.id)
    if (!peer?.user_id) return

    try {
      clearConversationKeyCache(selectedConversation.id)
      const freshKey = await getUserPublicKey(peer.user_id)
      if (freshKey) {
        const imported = await importPublicKeySpki(freshKey)
        const newAes = await deriveConversationKey(
          myKeyPair.privateKey,
          imported,
          selectedConversation.id,
          freshKey,
        )
        setConversationAesKey(newAes)
        setMembers((prev) =>
          prev.map((m) => (m.user_id === peer.user_id ? { ...m, public_key: freshKey } : m)),
        )
        const safety = await calculateSafetyNumber(myPublicKeySpki || '', freshKey)
        setSafetyNumber(safety)
      }
      if (myPublicKeySpki) {
        void uploadPublicKey(myPublicKeySpki).catch(() => {})
      }
      // Reset failed cache entries to trigger immediate re-decryption
      setDecryptedCache((prev) => {
        const next = { ...prev }
        for (const m of messages) {
          if (next[m.id] === '[Unable to decrypt: key mismatch]') {
            delete next[m.id]
          }
        }
        return next
      })
    } catch (err) {
      console.error('Failed to resync keys:', err)
    }
  }

  async function handleSend() {
    const content = draft.trim()
    if (!selectedConversationId || (!content && pendingAttachments.length === 0) || sending) return
    clearCurrentUnreads(selectedConversationId)

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

  async function handleDeleteConversation(convId: string, event?: React.MouseEvent) {
    if (event) event.stopPropagation()
    const conv = conversations.find((c) => c.id === convId)
    const label =
      conv?.kind === 'direct'
        ? conv.recipient_username
          ? `@${conv.recipient_username}`
          : 'this direct chat'
        : conv?.title || `Group ${convId.slice(-6)}`

    if (!window.confirm(`Are you sure you want to remove or leave ${label}?`)) return

    setDeletingConversationId(convId)
    try {
      await deleteConversation(convId)
      setConversations((prev) => prev.filter((c) => c.id !== convId))
      setSelectedConversationId((prev) => (prev === convId ? null : prev))
      if (selectedConversationId === convId) {
        setMessages([])
      }
    } catch (err: any) {
      setConversationError(err?.message || 'Failed to remove conversation')
    } finally {
      setDeletingConversationId(null)
    }
  }

  function handleDraftChange(value: string, selectionStart?: number) {
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

    const cursorPos = selectionStart !== undefined ? selectionStart : value.length
    const textBeforeCursor = value.slice(0, cursorPos)
    const match = textBeforeCursor.match(/@([a-zA-Z0-9_-]*)$/)
    if (match) {
      setMentionQuery(match[1])
      setMentionIndex(0)
    } else {
      setMentionQuery(null)
    }
  }

  function handleCopyMessageText(text: string, msgId: string) {
    void navigator.clipboard.writeText(text)
    setCopiedMessageId(msgId)
    setTimeout(() => setCopiedMessageId(null), 2000)
  }

  function applySmartSentence(sentence: string) {
    setDraft(sentence)
    setMentionQuery(null)
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }

  function selectMentionCandidate(candidate: { name: string }) {
    if (inputRef.current) {
      const cursorPos = inputRef.current.selectionStart || draft.length
      const textBeforeCursor = draft.slice(0, cursorPos)
      const textAfterCursor = draft.slice(cursorPos)
      const atIndex = textBeforeCursor.lastIndexOf('@')
      if (atIndex !== -1) {
        const newText = textBeforeCursor.slice(0, atIndex) + `@${candidate.name} ` + textAfterCursor
        setDraft(newText)
        setMentionQuery(null)
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus()
            const newPos = atIndex + candidate.name.length + 2
            inputRef.current.setSelectionRange(newPos, newPos)
          }
        }, 10)
        return
      }
    }
    setDraft((prev) => `${prev}@${candidate.name} `)
    setMentionQuery(null)
  }

  const directPartnerMember = selectedConversation?.kind === 'direct'
    ? members.find((m) => m.user_id !== user?.id)
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

  const directConversations = conversations.filter((c) => c.kind === 'direct')
  const groupConversations = conversations.filter((c) => c.kind === 'group')

  const filteredDirect = directConversations.filter((c) => {
    if (!chatSearchQuery.trim()) return true
    const q = chatSearchQuery.trim().toLowerCase()
    const name = c.recipient_username?.toLowerCase() || ''
    const title = c.title?.toLowerCase() || ''
    return name.includes(q) || title.includes(q)
  })

  const filteredGroups = groupConversations.filter((c) => {
    if (!chatSearchQuery.trim()) return true
    const q = chatSearchQuery.trim().toLowerCase()
    const title = c.title?.toLowerCase() || ''
    return title.includes(q)
  })

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null || !selectedConversation) return []
    const q = mentionQuery.toLowerCase()
    const list: {
      id: string
      name: string
      desc: string
      isSpecial?: boolean
      avatarUrl?: string | null
      isOnline?: boolean
    }[] = []

    if (selectedConversation.kind === 'group') {
      if ('everyone'.startsWith(q)) {
        list.push({ id: 'everyone', name: 'everyone', desc: 'Notify everyone in channel', isSpecial: true })
      }
      if ('all'.startsWith(q)) {
        list.push({ id: 'all', name: 'all', desc: 'Notify all channel members', isSpecial: true })
      }
      for (const m of members) {
        if (user && m.user_id === user.id) continue
        if (m.username.toLowerCase().startsWith(q)) {
          list.push({
            id: m.user_id,
            name: m.username,
            desc: m.status_message || 'Channel member',
            avatarUrl: m.avatar_url,
            isOnline: onlineUserIds.has(m.user_id),
          })
        }
      }
    } else {
      if (directPartner && directPartner.toLowerCase().startsWith(q)) {
        list.push({
          id: selectedConversation.recipient_id || 'partner',
          name: directPartner,
          desc: directPartnerStatus || 'Direct chat partner',
          avatarUrl: directPartnerAvatarUrl,
          isOnline: isDirectPartnerOnline,
        })
      }
    }
    return list
  }, [mentionQuery, selectedConversation, members, user, onlineUserIds, directPartner, directPartnerStatus, directPartnerAvatarUrl, isDirectPartnerOnline])

  const smartSuggestions = useMemo(() => {
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null
    const lastContent = lastMsg && !lastMsg.is_deleted ? (lastMsg.is_encrypted ? decryptedCache[lastMsg.id] : lastMsg.content) : null
    return getSmartSentenceSuggestions(lastContent)
  }, [messages, decryptedCache])

  const totalUnreadDirect = directConversations.reduce((sum, c) => sum + (unreadCounts[c.id] || 0), 0)
  const totalUnreadGroup = groupConversations.reduce((sum, c) => sum + (unreadCounts[c.id] || 0), 0)

  if (authLoading) {
    return <main className="flex min-h-screen items-center justify-center bg-[#0b1020] text-sm text-slate-400">Restoring session...</main>
  }

  if (!user) {
    return (
      <LandingPage
        onAuthenticated={setUser}
        initialError={oauthError}
        initialOAuthConfigNeeded={oauthConfigNeeded}
      />
    )
  }

  return (
    <div className="relative min-h-screen bg-[#070b14] text-slate-100 overflow-hidden">
      {/* Cyber Ambient Glowing Orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/4 h-[550px] w-[550px] rounded-full bg-gradient-to-tr from-emerald-500/25 via-teal-400/20 to-cyan-500/25 blur-[140px]" />
        <div className="absolute top-1/3 -right-32 h-[600px] w-[600px] rounded-full bg-gradient-to-bl from-cyan-500/25 via-blue-500/15 to-purple-600/25 blur-[160px]" />
        <div className="absolute bottom-0 left-1/4 h-[500px] w-[500px] rounded-full bg-gradient-to-tr from-purple-600/20 via-fuchsia-500/15 to-emerald-500/20 blur-[140px]" />
        <div className="absolute inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:28px_28px] opacity-20" />
      </div>

      <div className="relative flex min-h-screen z-10">
        {/* Left Rail (Navigation & Category Tabs) */}
        <aside className="w-20 border-r border-white/10 bg-[#090e1a]/60 backdrop-blur-2xl p-3 flex flex-col justify-between shadow-[4px_0_24px_rgba(0,0,0,0.3)]">
          <div>
            <div className="mb-6 relative group flex items-center justify-center">
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-emerald-500/30 via-teal-400/40 to-cyan-500/30 opacity-75 blur-md group-hover:opacity-100 transition duration-300" />
              <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.08] backdrop-blur-xl border border-white/20 border-t-white/40 shadow-[0_4px_16px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.3)]">
                <img
                  src="/shadow-chat-3d-glass.png"
                  alt="Shadow Chat"
                  className="h-10 w-10 object-contain drop-shadow-[0_4px_10px_rgba(45,212,191,0.5)] transform group-hover:scale-110 transition duration-300"
                />
              </div>
            </div>

            {/* Filter Navigation Tabs */}
            <nav className="space-y-2">
              <button
                onClick={() => setActiveCategory('all')}
                type="button"
                title="All Conversations"
                className={`flex w-full flex-col items-center justify-center rounded-xl p-2.5 text-xs font-medium transition cursor-pointer ${
                  activeCategory === 'all'
                    ? 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-300 border border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
                    : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                }`}
              >
                <span className="text-base">💬</span>
                <span className="mt-1 text-[11px] font-semibold">All</span>
                {conversations.length > 0 ? (
                  <span className="mt-0.5 rounded-full bg-emerald-500/30 border border-emerald-500/50 px-1.5 text-[9px] text-emerald-200 font-bold">
                    {conversations.length}
                  </span>
                ) : null}
              </button>

              <button
                onClick={() => setActiveCategory('direct')}
                type="button"
                title="Direct Messages"
                className={`flex w-full flex-col items-center justify-center rounded-xl p-2.5 text-xs font-medium transition cursor-pointer ${
                  activeCategory === 'direct'
                    ? 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-300 border border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
                    : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                }`}
              >
                <span className="text-base">👤</span>
                <span className="mt-1 text-[11px] font-semibold">Direct</span>
                {totalUnreadDirect > 0 ? (
                  <span className="mt-0.5 rounded-full bg-emerald-500 px-1.5 text-[9px] text-slate-950 font-bold shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse">
                    {totalUnreadDirect}
                  </span>
                ) : directConversations.length > 0 ? (
                  <span className="mt-0.5 rounded-full bg-emerald-500/30 border border-emerald-500/50 px-1.5 text-[9px] text-emerald-200 font-bold">
                    {directConversations.length}
                  </span>
                ) : null}
              </button>

              <button
                onClick={() => setActiveCategory('group')}
                type="button"
                title="Group Channels"
                className={`flex w-full flex-col items-center justify-center rounded-xl p-2.5 text-xs font-medium transition cursor-pointer ${
                  activeCategory === 'group'
                    ? 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-300 border border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
                    : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                }`}
              >
                <span className="text-base">👥</span>
                <span className="mt-1 text-[11px] font-semibold">Groups</span>
                {totalUnreadGroup > 0 ? (
                  <span className="mt-0.5 rounded-full bg-emerald-500 px-1.5 text-[9px] text-slate-950 font-bold shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse">
                    {totalUnreadGroup}
                  </span>
                ) : groupConversations.length > 0 ? (
                  <span className="mt-0.5 rounded-full bg-emerald-500/30 border border-emerald-500/50 px-1.5 text-[9px] text-emerald-200 font-bold">
                    {groupConversations.length}
                  </span>
                ) : null}
              </button>
            </nav>
          </div>

          {/* Left Rail Bottom User & Settings */}
          <div className="flex flex-col items-center gap-2 pt-3 border-t border-white/10">
            <button
              type="button"
              onClick={openProfileModal}
              title={`@${user.username} - Edit Profile`}
              className="group relative flex items-center justify-center rounded-xl p-1 transition hover:bg-white/[0.08] cursor-pointer"
            >
              <UserAvatar
                username={user.username}
                avatarUrl={user.avatar_url}
                size="sm"
                isOnline={true}
              />
            </button>
            <button
              type="button"
              onClick={openProfileModal}
              title="Profile & Settings"
              className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition text-sm cursor-pointer"
            >
              ⚙️
            </button>
            <button
              type="button"
              onClick={async () => {
                await logout()
                setUser(null)
              }}
              title="Log out"
              className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition text-sm cursor-pointer"
            >
              🚪
            </button>
          </div>
        </aside>

        {/* Dynamic Secondary Sidebar */}
        <aside className="w-80 border-r border-white/10 bg-[#0b1220]/50 backdrop-blur-2xl p-4 flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.2)]">
          {/* Header */}
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">Shadow Chat</h2>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">
                  E2EE
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {conversations.length} active {conversations.length === 1 ? 'chat' : 'chats'}
              </p>
            </div>
            <button
              onClick={() => {
                setCreateError('')
                setCreateModalOpen(true)
              }}
              type="button"
              className="flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/25 hover:border-emerald-500/60 shadow-[0_0_12px_rgba(16,185,129,0.25)] cursor-pointer"
            >
              <span>+</span> New
            </button>
          </div>

          {/* Search Box */}
          <div className="mb-3 relative">
            <input
              type="text"
              placeholder="Search conversations..."
              value={chatSearchQuery}
              onChange={(e) => setChatSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 pl-8 pr-7 text-xs text-slate-200 placeholder-slate-500 backdrop-blur-md focus:border-emerald-500/50 focus:bg-white/[0.07] focus:outline-none transition"
            />
            <span className="absolute left-2.5 top-2.5 text-xs text-slate-500 pointer-events-none">🔍</span>
            {chatSearchQuery ? (
              <button
                type="button"
                onClick={() => setChatSearchQuery('')}
                className="absolute right-2 top-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                ✕
              </button>
            ) : null}
          </div>

          {/* Conversations Scrollable List */}
          <div className="space-y-4 overflow-y-auto flex-1 pr-1 custom-scrollbar">
            {conversationLoading ? (
              <div className="py-6 text-center text-xs text-slate-500">
                <span className="inline-block animate-pulse">Loading conversations...</span>
              </div>
            ) : null}

            {conversationError ? (
              <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                {conversationError}
              </p>
            ) : null}

            {/* Empty state when user has 0 conversations */}
            {!conversationLoading && conversations.length === 0 ? (
              <div className="my-auto flex flex-col items-center justify-center p-4 text-center rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shadow-[0_0_16px_rgba(16,185,129,0.2)]">
                  <span className="text-xl">🛡️</span>
                </div>
                <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">No Active Chats</h3>
                <p className="mt-1 text-[11px] text-slate-400">
                  Your chat list is clean and private. Click below to start your first encrypted chat.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setCreateError('')
                    setCreateModalOpen(true)
                  }}
                  className="mt-3.5 rounded-xl border border-emerald-500/40 bg-emerald-500/20 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.25)] cursor-pointer"
                >
                  + Start Chat
                </button>
              </div>
            ) : null}

            {/* Empty search results */}
            {!conversationLoading && conversations.length > 0 && filteredDirect.length === 0 && filteredGroups.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                No chats matching &quot;{chatSearchQuery}&quot;
              </div>
            ) : null}

            {/* Direct Messages Section */}
            {(activeCategory === 'all' || activeCategory === 'direct') && filteredDirect.length > 0 ? (
              <div>
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Direct Messages ({filteredDirect.length})
                  </span>
                </div>
                <div className="space-y-1">
                  {filteredDirect.map((conversation) => {
                    const isSelected = conversation.id === selectedConversationId
                    const partnerName = conversation.recipient_username || (conversation.title ? conversation.title.replace(/^@/, '') : null)
                    const isPartnerOnline = conversation.recipient_id ? onlineUserIds.has(conversation.recipient_id) : false

                    return (
                      <div
                        key={conversation.id}
                        className={`group relative flex items-center justify-between rounded-xl px-2.5 py-2 text-sm transition-all ${
                          isSelected
                            ? 'border border-emerald-500/40 border-t-emerald-400/60 bg-gradient-to-r from-emerald-500/20 via-teal-500/15 to-transparent text-white font-medium shadow-[inset_0_1px_1px_rgba(255,255,255,0.2)] backdrop-blur-xl'
                            : 'border border-transparent text-slate-300 hover:border-white/10 hover:bg-white/[0.05]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedConversationId(conversation.id)}
                          className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                        >
                          <UserAvatar
                            username={partnerName || 'User'}
                            avatarUrl={conversation.recipient_avatar_url}
                            size="sm"
                            isOnline={isPartnerOnline}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between">
                              <span className="truncate block text-xs font-semibold text-slate-200">
                                {partnerName ? `@${partnerName}` : `Direct ${conversation.id.slice(-6)}`}
                              </span>
                              {unreadCounts[conversation.id] > 0 ? (
                                <span className="ml-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-slate-950 shadow-[0_0_8px_rgba(16,185,129,0.5)]">
                                  {unreadCounts[conversation.id]}
                                </span>
                              ) : null}
                            </div>
                            {conversation.recipient_status_message ? (
                              <p className="truncate text-[10px] text-slate-400 font-normal">
                                {conversation.recipient_status_message}
                              </p>
                            ) : null}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => handleDeleteConversation(conversation.id, e)}
                          title="Delete / close direct chat"
                          disabled={deletingConversationId === conversation.id}
                          className="opacity-0 group-hover:opacity-100 rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 transition duration-150 cursor-pointer ml-1"
                        >
                          {deletingConversationId === conversation.id ? (
                            <span className="text-[10px]">⏳</span>
                          ) : (
                            <TrashIcon className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {/* Group Channels Section */}
            {(activeCategory === 'all' || activeCategory === 'group') && filteredGroups.length > 0 ? (
              <div>
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Group Channels ({filteredGroups.length})
                  </span>
                </div>
                <div className="space-y-1">
                  {filteredGroups.map((conversation) => {
                    const isSelected = conversation.id === selectedConversationId
                    const displayTitle = conversation.title || `Group ${conversation.id.slice(-6)}`

                    return (
                      <div
                        key={conversation.id}
                        className={`group relative flex items-center justify-between rounded-xl px-2.5 py-2 text-sm transition-all ${
                          isSelected
                            ? 'border border-emerald-500/40 border-t-emerald-400/60 bg-gradient-to-r from-emerald-500/20 via-teal-500/15 to-transparent text-white font-medium shadow-[inset_0_1px_1px_rgba(255,255,255,0.2)] backdrop-blur-xl'
                            : 'border border-transparent text-slate-300 hover:border-white/10 hover:bg-white/[0.05]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedConversationId(conversation.id)}
                          className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                        >
                          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 text-[12px] font-bold text-emerald-400 border border-emerald-500/30">
                            #
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between">
                              <span className="truncate block text-xs font-semibold text-slate-200">
                                {displayTitle}
                              </span>
                              {unreadCounts[conversation.id] > 0 ? (
                                <span className="ml-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-slate-950 shadow-[0_0_8px_rgba(16,185,129,0.5)]">
                                  {unreadCounts[conversation.id]}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => handleDeleteConversation(conversation.id, e)}
                          title="Leave or delete group"
                          disabled={deletingConversationId === conversation.id}
                          className="opacity-0 group-hover:opacity-100 rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 transition duration-150 cursor-pointer ml-1"
                        >
                          {deletingConversationId === conversation.id ? (
                            <span className="text-[10px]">⏳</span>
                          ) : (
                            <TrashIcon className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-[#070b14]/40 backdrop-blur-md">
          <header className="flex items-center justify-between border-b border-white/10 bg-[#0d1424]/60 px-6 py-3.5 backdrop-blur-2xl shadow-sm">
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

              {selectedConversation ? (
                <button
                  type="button"
                  onClick={() => handleDeleteConversation(selectedConversation.id)}
                  title={selectedConversation.kind === 'direct' ? 'Delete direct chat' : 'Leave / delete group'}
                  disabled={deletingConversationId === selectedConversation.id}
                  className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 hover:border-rose-500/50 flex items-center gap-1.5 cursor-pointer"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">
                    {selectedConversation.kind === 'direct' ? 'Delete Chat' : 'Leave Group'}
                  </span>
                </button>
              ) : null}

              {/* Desktop Notification Bell Toggle */}
              <button
                type="button"
                onClick={async () => {
                  if (desktopNotifications === 'default') {
                    const res = await requestNotificationPermission()
                    setDesktopNotifications(res)
                  } else if (desktopNotifications === 'granted') {
                    alert('Desktop notifications are active. You will receive notifications when new messages or mentions arrive.')
                  } else {
                    alert('Desktop notifications are currently blocked by browser permissions. Please enable notifications in your browser settings to receive alerts.')
                  }
                }}
                title={
                  desktopNotifications === 'granted'
                    ? 'Desktop Notifications: Active'
                    : desktopNotifications === 'denied'
                    ? 'Desktop Notifications: Blocked in Browser'
                    : 'Click to Enable Desktop Notifications'
                }
                className="relative rounded-lg border border-slate-800 bg-slate-900/80 p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
              >
                {desktopNotifications === 'granted' ? (
                  <>
                    <BellIcon className="w-4 h-4 text-emerald-400" />
                    <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                  </>
                ) : (
                  <BellSlashIcon className="w-4 h-4 text-slate-400" />
                )}
              </button>

              {/* Audio Chime Mute/Unmute Toggle */}
              <button
                type="button"
                onClick={() => {
                  const next = !audioEnabled
                  setAudioEnabled(next)
                  localStorage.setItem('shadow_audio_enabled', String(next))
                  if (next) playNotificationSound(false)
                }}
                title={audioEnabled ? 'Sound Alerts: Enabled (click to mute)' : 'Sound Alerts: Muted (click to enable)'}
                className="rounded-lg border border-slate-800 bg-slate-900/80 p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
              >
                {audioEnabled ? (
                  <Volume2Icon className="w-4 h-4 text-emerald-400" />
                ) : (
                  <VolumeXIcon className="w-4 h-4 text-slate-500" />
                )}
              </button>

              {conversationAesKey ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSafetyModalOpen(true)}
                    title="End-to-End Encrypted. Click to verify Safety Number."
                    className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/40 bg-teal-500/10 px-3 py-1 text-xs font-medium text-teal-300 hover:bg-teal-500/20 transition cursor-pointer"
                  >
                    <span className="text-xs">🔒</span>
                    <span>E2EE Active</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleResyncKeys()}
                    title="Re-sync encryption keys with partner"
                    className="inline-flex items-center justify-center h-6 w-6 rounded-full border border-slate-700 bg-slate-800/80 text-slate-400 hover:text-emerald-300 hover:border-emerald-500/40 transition cursor-pointer text-xs"
                  >
                    🔄
                  </button>
                </div>
              ) : selectedConversation?.kind === 'direct' ? (
                <button
                  type="button"
                  onClick={() => void handleResyncKeys()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/20 transition cursor-pointer"
                  title="Click to re-sync encryption keys"
                >
                  <span className="text-xs">🔄</span>
                  <span>Sync Keys</span>
                </button>
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
            {!selectedConversation ? (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center bg-[#070b14]/30 backdrop-blur-sm">
                <div className="relative mb-6 flex h-24 w-24 items-center justify-center rounded-3xl bg-white/[0.05] border border-white/10 shadow-[0_12px_40px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.2)] backdrop-blur-2xl">
                  <div className="absolute -inset-2 rounded-3xl bg-emerald-500/20 blur-xl opacity-60 animate-pulse [animation-duration:4s]" />
                  <img
                    src="/shadow-chat-3d-glass.png"
                    alt="Shadow Chat"
                    className="relative h-14 w-14 object-contain drop-shadow-[0_4px_16px_rgba(45,212,191,0.6)]"
                  />
                </div>
                <h2 className="text-2xl font-bold text-white tracking-tight">Shadow Chat Encrypted Mesh</h2>
                <p className="mt-2 text-sm text-slate-400 max-w-md leading-relaxed">
                  Decentralized-style end-to-end encryption with WebCrypto AES-GCM &amp; ECDH. Your communications are completely stealth, tamper-proof, and ephemeral.
                </p>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setCreateError('')
                      setCreateKind('direct')
                      setCreateModalOpen(true)
                    }}
                    className="flex items-center gap-2 rounded-2xl border border-emerald-500/40 bg-gradient-to-r from-emerald-500/20 to-teal-500/20 px-5 py-2.5 text-sm font-semibold text-emerald-300 shadow-[0_0_20px_rgba(16,185,129,0.3)] backdrop-blur-xl transition hover:brightness-110 cursor-pointer"
                  >
                    <span>👤</span> New Direct Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreateError('')
                      setCreateKind('group')
                      setCreateModalOpen(true)
                    }}
                    className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-5 py-2.5 text-sm font-semibold text-slate-200 shadow-sm backdrop-blur-xl transition hover:bg-white/[0.1] hover:border-white/20 cursor-pointer"
                  >
                    <span>👥</span> New Group Channel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col bg-[#11141c]">
                <div className="border-b border-slate-800 bg-[#0d1017] px-6 py-2 text-xs text-slate-400 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 inline-block" />
                    <span>{backendStatus}</span>
                  </div>
                  {selectedConversation ? (
                    <span className="text-slate-500">
                      Channel #{activeChannelTitle} • Created {new Date(selectedConversation.created_at).toLocaleDateString()}
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4 space-y-1.5 custom-scrollbar">
                  {messagesError ? <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{messagesError}</p> : null}
                  {messagesLoading && messages.length === 0 ? <p className="text-sm text-slate-500 text-center py-8">Loading messages...</p> : null}
                  {!messagesLoading && messages.length === 0 ? (
                    <div className="m-auto text-center py-12">
                      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-800/80 border border-slate-700 text-slate-300 text-2xl font-bold">
                        #
                      </div>
                      <p className="text-base text-slate-200 font-semibold">Welcome to #{activeChannelTitle}!</p>
                      <p className="mt-1 text-xs text-slate-400">This is the start of the #{activeChannelTitle} channel. Send a message to begin.</p>
                    </div>
                  ) : null}
                  {hasOlderMessages ? (
                    <div className="text-center py-2">
                      <button onClick={() => void loadOlderMessages()} className="text-xs text-emerald-400 hover:underline cursor-pointer" type="button">
                        Load older messages
                      </button>
                    </div>
                  ) : null}

                  {messages.map((message) => {
                    const isSelf = message.sender_id === user.id
                    const senderMember = members.find((m) => m.user_id === message.sender_id)
                    const senderName = message.sender_username || senderMember?.username || (isSelf ? user.username : 'Member')
                    const senderAvatar = message.sender_avatar_url || senderMember?.avatar_url || (isSelf ? user.avatar_url : null)
                    const isSenderOnline = senderMember ? onlineUserIds.has(senderMember.user_id) : isSelf ? true : false
                    const isDeleted = Boolean(message.is_deleted)
                    const isEdited = Boolean(message.is_edited)
                    const isEditing = editingMessageId === message.id
                    const displayContent = isDeleted
                      ? 'This message was deleted'
                      : message.is_encrypted
                      ? decryptedCache[message.id] || '[Decrypting...]'
                      : message.content

                    // Check if message mentions current user or @everyone / @all
                    const isMentioned = !isSelf && !isDeleted && (
                      displayContent.includes('@everyone') ||
                      displayContent.includes('@all') ||
                      Boolean(user.username && displayContent.includes(`@${user.username}`))
                    )

                    return (
                      <div
                        key={message.id}
                        className={`group relative flex items-start gap-3.5 px-3 py-2 transition-colors rounded-lg ${
                          isMentioned
                            ? 'bg-amber-500/[0.08] hover:bg-amber-500/[0.12] border-l-2 border-amber-400 pl-3'
                            : 'hover:bg-slate-800/40'
                        }`}
                      >
                        {/* Avatar on Left */}
                        <UserAvatar
                          username={senderName}
                          avatarUrl={senderAvatar}
                          size="md"
                          isOnline={isSenderOnline}
                        />

                        {/* Right: Message Details */}
                        <div className="flex-1 min-w-0">
                          {/* Quoted Reply Banner */}
                          {message.reply_to && !isDeleted ? (
                            <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1 pl-2 border-l-2 border-slate-600">
                              <ReplyIcon className="w-3 h-3 text-slate-500" />
                              <span className="font-semibold text-emerald-300">
                                @{message.reply_to.sender_username || 'Member'}
                              </span>
                              <span className="truncate text-slate-400 max-w-md">
                                {message.reply_to.content}
                              </span>
                            </div>
                          ) : null}

                          {/* Header: Name + Timestamp + Badges */}
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-semibold text-white hover:underline cursor-pointer">
                              {senderName}
                              {isSelf ? <span className="ml-1 text-[11px] font-normal text-slate-400">(You)</span> : null}
                            </span>
                            <span className="text-[11px] text-slate-400 font-normal">
                              {formatDiscordTimestamp(message.created_at)}
                            </span>
                            {isEdited && !isDeleted ? (
                              <span className="text-[10px] text-slate-500 italic">(edited)</span>
                            ) : null}
                            {message.is_encrypted && !isDeleted ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-mono text-teal-400/90 rounded bg-teal-500/10 px-1 py-0.5 border border-teal-500/20">
                                🔒 E2EE
                              </span>
                            ) : null}
                            {isSelf && !isDeleted ? (
                              message.status === 'read' ? (
                                <span className="text-teal-400 flex items-center" title="Read">
                                  <DoubleCheckIcon className="w-3.5 h-3.5" />
                                </span>
                              ) : message.status === 'delivered' ? (
                                <span className="text-slate-400 flex items-center" title="Delivered">
                                  <DoubleCheckIcon className="w-3.5 h-3.5" />
                                </span>
                              ) : (
                                <span className="text-slate-500 flex items-center" title="Sent">
                                  <CheckIcon className="w-3.5 h-3.5" />
                                </span>
                              )
                            ) : null}
                          </div>

                          {/* Message Body or Inline Edit Form */}
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
                                  className="rounded px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleSaveEdit(message)}
                                  className="rounded bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          ) : isDeleted ? (
                            <p className="mt-1 text-sm italic text-slate-500 flex items-center gap-1.5">
                              <span>🚫</span>
                              <span>This message was deleted</span>
                            </p>
                          ) : displayContent === '[Unable to decrypt: key mismatch]' ? (
                            <div className="mt-1 inline-flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
                              <span>🔒 Key updated</span>
                              <button
                                type="button"
                                onClick={() => void handleResyncKeys()}
                                className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 font-semibold text-amber-200 hover:bg-amber-500/30 transition cursor-pointer"
                              >
                                <span>🔄 Re-sync Keys</span>
                              </button>
                            </div>
                          ) : (
                            <div className="mt-0.5 text-sm text-slate-200 leading-relaxed break-words whitespace-pre-wrap">
                              <FormattedMessageText
                                content={displayContent}
                                currentUsername={user.username}
                                onMentionClick={(uname) => {
                                  setDraft((prev) => `${prev}@${uname} `)
                                  inputRef.current?.focus()
                                }}
                              />
                            </div>
                          )}

                          {/* Attachments Section */}
                          {message.attachments && message.attachments.length > 0 && !isDeleted ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {message.attachments.map((att) => {
                                const isImg = att.content_type.startsWith('image/')
                                const fileUrl = getAttachmentFileUrl(att.url)
                                if (isImg) {
                                  return (
                                    <button
                                      key={att.id}
                                      type="button"
                                      onClick={() => setPreviewImageUrl(fileUrl)}
                                      className="group/img relative overflow-hidden rounded-xl border border-slate-700/80 max-w-[280px] max-h-[200px] cursor-pointer hover:border-emerald-500/50 transition"
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
                                    <PaperclipIcon className="w-4 h-4 text-emerald-400" />
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

                          {/* Reaction Badges */}
                          {message.reactions && Object.keys(message.reactions).length > 0 && !isDeleted ? (
                            <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                              {Object.entries(message.reactions).map(([emoji, userIds]) => {
                                const hasReacted = userIds.includes(user.id)
                                return (
                                  <button
                                    key={emoji}
                                    type="button"
                                    onClick={() => void handleToggleReaction(message, emoji)}
                                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition cursor-pointer ${
                                      hasReacted
                                        ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300 font-medium'
                                        : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700'
                                    }`}
                                  >
                                    <span>{emoji}</span>
                                    <span className="text-[11px] font-semibold">{userIds.length}</span>
                                  </button>
                                )
                              })}
                              <button
                                type="button"
                                onClick={() => setActiveReactionPickerMsgId(activeReactionPickerMsgId === message.id ? null : message.id)}
                                className="rounded-md border border-slate-700/60 bg-slate-800/40 hover:bg-slate-700/60 text-slate-400 hover:text-slate-200 px-1.5 py-0.5 text-xs transition cursor-pointer"
                                title="Add reaction"
                              >
                                +
                              </button>
                            </div>
                          ) : null}
                        </div>

                        {/* Floating Action Bar on Hover */}
                        {!isDeleted && (
                          <div className="absolute right-4 -top-3.5 z-20 hidden group-hover:flex items-center gap-0.5 rounded-lg border border-slate-700 bg-slate-900/95 px-1 py-0.5 shadow-xl backdrop-blur-md">
                            {/* Reaction Picker Button */}
                            <div className="relative">
                              <button
                                type="button"
                                title="Add Reaction"
                                onClick={() => setActiveReactionPickerMsgId(activeReactionPickerMsgId === message.id ? null : message.id)}
                                className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-400 transition cursor-pointer"
                              >
                                <SmileIcon className="w-4 h-4" />
                              </button>

                              {/* Reaction Picker Popover */}
                              {activeReactionPickerMsgId === message.id && (
                                <div className="absolute right-0 bottom-full mb-1 flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur-md z-30">
                                  {(['👍', '❤️', '😂', '🔥', '🎉', '🚀', '👀', '💯', '👏', '💡'] as const).map((emoji) => (
                                    <button
                                      key={emoji}
                                      type="button"
                                      onClick={() => {
                                        void handleToggleReaction(message, emoji)
                                        setActiveReactionPickerMsgId(null)
                                      }}
                                      className="hover:scale-125 transition-transform p-1 text-sm cursor-pointer"
                                    >
                                      {emoji}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Reply Button */}
                            <button
                              type="button"
                              title="Reply"
                              onClick={() => {
                                setReplyingTo(message)
                                inputRef.current?.focus()
                              }}
                              className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-400 transition cursor-pointer"
                            >
                              <ReplyIcon className="w-4 h-4" />
                            </button>

                            {/* Copy Message Text */}
                            <button
                              type="button"
                              title="Copy Text"
                              onClick={() => handleCopyMessageText(displayContent, message.id)}
                              className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition cursor-pointer"
                            >
                              {copiedMessageId === message.id ? (
                                <CheckIcon className="w-4 h-4 text-emerald-400" />
                              ) : (
                                <CopyIcon className="w-4 h-4" />
                              )}
                            </button>

                            {/* Edit & Delete (Self only) */}
                            {isSelf && (
                              <>
                                <div className="h-3 w-px bg-slate-700 mx-0.5" />
                                <button
                                  type="button"
                                  title="Edit Message"
                                  onClick={() => startEditing(message)}
                                  className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-teal-400 transition cursor-pointer"
                                >
                                  <PencilIcon className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  title="Delete Message"
                                  onClick={() => void handleDeleteMessage(message)}
                                  className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-rose-400 transition cursor-pointer"
                                >
                                  <TrashIcon className="w-4 h-4" />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* Ephemeral Typing Indicators Banner */}
                {activeTypingNames.length > 0 ? (
                  <div className="flex items-center gap-2 border-t border-slate-800 bg-[#0d1017] px-6 py-1.5 text-xs text-teal-300">
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

                {/* Message Draft Input Area (Discord Style) */}
                <div className="border-t border-slate-800 bg-[#0d1017] p-4">
                  {/* Replying Banner */}
                  {replyingTo ? (
                    <div className="flex items-center justify-between rounded-t-xl bg-slate-800/80 px-4 py-2 text-xs text-slate-300 border border-b-0 border-slate-700/80 mb-0">
                      <span className="flex items-center gap-1.5 truncate">
                        <ReplyIcon className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400 font-medium">Replying to</span>
                        <span className="font-semibold text-slate-200">
                          @{members.find((m) => m.user_id === replyingTo.sender_id)?.username || replyingTo.sender_username || 'User'}
                        </span>
                        <span className="truncate text-slate-400 max-w-[280px]">
                          — {replyingTo.is_encrypted ? decryptedCache[replyingTo.id] || '[Encrypted]' : replyingTo.content}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setReplyingTo(null)}
                        className="text-slate-400 hover:text-white ml-2 cursor-pointer"
                      >
                        <CloseIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : null}

                  {/* Pending Attachments List */}
                  {pendingAttachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2 px-3 py-2 bg-slate-800/50 border border-b-0 border-slate-700/80 rounded-t-xl">
                      {pendingAttachments.map((att) => (
                        <div
                          key={att.id}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1 text-xs text-slate-300"
                        >
                          <PaperclipIcon className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="truncate max-w-[160px]">{att.filename}</span>
                          <span className="text-[10px] text-slate-400">
                            ({(att.size_bytes / 1024).toFixed(0)} KB)
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingAttachments((prev) => prev.filter((item) => item.id !== att.id))
                            }
                            className="ml-1 text-slate-400 hover:text-rose-400 font-bold cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* Mention Autocomplete Popover */}
                  {mentionQuery !== null && mentionCandidates.length > 0 && (
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl mb-2 max-h-56 overflow-y-auto custom-scrollbar">
                      <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                        <AtSignIcon className="w-3 h-3 text-emerald-400" />
                        Members &amp; Roles matching @{mentionQuery}
                      </div>
                      <div className="mt-1 space-y-0.5">
                        {mentionCandidates.map((cand, idx) => {
                          const isSelected = idx === mentionIndex
                          return (
                            <button
                              key={cand.id}
                              type="button"
                              onClick={() => selectMentionCandidate(cand)}
                              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition cursor-pointer ${
                                isSelected
                                  ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
                                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                              }`}
                            >
                              {cand.isSpecial ? (
                                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/20 text-amber-300 font-bold text-xs border border-amber-500/40">
                                  @
                                </div>
                              ) : (
                                <UserAvatar
                                  username={cand.name}
                                  avatarUrl={cand.avatarUrl}
                                  size="sm"
                                  isOnline={cand.isOnline}
                                />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold truncate">@{cand.name}</div>
                                <div className="text-[10px] text-slate-400 truncate">{cand.desc}</div>
                              </div>
                              <span className="text-[10px] text-slate-500 font-mono">Tab/Enter</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Smart Sentences Quick Bar */}
                  {smartSentencesOpen ? (
                    <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-1 text-xs custom-scrollbar">
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400 whitespace-nowrap pl-1">
                        <SparklesIcon className="w-3.5 h-3.5" />
                        Smart Suggestions:
                      </span>
                      {smartSuggestions.map((suggestion, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => applySmartSentence(suggestion)}
                          className="rounded-full border border-slate-700/80 bg-slate-800/80 hover:bg-slate-700 hover:border-emerald-500/50 hover:text-emerald-300 px-3 py-1 text-slate-300 whitespace-nowrap transition cursor-pointer text-xs"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {/* Input bar */}
                  <div
                    className={`flex items-center gap-2.5 rounded-xl border border-slate-700/80 bg-slate-800/70 px-3.5 py-2.5 shadow-inner focus-within:border-emerald-500/60 focus-within:bg-slate-800/90 transition-all ${
                      replyingTo || pendingAttachments.length > 0 ? 'rounded-t-none' : ''
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
                      className="rounded-lg p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/60 transition cursor-pointer"
                    >
                      <span className="text-base font-bold leading-none">+</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!selectedConversationId || uploadingAttachment}
                      title="Attach file or image (max 15MB)"
                      className="rounded-lg p-1.5 text-slate-400 hover:text-emerald-400 hover:bg-slate-700/60 disabled:opacity-50 transition cursor-pointer"
                    >
                      <PaperclipIcon className="w-4 h-4" />
                    </button>
                    <input
                      ref={inputRef}
                      value={draft}
                      onChange={(event) => handleDraftChange(event.target.value, event.target.selectionStart || undefined)}
                      onKeyDown={(e) => {
                        if (mentionCandidates.length > 0 && mentionQuery !== null) {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault()
                            setMentionIndex((prev) => (prev + 1) % mentionCandidates.length)
                            return
                          }
                          if (e.key === 'ArrowUp') {
                            e.preventDefault()
                            setMentionIndex((prev) => (prev - 1 + mentionCandidates.length) % mentionCandidates.length)
                            return
                          }
                          if (e.key === 'Enter' || e.key === 'Tab') {
                            e.preventDefault()
                            const selected = mentionCandidates[mentionIndex] || mentionCandidates[0]
                            if (selected) {
                              selectMentionCandidate(selected)
                            }
                            return
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setMentionQuery(null)
                            return
                          }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void handleSend()
                        }
                      }}
                      disabled={!selectedConversationId || sending}
                      onFocus={() => clearCurrentUnreads(selectedConversationId)}
                      onClick={() => clearCurrentUnreads(selectedConversationId)}
                      className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
                      placeholder={selectedConversationId ? `Message #${activeChannelTitle}... (Use @ to mention)` : 'Select or create a conversation first'}
                    />
                    <button
                      type="button"
                      onClick={() => setSmartSentencesOpen(!smartSentencesOpen)}
                      title="Toggle Smart Suggestions"
                      className={`rounded-lg p-1.5 transition cursor-pointer ${
                        smartSentencesOpen ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                      }`}
                    >
                      <SparklesIcon className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => void handleSend()}
                      disabled={!selectedConversationId || (!draft.trim() && pendingAttachments.length === 0) || sending}
                      type="button"
                      className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-1.5 text-xs font-semibold text-slate-950 shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:brightness-105 active:scale-[0.98] transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span>{sending ? 'Sending...' : 'Send'}</span>
                      <SendIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
          )}

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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-md p-4">
          <div className="relative w-full max-w-md">
            <div className="absolute -inset-1.5 rounded-[36px] bg-gradient-to-r from-emerald-500/30 via-teal-400/20 to-purple-600/30 blur-2xl opacity-75 animate-pulse [animation-duration:5s]" />
            <div className="relative w-full rounded-3xl border border-white/20 border-t-white/40 bg-gradient-to-b from-white/[0.12] via-slate-900/50 to-slate-950/70 p-6 shadow-[0_25px_70px_rgba(0,0,0,0.8),inset_0_1px_1px_rgba(255,255,255,0.35)] backdrop-blur-3xl">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <h2 className="text-lg font-bold text-white tracking-tight">New Conversation</h2>
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/[0.08] text-slate-300 hover:border-white/40 hover:bg-white/20 hover:text-white transition shadow-sm"
                >
                  ✕
                </button>
              </div>

              <div className="mt-4 flex gap-2 rounded-2xl border border-white/20 border-t-white/30 bg-white/[0.06] p-1.5 backdrop-blur-xl shadow-inner">
                <button
                  type="button"
                  onClick={() => {
                    setCreateKind('direct')
                    setCreateError('')
                  }}
                  className={`flex-1 rounded-xl py-2 text-xs font-bold transition-all ${
                    createKind === 'direct'
                      ? 'bg-gradient-to-r from-emerald-400 to-teal-400 text-slate-950 shadow-[0_0_18px_rgba(16,185,129,0.45)]'
                      : 'text-slate-300 hover:text-white hover:bg-white/[0.06]'
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
                  className={`flex-1 rounded-xl py-2 text-xs font-bold transition-all ${
                    createKind === 'group'
                      ? 'bg-gradient-to-r from-emerald-400 to-teal-400 text-slate-950 shadow-[0_0_18px_rgba(16,185,129,0.45)]'
                      : 'text-slate-300 hover:text-white hover:bg-white/[0.06]'
                  }`}
                >
                  Group Chat
                </button>
              </div>

              {createError ? (
                <p className="mt-3 rounded-2xl border border-rose-400/40 bg-rose-500/15 px-3.5 py-2 text-xs text-rose-200 backdrop-blur-md">
                  {createError}
                </p>
              ) : null}

              {createKind === 'direct' ? (
                <div className="mt-4 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      Find user to chat with
                    </label>
                    <input
                      type="text"
                      value={userSearchQuery}
                      onChange={(e) => setUserSearchQuery(e.target.value)}
                      placeholder="Search by username..."
                      className="w-full rounded-2xl border border-white/20 border-t-white/30 bg-white/[0.08] px-4 py-2.5 text-sm text-white placeholder:text-slate-400 shadow-[inset_0_2px_4px_rgba(0,0,0,0.3),0_1px_1px_rgba(255,255,255,0.1)] backdrop-blur-xl focus:border-emerald-400 focus:bg-white/[0.14] focus:outline-none focus:ring-2 focus:ring-emerald-400/40 transition-all"
                      autoFocus
                    />
                  </div>

                  <div className="max-h-48 overflow-y-auto space-y-1.5">
                    {userSearching ? <p className="text-xs text-slate-400 py-2">Searching...</p> : null}
                    {!userSearching && userSearchQuery.trim() && userSearchResults.length === 0 ? (
                      <p className="text-xs text-slate-400 py-2">No users found.</p>
                    ) : null}
                    {userSearchResults.map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        disabled={createBusy}
                        onClick={() => void handleCreateDirect(result)}
                        className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] p-2.5 text-left hover:bg-white/[0.09] hover:border-white/20 backdrop-blur-md transition"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300 border border-emerald-500/30">
                            {result.username.charAt(0).toUpperCase()}
                          </span>
                          <span className="text-sm font-semibold text-slate-200">@{result.username}</span>
                        </div>
                        <span className="text-xs text-emerald-400 font-medium">Start Chat →</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <form onSubmit={handleCreateGroup} className="mt-4 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      Group Name (optional)
                    </label>
                    <input
                      type="text"
                      value={createTitle}
                      onChange={(e) => setCreateTitle(e.target.value)}
                      placeholder="e.g. Stealth Protocol"
                      maxLength={100}
                      className="w-full rounded-2xl border border-white/20 border-t-white/30 bg-white/[0.08] px-4 py-2.5 text-sm text-white placeholder:text-slate-400 shadow-[inset_0_2px_4px_rgba(0,0,0,0.3),0_1px_1px_rgba(255,255,255,0.1)] backdrop-blur-xl focus:border-emerald-400 focus:bg-white/[0.14] focus:outline-none focus:ring-2 focus:ring-emerald-400/40 transition-all"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      Add Participants ({selectedGroupParticipants.length} selected)
                    </label>
                    <input
                      type="text"
                      value={userSearchQuery}
                      onChange={(e) => setUserSearchQuery(e.target.value)}
                      placeholder="Search users to add..."
                      className="w-full rounded-2xl border border-white/20 border-t-white/30 bg-white/[0.08] px-4 py-2.5 text-sm text-white placeholder:text-slate-400 shadow-[inset_0_2px_4px_rgba(0,0,0,0.3),0_1px_1px_rgba(255,255,255,0.1)] backdrop-blur-xl focus:border-emerald-400 focus:bg-white/[0.14] focus:outline-none focus:ring-2 focus:ring-emerald-400/40 transition-all"
                    />
                  </div>

                  {selectedGroupParticipants.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 p-2 rounded-xl bg-white/[0.04] border border-white/10 backdrop-blur-md">
                      {selectedGroupParticipants.map((p) => (
                        <span
                          key={p.id}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-2 py-1 text-xs text-emerald-200"
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

                  <div className="max-h-36 overflow-y-auto space-y-1.5">
                    {userSearchResults
                      .filter((r) => !selectedGroupParticipants.some((p) => p.id === r.id))
                      .map((result) => (
                        <button
                          key={result.id}
                          type="button"
                          onClick={() => setSelectedGroupParticipants((prev) => [...prev, result])}
                          className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] p-2 text-left hover:bg-white/[0.08] transition"
                        >
                          <span className="text-xs font-medium text-slate-200">@{result.username}</span>
                          <span className="text-xs text-emerald-400 font-semibold">+ Add</span>
                        </button>
                      ))}
                  </div>

                  <button
                    type="submit"
                    disabled={createBusy}
                    className="w-full rounded-2xl bg-gradient-to-r from-emerald-400 to-teal-400 py-3 text-sm font-bold text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.35)] hover:shadow-[0_0_30px_rgba(16,185,129,0.55)] transition hover:brightness-105 active:scale-[0.98] disabled:opacity-50"
                  >
                    {createBusy ? 'Creating Group...' : 'Create Group'}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Invite Member Modal */}
      {inviteModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-md p-4">
          <div className="relative w-full max-w-md">
            <div className="absolute -inset-1.5 rounded-[36px] bg-gradient-to-r from-emerald-500/30 via-teal-400/20 to-purple-600/30 blur-2xl opacity-75 animate-pulse [animation-duration:5s]" />
            <div className="relative w-full rounded-3xl border border-white/20 border-t-white/40 bg-gradient-to-b from-white/[0.12] via-slate-900/50 to-slate-950/70 p-6 shadow-[0_25px_70px_rgba(0,0,0,0.8),inset_0_1px_1px_rgba(255,255,255,0.35)] backdrop-blur-3xl">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <h2 className="text-lg font-bold text-white tracking-tight">Invite to Group</h2>
                <button
                  type="button"
                  onClick={() => setInviteModalOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/[0.08] text-slate-300 hover:border-white/40 hover:bg-white/20 hover:text-white transition shadow-sm"
                >
                  ✕
                </button>
              </div>

              {inviteSuccess ? (
                <p className="mt-3 rounded-2xl border border-emerald-400/40 bg-emerald-500/15 px-3.5 py-2 text-xs text-emerald-200 backdrop-blur-md">
                  {inviteSuccess}
                </p>
              ) : null}
              {inviteError ? (
                <p className="mt-3 rounded-2xl border border-rose-400/40 bg-rose-500/15 px-3.5 py-2 text-xs text-rose-200 backdrop-blur-md">
                  {inviteError}
                </p>
              ) : null}

              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Search username to invite
                  </label>
                  <input
                    type="text"
                    value={inviteQuery}
                    onChange={(e) => setInviteQuery(e.target.value)}
                    placeholder="Type username..."
                    className="w-full rounded-2xl border border-white/20 border-t-white/30 bg-white/[0.08] px-4 py-2.5 text-sm text-white placeholder:text-slate-400 shadow-[inset_0_2px_4px_rgba(0,0,0,0.3),0_1px_1px_rgba(255,255,255,0.1)] backdrop-blur-xl focus:border-emerald-400 focus:bg-white/[0.14] focus:outline-none focus:ring-2 focus:ring-emerald-400/40 transition-all"
                    autoFocus
                  />
                </div>

                <div className="max-h-48 overflow-y-auto space-y-1.5">
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
                        className={`flex w-full items-center justify-between rounded-xl border p-2.5 text-left transition ${
                          alreadyMember
                            ? 'border-white/5 bg-white/[0.02] opacity-50 cursor-not-allowed'
                            : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.09] hover:border-white/20'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300 border border-emerald-500/30">
                            {result.username.charAt(0).toUpperCase()}
                          </span>
                          <span className="text-sm font-semibold text-slate-200">@{result.username}</span>
                        </div>
                        <span className="text-xs text-emerald-400 font-medium">
                          {alreadyMember ? 'Already member' : '+ Invite'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Safety Number / Fingerprint Modal */}
      {safetyModalOpen && safetyNumber ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-md p-4">
          <div className="relative w-full max-w-md">
            <div className="absolute -inset-1.5 rounded-[36px] bg-gradient-to-r from-teal-500/30 via-emerald-400/20 to-cyan-500/30 blur-2xl opacity-75 animate-pulse [animation-duration:5s]" />
            <div className="relative w-full rounded-3xl border border-white/20 border-t-white/40 bg-gradient-to-b from-white/[0.12] via-slate-900/50 to-slate-950/70 p-6 shadow-[0_25px_70px_rgba(0,0,0,0.8),inset_0_1px_1px_rgba(255,255,255,0.35)] backdrop-blur-3xl">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xl">🔒</span>
                  <h2 className="text-lg font-bold text-white tracking-tight">E2EE Safety Number</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSafetyModalOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/[0.08] text-slate-300 hover:border-white/40 hover:bg-white/20 hover:text-white transition shadow-sm"
                >
                  ✕
                </button>
              </div>
              <p className="mt-4 text-xs text-slate-300/80 leading-relaxed">
                Verify that your end-to-end encryption is authentic and secure. Compare this safety number with the other participant. If the numbers match on both screens, your conversation cannot be intercepted or modified by anyone, including the server.
              </p>
              <div className="mt-5 rounded-2xl border border-teal-500/40 border-t-teal-400/50 bg-teal-500/15 p-4 text-center font-mono text-base font-bold tracking-wider text-teal-200 shadow-[inset_0_1px_1px_rgba(255,255,255,0.2)] backdrop-blur-md">
                {safetyNumber}
              </div>
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => setSafetyModalOpen(false)}
                  className="rounded-xl bg-gradient-to-r from-teal-400 to-emerald-400 px-5 py-2.5 text-xs font-bold text-slate-950 shadow-[0_0_20px_rgba(45,212,191,0.35)] hover:brightness-105 active:scale-95 transition"
                >
                  Close & Confirm Verified
                </button>
              </div>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-md p-4">
          <div className="relative w-full max-w-lg">
            <div className="absolute -inset-1.5 rounded-[36px] bg-gradient-to-r from-emerald-500/30 via-teal-400/20 to-purple-600/30 blur-2xl opacity-75 animate-pulse [animation-duration:5s]" />
            <div className="relative w-full rounded-3xl border border-white/20 border-t-white/40 bg-gradient-to-b from-white/[0.12] via-slate-900/50 to-slate-950/70 p-6 shadow-[0_25px_70px_rgba(0,0,0,0.8),inset_0_1px_1px_rgba(255,255,255,0.35)] backdrop-blur-3xl">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">👤</span>
                  <div>
                    <h2 className="text-lg font-bold text-white tracking-tight">Profile Settings</h2>
                    <p className="text-xs text-slate-300/80">Manage your stealth persona, status, and identity</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setProfileModalOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/[0.08] text-slate-300 hover:border-white/40 hover:bg-white/20 hover:text-white transition shadow-sm"
                >
                  ✕
                </button>
              </div>

              {profileSuccess ? (
                <p className="mt-4 rounded-2xl border border-emerald-400/40 bg-emerald-500/15 px-3.5 py-2 text-xs text-emerald-200 backdrop-blur-md">
                  {profileSuccess}
                </p>
              ) : null}
              {profileError ? (
                <p className="mt-4 rounded-2xl border border-rose-400/40 bg-rose-500/15 px-3.5 py-2 text-xs text-rose-200 backdrop-blur-md">
                  {profileError}
                </p>
              ) : null}

              <form onSubmit={handleSaveProfile} className="mt-5 space-y-5">
                {/* Avatar Preview & Upload */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
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
                          className="rounded-xl border border-white/20 border-t-white/30 bg-white/[0.08] px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/[0.15] hover:text-white transition shadow-sm disabled:opacity-50"
                        >
                          {profileUploadingAvatar ? 'Uploading...' : 'Upload Image'}
                        </button>
                        {profileAvatarUrl ? (
                          <button
                            type="button"
                            onClick={() => setProfileAvatarUrl('')}
                            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/20 transition"
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                      <p className="text-[11px] text-slate-400">Max size 5MB (PNG, JPG, WebP, GIF)</p>
                    </div>
                  </div>

                  {/* Avatar Presets */}
                  <div className="mt-3.5">
                    <p className="text-[11px] text-slate-300 mb-1.5 font-medium">Or choose a preset style:</p>
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
                          className={`rounded-xl border px-3 py-1.5 text-xs font-medium backdrop-blur-md transition ${
                            profileAvatarUrl === preset.url
                              ? 'border-emerald-400/60 bg-emerald-500/25 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                              : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]'
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
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                    Custom Status Message
                  </label>
                  <input
                    type="text"
                    maxLength={140}
                    value={profileStatusMessage}
                    onChange={(e) => setProfileStatusMessage(e.target.value)}
                    placeholder="e.g. ⚡ Coding in stealth mode"
                    className="w-full rounded-2xl border border-white/20 border-t-white/30 bg-white/[0.08] px-4 py-2.5 text-sm text-white placeholder:text-slate-400 shadow-[inset_0_2px_4px_rgba(0,0,0,0.3),0_1px_1px_rgba(255,255,255,0.1)] backdrop-blur-xl focus:border-emerald-400 focus:bg-white/[0.14] focus:outline-none focus:ring-2 focus:ring-emerald-400/40 transition-all"
                  />
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
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
                        className="rounded-full border border-white/15 bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-slate-300 hover:border-white/30 hover:bg-white/[0.09] transition"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Account Overview */}
                <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-3.5 space-y-2 text-xs backdrop-blur-md">
                  <div className="flex justify-between items-center text-slate-300">
                    <span className="text-slate-400">Username:</span>
                    <span className="font-semibold text-white">@{user.username}</span>
                  </div>
                  <div className="flex justify-between items-center text-slate-300">
                    <span className="text-slate-400">Email:</span>
                    <span className="flex items-center gap-1.5 font-medium text-slate-200">
                      {user.email}
                      <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300 border border-emerald-400/30">
                        ✓ Verified
                      </span>
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-slate-300">
                    <span className="text-slate-400">E2EE Identity:</span>
                    <span className="text-teal-300 font-mono text-[11px] font-semibold">
                      {myPublicKeySpki ? 'SPKI Key Active' : 'Generating...'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setProfileModalOpen(false)}
                    className="rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/[0.1] hover:text-white transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={profileSaving}
                    className="rounded-xl bg-gradient-to-r from-emerald-400 to-teal-400 px-5 py-2 text-xs font-bold text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.35)] hover:brightness-105 active:scale-95 disabled:opacity-50 transition"
                  >
                    {profileSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
