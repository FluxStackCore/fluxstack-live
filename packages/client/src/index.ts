// @fluxstack/live-client - Framework-agnostic browser client
//
// This package provides the core WebSocket connection, room management,
// file upload, state persistence, and validation utilities.
// It has NO dependency on any UI framework (React, Vue, etc.).

// Connection
export { LiveConnection } from './connection'
export type {
  LiveAuthOptions,
  LiveConnectionOptions,
  LiveConnectionState,
} from './connection'

// Component Handle (vanilla JS equivalent of Live.use)
export { LiveComponentHandle } from './component'
export type { LiveComponentOptions } from './component'

// Rooms
export { RoomManager } from './rooms'
export type {
  RoomClientMessage,
  RoomServerMessage,
  RoomHandle,
  RoomProxy,
  RoomManagerOptions,
  EventHandler,
  Unsubscribe,
} from './rooms'

// Upload
export {
  AdaptiveChunkSizer,
  ChunkedUploader,
  createBinaryChunkMessage,
} from './upload'
export type {
  AdaptiveChunkConfig,
  ChunkMetrics,
  ChunkedUploadOptions,
  ChunkedUploadState,
} from './upload'

// Persistence
export {
  persistState,
  getPersistedState,
  clearPersistedState,
} from './persistence'
export type { PersistedState } from './persistence'

// State Validation
export { StateValidator } from './state-validator'
export type {
  StateValidation,
  StateConflict,
  HybridState,
} from './state-validator'
