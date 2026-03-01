// @fluxstack/live - File Upload Manager
//
// Handles chunked file uploads over WebSocket with security validations.

import { liveLog, liveWarn } from '../debug/LiveLogger'
import type {
  ActiveUpload,
  FileUploadStartMessage,
  FileUploadChunkMessage,
  FileUploadCompleteMessage,
  FileUploadProgressResponse,
  FileUploadCompleteResponse
} from '../protocol/messages'

// Magic bytes mapping for content validation
const MAGIC_BYTES: Record<string, { bytes: number[]; offset?: number }[]> = {
  'image/jpeg': [{ bytes: [0xFF, 0xD8, 0xFF] }],
  'image/png': [{ bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }],
  'image/gif': [
    { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
    { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  ],
  'image/webp': [{ bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }],
  'application/pdf': [{ bytes: [0x25, 0x50, 0x44, 0x46] }],
  'application/zip': [
    { bytes: [0x50, 0x4B, 0x03, 0x04] },
    { bytes: [0x50, 0x4B, 0x05, 0x06] },
  ],
  'application/gzip': [{ bytes: [0x1F, 0x8B] }],
}

export interface FileUploadConfig {
  maxUploadSize?: number
  chunkTimeout?: number
  maxBytesPerUser?: number
  quotaResetInterval?: number
  allowedTypes?: string[]
  blockedExtensions?: string[]
  uploadsDir?: string
  /** Custom file assembly handler - if not provided, uses default fs assembly */
  assembleFile?: (upload: ActiveUpload) => Promise<string>
}

export class FileUploadManager {
  private activeUploads = new Map<string, ActiveUpload>()
  private readonly maxUploadSize: number
  private readonly chunkTimeout: number
  private userUploadBytes = new Map<string, number>()
  private readonly maxBytesPerUser: number
  private readonly quotaResetInterval: number
  private readonly allowedTypes: string[]
  private readonly blockedExtensions: Set<string>
  private readonly uploadsDir: string
  private readonly customAssembleFile?: (upload: ActiveUpload) => Promise<string>

  private cleanupTimer?: ReturnType<typeof setInterval>
  private quotaTimer?: ReturnType<typeof setInterval>

  constructor(config: FileUploadConfig = {}) {
    this.maxUploadSize = config.maxUploadSize ?? 50 * 1024 * 1024
    this.chunkTimeout = config.chunkTimeout ?? 30000
    this.maxBytesPerUser = config.maxBytesPerUser ?? 500 * 1024 * 1024
    this.quotaResetInterval = config.quotaResetInterval ?? 24 * 60 * 60 * 1000
    this.allowedTypes = config.allowedTypes ?? [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'application/pdf',
      'text/plain', 'text/csv', 'text/markdown',
      'application/json',
      'application/zip', 'application/gzip',
    ]
    this.blockedExtensions = new Set(config.blockedExtensions ?? [
      '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
      '.sh', '.bash', '.zsh', '.csh',
      '.ps1', '.psm1', '.psd1',
      '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
      '.dll', '.sys', '.drv', '.so', '.dylib',
    ])
    this.uploadsDir = config.uploadsDir ?? './uploads'
    this.customAssembleFile = config.assembleFile

    this.cleanupTimer = setInterval(() => this.cleanupStaleUploads(), 5 * 60 * 1000)
    this.quotaTimer = setInterval(() => this.resetUploadQuotas(), this.quotaResetInterval)
  }

  async startUpload(message: FileUploadStartMessage, userId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { uploadId, componentId, filename, fileType, fileSize, chunkSize = 64 * 1024 } = message

      if (fileSize > this.maxUploadSize) {
        throw new Error(`File too large: ${fileSize} bytes. Max: ${this.maxUploadSize} bytes`)
      }

      if (userId) {
        const currentUsage = this.userUploadBytes.get(userId) || 0
        if (currentUsage + fileSize > this.maxBytesPerUser) {
          throw new Error(`Upload quota exceeded for user.`)
        }
      }

      if (this.allowedTypes.length > 0 && !this.allowedTypes.includes(fileType)) {
        throw new Error(`File type not allowed: ${fileType}`)
      }

      // Sanitize filename
      const pathModule = await import('path')
      const safeBase = pathModule.basename(filename)
      const ext = pathModule.extname(safeBase).toLowerCase()
      if (this.blockedExtensions.has(ext)) {
        throw new Error(`File extension not allowed: ${ext}`)
      }

      // Double extension prevention
      const parts = safeBase.split('.')
      if (parts.length > 2) {
        for (let i = 1; i < parts.length - 1; i++) {
          const intermediateExt = '.' + parts[i].toLowerCase()
          if (this.blockedExtensions.has(intermediateExt)) {
            throw new Error(`Suspicious double extension detected: ${intermediateExt} in ${safeBase}`)
          }
        }
      }

      if (safeBase.length > 255) {
        throw new Error('Filename too long')
      }

      if (this.activeUploads.has(uploadId)) {
        throw new Error(`Upload ${uploadId} already in progress`)
      }

      const totalChunks = Math.ceil(fileSize / chunkSize)
      const upload: ActiveUpload = {
        uploadId,
        componentId,
        filename,
        fileType,
        fileSize,
        totalChunks,
        receivedChunks: new Map(),
        bytesReceived: 0,
        startTime: Date.now(),
        lastChunkTime: Date.now()
      }

      this.activeUploads.set(uploadId, upload)

      if (userId) {
        const currentUsage = this.userUploadBytes.get(userId) || 0
        this.userUploadBytes.set(userId, currentUsage + fileSize)
      }

      liveLog('messages', componentId, `Upload started: ${uploadId} (${filename}, ${fileSize} bytes)`)

      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async receiveChunk(message: FileUploadChunkMessage, binaryData: Buffer | null = null): Promise<FileUploadProgressResponse | null> {
    const { uploadId, chunkIndex, totalChunks, data } = message

    const upload = this.activeUploads.get(uploadId)
    if (!upload) throw new Error(`Upload ${uploadId} not found`)

    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      throw new Error(`Invalid chunk index: ${chunkIndex}`)
    }

    if (!upload.receivedChunks.has(chunkIndex)) {
      let chunkBytes: number
      if (binaryData) {
        upload.receivedChunks.set(chunkIndex, binaryData)
        chunkBytes = binaryData.length
      } else {
        upload.receivedChunks.set(chunkIndex, data as string)
        chunkBytes = Buffer.from(data as string, 'base64').length
      }
      upload.lastChunkTime = Date.now()
      upload.bytesReceived += chunkBytes
    }

    const progress = (upload.bytesReceived / upload.fileSize) * 100

    return {
      type: 'FILE_UPLOAD_PROGRESS',
      componentId: upload.componentId,
      uploadId: upload.uploadId,
      chunkIndex,
      totalChunks,
      bytesUploaded: Math.min(upload.bytesReceived, upload.fileSize),
      totalBytes: upload.fileSize,
      progress: Math.min(progress, 100),
      timestamp: Date.now()
    }
  }

  async completeUpload(message: FileUploadCompleteMessage): Promise<FileUploadCompleteResponse> {
    try {
      const { uploadId } = message

      const upload = this.activeUploads.get(uploadId)
      if (!upload) throw new Error(`Upload ${uploadId} not found`)

      if (upload.bytesReceived !== upload.fileSize) {
        throw new Error(`Incomplete upload: received ${upload.bytesReceived}/${upload.fileSize} bytes`)
      }

      this.validateContentMagicBytes(upload)

      const fileUrl = this.customAssembleFile
        ? await this.customAssembleFile(upload)
        : await this.defaultAssembleFile(upload)

      this.activeUploads.delete(uploadId)

      return {
        type: 'FILE_UPLOAD_COMPLETE',
        componentId: upload.componentId,
        uploadId: upload.uploadId,
        success: true,
        filename: upload.filename,
        fileUrl,
        timestamp: Date.now()
      }
    } catch (error: any) {
      return {
        type: 'FILE_UPLOAD_COMPLETE',
        componentId: '',
        uploadId: message.uploadId,
        success: false,
        error: error.message,
        timestamp: Date.now()
      }
    }
  }

  private async defaultAssembleFile(upload: ActiveUpload): Promise<string> {
    const { writeFile, mkdir } = await import('fs/promises')
    const { existsSync } = await import('fs')
    const { join, extname, basename } = await import('path')

    if (!existsSync(this.uploadsDir)) {
      await mkdir(this.uploadsDir, { recursive: true })
    }

    const extension = extname(basename(upload.filename)).toLowerCase()
    const safeFilename = `${crypto.randomUUID()}${extension}`
    const filePath = join(this.uploadsDir, safeFilename)

    const chunks: Buffer[] = []
    for (let i = 0; i < upload.totalChunks; i++) {
      const chunkData = upload.receivedChunks.get(i)
      if (chunkData) {
        if (Buffer.isBuffer(chunkData)) {
          chunks.push(chunkData)
        } else {
          chunks.push(Buffer.from(chunkData, 'base64'))
        }
      }
    }

    await writeFile(filePath, Buffer.concat(chunks))
    return `/uploads/${safeFilename}`
  }

  private validateContentMagicBytes(upload: ActiveUpload): void {
    const expectedSignatures = MAGIC_BYTES[upload.fileType]
    if (!expectedSignatures) return

    const firstChunk = upload.receivedChunks.get(0)
    if (!firstChunk) throw new Error('Cannot validate file content: first chunk missing')

    const headerBuffer = Buffer.isBuffer(firstChunk)
      ? firstChunk
      : Buffer.from(firstChunk, 'base64')

    let matched = false
    for (const sig of expectedSignatures) {
      const offset = sig.offset ?? 0
      if (headerBuffer.length < offset + sig.bytes.length) continue

      let sigMatches = true
      for (let i = 0; i < sig.bytes.length; i++) {
        if (headerBuffer[offset + i] !== sig.bytes[i]) {
          sigMatches = false
          break
        }
      }

      if (sigMatches) {
        matched = true
        break
      }
    }

    if (!matched) {
      throw new Error(
        `File content does not match claimed type '${upload.fileType}'. ` +
        `The file may be disguised as a different format.`
      )
    }
  }

  private cleanupStaleUploads(): void {
    const now = Date.now()
    for (const [uploadId, upload] of this.activeUploads) {
      if (now - upload.lastChunkTime > this.chunkTimeout * 2) {
        this.activeUploads.delete(uploadId)
        liveLog('messages', null, `Cleaned up stale upload: ${uploadId}`)
      }
    }
  }

  private resetUploadQuotas(): void {
    this.userUploadBytes.clear()
  }

  getUserUploadUsage(userId: string): { used: number; limit: number; remaining: number } {
    const used = this.userUploadBytes.get(userId) || 0
    return { used, limit: this.maxBytesPerUser, remaining: Math.max(0, this.maxBytesPerUser - used) }
  }

  getUploadStatus(uploadId: string): ActiveUpload | null {
    return this.activeUploads.get(uploadId) || null
  }

  getStats() {
    return {
      activeUploads: this.activeUploads.size,
      maxUploadSize: this.maxUploadSize,
      allowedTypes: this.allowedTypes
    }
  }

  shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    if (this.quotaTimer) clearInterval(this.quotaTimer)
  }
}
