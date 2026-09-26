// @fluxstack/live - Protocol Message Types
//
// FROZEN: These message types define the wire protocol between client and server.
// Do NOT change existing types — only add new ones.

import type { SignedState } from '../security/StateSignature'
import type { LiveAuthCredentials } from '../auth/types'
import type { GenericWebSocket } from '../transport/types'
import type { LiveComponent } from '../component/LiveComponent'

// ===== Client → Server Messages =====

/** Todos os valores de `type` que trafegam no envelope `LiveMessage`. */
export type LiveMessageType =
  'COMPONENT_MOUNT' | 'COMPONENT_UNMOUNT' |
  'COMPONENT_REHYDRATE' | 'COMPONENT_ACTION' | 'CALL_ACTION' |
  'ACTION_RESPONSE' | 'PROPERTY_UPDATE' | 'STATE_UPDATE' | 'STATE_DELTA' | 'STATE_REHYDRATED' |
  // Renovação throttled do signedState (payload: { signedState })
  'STATE_SIGNATURE' |
  'ERROR' | 'BROADCAST' | 'FILE_UPLOAD_START' | 'FILE_UPLOAD_CHUNK' | 'FILE_UPLOAD_COMPLETE' |
  'COMPONENT_PING' | 'COMPONENT_PONG' |
  // Auth system message
  'AUTH' |
  // Room system messages
  'ROOM_JOIN' | 'ROOM_LEAVE' | 'ROOM_EMIT' | 'ROOM_STATE_SET' | 'ROOM_STATE_GET'

/**
 * Envelope genérico de mensagem (usado nos dois sentidos: o servidor também
 * emite `STATE_DELTA`/`STATE_UPDATE`/`ERROR` com este formato).
 *
 * `payload` é `unknown`: quem lê deve estreitar o tipo. Para mensagens vindas
 * do cliente, use `ClientMessage` (já validada por `parseClientMessage`).
 */
export interface LiveMessage {
  type: LiveMessageType
  componentId: string
  action?: string
  property?: string
  payload?: unknown
  timestamp?: number
  userId?: string
  room?: string
  // Request-Response system
  requestId?: string
  responseId?: string
  expectResponse?: boolean
}

/**
 * Payload de cada mensagem cliente → servidor, por `type`.
 *
 * O wire format é o mesmo de sempre; este mapa só descreve o que o servidor
 * aceita depois da validação de forma em `parseClientMessage`
 * (`protocol/validation.ts`).
 */
export interface ClientMessagePayloads {
  COMPONENT_MOUNT: {
    component: string
    props?: Record<string, unknown>
    room?: string
    /** Ignorado pelo servidor (userId vem só da autenticação). */
    userId?: string
    debugLabel?: string
  }
  COMPONENT_UNMOUNT: unknown
  COMPONENT_REHYDRATE: {
    component: string
    signedState: SignedState
    room?: string
    /** Ignorado pelo servidor (userId vem só da autenticação). */
    userId?: string
  }
  /** Payload da action: formato definido por cada componente (valide com `actionSchemas`). */
  CALL_ACTION: unknown
  PROPERTY_UPDATE: { value: unknown }
  AUTH: LiveAuthCredentials | undefined
  ROOM_JOIN: { roomId?: string; initialState?: unknown } | undefined
  ROOM_LEAVE: { roomId?: string } | undefined
  ROOM_EMIT: { roomId?: string; event: string; data?: unknown }
  ROOM_STATE_SET: { roomId?: string; state: Record<string, unknown> }
  ROOM_STATE_GET: { roomId?: string } | undefined
  /** Uploads usam campos no topo da mensagem (ver `ClientFileUpload*`). */
  FILE_UPLOAD_START: unknown
  FILE_UPLOAD_CHUNK: unknown
  FILE_UPLOAD_COMPLETE: unknown
}

/** Tipos de mensagem que o cliente pode enviar. */
export type ClientMessageType = keyof ClientMessagePayloads

