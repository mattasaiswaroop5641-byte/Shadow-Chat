import type { Conversation, ConversationMember, Message, TokenReply, User, UserSummary } from '../types'

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
const apiBaseUrl = configuredBaseUrl || 'http://127.0.0.1:8000'
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
  headers.set('Content-Type', 'application/json')
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

export function sendMessage(conversationId: string, content: string): Promise<Message> {
  return request<Message>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

export async function openConversationSocket(
  onMessage: (message: Message) => void,
  onStatus: (status: 'connected' | 'disconnected') => void,
  onMemberJoined?: (event: { conversation_id: string; user: { id: string; username: string } }) => void,
): Promise<{ subscribe: (conversationId: string) => void; close: () => void }> {
  const websocketUrl = apiBaseUrl.replace(/^http/, 'ws') + '/ws'
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
    close: () => {
      closedByClient = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      socket?.close()
    },
  }
}
