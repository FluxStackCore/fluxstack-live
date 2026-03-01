// @fluxstack/live-client - Chunked Upload Manager
//
// Framework-agnostic chunked file upload with adaptive sizing and binary protocol.

import type {
  FileUploadStartMessage,
  FileUploadChunkMessage,
  FileUploadCompleteMessage,
  FileUploadProgressResponse,
  FileUploadCompleteResponse,
  BinaryChunkHeader,
} from '@fluxstack/live'

// ===== Adaptive Chunk Sizer =====

export interface AdaptiveChunkConfig {
  minChunkSize: number
  maxChunkSize: number
  initialChunkSize: number
  targetLatency: number
  adjustmentFactor: number
  measurementWindow: number
}

export interface ChunkMetrics {
  chunkIndex: number
  chunkSize: number
  startTime: number
  endTime: number
  latency: number
  throughput: number
  success: boolean
}

export class AdaptiveChunkSizer {
  private config: Required<AdaptiveChunkConfig>
  private currentChunkSize: number
  private metrics: ChunkMetrics[] = []
  private consecutiveErrors = 0
  private consecutiveSuccesses = 0

  constructor(config: Partial<AdaptiveChunkConfig> = {}) {
    this.config = {
      minChunkSize: config.minChunkSize ?? 16 * 1024,
      maxChunkSize: config.maxChunkSize ?? 1024 * 1024,
      initialChunkSize: config.initialChunkSize ?? 64 * 1024,
      targetLatency: config.targetLatency ?? 200,
      adjustmentFactor: config.adjustmentFactor ?? 1.5,
      measurementWindow: config.measurementWindow ?? 3,
    }
    this.currentChunkSize = this.config.initialChunkSize
  }

  getChunkSize(): number {
    return this.currentChunkSize
  }

  recordChunkStart(_chunkIndex: number): number {
    return Date.now()
  }

  recordChunkComplete(chunkIndex: number, chunkSize: number, startTime: number, success: boolean): void {
    const endTime = Date.now()
    const latency = endTime - startTime
    const throughput = success ? (chunkSize / latency) * 1000 : 0

    this.metrics.push({ chunkIndex, chunkSize, startTime, endTime, latency, throughput, success })

    if (this.metrics.length > this.config.measurementWindow * 2) {
      this.metrics = this.metrics.slice(-this.config.measurementWindow * 2)
    }

    if (success) {
      this.consecutiveSuccesses++
      this.consecutiveErrors = 0
      this.adjustUp(latency)
    } else {
      this.consecutiveErrors++
      this.consecutiveSuccesses = 0
      this.adjustDown()
    }
  }

  private adjustUp(latency: number): void {
    if (this.consecutiveSuccesses < 2) return
    if (latency > this.config.targetLatency) return

    const latencyRatio = this.config.targetLatency / latency
    let newSize = Math.floor(this.currentChunkSize * Math.min(latencyRatio, this.config.adjustmentFactor))
    newSize = Math.min(newSize, this.config.maxChunkSize)
    if (newSize > this.currentChunkSize) this.currentChunkSize = newSize
  }

  private adjustDown(): void {
    const decreaseFactor = this.consecutiveErrors > 1 ? 2 : this.config.adjustmentFactor
    let newSize = Math.floor(this.currentChunkSize / decreaseFactor)
    newSize = Math.max(newSize, this.config.minChunkSize)
    if (newSize < this.currentChunkSize) this.currentChunkSize = newSize
  }

  getAverageThroughput(): number {
    const recent = this.metrics.slice(-this.config.measurementWindow).filter(m => m.success)
    if (recent.length === 0) return 0
    return recent.reduce((sum, m) => sum + m.throughput, 0) / recent.length
  }

  getStats() {
    return {
      currentChunkSize: this.currentChunkSize,
      averageThroughput: this.getAverageThroughput(),
      consecutiveSuccesses: this.consecutiveSuccesses,
      consecutiveErrors: this.consecutiveErrors,
      totalMeasurements: this.metrics.length,
    }
  }

  reset(): void {
    this.currentChunkSize = this.config.initialChunkSize
    this.metrics = []
    this.consecutiveErrors = 0
    this.consecutiveSuccesses = 0
  }
}

// ===== Binary Protocol =====

