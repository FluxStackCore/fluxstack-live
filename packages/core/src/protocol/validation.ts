// @fluxstack/live - Validação de forma das mensagens cliente → servidor
//
// Tudo que chega da rede é `unknown`. Antes de despachar, o LiveServer passa
// o valor por `parseClientMessage`, que confere o MÍNIMO que cada handler
// precisa para não quebrar (tipos dos campos lidos) e devolve uma
// `ClientMessage` tipada — ou um erro, que vira `ERROR 'Invalid message'`.
//
// Sem dependência nova: type-guards pequenos e explícitos. O wire format não
// muda; regras de negócio (auth, posse, limites de upload...) continuam nos
// handlers — aqui é só forma.

import type {
  ClientMessage,
  ClientMessageEnvelope,
  ClientMessagePayloads,
  ClientMessageType,
} from './messages'
import type { SignedState } from '../security/StateSignature'

// ===== Type-guards básicos =====

/** Objeto plano (não null, não array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalRecord(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isRecord(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Forma mínima de um `SignedState` (a assinatura é conferida depois, pelo StateSignatureManager). */
export function isSignedState(value: unknown): value is SignedState {
  return isRecord(value)
    && typeof value.data === 'string'
    && typeof value.signature === 'string'
    && typeof value.timestamp === 'number'
    && typeof value.version === 'number'
    && typeof value.componentId === 'string'
    && isOptionalString(value.nonce)
    && (value.compressed === undefined || typeof value.compressed === 'boolean')
    && (value.encrypted === undefined || typeof value.encrypted === 'boolean')
}

const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set<ClientMessageType>([
  'COMPONENT_MOUNT', 'COMPONENT_UNMOUNT', 'COMPONENT_REHYDRATE', 'CALL_ACTION', 'PROPERTY_UPDATE',
  'AUTH',
  'ROOM_JOIN', 'ROOM_LEAVE', 'ROOM_EMIT', 'ROOM_STATE_SET', 'ROOM_STATE_GET',
  'FILE_UPLOAD_START', 'FILE_UPLOAD_CHUNK', 'FILE_UPLOAD_COMPLETE',
])

export function isClientMessageType(type: unknown): type is ClientMessageType {
  return typeof type === 'string' && CLIENT_MESSAGE_TYPES.has(type)
}

// ===== Resultado =====

export type ParseClientMessageResult =
  | { ok: true; message: ClientMessage }
  /** `type` é string mas não é uma mensagem de cliente conhecida. */
  | { ok: false; reason: 'unknown-type'; type: string; envelope: ClientMessageEnvelope }
  | { ok: false; reason: 'invalid'; error: string; envelope: ClientMessageEnvelope }

/**
 * Extrai os campos de envelope que são seguros para ecoar numa resposta de erro
 * (requestId/componentId só se forem strings).
 */
export function extractEnvelope(raw: Record<string, unknown>): ClientMessageEnvelope {
  return {
    componentId: typeof raw.componentId === 'string' ? raw.componentId : undefined,
    requestId: typeof raw.requestId === 'string' ? raw.requestId : undefined,
  }
}

function invalid(envelope: ClientMessageEnvelope, error: string): ParseClientMessageResult {
  return { ok: false, reason: 'invalid', error, envelope }
}

/** Envelope com os tipos corretos (campos opcionais, mas nunca de outro tipo). */
function validEnvelope(raw: Record<string, unknown>): string | null {
  if (!isOptionalString(raw.componentId)) return 'componentId must be a string'
  if (!isOptionalString(raw.requestId)) return 'requestId must be a string'
  if (!isOptionalString(raw.responseId)) return 'responseId must be a string'
  if (raw.expectResponse !== undefined && typeof raw.expectResponse !== 'boolean') return 'expectResponse must be a boolean'
  if (raw.timestamp !== undefined && typeof raw.timestamp !== 'number') return 'timestamp must be a number'
  if (!isOptionalString(raw.userId)) return 'userId must be a string'
  if (!isOptionalString(raw.room)) return 'room must be a string'
  return null
}

