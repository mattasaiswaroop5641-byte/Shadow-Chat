import type {
  Attachment,
  Conversation,
  ConversationMember,
  Message,
  MessageDeletedEvent,
  MessageDeliveredEvent,
  MessageEditedEvent,
  MessageReactionEvent,
  PresenceEvent,
  ReadReceiptEvent,
  TokenReply,
  TypingEvent,
  User,
  UserProfileUpdatedEvent,
  UserSummary,
} from '../types'

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
const configuredWsUrl = import.meta.env.VITE_WS_URL?.trim()
const apiBaseUrl = (configuredBaseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '')
const refreshTokenStorageKey = 'shadow-chat.refresh-token'

let accessToken: string | null = null
let refreshPromise: Promise<string | null> | null = null
let sessionExpiredHandler: (() => void) | null = null
const maxReconnectAttempts = 5
const initialReconnectDelayMs = 1500
const maxReconnectDelayMs = 15000

if (import.meta.env.PROD && !configuredBaseUrl) {
  throw new Error('VITE_API_BASE_URL must be configured for production builds')
}

export async function fetchHealth(): Promise<{ status: string; service: string }> {
  const response = await fetch(`${apiBaseUrl}/health`)
  if (!response.ok) {
    throw new Error('Unable to reach backend health endpoint')
  }
  return response.json()
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler
}


async function parseError(response: Response): Promise<ApiError> {
  let message = `Request failed (${response.status})`
  try {
    const body = (await response.json()) as { detail?: string }
    if (body.detail) message = body.detail
  } catch {
    // Keep the status-based message when the server does not return JSON.
  }
  return new ApiError(response.status, message)
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers })
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new ApiError(503, 'Backend unavailable. Start the API and check its database connection.')
    }
    throw error
  }
  if (response.status === 401 && retry && path !== '/auth/refresh') {
    const refreshedToken = await refreshAccessToken()
    if (refreshedToken) return request<T>(path, init, false)
    sessionExpiredHandler?.()
  }
  if (!response.ok) throw await parseError(response)
  return response.status === 204 ? (undefined as T) : response.json()
}


function getStoredRefreshToken(): string | null {
  return sessionStorage.getItem(refreshTokenStorageKey)
}

function storeTokens(tokens: TokenReply): void {
  accessToken = tokens.access_token
  sessionStorage.setItem(refreshTokenStorageKey, tokens.refresh_token)
}

export function clearSession(): void {
  accessToken = null
  sessionStorage.removeItem(refreshTokenStorageKey)
}

async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise
  const refreshToken = getStoredRefreshToken()
  if (!refreshToken) return null

  refreshPromise = fetch(`${apiBaseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
    .then(async (response) => {
      if (!response.ok) throw await parseError(response)
      const tokens = (await response.json()) as TokenReply
      storeTokens(tokens)
      return tokens.access_token
    })
    .catch((error: unknown) => {
      clearSession()
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    })
    .finally(() => {
      refreshPromise = null
    })
  return refreshPromise
}

async function ensureAccessToken(): Promise<string> {
  if (!accessToken && !(await refreshAccessToken())) {
    throw new ApiError(401, 'Authentication required')
  }
  return accessToken as string
}

export async function restoreSession(): Promise<User | null> {
  if (!getStoredRefreshToken()) return null
  try {
    await refreshAccessToken()
    return await request<User>('/auth/me')
  } catch {
    clearSession()
    return null
  }
}

export async function register(email: string, username: string, password: string): Promise<void> {
  const tokens = await request<TokenReply>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, username, password }),
  }, false)
  storeTokens(tokens)
}

export async function login(email: string, password: string): Promise<User> {
  const tokens = await request<TokenReply>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }, false)
  storeTokens(tokens)
  return request<User>('/auth/me', {}, false)
}

export async function verifyEmail(code: string): Promise<User> {
  await request<{ status: string }>('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ code }),
  }, false)
  return request<User>('/auth/me', {}, false)
}

export async function resendVerification(): Promise<void> {
  await request<{ status: string }>('/auth/resend-verification', { method: 'POST' }, false)
}

export async function logout(): Promise<void> {
  const refreshToken = getStoredRefreshToken()
  try {
    if (refreshToken) {
      await fetch(`${apiBaseUrl}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
    }
  } finally {
    clearSession()
  }
}

export function searchUsers(query: string): Promise<UserSummary[]> {
  const params = new URLSearchParams({ q: query })
  return request<UserSummary[]>(`/users/search?${params.toString()}`)
}

export function listConversations(): Promise<Conversation[]> {
  return request<Conversation[]>('/conversations')
}

export type CreateConversationOptions = {
  kind: 'direct' | 'group'
  recipient_id?: string
  participant_ids?: string[]
  title?: string
}

