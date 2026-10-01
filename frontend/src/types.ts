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
  public_key?: string | null
  is_online?: boolean
}

export type Attachment = {
  id: string
  filename: string
  content_type: string
  size_bytes: number
  url: string
  is_encrypted?: boolean
}

export type ReplySummary = {
  id: string
  sender_id: string
  sender_username?: string | null
  content: string
  is_encrypted?: boolean
}

export type Message = {
  id: string
  conversation_id: string
  sender_id: string
  content: string
  client_id: string
  nonce?: string | null
  is_encrypted?: boolean
  status?: 'sent' | 'delivered' | 'read'
  created_at: string
  edited_at?: string | null
  is_edited?: boolean
  is_deleted?: boolean
  reply_to_id?: string | null
  reply_to?: ReplySummary | null
  attachments?: Attachment[]
  reactions?: Record<string, string[]>
}

export type TypingEvent = {
  type: 'typing'
  conversation_id: string
  user_id: string
  username: string
  is_typing: boolean
}

export type ReadReceiptEvent = {
  type: 'read_receipt'
  conversation_id: string
  reader_id: string
}

export type MessageDeliveredEvent = {
  type: 'message_delivered'
  conversation_id: string
  message_id: string
}

export type PresenceEvent = {
  type: 'presence'
  user_id: string
  status: 'online' | 'offline'
}

export type MessageReactionEvent = {
  type: 'message_reaction'
  conversation_id: string
  message_id: string
  reactions: Record<string, string[]>
}

export type MessageEditedEvent = {
  type: 'message_edited'
  message: Message
}

export type MessageDeletedEvent = {
  type: 'message_deleted'
  conversation_id: string
  message_id: string
}


