// @fluxstack/live - Auth Context Implementation

import type { LiveAuthContext, LiveAuthSession } from './types'

/**
 * Auth context for authenticated sessions.
 * Provides type-safe helpers for role and permission checks.
 *
 * Used internally by the framework - devs access via this.$auth in LiveComponent.
 */
export class AuthenticatedContext implements LiveAuthContext {
  readonly authenticated = true
  readonly session: LiveAuthSession
  readonly token?: string
  readonly authenticatedAt: number

  /** @deprecated Use `session` instead */
  get user(): LiveAuthSession { return this.session }

  constructor(session: LiveAuthSession, token?: string) {
    this.session = session
    this.token = token
    this.authenticatedAt = Date.now()
  }

  hasRole(role: string): boolean {
    return this.session.roles?.includes(role) ?? false
  }

  hasAnyRole(roles: string[]): boolean {
    if (!this.session.roles?.length) return false
    return roles.some(role => this.session.roles!.includes(role))
  }

  hasAllRoles(roles: string[]): boolean {
    if (!this.session.roles?.length) return roles.length === 0
    return roles.every(role => this.session.roles!.includes(role))
  }

  hasPermission(permission: string): boolean {
    return this.session.permissions?.includes(permission) ?? false
  }

  hasAllPermissions(permissions: string[]): boolean {
    if (!this.session.permissions?.length) return permissions.length === 0
    return permissions.every(perm => this.session.permissions!.includes(perm))
  }

  hasAnyPermission(permissions: string[]): boolean {
    if (!this.session.permissions?.length) return false
    return permissions.some(perm => this.session.permissions!.includes(perm))
  }
}

/**
 * Context for unauthenticated connections (guest).
 * Returned when no credentials are provided or when auth fails.
 */
export class AnonymousContext implements LiveAuthContext {
  readonly authenticated = false
  readonly session = undefined
  readonly user = undefined
  readonly token = undefined
  readonly authenticatedAt = undefined

  hasRole(): boolean { return false }
  hasAnyRole(): boolean { return false }
  hasAllRoles(): boolean { return false }
  hasPermission(): boolean { return false }
  hasAllPermissions(): boolean { return false }
  hasAnyPermission(): boolean { return false }
}

/** Singleton for anonymous contexts */
export const ANONYMOUS_CONTEXT = new AnonymousContext()
