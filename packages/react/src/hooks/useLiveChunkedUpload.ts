// @fluxstack/live-react - useLiveChunkedUpload Hook

import { useMemo } from 'react'
import { useLiveComponents } from '../LiveComponentsProvider'
import { useChunkedUpload } from './useChunkedUpload'
import type { ChunkedUploadOptions } from '@fluxstack/live-client'
import type { FileUploadCompleteResponse } from '@fluxstack/live'

/** Actions que o componente de upload do servidor precisa expor (o retorno é ignorado). */
type LiveUploadActions = {
  $componentId: string | null
  startUpload: (payload: { fileName: string; fileSize: number; fileType: string }) => Promise<unknown>
  updateProgress: (payload: { progress: number; bytesUploaded: number; totalBytes: number }) => Promise<unknown>
  completeUpload: (payload: { fileUrl: string }) => Promise<unknown>
  failUpload: (payload: { error: string }) => Promise<unknown>
  reset: () => Promise<unknown>
}

export interface LiveChunkedUploadOptions extends Omit<ChunkedUploadOptions, 'sendMessageAndWait' | 'onProgress' | 'onComplete' | 'onError'> {
  onProgress?: (progress: number, bytesUploaded: number, totalBytes: number) => void
  onComplete?: (response: FileUploadCompleteResponse) => void
  onError?: (error: string) => void
  fileUrlResolver?: (fileUrl: string) => string
}

export function useLiveChunkedUpload(live: LiveUploadActions, options: LiveChunkedUploadOptions = {}) {
  const { sendMessageAndWait, sendBinaryAndWait } = useLiveComponents()
  const { onProgress, onComplete, onError, fileUrlResolver, ...chunkedOptions } = options
  const componentId = live.$componentId ?? ''

  const base = useChunkedUpload(componentId, {
    ...chunkedOptions,
    sendMessageAndWait,
    sendBinaryAndWait,
    onProgress: (pct, uploaded, total) => {
      void live.updateProgress({ progress: pct, bytesUploaded: uploaded, totalBytes: total }).catch(() => {})
      onProgress?.(pct, uploaded, total)
    },
    onComplete: (response) => {
      const rawUrl = response.fileUrl || ''
      const resolvedUrl = fileUrlResolver ? fileUrlResolver(rawUrl) : rawUrl
      void live.completeUpload({ fileUrl: resolvedUrl }).catch(() => {})
      onComplete?.(response)
    },
    onError: (error) => {
      void live.failUpload({ error }).catch(() => {})
      onError?.(error)
    },
  })

  const uploadFile = useMemo(() => {
    return async (file: File) => {
      if (!live.$componentId) {
        const msg = 'WebSocket not ready. Wait a moment and try again.'
        void live.failUpload({ error: msg }).catch(() => {})
        onError?.(msg)
        return
      }

      await live.startUpload({
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
      })

      await base.uploadFile(file)
    }
  }, [base, live, onError])

  const reset = useMemo(() => {
    return async () => {
      await live.reset()
      base.reset()
    }
  }, [base, live])

  return { ...base, uploadFile, reset }
}