/** Campos de envelope comuns a toda mensagem do cliente. */
export interface ClientMessageEnvelope {
  componentId?: string
  requestId?: string
  responseId?: string
  expectResponse?: boolean
  timestamp?: number
  /** Enviado por clientes antigos; o servidor NUNCA confia nele. */
  userId?: string
  room?: string
}

/** Campo vindo da rede ainda não validado (quem consome valida). */
export type UntrustedFields<T> = { [K in keyof T]?: unknown }

type WithComponent = { componentId: string }

/** Mensagens de sala: `roomId` normalizado (topo da mensagem ou `payload.roomId`). */
type RoomVariant<K extends 'ROOM_JOIN' | 'ROOM_LEAVE' | 'ROOM_EMIT' | 'ROOM_STATE_SET' | 'ROOM_STATE_GET'> =
  ClientMessageEnvelope & WithComponent & { type: K; roomId: string; payload: ClientMessagePayloads[K] }

/**
 * Mensagem cliente → servidor já validada (união discriminada por `type`).
 * Produzida por `parseClientMessage`; nunca construa a partir de JSON cru.
 */
export type ClientMessage =
  | (ClientMessageEnvelope & { type: 'COMPONENT_MOUNT'; payload: ClientMessagePayloads['COMPONENT_MOUNT'] })
  | (ClientMessageEnvelope & WithComponent & { type: 'COMPONENT_UNMOUNT'; payload?: unknown })
  | (ClientMessageEnvelope & WithComponent & { type: 'COMPONENT_REHYDRATE'; payload: ClientMessagePayloads['COMPONENT_REHYDRATE'] })
  | (ClientMessageEnvelope & WithComponent & { type: 'CALL_ACTION'; action: string; payload?: unknown })
  | (ClientMessageEnvelope & WithComponent & { type: 'PROPERTY_UPDATE'; property: string; payload: ClientMessagePayloads['PROPERTY_UPDATE'] })
  | (ClientMessageEnvelope & { type: 'AUTH'; payload: ClientMessagePayloads['AUTH'] })
  | RoomVariant<'ROOM_JOIN'>
  | RoomVariant<'ROOM_LEAVE'>
  | RoomVariant<'ROOM_EMIT'>
  | RoomVariant<'ROOM_STATE_SET'>
  | RoomVariant<'ROOM_STATE_GET'>
  // Uploads: os campos são validados um a um pelo FileUploadManager (que devolve
  // mensagens de erro específicas); aqui só o envelope é garantido.
  | (ClientMessageEnvelope & UntrustedFields<Omit<FileUploadStartMessage, 'type' | 'componentId' | 'requestId'>> & { type: 'FILE_UPLOAD_START'; payload?: unknown })
  | (ClientMessageEnvelope & UntrustedFields<Omit<FileUploadChunkMessage, 'type' | 'componentId' | 'requestId'>> & { type: 'FILE_UPLOAD_CHUNK'; payload?: unknown })
  | (ClientMessageEnvelope & UntrustedFields<Omit<FileUploadCompleteMessage, 'type' | 'componentId' | 'requestId'>> & { type: 'FILE_UPLOAD_COMPLETE'; payload?: unknown })

/** Estreita `ClientMessage` para um `type` específico. */
export type ClientMessageOf<K extends ClientMessageType> = Extract<ClientMessage, { type: K }>

/** Mensagens que o `ComponentRegistry.handleMessage` processa. */
export type RegistryClientMessage = ClientMessageOf<'COMPONENT_MOUNT' | 'COMPONENT_UNMOUNT' | 'CALL_ACTION' | 'PROPERTY_UPDATE'>

// ===== Server → Client Messages =====

