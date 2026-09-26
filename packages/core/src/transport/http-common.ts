// @fluxstack/live - Base comum dos transportes HTTP (SSE e long-polling)
//
// Os dois transportes identificam a sessão por um token secreto enviado no
// header `x-live-session` e recebem frames do cliente por POST. Esta base
// concentra o que é igual: geração de token, base64 e o handler do POST.

import type { GenericWebSocket, WebSocketConfig } from './types'

/** Header com o token de sessão em cada requisição do cliente. */
export const LIVE_SESSION_HEADER = 'x-live-session'

/** Token de sessão: 32 bytes aleatórios em hex. */
export function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** Socket de sessão HTTP: precisa ao menos do estado e da origem registrada. */
export interface HttpSessionSocket extends GenericWebSocket {
  readonly token: string
}

/** Lê o corpo até `max` bytes. Passou → cancela o stream e devolve null. */
async function readBodyCapped(request: Request, max: number): Promise<ArrayBuffer | null> {
  if (!request.body) return new ArrayBuffer(0)
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      reader.cancel().catch(() => { /* já encerrado */ })
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.byteLength }
  return out.buffer
}

/**
 * POST `.../send`: valida sessão, origem e tamanho, e entrega o frame ao LiveServer.
 * 404 = sessão inexistente/expirada (o cliente fecha e reconecta).
 */
export async function handleSessionSend(
  request: Request,
  sockets: ReadonlyMap<string, HttpSessionSocket>,
  config: Omit<WebSocketConfig, 'path'>,
  maxMessageSize: number,
  onActivity?: (socket: HttpSessionSocket) => void,
): Promise<Response> {
  const token = request.headers.get(LIVE_SESSION_HEADER)
  const socket = token ? sockets.get(token) : undefined
  if (!socket || socket.readyState !== 1) return new Response('Unknown session', { status: 404 })

  // Mesmo com token secreto, POST de outra origem é recusado.
  const origin = request.headers.get('origin')
  if (origin && socket.data?.origin && origin !== socket.data.origin) {
    return new Response('Origin mismatch', { status: 403 })
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > maxMessageSize) return new Response('Payload too large', { status: 413 })

  // Lê com teto: um corpo sem Content-Length (chunked) que passa do limite é
  // recusado assim que estoura, sem ser bufferizado inteiro.
  const body = await readBodyCapped(request, maxMessageSize)
  if (!body) return new Response('Payload too large', { status: 413 })

  onActivity?.(socket)

  const contentType = request.headers.get('content-type') ?? ''
  const isBinary = contentType.startsWith('application/octet-stream')
  const message = isBinary ? body : new TextDecoder().decode(body)
  try {
    await config.onMessage(socket, message, isBinary)
  } catch (err) {
    config.onError?.(socket, err instanceof Error ? err : new Error(String(err)))
  }
  return new Response(null, { status: 204 })
}
