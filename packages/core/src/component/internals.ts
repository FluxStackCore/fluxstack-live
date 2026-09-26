// @fluxstack/live - Acesso interno do framework a um LiveComponent
//
// Hooks de lifecycle (`onMount`, `onConnect`, ...) e `emit` são `protected` na
// classe pública — o usuário sobrescreve, mas não chama de fora. O registry
// precisa chamá-los; em vez de espalhar `(component as any).onX()`, todo acesso
// passa por esta interface. NÃO é exportada pelo index do pacote.

import type { AnyLiveComponent } from './LiveComponent'
import { EMIT_OVERRIDE_KEY, STATE_DELTA_HOOK_KEY } from './managers/ComponentMessaging'

/** @internal Visão "de dentro" de um LiveComponent (membros protegidos/readonly). */
export interface LiveComponentInternals {
  /** Gravável só pelo registry (troca pelo id do claim de singleton no cluster). */
  id: string
  emit(type: string, payload: unknown): void
  onConnect(): void
  onMount(): void | Promise<void>
  onDisconnect(): void
  onRehydrate(previousState: unknown): void
  onClientJoin(connectionId: string, connectionCount: number): void
  onClientLeave(connectionId: string, connectionCount: number): void
  [EMIT_OVERRIDE_KEY]: ((type: string, payload: unknown) => void) | null
  /** Chamado após cada STATE_DELTA (JSON ou binário) — renovação do signedState. */
  [STATE_DELTA_HOOK_KEY]: (() => void) | null
}

/**
 * @internal Expõe os membros protegidos de um componente para o framework.
 * Os membros existem em `LiveComponent` (a classe base os declara), só não
 * são públicos — por isso o cast via `unknown`.
 */
export function internals(component: AnyLiveComponent): LiveComponentInternals {
  return component as unknown as LiveComponentInternals
}
