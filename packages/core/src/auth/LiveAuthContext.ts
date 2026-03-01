// @fluxstack/live - Auth Context Implementation

import type { LiveAuthContext, LiveAuthUser } from './types'

/**
 * Auth context for authenticated users.
 * Provides type-safe helpers for role and permission checks.
 *
 * Used internally by the framework - devs access via this.$auth in LiveComponent.
 */
export class AuthenticatedContext implements LiveAuthContext {
  readonly authenticated = true
  readonly user: LiveAuthUser
  readonly token?: string
  readonly authenticatedAt: number

  constructor(user: LiveAuthUser, token?: string) {
    this.user = user
    this.token = token
    this.authenticatedAt = Date.now()
  }

  hasRole(role: string): boolean {
    return this.user.roles?.includes(role) ?? false
  }

  hasAnyRole(roles: string[]): boolean {
    if (!this.user.roles?.length) return false
    return roles.some(role => this.user.roles!.includes(role))
  }

  hasAllRoles(roles: string[]): boolean {
    if (!this.user.roles?.length) return roles.length === 0
    return roles.every(role => this.user.roles!.includes(role))
  }

  hasPermission(permission: string): boolean {
    return this.user.permissions?.includes(permission) ?? false
  }

  hasAllPermissions(permissions: string[]): boolean {
    if (!this.user.permissions?.length) return permissions.length === 0
    return permissions.every(perm => this.user.permissions!.includes(perm))
  }

  hasAnyPermission(permissions: string[]): boolean {
    if (!this.user.permissions?.length) return false
    return permissions.some(perm => this.user.permissions!.includes(perm))
  }
}

/**
 * Context for unauthenticated users (guest).
 * Returned when no credentials are provided or when auth fails.
 */
export class AnonymousContext implements LiveAuthContext {
  readonly authenticated = false
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
