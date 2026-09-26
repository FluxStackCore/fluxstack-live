// @fluxstack/live-client - Protocolo cliente → servidor (tipado)
//
// O servidor valida CADA mensagem do cliente (`parseClientMessage` em
// `@fluxstack/live/protocol/validation`) e responde `ERROR 'Invalid message: ...'`
// quando a forma está errada. Este módulo é a única fonte das mensagens que o
// client/react/vue enviam: os builders abaixo devolvem `OutgoingClientMessage`,
// que espelha `ClientMessage` do core — se alguém mudar a forma, o compilador
// (e o teste `__tests__/integration/client-protocol.test.ts`, que passa cada
// builder pelo validador real do servidor) acusa.
//
// Por que um espelho e não `import type { ClientMessage } from '@fluxstack/live'`?
// O core ainda não exporta `ClientMessage`/`ClientMessagePayloads` no índice
// público. Quando exportar, troque `OutgoingClientMessage` por ele.
//
// O mesmo arquivo concentra os leitores de resposta: `WebSocketResponse.result`
// e `.payload` são `unknown` no core, e os helpers `read*` fazem o narrowing.

import type {
  FileUploadChunkMessage,
  FileUploadCompleteMessage,
  FileUploadStartMessage,
  LiveAuthCredentials,
  SignedState,
  WebSocketMessage,
  WebSocketResponse,
} from '@fluxstack/live'

// ===== Type-guards =====

/** Objeto plano (não null, não array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Cópia rasa de um objeto tipado como `Record<string, unknown>` (interfaces
 * não têm index signature, então não são atribuíveis diretamente).
 */
export function toRecord(value: object | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (value) for (const [k, v] of Object.entries(value)) out[k] = v
  return out
}

/** Forma mínima de um `SignedState` (mesma regra do validador do servidor). */
export function isSignedState(value: unknown): value is SignedState {
  return isRecord(value)
    && typeof value.data === 'string'
    && typeof value.signature === 'string'
    && typeof value.timestamp === 'number'
    && typeof value.version === 'number'
    && typeof value.componentId === 'string'
    && (value.nonce === undefined || typeof value.nonce === 'string')
    && (value.compressed === undefined || typeof value.compressed === 'boolean')
    && (value.encrypted === undefined || typeof value.encrypted === 'boolean')
}

// ===== Mensagens cliente → servidor =====

/** Campos de envelope comuns (o `requestId` é posto por `sendMessageAndWait`). */
export interface OutgoingEnvelope {
  componentId?: string
  requestId?: string
  expectResponse?: boolean
  timestamp?: number
}

export interface MountPayload {
  component: string
  props?: Record<string, unknown>
  room?: string
  /** Ignorado pelo servidor (o userId vem só da autenticação). */
  userId?: string
  debugLabel?: string
}

export interface RehydratePayload {
  component: string
  signedState: SignedState
  room?: string
  /** Ignorado pelo servidor (o userId vem só da autenticação). */
  userId?: string
}

type WithComponent = { componentId: string }
type RoomBase = OutgoingEnvelope & WithComponent & { roomId: string }

/**
 * Toda mensagem que o cliente sabe enviar (união discriminada por `type`).
 * Espelha `ClientMessage` do core + o heartbeat `PING`.
 */
export type OutgoingClientMessage =
  | (OutgoingEnvelope & { type: 'COMPONENT_MOUNT'; payload: MountPayload })
  | (OutgoingEnvelope & WithComponent & { type: 'COMPONENT_UNMOUNT' })
  | (OutgoingEnvelope & WithComponent & { type: 'COMPONENT_REHYDRATE'; payload: RehydratePayload })
  | (OutgoingEnvelope & WithComponent & { type: 'CALL_ACTION'; action: string; payload?: unknown })
  | (OutgoingEnvelope & WithComponent & { type: 'PROPERTY_UPDATE'; property: string; payload: { value: unknown } })
  | (OutgoingEnvelope & { type: 'AUTH'; payload: LiveAuthCredentials | undefined })
  | (RoomBase & { type: 'ROOM_JOIN'; payload: { initialState?: unknown } | undefined })
  | (RoomBase & { type: 'ROOM_LEAVE'; payload: undefined })
  | (RoomBase & { type: 'ROOM_STATE_GET'; payload: undefined })
  | (RoomBase & { type: 'ROOM_EMIT'; payload: { event: string; data?: unknown } })
  | (RoomBase & { type: 'ROOM_STATE_SET'; payload: { state: Record<string, unknown> } })
  | FileUploadStartMessage
  | FileUploadChunkMessage
  | FileUploadCompleteMessage
  | HeartbeatMessage

