/**
 * Plugin system error class.
 *
 * Intentionally small: carries a `code` and `statusCode` so the host app
 * can surface plugin errors the same way it surfaces its own (in FluxStack,
 * the framework's error middleware reads `code` and `statusCode` off any
 * thrown object).
 *
 * The shape is assignable to FluxStack's own `FluxStackError` consumers
 * because both expose `code: string` and `statusCode: number` as public
 * readonly fields.
 */
export class PluginError extends Error {
  public readonly code: string
  public readonly statusCode: number

  constructor(message: string, code: string, statusCode: number = 500) {
    super(message)
    this.name = 'PluginError'
    this.code = code
    this.statusCode = statusCode

    // Preserve V8-style stack traces where available
    if ((Error as unknown as { captureStackTrace?: Function }).captureStackTrace) {
      ;(Error as unknown as { captureStackTrace: Function }).captureStackTrace(this, PluginError)
    }
  }
}
