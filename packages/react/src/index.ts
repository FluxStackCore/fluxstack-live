// @fluxstack/live-react - React bindings for Live Components
//
// Usage:
//   import { LiveComponentsProvider, Live, useLiveComponent } from '@fluxstack/live-react'

// Provider
export { LiveComponentsProvider, useLiveComponents } from './LiveComponentsProvider'
export type {
  LiveComponentsContextValue,
  LiveComponentsProviderProps,
} from './LiveComponentsProvider'

// Live.use() API
export { Live } from './components/Live'

// Core Hook
export { useLiveComponent, createLiveComponent } from './hooks/useLiveComponent'
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

// Debugger Hook
export { useLiveDebugger } from './hooks/useLiveDebugger'
export type {
  DebugEvent,
  DebugEventType,
  ComponentSnapshot,
  DebugSnapshot,
  DebugFilter,
  UseLiveDebuggerReturn,
  UseLiveDebuggerOptions,
} from './hooks/useLiveDebugger'

// Re-export client types for convenience
export type { LiveAuthOptions } from '@fluxstack/live-client'