export function createConversation(
  payloadOrKind: 'direct' | 'group' | CreateConversationOptions = 'group',
): Promise<Conversation> {
  const body = typeof payloadOrKind === 'string' ? { kind: payloadOrKind } : payloadOrKind
  return request<Conversation>('/conversations', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function deleteConversation(conversationId: string): Promise<void> {
  return request<void>(`/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  })
}

export function listMembers(conversationId: string): Promise<ConversationMember[]> {
  return request<ConversationMember[]>(`/conversations/${encodeURIComponent(conversationId)}/members`)
}

export function addMember(
  conversationId: string,
  payload: { user_id?: string; username?: string },
): Promise<ConversationMember> {
  return request<ConversationMember>(`/conversations/${encodeURIComponent(conversationId)}/members`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listMessages(
  conversationId: string,
  before?: string,
  limit = 50,
): Promise<Message[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before) params.set('before', before)
  return request<Message[]>(
    `/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`,
  )
}

export function sendMessage(
  conversationId: string,
  content: string,
  nonce?: string | null,
  is_encrypted?: boolean,
  reply_to_id?: string | null,
  attachments?: Attachment[],
): Promise<Message> {
  return request<Message>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      nonce,
      is_encrypted: Boolean(is_encrypted),
      reply_to_id: reply_to_id || undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    }),
  })
}

export function uploadAttachment(conversationId: string, file: File): Promise<Attachment> {
  const formData = new FormData()
  formData.append('file', file)
  return request<Attachment>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/attachments`,
    {
      method: 'POST',
      body: formData,
    },
  )
}

export function getAttachmentFileUrl(path: string): string {
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return `${apiBaseUrl}${path.startsWith('/') ? '' : '/'}${path}`
}

export function toggleReaction(
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<Record<string, string[]>> {
  return request<Record<string, string[]>>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    },
  )
}

export function editMessage(
  conversationId: string,
  messageId: string,
  content: string,
  nonce?: string | null,
  is_encrypted?: boolean,
): Promise<Message> {
  return request<Message>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content, nonce, is_encrypted: Boolean(is_encrypted) }),
    },
  )
}

export function deleteMessage(conversationId: string, messageId: string): Promise<void> {
  return request<void>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'DELETE',
    },
  )
}

export function uploadPublicKey(publicKey: string): Promise<void> {
  return request<void>('/users/me/public-key', {
    method: 'PUT',
    body: JSON.stringify({ public_key: publicKey }),
  })
}

export async function getUserPublicKey(userId: string): Promise<string | null> {
  try {
    const res = await request<{ user_id: string; public_key: string | null }>(
      `/users/${encodeURIComponent(userId)}/public-key`,
    )
    return res.public_key
  } catch {
    return null
  }
}

export function markMessagesRead(conversationId: string): Promise<void> {
  return request<void>(`/conversations/${encodeURIComponent(conversationId)}/messages/read`, {
    method: 'POST',
  })
}

export function getUsersPresence(userIds: string[]): Promise<Record<string, boolean>> {
  if (userIds.length === 0) return Promise.resolve({})
  return request<Record<string, boolean>>(
    `/users/presence?user_ids=${encodeURIComponent(userIds.join(','))}`,
  )
}

