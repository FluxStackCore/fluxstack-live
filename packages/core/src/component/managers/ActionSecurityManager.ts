// @fluxstack/live - Action Security Manager
//
// Handles action validation, blocked actions, publicActions, rate limiting, Zod schemas.
// Extracted from LiveComponent for single-responsibility.

import type { LiveDebuggerInterface } from '../context'

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

export interface ActionSecurityContext {
  /** The component instance to execute the action on */
  component: any
  /** Component class (constructor) for reading static properties */
  componentClass: {
    componentName?: string
    name: string
    publicActions?: readonly string[]
    actionSchemas?: Record<string, { safeParse: (data: unknown) => { success: boolean; error?: any; data?: any } }>
    actionRateLimit?: { maxCalls: number; windowMs: number; perAction?: boolean }
  }
  /** Component id for debugging */
  componentId: string
  /** Emit function for sending ERROR messages */
  emitFn: (type: string, payload: any) => void
  /** Debugger interface */
  debugger?: LiveDebuggerInterface | null
}

export class ActionSecurityManager {
  private _actionCalls = new Map<string, { count: number; windowStart: number }>()

  async validateAndExecute(
    action: string,
    payload: any,
    ctx: ActionSecurityContext
  ): Promise<any> {
    const actionStart = Date.now()
    const { component, componentClass, componentId } = ctx

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
        const key = rateLimit.perAction ? action : '*'
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
          const errorMsg = result.error?.message || result.error?.issues?.map((i: any) => i.message).join(', ') || 'Invalid payload'
          throw new Error(`Action '${action}' payload validation failed: ${errorMsg}`)
        }
        payload = result.data ?? payload
      }

      // Debug tracking
      ctx.debugger?.trackActionCall(componentId, action, payload)

      // onAction hook
      let hookResult: void | false | Promise<void | false>
      try {
        hookResult = await component.onAction(action, payload)
      } catch (hookError: any) {
        ctx.debugger?.trackActionError(componentId, action, hookError.message, Date.now() - actionStart)
        ctx.emitFn('ERROR', {
          action,
          error: `Action '${action}' failed pre-validation`
        })
        throw hookError
      }
      if (hookResult === false) {
        ctx.debugger?.trackActionError(componentId, action, 'Action cancelled', Date.now() - actionStart)
        throw new Error(`Action '${action}' was cancelled`)
      }

      // Execute action
      const result = await method.call(component, payload)

      ctx.debugger?.trackActionResult(componentId, action, result, Date.now() - actionStart)

      return result
    } catch (error: any) {
      if (!error.message?.includes('was cancelled') && !error.message?.includes('pre-validation')) {
        ctx.debugger?.trackActionError(componentId, action, error.message, Date.now() - actionStart)

        ctx.emitFn('ERROR', {
          action,
          error: error.message
        })
      }
      throw error
    }
  }
}