function envelopeOf(raw: Record<string, unknown>): ClientMessageEnvelope {
  // Já validado por validEnvelope — os casts refletem a checagem acima.
  return {
    componentId: raw.componentId as string | undefined,
    requestId: raw.requestId as string | undefined,
    responseId: raw.responseId as string | undefined,
    expectResponse: raw.expectResponse as boolean | undefined,
    timestamp: raw.timestamp as number | undefined,
    userId: raw.userId as string | undefined,
    room: raw.room as string | undefined,
  }
}

/**
 * Valida a forma de uma mensagem vinda do cliente (já passada por JSON.parse
 * e `sanitizePayload`). Nunca lança.
 */
export function parseClientMessage(raw: unknown): ParseClientMessageResult {
  if (!isRecord(raw)) return invalid({}, 'expected object')

  const safeEnvelope = extractEnvelope(raw)
  if (typeof raw.type !== 'string') return invalid(safeEnvelope, 'missing type')

  const envelopeError = validEnvelope(raw)
  if (envelopeError) return invalid(safeEnvelope, envelopeError)
  const envelope = envelopeOf(raw)

  if (!isClientMessageType(raw.type)) {
    return { ok: false, reason: 'unknown-type', type: raw.type, envelope }
  }

  const payload = raw.payload
  const componentId = envelope.componentId

  switch (raw.type) {
    case 'COMPONENT_MOUNT': {
      if (!isRecord(payload)) return invalid(envelope, 'COMPONENT_MOUNT requires payload')
      if (typeof payload.component !== 'string') return invalid(envelope, 'payload.component must be a string')
      if (!isOptionalRecord(payload.props)) return invalid(envelope, 'payload.props must be an object')
      if (!isOptionalString(payload.room)) return invalid(envelope, 'payload.room must be a string')
      if (!isOptionalString(payload.userId)) return invalid(envelope, 'payload.userId must be a string')
      if (!isOptionalString(payload.debugLabel)) return invalid(envelope, 'payload.debugLabel must be a string')
      const mountPayload: ClientMessagePayloads['COMPONENT_MOUNT'] = {
        component: payload.component,
        props: payload.props,
        room: payload.room,
        userId: payload.userId,
        debugLabel: payload.debugLabel,
      }
      return { ok: true, message: { ...envelope, type: 'COMPONENT_MOUNT', payload: mountPayload } }
    }

    case 'COMPONENT_UNMOUNT': {
      if (typeof componentId !== 'string') return invalid(envelope, 'componentId is required')
      return { ok: true, message: { ...envelope, componentId, type: 'COMPONENT_UNMOUNT', payload } }
    }

    case 'COMPONENT_REHYDRATE': {
      if (typeof componentId !== 'string') return invalid(envelope, 'componentId is required')
      if (!isRecord(payload)) return invalid(envelope, 'COMPONENT_REHYDRATE requires payload')
      if (typeof payload.component !== 'string') return invalid(envelope, 'payload.component must be a string')
      if (!isSignedState(payload.signedState)) return invalid(envelope, 'payload.signedState is malformed')
      if (!isOptionalString(payload.room)) return invalid(envelope, 'payload.room must be a string')
      if (!isOptionalString(payload.userId)) return invalid(envelope, 'payload.userId must be a string')
      const rehydratePayload: ClientMessagePayloads['COMPONENT_REHYDRATE'] = {
        component: payload.component,
        signedState: payload.signedState,
        room: payload.room,
        userId: payload.userId,
      }
      return { ok: true, message: { ...envelope, componentId, type: 'COMPONENT_REHYDRATE', payload: rehydratePayload } }
    }

    case 'CALL_ACTION': {
      if (typeof componentId !== 'string') return invalid(envelope, 'componentId is required')
      // String vazia segue adiante e é recusada pelo ActionSecurityManager (mesma mensagem de antes).
      if (typeof raw.action !== 'string') return invalid(envelope, 'action must be a string')
      // payload é da action: formato livre (o componente valida via actionSchemas).
      return { ok: true, message: { ...envelope, componentId, type: 'CALL_ACTION', action: raw.action, payload } }
    }

    case 'PROPERTY_UPDATE': {
      if (typeof componentId !== 'string') return invalid(envelope, 'componentId is required')
      if (typeof raw.property !== 'string') return invalid(envelope, 'property must be a string')
      if (!isRecord(payload)) return invalid(envelope, 'PROPERTY_UPDATE requires payload.value')
      return {
        ok: true,
        message: { ...envelope, componentId, type: 'PROPERTY_UPDATE', property: raw.property, payload: { value: payload.value } },
      }
    }

    case 'AUTH': {
      // Credenciais: objeto opcional. Campos específicos são do provider.
      if (!isOptionalRecord(payload)) return invalid(envelope, 'AUTH payload must be an object')
      return { ok: true, message: { ...envelope, type: 'AUTH', payload } }
    }

    case 'ROOM_JOIN':
    case 'ROOM_LEAVE':
    case 'ROOM_EMIT':
    case 'ROOM_STATE_SET':
    case 'ROOM_STATE_GET': {
      if (typeof componentId !== 'string') return invalid(envelope, 'componentId is required')
      if (!isOptionalRecord(payload)) return invalid(envelope, 'room payload must be an object')
      // roomId pode vir no topo da mensagem ou em payload.roomId (os dois formatos existem).
      const roomId = raw.roomId || payload?.roomId
      if (!isNonEmptyString(roomId)) return invalid(envelope, 'roomId must be a non-empty string')
      if (!isOptionalString(payload?.roomId)) return invalid(envelope, 'payload.roomId must be a string')
      const base = { ...envelope, componentId, roomId }

      switch (raw.type) {
        case 'ROOM_JOIN':
          return {
            ok: true,
            message: { ...base, type: 'ROOM_JOIN', payload: payload && { roomId: payload.roomId as string | undefined, initialState: payload.initialState } },
          }
        case 'ROOM_LEAVE':
          return { ok: true, message: { ...base, type: 'ROOM_LEAVE', payload: payload && { roomId: payload.roomId as string | undefined } } }
        case 'ROOM_STATE_GET':
          return { ok: true, message: { ...base, type: 'ROOM_STATE_GET', payload: payload && { roomId: payload.roomId as string | undefined } } }
        case 'ROOM_EMIT': {
          if (!payload || typeof payload.event !== 'string') return invalid(envelope, 'payload.event must be a string')
          return {
            ok: true,
            message: { ...base, type: 'ROOM_EMIT', payload: { roomId: payload.roomId as string | undefined, event: payload.event, data: payload.data } },
          }
        }
        case 'ROOM_STATE_SET': {
          if (!payload || !isRecord(payload.state)) return invalid(envelope, 'payload.state must be an object')
          return {
            ok: true,
            message: { ...base, type: 'ROOM_STATE_SET', payload: { roomId: payload.roomId as string | undefined, state: payload.state } },
          }
        }
      }
      // Inalcançável: o switch interno cobre todos os tipos de sala.
      return invalid(envelope, 'unknown room message')
    }

    case 'FILE_UPLOAD_START':
    case 'FILE_UPLOAD_CHUNK':
    case 'FILE_UPLOAD_COMPLETE': {
      // Campos de upload: FileUploadManager valida um a um (com mensagens de erro
      // específicas no FILE_UPLOAD_*_RESPONSE). Aqui repassamos os campos crus.
      const { type: _type, componentId: _cid, requestId: _rid, ...fields } = raw
      return { ok: true, message: { ...fields, ...envelope, type: raw.type, payload } }
    }
  }
}
