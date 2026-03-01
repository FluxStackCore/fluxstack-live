// @fluxstack/live-react - useChunkedUpload Hook
//
// React hook wrapping ChunkedUploader from @fluxstack/live-client.

import { useState, useCallback, useRef } from 'react'
import { ChunkedUploader } from '@fluxstack/live-client'
import type { ChunkedUploadOptions, ChunkedUploadState } from '@fluxstack/live-client'

export type { ChunkedUploadOptions, ChunkedUploadState }

export function useChunkedUpload(componentId: string, options: ChunkedUploadOptions) {
  const [state, setState] = useState<ChunkedUploadState>({
    uploading: false,
    progress: 0,
    error: null,
    uploadId: null,
    bytesUploaded: 0,
    totalBytes: 0,
  })

  const uploaderRef = useRef<ChunkedUploader | null>(null)

  if (!uploaderRef.current) {
    uploaderRef.current = new ChunkedUploader(componentId, {
      ...options,
      onProgress: (progress, bytesUploaded, totalBytes) => {
        setState(prev => ({ ...prev, progress, bytesUploaded }))
        options.onProgress?.(progress, bytesUploaded, totalBytes)
      },
      onComplete: (response) => {
        setState(prev => ({ ...prev, uploading: false, progress: 100, bytesUploaded: prev.totalBytes }))
        options.onComplete?.(response)
      },
      onError: (error) => {
        setState(prev => ({ ...prev, uploading: false, error }))
        options.onError?.(error)
      },
    })
  }

  const uploadFile = useCallback(async (file: File) => {
    setState({ uploading: true, progress: 0, error: null, uploadId: null, bytesUploaded: 0, totalBytes: file.size })
    await uploaderRef.current!.uploadFile(file)
  }, [])

  const cancelUpload = useCallback(() => {
    uploaderRef.current?.cancelUpload()
    setState(prev => ({ ...prev, uploading: false, error: 'Upload cancelled' }))
  }, [])

  const reset = useCallback(() => {
    uploaderRef.current?.reset()
    setState({ uploading: false, progress: 0, error: null, uploadId: null, bytesUploaded: 0, totalBytes: 0 })
  }, [])

  return { ...state, uploadFile, cancelUpload, reset }
}
