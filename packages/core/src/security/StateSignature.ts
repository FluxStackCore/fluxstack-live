// @fluxstack/live - State Signature (HMAC-SHA256)
//
// Cryptographic state signing for secure client-side persistence.
// Supports: key rotation, compression (gzip), encryption (AES-256-CBC),
// anti-replay nonces, state backups, and state migrations.

import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { gzipSync, gunzipSync } from 'zlib'
import { liveLog, liveWarn } from '../debug/LiveLogger'

export interface SignedState {
  data: string
  signature: string
  timestamp: number
  version: number
  componentId: string
  nonce?: string
  compressed?: boolean
  encrypted?: boolean
}

export interface StateSignatureConfig {
  /** HMAC secret for signing. Defaults to env LIVE_STATE_SECRET or a random key. */
  secret?: string
  /** Enable key rotation */
  rotationEnabled?: boolean
  /** Key rotation interval in ms */
  rotationInterval?: number
  /** Enable compression */
  compressionEnabled?: boolean
  /** Enable encryption */
  encryptionEnabled?: boolean
  /** Enable anti-replay nonces */
  nonceEnabled?: boolean
  /** Maximum state age in ms */
  maxStateAge?: number
  /** Enable state backups */
  backupEnabled?: boolean
  /** Max state backups to keep */
  maxBackups?: number
}

interface StateBackup {
  signedState: SignedState
  backedUpAt: number
}

export class StateSignatureManager {
  private secret: Buffer
  private previousSecrets: Buffer[] = []
  private rotationTimer?: ReturnType<typeof setInterval>
  private usedNonces = new Set<string>()
  private nonceCleanupTimer?: ReturnType<typeof setInterval>
  private stateBackups = new Map<string, StateBackup[]>()
  private config: Required<StateSignatureConfig>

  constructor(config: StateSignatureConfig = {}) {
    const defaultSecret = typeof process !== 'undefined'
      ? process.env?.LIVE_STATE_SECRET
      : undefined

    this.config = {
      secret: config.secret ?? defaultSecret ?? '',
      rotationEnabled: config.rotationEnabled ?? false,
      rotationInterval: config.rotationInterval ?? 24 * 60 * 60 * 1000,
      compressionEnabled: config.compressionEnabled ?? true,
      encryptionEnabled: config.encryptionEnabled ?? false,
      nonceEnabled: config.nonceEnabled ?? false,
      maxStateAge: config.maxStateAge ?? 7 * 24 * 60 * 60 * 1000,
      backupEnabled: config.backupEnabled ?? true,
      maxBackups: config.maxBackups ?? 3,
    }

    // Generate random secret if none provided
    if (!this.config.secret) {
      this.config.secret = randomBytes(32).toString('hex')
      liveWarn('state', null, 'No LIVE_STATE_SECRET provided. Using random key (state will not persist across restarts).')
    }

    this.secret = Buffer.from(this.config.secret, 'utf-8')

    if (this.config.rotationEnabled) {
      this.setupKeyRotation()
    }

    if (this.config.nonceEnabled) {
      this.nonceCleanupTimer = setInterval(() => this.cleanupNonces(), 60 * 60 * 1000)
    }
  }

  async signState(
    componentId: string,
    state: Record<string, unknown>,
    version: number,
    options?: { compress?: boolean; backup?: boolean }
  ): Promise<SignedState> {
    let dataStr = JSON.stringify(state)
    let compressed = false
    let encrypted = false

    // Compression
    if ((options?.compress ?? this.config.compressionEnabled) && dataStr.length > 1024) {
      const compressedBuf = gzipSync(Buffer.from(dataStr, 'utf-8'))
      const compressedB64 = compressedBuf.toString('base64')
      if (compressedB64.length < dataStr.length * 0.9) {
        dataStr = compressedB64
        compressed = true
      }
    }

    // Encryption
    if (this.config.encryptionEnabled) {
      const iv = randomBytes(16)
      const key = this.deriveEncryptionKey()
      const cipher = createCipheriv('aes-256-cbc', key, iv)
      let encryptedData = cipher.update(dataStr, 'utf-8', 'base64')
      encryptedData += cipher.final('base64')
      dataStr = iv.toString('base64') + ':' + encryptedData
      encrypted = true
    }

    // Nonce
    const nonce = this.config.nonceEnabled ? randomBytes(16).toString('hex') : undefined

    const signedState: SignedState = {
      data: dataStr,
      signature: '',
      timestamp: Date.now(),
      version,
      componentId,
      nonce,
      compressed,
      encrypted
    }

    signedState.signature = this.computeSignature(signedState)

    // Backup
    if (options?.backup ?? this.config.backupEnabled) {
      this.backupState(componentId, signedState)
    }

    return signedState
  }