export function updateUserProfile(profile: {
  avatar_url?: string | null
  status_message?: string | null
}): Promise<User> {
  return request<User>('/users/me/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}

export function uploadAvatar(file: File): Promise<User> {
  const formData = new FormData()
  formData.append('file', file)
  return request<User>('/users/me/avatar', {
    method: 'POST',
    body: formData,
  })
}

export type SocketHandlers = {
  onMessage: (message: Message) => void
  onStatus: (status: 'connected' | 'disconnected') => void
  onMemberJoined?: (event: { conversation_id: string; user: { id: string; username: string } }) => void
  onTyping?: (event: TypingEvent) => void
  onReadReceipt?: (event: ReadReceiptEvent) => void
  onMessageDelivered?: (event: MessageDeliveredEvent) => void
  onPresence?: (event: PresenceEvent) => void
  onMessageReaction?: (event: MessageReactionEvent) => void
  onMessageEdited?: (event: MessageEditedEvent) => void
  onMessageDeleted?: (event: MessageDeletedEvent) => void
  onUserProfileUpdated?: (event: UserProfileUpdatedEvent) => void
  onConversationDeleted?: (event: { conversation_id: string }) => void
}

export async function openConversationSocket(
  handlers: SocketHandlers | ((message: Message) => void),
  legacyOnStatus?: (status: 'connected' | 'disconnected') => void,
  legacyOnMemberJoined?: (event: { conversation_id: string; user: { id: string; username: string } }) => void,
): Promise<{
  subscribe: (conversationId: string) => void
  sendTyping: (conversationId: string, isTyping: boolean) => void
  sendRead: (conversationId: string) => void
  close: () => void
}> {
  const onMessage = typeof handlers === 'function' ? handlers : handlers.onMessage
  const onStatus = typeof handlers === 'function' ? (legacyOnStatus || (() => {})) : handlers.onStatus
  const onMemberJoined = typeof handlers === 'function' ? legacyOnMemberJoined : handlers.onMemberJoined
  const onTyping = typeof handlers === 'object' ? handlers.onTyping : undefined
  const onReadReceipt = typeof handlers === 'object' ? handlers.onReadReceipt : undefined
  const onMessageDelivered = typeof handlers === 'object' ? handlers.onMessageDelivered : undefined
  const onPresence = typeof handlers === 'object' ? handlers.onPresence : undefined
  const onMessageReaction = typeof handlers === 'object' ? handlers.onMessageReaction : undefined
  const onMessageEdited = typeof handlers === 'object' ? handlers.onMessageEdited : undefined
  const onMessageDeleted = typeof handlers === 'object' ? handlers.onMessageDeleted : undefined
  const onUserProfileUpdated = typeof handlers === 'object' ? handlers.onUserProfileUpdated : undefined
  const onConversationDeleted = typeof handlers === 'object' ? handlers.onConversationDeleted : undefined

  const websocketUrl = configuredWsUrl || (apiBaseUrl.replace(/^http/, 'ws') + '/ws')
  let closedByClient = false
  let subscribedConversation: string | null = null
  let socket: WebSocket | null = null
  let reconnectTimer: number | undefined
  let reconnectAttempts = 0

  const connect = async () => {
    if (closedByClient) return
    try {
      const token = await ensureAccessToken()
      socket = new WebSocket(websocketUrl)
      socket.addEventListener('open', () => {
        socket?.send(JSON.stringify({ type: 'auth', access_token: token }))
        onStatus('connected')
        if (subscribedConversation) {
          socket?.send(JSON.stringify({ type: 'subscribe', conversation_id: subscribedConversation }))
        }
      })
      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data) as {
            type?: string
            message?: Message
            conversation_id?: string
            user?: { id: string; username: string }
          }
          if (payload.type === 'subscribed') reconnectAttempts = 0
          if (payload.type === 'message' && payload.message) onMessage(payload.message)
          if (payload.type === 'member_joined' && payload.conversation_id && payload.user && onMemberJoined) {
            onMemberJoined({ conversation_id: payload.conversation_id, user: payload.user })
          }
          if (payload.type === 'typing' && onTyping) {
            onTyping(payload as unknown as TypingEvent)
          }
          if (payload.type === 'read_receipt' && onReadReceipt) {
            onReadReceipt(payload as unknown as ReadReceiptEvent)
          }
          if (payload.type === 'message_delivered' && onMessageDelivered) {
            onMessageDelivered(payload as unknown as MessageDeliveredEvent)
          }
          if (payload.type === 'presence' && onPresence) {
            onPresence(payload as unknown as PresenceEvent)
          }
          if (payload.type === 'message_reaction' && onMessageReaction) {
            onMessageReaction(payload as unknown as MessageReactionEvent)
          }
          if (payload.type === 'message_edited' && onMessageEdited) {
            onMessageEdited(payload as unknown as MessageEditedEvent)
          }
          if (payload.type === 'message_deleted' && onMessageDeleted) {
            onMessageDeleted(payload as unknown as MessageDeletedEvent)
          }
          if (payload.type === 'user_profile_updated' && onUserProfileUpdated) {
            onUserProfileUpdated(payload as unknown as UserProfileUpdatedEvent)
          }
          if (payload.type === 'conversation_deleted' && onConversationDeleted) {
            onConversationDeleted({ conversation_id: (payload as any).conversation_id as string })
          }
        } catch {
          // Ignore malformed server events; REST remains the source of truth.
        }
      })
      socket.addEventListener('close', (event) => {
        onStatus('disconnected')
        if (event.code === 1008) accessToken = null
        if (closedByClient || reconnectAttempts >= maxReconnectAttempts) return
        const delay = Math.min(
          initialReconnectDelayMs * 2 ** reconnectAttempts,
          maxReconnectDelayMs,
        )
        reconnectAttempts += 1
        reconnectTimer = window.setTimeout(() => void connect(), delay)
      })
      socket.addEventListener('error', () => onStatus('disconnected'))
    } catch (error: unknown) {
      onStatus('disconnected')
      if (error instanceof ApiError && error.status === 401) {
        sessionExpiredHandler?.()
        return
      }
      if (closedByClient || reconnectAttempts >= maxReconnectAttempts) return
      const delay = Math.min(
        initialReconnectDelayMs * 2 ** reconnectAttempts,
        maxReconnectDelayMs,
      )
      reconnectAttempts += 1
      reconnectTimer = window.setTimeout(() => void connect(), delay)
    }
  }
  void connect()

  return {
    subscribe: (conversationId: string) => {
      subscribedConversation = conversationId
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'subscribe', conversation_id: conversationId }))
      }
    },
    sendTyping: (conversationId: string, isTyping: boolean) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'typing', conversation_id: conversationId, is_typing: isTyping }))
      }
    },
    sendRead: (conversationId: string) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'read', conversation_id: conversationId }))
      }
    },
    close: () => {
      closedByClient = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      socket?.close()
    },
  }
}