export interface WebSocketResponse {
  type: 'MESSAGE_RESPONSE' | 'CONNECTION_ESTABLISHED' | 'ERROR' | 'BROADCAST' | 'ACTION_RESPONSE' | 'COMPONENT_MOUNTED' | 'COMPONENT_REHYDRATED' | 'STATE_UPDATE' | 'STATE_DELTA' | 'STATE_REHYDRATED' | 'STATE_SIGNATURE' | 'FILE_UPLOAD_PROGRESS' | 'FILE_UPLOAD_COMPLETE' | 'FILE_UPLOAD_ERROR' | 'FILE_UPLOAD_START_RESPONSE' | 'COMPONENT_PONG' |
  // Auth system response
  'AUTH_RESPONSE' |
  // Room system responses
  'ROOM_EVENT' | 'ROOM_STATE' | 'ROOM_SYSTEM' | 'ROOM_JOINED' | 'ROOM_LEFT'
  originalType?: string
  componentId?: string
  success?: boolean
  /** Resultado de mount/action/rehydrate — `unknown`: o cliente estreita conforme o `type`. */
  result?: unknown
  // Request-Response system
  requestId?: string
  responseId?: string
  error?: string
  timestamp?: number
  connectionId?: string
  payload?: unknown
  // File upload specific fields
  uploadId?: string
  chunkIndex?: number
  totalChunks?: number
  bytesUploaded?: number
  totalBytes?: number
  progress?: number
  filename?: string
  fileUrl?: string
  // Re-hydration specific fields
  signedState?: unknown
  oldComponentId?: string
  newComponentId?: string
}

// ===== Room Messages =====

export interface RoomMessage {
  type: 'ROOM_JOIN' | 'ROOM_LEAVE' | 'ROOM_EMIT' | 'ROOM_STATE_SET' | 'ROOM_STATE_GET'
  componentId: string
  roomId: string
  event?: string
  data?: unknown
  requestId?: string
  timestamp: number
}

// ===== Component State Types =====

export interface ComponentState {
  [key: string]: unknown
}

export interface BroadcastMessage {
  type: string
  payload: unknown
  room?: string
  excludeUser?: string
}

// ===== Client-Side Component Instance =====

export interface LiveComponentInstance<TState = ComponentState, TActions = Record<string, Function>> {
  id: string
  state: TState
  call: <T extends keyof TActions>(action: T, ...args: unknown[]) => Promise<unknown>
  set: <K extends keyof TState>(property: K, value: TState[K]) => void
  loading: boolean
  errors: Record<string, string>
  connected: boolean
  room?: string
}

// ===== Client WebSocket Types =====

export interface WebSocketMessage {
  type: string
  componentId?: string
  action?: string
  payload?: unknown
  timestamp?: number
  userId?: string
  room?: string
  requestId?: string
  responseId?: string
  expectResponse?: boolean
}

// ===== Hybrid State Types =====

export interface HybridState<T> {
  data: T
  validation: StateValidation
  conflicts: StateConflict[]
  status: 'synced' | 'conflict' | 'disconnected'
}

export interface StateValidation {
  checksum: string
  version: number
  source: 'client' | 'server' | 'mount'
  timestamp: number
}

export interface StateConflict {
  property: string
  clientValue: unknown
  serverValue: unknown
  timestamp: number
  resolved: boolean
}

export interface HybridComponentOptions {
  fallbackToLocal?: boolean
  room?: string
  userId?: string
  autoMount?: boolean
  debug?: boolean

  // Component lifecycle callbacks
  onConnect?: () => void
  onMount?: () => void
  onRehydrate?: () => void
  onDisconnect?: () => void
  onError?: (error: string) => void
  onStateChange?: (newState: unknown, oldState: unknown) => void
}

// ===== Server Room Handle =====

/**
 * Options for the proxy-side `emit()` call.
 *
 * By default, when a `LiveComponent` emits through `$room(...).emit()`, the
 * calling component is excluded from receiving its own event. This matches
 * "broadcast to everyone else" semantics and is the historical behaviour.
 *
 * Set `includeSelf: true` to also deliver the event to the caller's own
 * `room.on()` handlers — useful when using an emit as a state-sync trigger
 * that should rebuild the caller's local view as well.
 *
 * Note: this option only affects the proxy path. `LiveRoom.emit()` called
 * from inside a room subclass method already delivers to every subscriber.
 */
