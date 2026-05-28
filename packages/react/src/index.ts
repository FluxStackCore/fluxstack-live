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


// Live.use() API
export { Live } from './components/Live'

// Helpers de UI de estado (também acessíveis via Live.Boundary / Live.Status)
export { LiveBoundary, LiveStatus } from './components/LiveBoundary'
export type { LiveBoundaryProps, LiveStatusProps } from './components/LiveBoundary'

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