/**
 * Creates a binary message with header + data
 * Format: [4 bytes header length LE][JSON header][binary data]
 */
export function createBinaryChunkMessage(header: BinaryChunkHeader, chunkData: Uint8Array): ArrayBuffer {
  const headerJson = JSON.stringify(header)
  const headerBytes = new TextEncoder().encode(headerJson)

  const totalSize = 4 + headerBytes.length + chunkData.length
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  const uint8View = new Uint8Array(buffer)

  view.setUint32(0, headerBytes.length, true)
  uint8View.set(headerBytes, 4)
  uint8View.set(chunkData, 4 + headerBytes.length)

  return buffer
}

// ===== Chunked Uploader =====

export interface ChunkedUploadOptions {
  chunkSize?: number
  maxFileSize?: number
  allowedTypes?: string[]
  sendMessageAndWait: (message: any, timeout?: number) => Promise<any>
  sendBinaryAndWait?: (data: ArrayBuffer, requestId: string, timeout?: number) => Promise<any>
  onProgress?: (progress: number, bytesUploaded: number, totalBytes: number) => void
  onComplete?: (response: FileUploadCompleteResponse) => void
  onError?: (error: string) => void
  adaptiveChunking?: boolean
  adaptiveConfig?: Partial<AdaptiveChunkConfig>
  useBinaryProtocol?: boolean
}

export interface ChunkedUploadState {
  uploading: boolean
  progress: number
  error: string | null
  uploadId: string | null
  bytesUploaded: number
  totalBytes: number
}

/**
 * Framework-agnostic chunked file uploader.
 * Manages the upload lifecycle without any UI framework dependency.
 */
export class ChunkedUploader {
  private options: Required<Pick<ChunkedUploadOptions, 'chunkSize' | 'maxFileSize' | 'allowedTypes' | 'useBinaryProtocol' | 'adaptiveChunking'>> & ChunkedUploadOptions
  private abortController: AbortController | null = null
  private adaptiveSizer: AdaptiveChunkSizer | null = null
  private _state: ChunkedUploadState = {
    uploading: false,
    progress: 0,
    error: null,
    uploadId: null,
    bytesUploaded: 0,
    totalBytes: 0,
  }
  private stateListeners = new Set<(state: ChunkedUploadState) => void>()

  constructor(
    private componentId: string,
    options: ChunkedUploadOptions,
  ) {
    this.options = {
      chunkSize: options.chunkSize ?? 64 * 1024,
      maxFileSize: options.maxFileSize ?? 50 * 1024 * 1024,
      allowedTypes: options.allowedTypes ?? [],
      useBinaryProtocol: options.useBinaryProtocol ?? true,
      adaptiveChunking: options.adaptiveChunking ?? false,
      ...options,
    }

    if (this.options.adaptiveChunking) {
      this.adaptiveSizer = new AdaptiveChunkSizer({
        initialChunkSize: this.options.chunkSize,
        minChunkSize: this.options.chunkSize,
        maxChunkSize: 1024 * 1024,
        ...options.adaptiveConfig,
      })
    }
  }

  get state(): ChunkedUploadState {
    return { ...this._state }
  }

  onStateChange(callback: (state: ChunkedUploadState) => void): () => void {
    this.stateListeners.add(callback)
    return () => { this.stateListeners.delete(callback) }
  }

  private setState(patch: Partial<ChunkedUploadState>) {
    this._state = { ...this._state, ...patch }
    for (const cb of this.stateListeners) cb(this._state)
  }

