// @fluxstack/live - Action Security Manager
//
// Handles action validation, blocked actions, publicActions, rate limiting, Zod schemas.
// Extracted from LiveComponent for single-responsibility.

import { errorMessage } from '../../utils/errors'

const BLOCKED_ACTIONS: ReadonlySet<string> = new Set([
  'constructor', 'destroy', 'executeAction', 'getSerializableState',
  'onMount', 'onDestroy', 'onConnect', 'onDisconnect',
  'onStateChange', 'onRoomJoin', 'onRoomLeave',
  'onRehydrate', 'onAction',
  'onClientJoin', 'onClientLeave',
  'setState', 'sendBinaryDelta', 'emit', 'broadcast', 'broadcastToRoom',
  'createStateProxy', 'createDirectStateAccessors', 'generateId',
  'setAuthContext', '_resetAuthContext', '$auth',
  '$private', '_privateState',
  '$persistent',
  '_inStateChange',
  '$room', '$rooms', 'subscribeToRoom', 'unsubscribeFromRoom',
  'emitRoomEvent', 'onRoomEvent', 'emitRoomEventWithState',
])

/**
 * Visão do componente usada aqui: um dicionário de membros (a action é
 * procurada por nome) com o hook `onAction`. O nome da action é validado
 * (allowlist + bloqueios) antes de qualquer acesso.
 */
export interface ActionTarget {
  [member: string]: unknown
}

/** Schema no formato Zod (só `safeParse` é usado). */
export interface ActionPayloadSchema {
  safeParse: (data: unknown) => {
    success: boolean
    error?: { message?: string; issues?: ReadonlyArray<{ message: string }> }
    data?: unknown
  }
}

export interface ActionSecurityContext {
  /** The component instance to execute the action on */
  component: object
  /** Component class (constructor) for reading static properties */
  componentClass: {
    componentName?: string
    name: string
    publicActions?: readonly string[]
    actionSchemas?: Record<string, ActionPayloadSchema>
    actionRateLimit?: { maxCalls: number; windowMs: number; perAction?: boolean }
  }
  /** Component id for debugging */
  componentId: string
  /** Emit function for sending ERROR messages */
  emitFn: (type: string, payload: unknown) => void
  /**
   * Quem está chamando a action (conexão de origem). Em singletons o `$auth`
   * do componente é o de quem montou primeiro — a identidade REAL do chamador
   * chega aqui e é repassada como 2º argumento da action.
   */
  caller?: ActionCaller
}

/** Identidade do chamador de uma action (repassada como 2º argumento). */
export interface ActionCaller {
  /** connectionId da conexão que disparou a action (ausente em chamadas internas) */
  connectionId?: string
  /** contexto de auth da conexão chamadora */
  auth: import('../../auth/types').LiveAuthContext
}

export class ActionSecurityManager {
  private _actionCalls = new Map<string, { count: number; windowStart: number }>()

  async validateAndExecute(
    action: string,
    payload: unknown,
    ctx: ActionSecurityContext
  ): Promise<unknown> {
    const { componentClass, componentId } = ctx
    // Acesso por nome (a action é uma string vinda do cliente, validada abaixo).
    const component = ctx.component as ActionTarget

    try {
      // Blocked actions check
      if ((BLOCKED_ACTIONS as Set<string>).has(action)) {
        throw new Error(`Action '${action}' is not callable`)
      }

      // Private prefix check
      if (action.startsWith('_') || action.startsWith('#')) {
        throw new Error(`Action '${action}' is not callable`)
      }

      // publicActions check
      const publicActions = componentClass.publicActions
      if (!publicActions) {
        console.warn(`[SECURITY] Component '${componentClass.componentName || componentClass.name}' has no publicActions defined. All remote actions are blocked.`)
        throw new Error(`Action '${action}' is not callable - component has no publicActions defined`)
      }
      if (!publicActions.includes(action)) {
        const methodExists = typeof component[action] === 'function'
        if (methodExists) {
          const name = componentClass.componentName || componentClass.name
          throw new Error(
            `Action '${action}' exists on '${name}' but is not listed in publicActions. ` +
            `Add it to: static publicActions = [..., '${action}']`
          )
        }
        throw new Error(`Action '${action}' is not callable`)
      }

      // Method existence check
      const method = component[action]
      if (typeof method !== 'function') {
        throw new Error(`Action '${action}' not found on component`)
      }

      // Prototype pollution guard
      if (Object.prototype.hasOwnProperty.call(Object.prototype, action)) {
        throw new Error(`Action '${action}' is not callable`)
      }

      // Rate limiting
      const rateLimit = componentClass.actionRateLimit
      if (rateLimit) {
        const now = Date.now()
        // Chave inclui a conexão chamadora: em singletons um cliente abusivo
        // não pode esgotar o limite de todos os outros.
        const base = rateLimit.perAction ? action : '*'
        const key = ctx.caller?.connectionId ? `${ctx.caller.connectionId}:${base}` : base
        let entry = this._actionCalls.get(key)
        if (!entry || now - entry.windowStart >= rateLimit.windowMs) {
          entry = { count: 0, windowStart: now }
          this._actionCalls.set(key, entry)
        }
        entry.count++
        if (entry.count > rateLimit.maxCalls) {
          throw new Error(`Action rate limit exceeded (max ${rateLimit.maxCalls} calls per ${rateLimit.windowMs}ms)`)
        }
      }

      // Zod schema validation
      const schemas = componentClass.actionSchemas
      if (schemas && schemas[action]) {
        const result = schemas[action].safeParse(payload)
        if (!result.success) {
          const errorMsg = result.error?.message || result.error?.issues?.map((i) => i.message).join(', ') || 'Invalid payload'
          throw new Error(`Action '${action}' payload validation failed: ${errorMsg}`)
        }
        payload = result.data ?? payload
      }

      // onAction hook
      let hookResult: unknown
      try {
        const onAction = component.onAction
        hookResult = typeof onAction === 'function' ? await onAction.call(component, action, payload) : undefined
      } catch (hookError) {
        ctx.emitFn('ERROR', {
          action,
          error: `Action '${action}' failed pre-validation`
        })
        throw hookError
      }
      if (hookResult === false) {
        throw new Error(`Action '${action}' was cancelled`)
      }

      // Execute action
      const result = ctx.caller
        ? await method.call(component, payload, ctx.caller)
        : await method.call(component, payload)

      return result
    } catch (error) {
      if (!errorMessage(error).includes('was cancelled') && !errorMessage(error).includes('pre-validation')) {
        ctx.emitFn('ERROR', {
          action,
          error: errorMessage(error)
        })
      }
      throw error
    }
  }
}