export interface RoomEmitOptions {
  /** When true, the calling component also receives the event. Default: false. */
  includeSelf?: boolean
}

export interface ServerRoomHandle<TState = Record<string, unknown>, TEvents extends object = Record<string, unknown>> {
  readonly id: string
  readonly state: TState
  join: (initialState?: TState) => void
  leave: () => void
  emit: <K extends keyof TEvents>(event: K, data: TEvents[K], options?: RoomEmitOptions) => number
  on: <K extends keyof TEvents>(event: K, handler: (data: TEvents[K]) => void) => () => void
  setState: (updates: Partial<TState>) => void
}

export interface ServerRoomProxy<TState = Record<string, unknown>, TEvents extends object = Record<string, unknown>> {
  (roomId: string): ServerRoomHandle<TState, TEvents>
  readonly id: string | undefined
  readonly state: TState
  join: (initialState?: TState) => void
  leave: () => void
  emit: <K extends keyof TEvents>(event: K, data: TEvents[K], options?: RoomEmitOptions) => number
  on: <K extends keyof TEvents>(event: K, handler: (data: TEvents[K]) => void) => () => void
  setState: (updates: Partial<TState>) => void
}

// ===== File Upload Types =====

export interface FileChunkData {
  uploadId: string
  filename: string
  fileType: string
  fileSize: number
  chunkIndex: number
  totalChunks: number
  chunkSize: number
  data: string
  hash?: string
}

export interface FileUploadStartMessage {
  type: 'FILE_UPLOAD_START'
  componentId: string
  uploadId: string
  filename: string
  fileType: string
  fileSize: number
  chunkSize?: number
  requestId?: string
}

export interface FileUploadChunkMessage {
  type: 'FILE_UPLOAD_CHUNK'
  componentId: string
  uploadId: string
  chunkIndex: number
  totalChunks: number
  data: string | Buffer
  hash?: string
  requestId?: string
}

export interface BinaryChunkHeader {
  type: 'FILE_UPLOAD_CHUNK'
  componentId: string
  uploadId: string
  chunkIndex: number
  totalChunks: number
  requestId?: string
}

export interface FileUploadCompleteMessage {
  type: 'FILE_UPLOAD_COMPLETE'
  componentId: string
  uploadId: string
  requestId?: string
}

export interface FileUploadProgressResponse {
  type: 'FILE_UPLOAD_PROGRESS'
  componentId: string
  uploadId: string
  chunkIndex: number
  totalChunks: number
  bytesUploaded: number
  totalBytes: number
  progress: number
  requestId?: string
  timestamp: number
}

export interface FileUploadCompleteResponse {
  type: 'FILE_UPLOAD_COMPLETE'
  componentId: string
  uploadId: string
  success: boolean
  filename?: string
  fileUrl?: string
  error?: string
  requestId?: string
  timestamp: number
}

export interface ActiveUpload {
  uploadId: string
  componentId: string
  filename: string
  fileType: string
  fileSize: number
  totalChunks: number
  receivedChunks: Map<number, string | Buffer>
  bytesReceived: number
  startTime: number
  lastChunkTime: number
  tempFilePath?: string
  /** connectionId que iniciou o upload — só ela pode enviar chunks / completar */
  ownerConnectionId?: string
  /** tamanho de chunk acordado no start (validado pelo server) */
  chunkSize?: number
}

// ===== Component Definition =====

/** Instância de componente com o state apagado (registries guardam classes heterogêneas). */
type LiveComponentLike = LiveComponent<object, object>

export interface ComponentDefinition<TState = ComponentState> {
  name: string
  initialState: TState
  component: new (initialState: TState, ws: GenericWebSocket, options?: { room?: string; userId?: string }) => LiveComponentLike
}
