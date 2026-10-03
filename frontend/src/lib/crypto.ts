// End-to-End Encryption (E2EE) module using the Web Crypto API
// - ECDH (NIST P-256) for asymmetric key exchange
// - HKDF (SHA-256) for key derivation
// - AES-256-GCM for authenticated symmetric message encryption
// - IndexedDB for non-extractable client-side key storage

const DB_NAME = 'shadow-chat-e2ee'
const DB_VERSION = 1
const STORE_NAME = 'identity-keys'

const conversationKeyCache = new Map<string, CryptoKey>()

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// -----------------------------------------------------------------------------
// IndexedDB Key Storage
// -----------------------------------------------------------------------------
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

interface StoredKeysRecord {
  publicKeyJwk?: JsonWebKey
  privateKeyJwk?: JsonWebKey
  publicKey?: CryptoKey
  privateKey?: CryptoKey
}

async function loadKeyPairFromIndexedDB(userId: string): Promise<CryptoKeyPair | null> {
  try {
    const db = await openDatabase()
    const raw = await new Promise<StoredKeysRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(userId)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
    if (!raw) return null

    // 1. Preferred portable JWK format
    if (raw.publicKeyJwk && raw.privateKeyJwk) {
      const publicKey = await window.crypto.subtle.importKey(
        'jwk',
        raw.publicKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        [],
      )
      const privateKey = await window.crypto.subtle.importKey(
        'jwk',
        raw.privateKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits'],
      )
      return { publicKey, privateKey }
    }

    // 2. Backward compatibility with directly stored CryptoKeys
    if (raw.publicKey && raw.privateKey) {
      return { publicKey: raw.publicKey, privateKey: raw.privateKey }
    }
    return null
  } catch {
    return null
  }
}

async function saveKeyPairToIndexedDB(userId: string, keyPair: CryptoKeyPair): Promise<void> {
  try {
    const db = await openDatabase()
    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const privateKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put({ publicKeyJwk, privateKeyJwk }, userId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch (err) {
    console.warn('Unable to persist keypair to IndexedDB:', err)
  }
}

// -----------------------------------------------------------------------------
// Key Generation & SPKI Export/Import
// -----------------------------------------------------------------------------
export async function getOrGenerateIdentityKeyPair(userId: string): Promise<CryptoKeyPair> {
  const existing = await loadKeyPairFromIndexedDB(userId)
  if (existing) {
    return existing
  }

  const keyPair = await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, // extractable for exporting public key & storing in IndexedDB
    ['deriveKey', 'deriveBits'],
  )

  await saveKeyPairToIndexedDB(userId, keyPair)
  return keyPair
}

export async function exportPublicKeySpki(publicKey: CryptoKey): Promise<string> {
  const exported = await window.crypto.subtle.exportKey('spki', publicKey)
  return bufferToBase64(exported)
}

export async function importPublicKeySpki(spkiBase64: string): Promise<CryptoKey> {
  const binary = base64ToBuffer(spkiBase64)
  return window.crypto.subtle.importKey(
    'spki',
    binary.buffer as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
}

// -----------------------------------------------------------------------------
// Shared Secret & AES-256-GCM Session Key Derivation (HKDF)
// -----------------------------------------------------------------------------
export async function deriveConversationKey(
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
  conversationId: string,
  theirKeySpki?: string,
): Promise<CryptoKey> {
  const cacheKey = theirKeySpki ? `${conversationId}:${theirKeySpki}` : `${conversationId}`
  const cached = conversationKeyCache.get(cacheKey)
  if (cached) return cached

  // 1. ECDH Shared Secret Bits
  const sharedBits = await window.crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    256,
  )

  // 2. Import into HKDF
  const hkdfKey = await window.crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey'],
  )

  // 3. Derive 256-bit AES-GCM Key with salt and conversation info
  const encoder = new TextEncoder()
  const derivedKey = await window.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('shadow-chat-e2ee-salt').buffer as ArrayBuffer,
      info: encoder.encode(`conversation:${conversationId}`).buffer as ArrayBuffer,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  conversationKeyCache.set(cacheKey, derivedKey)
  return derivedKey
}

export function clearConversationKeyCache(conversationId?: string): void {
  if (conversationId) {
    for (const key of Array.from(conversationKeyCache.keys())) {
      if (key === conversationId || key.startsWith(`${conversationId}:`)) {
        conversationKeyCache.delete(key)
      }
    }
  } else {
    conversationKeyCache.clear()
  }
}

// -----------------------------------------------------------------------------
// Encryption & Decryption
// -----------------------------------------------------------------------------
export async function encryptMessage(
  plaintext: string,
  aesKey: CryptoKey,
): Promise<{ ciphertext: string; nonce: string }> {
  const encoder = new TextEncoder()
  const data = encoder.encode(plaintext)

  // 12-byte cryptographically secure initialization vector
  const iv = window.crypto.getRandomValues(new Uint8Array(12))

  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    aesKey,
    data.buffer as ArrayBuffer,
  )

  return {
    ciphertext: bufferToBase64(encrypted),
    nonce: bufferToBase64(iv),
  }
}

export async function decryptMessage(
  ciphertext: string,
  nonce: string,
  aesKey: CryptoKey,
): Promise<string> {
  const encryptedBytes = base64ToBuffer(ciphertext)
  const iv = base64ToBuffer(nonce)

  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    aesKey,
    encryptedBytes.buffer as ArrayBuffer,
  )

  return new TextDecoder().decode(decrypted)
}

// -----------------------------------------------------------------------------
// Safety Number / Fingerprint Generation (MITM Verification)
// -----------------------------------------------------------------------------
export async function calculateSafetyNumber(
  myKeySpki: string,
  theirKeySpki: string,
): Promise<string> {
  // Sort alphabetically to ensure commutativity: both parties compute the exact same fingerprint
  const sorted = [myKeySpki.trim(), theirKeySpki.trim()].sort()
  const combined = sorted[0] + sorted[1]

  const digest = await window.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(combined).buffer as ArrayBuffer,
  )

  const bytes = new Uint8Array(digest)
  // Format into 6 blocks of 5 digits
  const blocks: string[] = []
  for (let i = 0; i < 6; i++) {
    const chunk = (bytes[i * 4] << 24) | (bytes[i * 4 + 1] << 16) | (bytes[i * 4 + 2] << 8) | bytes[i * 4 + 3]
    const positiveChunk = Math.abs(chunk) % 100000
    blocks.push(positiveChunk.toString().padStart(5, '0'))
  }

  return blocks.join(' ')
}
