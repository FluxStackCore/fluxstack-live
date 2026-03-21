import { useMemo } from 'react'
import { Live, useLiveChunkedUpload } from '@fluxstack/live-react'
import type { LiveChunkedUploadOptions } from '@fluxstack/live-react'
import type { FileUploadCompleteResponse, LiveComponent } from '@fluxstack/live'

export interface UseLiveUploadOptions {
  /**
   * The LiveUpload component class from your app.
   * Must have a static `defaultState` and a `failUpload` action.
   */
  component: typeof LiveComponent & { defaultState: any }
  live?: {
    room?: string
    userId?: string
    autoMount?: boolean
    debug?: boolean
  }
  upload?: LiveChunkedUploadOptions
  onProgress?: (progress: number, bytesUploaded: number, totalBytes: number) => void
  onComplete?: (response: FileUploadCompleteResponse) => void
  onError?: (error: string) => void
}

export function useLiveUpload(options: UseLiveUploadOptions) {
  const { component, live: liveOptions, upload: uploadOptions, onProgress, onComplete, onError } = options

  const live = Live.use(component as any, {
    initialState: component.defaultState,
    ...liveOptions
  })

  const mergedUploadOptions = useMemo<LiveChunkedUploadOptions>(() => {
    return {
      allowedTypes: [],
      maxFileSize: 500 * 1024 * 1024,
      adaptiveChunking: true,
      fileUrlResolver: (fileUrl: string) => fileUrl.startsWith('/uploads/') ? `/api${fileUrl}` : fileUrl,
      onProgress,
      onComplete,
      onError,
      ...uploadOptions
    }
  }, [onProgress, onComplete, onError, uploadOptions])

  const upload = useLiveChunkedUpload(live as any, mergedUploadOptions)

  const startUpload = useMemo(() => {
    return async (file: File) => {
      if (!live.$connected || !live.$componentId) {
        const msg = 'WebSocket nao conectado. Tente novamente.'
        onError?.(msg)
        await (live as any).failUpload({ error: msg })
        return
      }
      await upload.uploadFile(file)
    }
  }, [live, upload, onError])

  return {
    live,
    state: live.$state,
    status: (live.$state as any).status,
    connected: live.$connected,
    componentId: live.$componentId,
    uploading: upload.uploading,
    progress: upload.progress,
    bytesUploaded: upload.bytesUploaded,
    totalBytes: upload.totalBytes,
    error: (live.$state as any).error,
    startUpload,
    cancelUpload: upload.cancelUpload,
    reset: upload.reset
  }
}