  async validateState(signedState: SignedState): Promise<{ valid: boolean; error?: string }> {
    try {
      // Check max age
      const age = Date.now() - signedState.timestamp
      if (age > this.config.maxStateAge) {
        return { valid: false, error: 'State expired' }
      }

      // Check nonce
      if (signedState.nonce && this.config.nonceEnabled) {
        if (this.usedNonces.has(signedState.nonce)) {
          return { valid: false, error: 'Nonce already used (replay attempt)' }
        }
      }

      // Verify signature with current key
      const expectedSig = this.computeSignature(signedState)
      if (this.timingSafeEqual(signedState.signature, expectedSig)) {
        if (signedState.nonce) this.usedNonces.add(signedState.nonce)
        return { valid: true }
      }

      // Try previous keys (rotation)
      for (const prevSecret of this.previousSecrets) {
        const prevSig = this.computeSignatureWithKey(signedState, prevSecret)
        if (this.timingSafeEqual(signedState.signature, prevSig)) {
          if (signedState.nonce) this.usedNonces.add(signedState.nonce)
          return { valid: true }
        }
      }

      return { valid: false, error: 'Invalid signature' }
    } catch (error: any) {
      return { valid: false, error: error.message }
    }
  }

  async extractData(signedState: SignedState): Promise<Record<string, unknown>> {
    let dataStr = signedState.data

    // Decrypt
    if (signedState.encrypted) {
      const [ivB64, encryptedData] = dataStr.split(':')
      const iv = Buffer.from(ivB64, 'base64')
      const key = this.deriveEncryptionKey()
      const decipher = createDecipheriv('aes-256-cbc', key, iv)
      dataStr = decipher.update(encryptedData, 'base64', 'utf-8')
      dataStr += decipher.final('utf-8')
    }

    // Decompress
    if (signedState.compressed) {
      const decompressed = gunzipSync(Buffer.from(dataStr, 'base64'))
      dataStr = decompressed.toString('utf-8')
    }

    return JSON.parse(dataStr)
  }

  getBackups(componentId: string): SignedState[] {
    return (this.stateBackups.get(componentId) || []).map(b => b.signedState)
  }

  getLatestBackup(componentId: string): SignedState | null {
    const backups = this.stateBackups.get(componentId)
    if (!backups || backups.length === 0) return null
    return backups[backups.length - 1].signedState
  }

  private backupState(componentId: string, signedState: SignedState): void {
    if (!this.stateBackups.has(componentId)) {
      this.stateBackups.set(componentId, [])
    }

    const backups = this.stateBackups.get(componentId)!
    backups.push({ signedState, backedUpAt: Date.now() })

    while (backups.length > this.config.maxBackups) {
      backups.shift()
    }
  }

  private computeSignature(signedState: SignedState): string {
    return this.computeSignatureWithKey(signedState, this.secret)
  }

  private computeSignatureWithKey(signedState: SignedState, key: Buffer): string {
    const payload = `${signedState.componentId}:${signedState.version}:${signedState.timestamp}:${signedState.data}${signedState.nonce ? ':' + signedState.nonce : ''}`
    return createHmac('sha256', key).update(payload).digest('hex')
  }

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    try {
      const { timingSafeEqual: tse } = require('crypto')
      return tse(bufA, bufB)
    } catch {
      // Fallback (not timing-safe but functional)
      return a === b
    }
  }

  private deriveEncryptionKey(): Buffer {
    return createHmac('sha256', this.secret).update('encryption-key-derivation').digest()
  }

  private setupKeyRotation(): void {
    this.rotationTimer = setInterval(() => {
      this.previousSecrets.unshift(this.secret)
      if (this.previousSecrets.length > 3) {
        this.previousSecrets.pop()
      }
      this.secret = randomBytes(32)
      liveLog('state', null, 'Key rotation completed')
    }, this.config.rotationInterval)
  }

  private cleanupNonces(): void {
    // Simply clear old nonces periodically
    if (this.usedNonces.size > 100000) {
      this.usedNonces.clear()
    }
  }

  shutdown(): void {
    if (this.rotationTimer) clearInterval(this.rotationTimer)
    if (this.nonceCleanupTimer) clearInterval(this.nonceCleanupTimer)
  }
}