/**
 * Heartbeat do `LiveConnection`. O servidor não tem handler para `PING` e
 * responde `MESSAGE_RESPONSE 'Unknown message type'` (sem componentId, então
 * a resposta é ignorada). Serve só para detectar falha de envio.
 */
export interface HeartbeatMessage {
  type: 'PING'
}

export type OutgoingMessageType = OutgoingClientMessage['type']
export type OutgoingMessageOf<K extends OutgoingMessageType> = Extract<OutgoingClientMessage, { type: K }>

/**
 * O que `LiveConnection.sendMessage` aceita: as mensagens tipadas acima ou o
 * `WebSocketMessage` genérico (compatibilidade com apps que montam mensagens à mão).
 */
export type LiveOutgoingMessage = OutgoingClientMessage | WebSocketMessage

// ===== Builders =====

export const clientMessages = {
  mount(componentId: string | undefined, payload: MountPayload): OutgoingMessageOf<'COMPONENT_MOUNT'> {
    return { type: 'COMPONENT_MOUNT', componentId, payload }
  },

  unmount(componentId: string): OutgoingMessageOf<'COMPONENT_UNMOUNT'> {
    return { type: 'COMPONENT_UNMOUNT', componentId }
  },

  /** `payload.component` — o servidor lê `component` (não `componentName`). */
  rehydrate(componentId: string, payload: RehydratePayload): OutgoingMessageOf<'COMPONENT_REHYDRATE'> {
    return { type: 'COMPONENT_REHYDRATE', componentId, payload }
  },

  /** `expectResponse: false` = fire-and-forget. */
  callAction(componentId: string, action: string, payload?: unknown, expectResponse?: boolean): OutgoingMessageOf<'CALL_ACTION'> {
    const msg: OutgoingMessageOf<'CALL_ACTION'> = { type: 'CALL_ACTION', componentId, action, payload }
    if (expectResponse !== undefined) msg.expectResponse = expectResponse
    return msg
  },

  propertyUpdate(componentId: string, property: string, value: unknown): OutgoingMessageOf<'PROPERTY_UPDATE'> {
    return { type: 'PROPERTY_UPDATE', componentId, property, payload: { value } }
  },

  auth(credentials: LiveAuthCredentials | undefined): OutgoingMessageOf<'AUTH'> {
    return { type: 'AUTH', payload: credentials }
  },

  roomJoin(componentId: string, roomId: string, initialState?: unknown): OutgoingMessageOf<'ROOM_JOIN'> {
    return {
      type: 'ROOM_JOIN', componentId, roomId,
      payload: initialState === undefined ? undefined : { initialState },
      timestamp: Date.now(),
    }
  },

  roomLeave(componentId: string, roomId: string): OutgoingMessageOf<'ROOM_LEAVE'> {
    return { type: 'ROOM_LEAVE', componentId, roomId, payload: undefined, timestamp: Date.now() }
  },

  roomStateGet(componentId: string, roomId: string): OutgoingMessageOf<'ROOM_STATE_GET'> {
    return { type: 'ROOM_STATE_GET', componentId, roomId, payload: undefined, timestamp: Date.now() }
  },

  /** O servidor lê `payload.event` / `payload.data`. */
  roomEmit(componentId: string, roomId: string, event: string, data: unknown): OutgoingMessageOf<'ROOM_EMIT'> {
    return { type: 'ROOM_EMIT', componentId, roomId, payload: { event, data }, timestamp: Date.now() }
  },

  /** O servidor lê `payload.state` (objeto). */
  roomStateSet(componentId: string, roomId: string, state: Record<string, unknown>): OutgoingMessageOf<'ROOM_STATE_SET'> {
    return { type: 'ROOM_STATE_SET', componentId, roomId, payload: { state }, timestamp: Date.now() }
  },

  ping(): HeartbeatMessage {
    return { type: 'PING' }
  },
} as const

// ===== Leitores de resposta (narrowing de `unknown`) =====

export interface MountResult {
  componentId: string
  initialState?: Record<string, unknown>
  signedState?: SignedState
}

