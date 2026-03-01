// @fluxstack/live - Protocol Message Types
//
// FROZEN: These message types define the wire protocol between client and server.
// Do NOT change existing types — only add new ones.

// ===== Client → Server Messages =====

export interface LiveMessage {
  type: 'COMPONENT_MOUNT' | 'COMPONENT_UNMOUNT' |
  'COMPONENT_REHYDRATE' | 'COMPONENT_ACTION' | 'CALL_ACTION' |
  'ACTION_RESPONSE' | 'PROPERTY_UPDATE' | 'STATE_UPDATE' | 'STATE_DELTA' | 'STATE_REHYDRATED' |
  'ERROR' | 'BROADCAST' | 'FILE_UPLOAD_START' | 'FILE_UPLOAD_CHUNK' | 'FILE_UPLOAD_COMPLETE' |
  'COMPONENT_PING' | 'COMPONENT_PONG' |
  // Auth system message
  'AUTH' |
  // Room system messages
  'ROOM_JOIN' | 'ROOM_LEAVE' | 'ROOM_EMIT' | 'ROOM_STATE_SET' | 'ROOM_STATE_GET'
  componentId: string
  action?: string
  property?: string
  payload?: any
  timestamp?: number
  userId?: string
  room?: string
  // Request-Response system
  requestId?: string
  responseId?: string
  expectResponse?: boolean
}

// ===== Server → Client Messages =====

export interface WebSocketResponse {
  type: 'MESSAGE_RESPONSE' | 'CONNECTION_ESTABLISHED' | 'ERROR' | 'BROADCAST' | 'ACTION_RESPONSE' | 'COMPONENT_MOUNTED' | 'COMPONENT_REHYDRATED' | 'STATE_UPDATE' | 'STATE_DELTA' | 'STATE_REHYDRATED' | 'FILE_UPLOAD_PROGRESS' | 'FILE_UPLOAD_COMPLETE' | 'FILE_UPLOAD_ERROR' | 'FILE_UPLOAD_START_RESPONSE' | 'COMPONENT_PONG' |
  // Auth system response
  'AUTH_RESPONSE' |
  // Room system responses
  'ROOM_EVENT' | 'ROOM_STATE' | 'ROOM_SYSTEM' | 'ROOM_JOINED' | 'ROOM_LEFT'
  originalType?: string
  componentId?: string
  success?: boolean
  result?: any
  // Request-Response system
  requestId?: string
  responseId?: string
  error?: string
  timestamp?: number
  connectionId?: string
  payload?: any
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
  signedState?: any
  oldComponentId?: string
  newComponentId?: string
}

// ===== Room Messages =====

export interface RoomMessage {
  type: 'ROOM_JOIN' | 'ROOM_LEAVE' | 'ROOM_EMIT' | 'ROOM_STATE_SET' | 'ROOM_STATE_GET'
  componentId: string
  roomId: string
  event?: string
  data?: any
  requestId?: string
  timestamp: number
}

// ===== Component State Types =====

export interface ComponentState {
  [key: string]: any
}

export interface BroadcastMessage {
  type: string
  payload: any
  room?: string
  excludeUser?: string
}

// ===== Client-Side Component Instance =====

export interface LiveComponentInstance<TState = ComponentState, TActions = Record<string, Function>> {
  id: string
  state: TState
  call: <T extends keyof TActions>(action: T, ...args: any[]) => Promise<any>
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
  payload?: any
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
  clientValue: any
  serverValue: any
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
  onStateChange?: (newState: any, oldState: any) => void
}

// ===== Server Room Handle =====

export interface ServerRoomHandle<TState = any, TEvents extends Record<string, any> = Record<string, any>> {
  readonly id: string
  readonly state: TState
  join: (initialState?: TState) => void
  leave: () => void
  emit: <K extends keyof TEvents>(event: K, data: TEvents[K]) => number
  on: <K extends keyof TEvents>(event: K, handler: (data: TEvents[K]) => void) => () => void
  setState: (updates: Partial<TState>) => void
}

export interface ServerRoomProxy<TState = any, TEvents extends Record<string, any> = Record<string, any>> {
  (roomId: string): ServerRoomHandle<TState, TEvents>
  readonly id: string | undefined
  readonly state: TState
  join: (initialState?: TState) => void
  leave: () => void
  emit: <K extends keyof TEvents>(event: K, data: TEvents[K]) => number
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
}

// ===== Component Definition =====

export interface ComponentDefinition<TState = ComponentState> {
  name: string
  initialState: TState
  component: new (initialState: TState, ws: any, options?: { room?: string; userId?: string }) => any
}
