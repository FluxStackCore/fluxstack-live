// @fluxstack/live - Helpers para erros vindos de `catch`
//
// Em TS o valor capturado por `catch` é `unknown` (qualquer coisa pode ser
// lançada). Estes helpers extraem a mensagem sem precisar de `catch (e: any)`.

/**
 * Mensagem legível de um erro desconhecido.
 * - `Error` (ou objeto com `message: string`) → a mensagem
 * - qualquer outro valor → `String(valor)`
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(err)
}

/** Normaliza qualquer valor lançado para uma instância de `Error`. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(errorMessage(err))
}
