// @fluxstack/live-react - React bindings for Live Components
//
// Usage:
//   import { LiveComponentsProvider, Live, useLive } from '@fluxstack/live-react'

// Provider
export { LiveComponentsProvider, useLiveComponents } from './LiveComponentsProvider'
export type {
  LiveComponentsContextValue,
  LiveComponentsProviderProps,
} from './LiveComponentsProvider'

// SSR-safe Provider (drop-in replacement for SSR apps)
export { SSRLiveProvider, useSSRLiveComponents } from './SSRLiveProvider'

// Live.use() API
export { Live } from './components/Live'

// Core Hook
export { useLiveComponent, useLiveComponent as useLive, createLiveComponent } from './hooks/useLiveComponent'
export type {
  LiveComponentProxy,
  LiveComponentProxyWithBroadcasts,
  LiveProxy,
  LiveProxyWithBroadcasts,
  UseLiveComponentOptions,
  HybridComponentOptions,
  FieldOptions,
  FieldBinding,
} from './hooks/useLiveComponent'

// Upload Hooks
export { useChunkedUpload } from './hooks/useChunkedUpload'
export type { ChunkedUploadOptions, ChunkedUploadState } from './hooks/useChunkedUpload'
export { useLiveChunkedUpload } from './hooks/useLiveChunkedUpload'
export type { LiveChunkedUploadOptions } from './hooks/useLiveChunkedUpload'

// Re-export client types for convenience
export type { LiveAuthOptions } from '@fluxstack/live-client'
