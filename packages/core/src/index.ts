// @fluxstack/live - Main Entry Point
//
// Framework-agnostic Live Components for real-time server-client state synchronization.

// ===== LiveServer (main entry) =====
export { LiveServer, type LiveServerOptions } from './server/LiveServer'

// ===== LiveComponent Base Class =====
export { LiveComponent, EMIT_OVERRIDE_KEY } from './component/LiveComponent'

// ===== Transport Types (for adapter authors) =====
export type {
  GenericWebSocket,
  LiveWSData,
  FluxStackWebSocket,
  FluxStackWSData,
  LiveTransport,
  WebSocketConfig,
  HttpRouteDefinition,
  HttpRequest,
  HttpResponse,
} from './transport/types'
export { queueWsMessage, sendImmediate, sendBinaryImmediate } from './transport/WsSendBatcher'

// ===== Protocol Messages =====
export type {
  LiveMessage,
  WebSocketResponse,
  RoomMessage,
  ComponentState,
  BroadcastMessage,
  ComponentDefinition,
  LiveComponentInstance,
  ServerRoomHandle,
  ServerRoomProxy,
  FileChunkData,
  FileUploadStartMessage,
  FileUploadChunkMessage,
  FileUploadCompleteMessage,
  FileUploadProgressResponse,
  FileUploadCompleteResponse,
  BinaryChunkHeader,
  ActiveUpload,
  HybridState,
  HybridComponentOptions,
  WebSocketMessage,
} from './protocol/messages'
export { encodeBinaryChunk, decodeBinaryChunk } from './protocol/binary'
export { PROTOCOL_VERSION, DEFAULT_WS_PATH, DEFAULT_CHUNK_SIZE } from './protocol/constants'

// ===== Auth System =====
export type {
  LiveAuthCredentials,
  LiveAuthSession,
  LiveAuthUser,
  LiveAuthContext,
  LiveAuthProvider,
  LiveComponentAuth,
  LiveComponentAuthorize,
  LiveActionAuth,
  LiveActionAuthorize,
  LiveActionAuthMap,
  LiveAuthResult,
} from './auth/types'
export { AuthenticatedContext, AnonymousContext, ANONYMOUS_CONTEXT } from './auth/LiveAuthContext'
export { LiveAuthManager } from './auth/LiveAuthManager'

// ===== Rooms =====
export { RoomEventBus, createTypedRoomEventBus, type EventHandler, type RoomSubscription } from './rooms/RoomEventBus'
export { RoomStateManager, createTypedRoomState, type RoomStateData, type RoomInfo } from './rooms/RoomStateManager'
export { LiveRoomManager } from './rooms/LiveRoomManager'
export type { IRoomStorageAdapter, IRoomPubSubAdapter } from './rooms/adapters'
export { InMemoryRoomAdapter } from './rooms/InMemoryRoomAdapter'
export { LiveRoom } from './rooms/LiveRoom'
export type {
  LiveRoomClass,
  LiveRoomOptions,
  RoomJoinContext,
  RoomLeaveContext,
  RoomEventContext,
  InferRoomState,
  InferRoomMeta,
  InferRoomEvents,
} from './rooms/LiveRoom'
export { RoomRegistry } from './rooms/RoomRegistry'
export {
  msgpackCodec,
  jsonCodec,
  resolveCodec,
  buildRoomFrame,
  buildRoomFrameTail,
  prependMemberHeader,
  parseRoomFrame,
  BINARY_ROOM_EVENT,
  BINARY_ROOM_STATE,
  type RoomCodec,
  type RoomCodecOption,
} from './rooms/RoomCodec'

// ===== Debug & Logging =====
export {
  liveLog,
  liveWarn,
  registerComponentLogging,
  unregisterComponentLogging,
  type LiveLogCategory,
  type LiveLogConfig,
} from './debug/LiveLogger'

// ===== Security =====
export { StateSignatureManager, type SignedState, type StateSignatureConfig } from './security/StateSignature'

// ===== Performance =====
export {
  PerformanceMonitor,
  type ComponentPerformanceMetrics,
  type PerformanceAlert,
  type PerformanceConfig,
} from './monitoring/PerformanceMonitor'

// ===== Connection =====
export { WebSocketConnectionManager, type ConnectionConfig, type ConnectionMetrics, type ConnectionHealth } from './connection/WebSocketConnectionManager'
export { ConnectionRateLimiter, RateLimiterRegistry } from './connection/RateLimiter'

// ===== File Upload =====
export { FileUploadManager, type FileUploadConfig } from './upload/FileUploadManager'

// ===== Component Registry =====
export {
  ComponentRegistry,
  type ComponentMetadata,
  type ComponentMetrics,
  type StateMigration,
} from './component/ComponentRegistry'

// ===== DI Context =====
export { setLiveComponentContext, getLiveComponentContext, type LiveComponentContext, type LiveRoomManagerInterface } from './component/context'

// ===== Cluster Adapter =====
export type {
  IClusterAdapter,
  ClusterComponentState,
  ClusterSingletonOwner,
  ClusterSingletonClaim,
  ClusterActionRequest,
  ClusterActionResponse,
  ClusterDeltaHandler,
} from './cluster'

// ===== Type Utilities =====
export type {
  ExtractActions,
  ActionNames,
  ActionPayload,
  ActionReturn,
  InferComponentState,
  InferPrivateState,
  TypedCall,
  TypedCallAndWait,
  TypedSetValue,
  UseTypedLiveComponentReturn,
} from './component/types'