  async uploadFile(file: File): Promise<void> {
    const { allowedTypes, maxFileSize, chunkSize, sendMessageAndWait, sendBinaryAndWait, useBinaryProtocol } = this.options
    const canUseBinary = useBinaryProtocol && sendBinaryAndWait

    // Validate
    if (allowedTypes.length > 0 && !allowedTypes.includes(file.type)) {
      const error = `Invalid file type: ${file.type}. Allowed: ${allowedTypes.join(', ')}`
      this.setState({ error })
      this.options.onError?.(error)
      return
    }

    if (file.size > maxFileSize) {
      const error = `File too large: ${file.size} bytes. Max: ${maxFileSize} bytes`
      this.setState({ error })
      this.options.onError?.(error)
      return
    }

    try {
      const uploadId = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
      this.abortController = new AbortController()
      this.adaptiveSizer?.reset()

      this.setState({ uploading: true, progress: 0, error: null, uploadId, bytesUploaded: 0, totalBytes: file.size })

      const initialChunkSize = this.adaptiveSizer?.getChunkSize() ?? chunkSize

      // Start upload
      const startMessage: FileUploadStartMessage = {
        type: 'FILE_UPLOAD_START',
        componentId: this.componentId,
        uploadId,
        filename: file.name,
        fileType: file.type,
        fileSize: file.size,
        chunkSize,
        requestId: `start-${uploadId}`,
      }

      const startResponse = await sendMessageAndWait(startMessage, 10000)
      if (!startResponse?.success) throw new Error(startResponse?.error || 'Failed to start upload')

      let offset = 0
      let chunkIndex = 0
      const estimatedTotalChunks = Math.ceil(file.size / initialChunkSize)

      while (offset < file.size) {
        if (this.abortController?.signal.aborted) throw new Error('Upload cancelled')

        const currentChunkSize = this.adaptiveSizer?.getChunkSize() ?? chunkSize
        const chunkEnd = Math.min(offset + currentChunkSize, file.size)
        const sliceBuffer = await file.slice(offset, chunkEnd).arrayBuffer()
        const chunkBytes = new Uint8Array(sliceBuffer)
        const chunkStartTime = this.adaptiveSizer?.recordChunkStart(chunkIndex) ?? 0
        const requestId = `chunk-${uploadId}-${chunkIndex}`

        try {
          let progressResponse: FileUploadProgressResponse | undefined

          if (canUseBinary) {
            const header: BinaryChunkHeader = {
              type: 'FILE_UPLOAD_CHUNK',
              componentId: this.componentId,
              uploadId,
              chunkIndex,
              totalChunks: estimatedTotalChunks,
              requestId,
            }
            const binaryMessage = createBinaryChunkMessage(header, chunkBytes)
            progressResponse = await sendBinaryAndWait!(binaryMessage, requestId, 10000) as FileUploadProgressResponse
          } else {
            let binary = ''
            for (let j = 0; j < chunkBytes.length; j++) binary += String.fromCharCode(chunkBytes[j])

            const chunkMessage: FileUploadChunkMessage = {
              type: 'FILE_UPLOAD_CHUNK',
              componentId: this.componentId,
              uploadId,
              chunkIndex,
              totalChunks: estimatedTotalChunks,
              data: btoa(binary),
              requestId,
            }
            progressResponse = await sendMessageAndWait!(chunkMessage, 10000) as FileUploadProgressResponse
          }

          if (progressResponse) {
            this.setState({ progress: progressResponse.progress, bytesUploaded: progressResponse.bytesUploaded })
            this.options.onProgress?.(progressResponse.progress, progressResponse.bytesUploaded, file.size)
          }

          this.adaptiveSizer?.recordChunkComplete(chunkIndex, chunkBytes.length, chunkStartTime, true)
        } catch (error) {
          this.adaptiveSizer?.recordChunkComplete(chunkIndex, chunkBytes.length, chunkStartTime, false)
          throw error
        }

        offset += chunkBytes.length
        chunkIndex++

        if (!this.options.adaptiveChunking) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }

      // Complete
      const completeMessage: FileUploadCompleteMessage = {
        type: 'FILE_UPLOAD_COMPLETE',
        componentId: this.componentId,
        uploadId,
        requestId: `complete-${uploadId}`,
      }

      const completeResponse = await sendMessageAndWait(completeMessage, 10000) as FileUploadCompleteResponse

      if (completeResponse?.success) {
        this.setState({ uploading: false, progress: 100, bytesUploaded: file.size })
        this.options.onComplete?.(completeResponse)
      } else {
        throw new Error(completeResponse?.error || 'Upload completion failed')
      }
    } catch (error: any) {
      this.setState({ uploading: false, error: error.message })
      this.options.onError?.(error.message)
    }
  }

  cancelUpload(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.setState({ uploading: false, error: 'Upload cancelled' })
    }
  }

  reset(): void {
    this._state = { uploading: false, progress: 0, error: null, uploadId: null, bytesUploaded: 0, totalBytes: 0 }
    for (const cb of this.stateListeners) cb(this._state)
  }
}
