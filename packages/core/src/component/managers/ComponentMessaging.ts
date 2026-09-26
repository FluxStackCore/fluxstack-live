// @fluxstack/live - Component Messaging Manager
//
// Handles emit() and broadcast() for LiveComponent.
// Extracted from LiveComponent for single-responsibility.

import type { GenericWebSocket } from '../../transport/types'
import { queueWsMessage } from '../../transport/WsSendBatcher'
import { liveLog, liveWarn } from '../../debug/LiveLogger'
import type { LiveMessage, LiveMessageType, BroadcastMessage } from '../../protocol/messages'

/** Symbol key for singleton emit override */
export const EMIT_OVERRIDE_KEY = Symbol.for('fluxstack:emitOverride')

/**
 * @internal Symbol key do gancho "o estado mudou" (chamado após cada STATE_DELTA,
 * JSON ou binário). O registry o instala para renovar o signedState (throttled).
 */
export const STATE_DELTA_HOOK_KEY = Symbol.for('fluxstack:stateDeltaHook')

export interface ComponentMessagingContext {
  componentId: string
  ws: GenericWebSocket
  getUserId: () => string | undefined
  getRoom: () => string | undefined
  getBroadcastToRoom: () => (message: BroadcastMessage) => void
  getEmitOverride: () => ((type: string, payload: unknown) => void) | null
}

export class ComponentMessaging {
  constructor(private ctx: ComponentMessagingContext) {}

  emit(type: string, payload: unknown): void {
    const override = this.ctx.getEmitOverride()
    if (override) {
      override(type, payload)
      return
    }

    const message: LiveMessage = {
      // emit() aceita tipos custom; o envelope só enumera os conhecidos.
      type: type as LiveMessageType,
      componentId: this.ctx.componentId,
      payload,
      userId: this.ctx.getUserId(),
      room: this.ctx.getRoom()
    }

    if (this.ctx.ws) {
      queueWsMessage(this.ctx.ws, message)
    }
  }

  broadcast(type: string, payload: unknown, excludeCurrentUser = false): void {
    const room = this.ctx.getRoom()
    if (!room) {
      liveWarn('rooms', this.ctx.componentId, `[${this.ctx.componentId}] Cannot broadcast '${type}' - no room set`)
      return
    }

    const message: BroadcastMessage = {
      type,
      payload,
      room,
      excludeUser: excludeCurrentUser ? this.ctx.getUserId() : undefined
    }

    liveLog('rooms', this.ctx.componentId, `[${this.ctx.componentId}] Broadcasting '${type}' to room '${room}'`)

    this.ctx.getBroadcastToRoom()(message)
  }
}