/** `result` de `COMPONENT_MOUNT` bem-sucedido; `null` se a forma não bate. */
export function readMountResult(response: WebSocketResponse | undefined): MountResult | null {
  const result = response?.result
  if (!isRecord(result) || typeof result.componentId !== 'string' || !result.componentId) return null
  return {
    componentId: result.componentId,
    initialState: isRecord(result.initialState) ? result.initialState : undefined,
    signedState: isSignedState(result.signedState) ? result.signedState : undefined,
  }
}

/** `result.newComponentId` de `COMPONENT_REHYDRATED`. */
export function readRehydrateResult(response: WebSocketResponse | undefined): { newComponentId: string } | null {
  const result = response?.result
  if (!isRecord(result) || typeof result.newComponentId !== 'string' || !result.newComponentId) return null
  return { newComponentId: result.newComponentId }
}

/** `payload` de `STATE_UPDATE`: `{ state, signedState? }`. */
export function readStateUpdate(message: WebSocketResponse): { state: Record<string, unknown>; signedState?: SignedState } | null {
  const payload = message.payload
  if (!isRecord(payload) || !isRecord(payload.state)) return null
  return { state: payload.state, signedState: isSignedState(payload.signedState) ? payload.signedState : undefined }
}

/** `payload.delta` de `STATE_DELTA`. */
export function readStateDelta(message: WebSocketResponse): Record<string, unknown> | null {
  const payload = message.payload
  if (!isRecord(payload) || !isRecord(payload.delta)) return null
  return payload.delta
}

/**
 * `payload.signedState` de `STATE_SIGNATURE` — renovação throttled da
 * assinatura depois de mudanças de estado. Guarde SEMPRE a mais recente: é ela
 * que a re-hidratação deve reenviar (a do mount volta ao estado inicial).
 * `null` se a mensagem não é `STATE_SIGNATURE` ou a forma não bate.
 */
export function readStateSignature(message: WebSocketResponse): SignedState | null {
  if (message.type !== 'STATE_SIGNATURE') return null
  const payload = message.payload
  if (!isRecord(payload) || !isSignedState(payload.signedState)) return null
  return payload.signedState
}

/** `payload` de `STATE_REHYDRATED`: `{ state, newComponentId, signedState? }`. */
export function readStateRehydrated(message: WebSocketResponse): {
  state: Record<string, unknown>
  newComponentId: string
  signedState?: SignedState
} | null {
  const payload = message.payload
  if (!isRecord(payload) || !isRecord(payload.state) || typeof payload.newComponentId !== 'string') return null
  return {
    state: payload.state,
    newComponentId: payload.newComponentId,
    signedState: isSignedState(payload.signedState) ? payload.signedState : undefined,
  }
}

/** `payload` de `BROADCAST`: `{ type, data }`. */
export function readBroadcast(message: WebSocketResponse): { type: string; data: unknown } | null {
  const payload = message.payload
  if (!isRecord(payload) || typeof payload.type !== 'string') return null
  return { type: payload.type, data: payload.data }
}

/**
 * Mensagem de erro de uma resposta. O servidor põe `error` no topo; eventos
 * `ERROR` emitidos pelo componente (`emit('ERROR', { error })`) trazem em `payload.error`.
 */
export function readErrorMessage(message: WebSocketResponse): string | undefined {
  if (typeof message.error === 'string' && message.error) return message.error
  const payload = message.payload
  if (isRecord(payload) && typeof payload.error === 'string') return payload.error
  return undefined
}

/** `payload` de `AUTH_RESPONSE`. */
export function readAuthPayload(message: WebSocketResponse): { authenticated: boolean; session: Record<string, unknown> | null } {
  const payload = message.payload
  if (!isRecord(payload) || payload.authenticated !== true) return { authenticated: false, session: null }
  return { authenticated: true, session: isRecord(payload.session) ? payload.session : null }
}

/**
 * Resposta de `ROOM_JOIN`. O servidor responde `ROOM_JOINED` com
 * `payload: { roomId, state }`; formas antigas (`{ success, state }`) seguem aceitas.
 */
export function readRoomJoinResponse(response: WebSocketResponse | undefined): { joined: boolean; state?: Record<string, unknown> } {
  if (!response) return { joined: false }
  const joined = response.type === 'ROOM_JOINED' || response.success === true
  if (!joined) return { joined: false }
  const payload = response.payload
  if (isRecord(payload) && isRecord(payload.state)) return { joined: true, state: payload.state }
  const legacy: unknown = (response as WebSocketResponse & { state?: unknown }).state
  return { joined: true, state: isRecord(legacy) ? legacy : undefined }
}
