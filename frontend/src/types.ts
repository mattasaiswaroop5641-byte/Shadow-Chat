export type NavItem = {
  id: string
  label: string
  badge?: string
  active?: boolean
}

export type ServerItem = {
  id: string
  name: string
  accent: string
  unread?: number
}

export type ChannelItem = {
  id: string
  name: string
  unread?: number
  active?: boolean
}

export type MessageItem = {
  id: string
  sender: string
  content: string
  timestamp: string
  self?: boolean
}

export type User = {
  id: string
  email: string
  username: string
  created_at: string
  email_verified: boolean
}

export type TokenReply = {
  access_token: string
  refresh_token: string
  token_type: string
}

export type Conversation = {
  id: string
  kind: 'direct' | 'group'
  owner_id: string
  title?: string
  created_at: string
  updated_at: string
}

export type UserSummary = {
  id: string
  username: string
}

export type ConversationMember = {
  id: string
  conversation_id: string
  user_id: string
  username: string
  role: 'owner' | 'member'
  created_at: string
}

export type Message = {
  id: string
  conversation_id: string
  sender_id: string
  content: string
  client_id: string
  created_at: string
}
