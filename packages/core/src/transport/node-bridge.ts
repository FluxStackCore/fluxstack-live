// @fluxstack/live - Ponte Node http ⇄ Fetch API
//
// Adapters sobre o `http` do Node (Express, Fastify) usam isto para servir
// `RawHttpRoute` (Request/Response padrão), p.ex. o transporte SSE.
// Tipos ESTRUTURAIS: o core não importa 'http' e segue agnóstico de runtime.

/** Subconjunto de `http.IncomingMessage` usado pela ponte. */
export interface NodeRequestLike extends AsyncIterable<Uint8Array | string> {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  /** corpo já lido por um body-parser do framework (ex.: express.json()) */
  body?: unknown
  /** true se o stream do corpo já foi consumido */
  readableEnded?: boolean
}

/** Subconjunto de `http.ServerResponse` usado pela ponte. */
export interface NodeResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown
  /** `false` = buffer do socket cheio; esperar o evento 'drain' antes de escrever mais */
  write(chunk: Uint8Array): unknown
  end(chunk?: Uint8Array | string): unknown
  on(event: 'close' | 'drain', listener: () => void): unknown
  flushHeaders?(): void
}

/**
 * Corpo da request. Se um body-parser já consumiu o stream, reconstrói a partir
 * do resultado; senão devolve um ReadableStream PREGUIÇOSO sobre o stream Node:
 * nada é lido antes do handler pedir. Assim o handler valida sessão, origem e
 * tamanho antes de aceitar bytes (sem isso um POST chunked sem fim, mesmo sem
 * token, seria bufferizado inteiro em memória).
 */
function nodeBody(req: NodeRequestLike): Uint8Array | ReadableStream<Uint8Array> | undefined {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return undefined

  // Um body-parser já consumiu o stream: reconstrói a partir do resultado.
  if (req.readableEnded && req.body !== undefined) {
    const b = req.body
    if (b instanceof Uint8Array) return b
    if (typeof b === 'string') return new TextEncoder().encode(b)
    return new TextEncoder().encode(JSON.stringify(b))
  }

  let iterator: AsyncIterator<Uint8Array | string> | null = null
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      iterator ??= req[Symbol.asyncIterator]()
      const { value, done } = await iterator.next()
      if (done) { controller.close(); return }
      controller.enqueue(typeof value === 'string' ? new TextEncoder().encode(value) : value)
    },
    // cancel (404/413): só paramos de puxar. NÃO chamamos iterator.return():
    // no Node isso destrói a IncomingMessage e o socket, e a resposta de erro
    // poderia se perder antes de sair. O Node descarta/expira o resto sozinho.
  }, { highWaterMark: 0 })
}

/** Converte a request Node em `Request` padrão. */
export async function nodeToFetchRequest(req: NodeRequestLike, origin = 'http://localhost'): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else headers.set(key, value)
  }
  const host = headers.get('host')
  const base = host ? `http://${host}` : origin
  const body = nodeBody(req)
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method ?? 'GET',
    headers,
    body: body as RequestInit['body'],
  }
  // corpo em stream exige duplex: 'half' (Node/undici)
  if (body instanceof ReadableStream) init.duplex = 'half'
  return new Request(new URL(req.url ?? '/', base), init)
}

/**
 * Escreve um `Response` padrão na resposta Node, fazendo streaming do corpo
 * (necessário para SSE). Se o cliente desconectar, cancela o stream — o que
 * dispara o `cancel()` do ReadableStream (fecha a conexão SSE no servidor).
 */
export async function writeFetchResponse(res: NodeResponseLike, response: Response): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  res.writeHead(response.status, headers)
  res.flushHeaders?.()

  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  let clientGone = false
  // Backpressure: com o buffer do socket cheio (write() === false) para de ler
  // até o 'drain'. Sem isso a fila do ReadableStream nunca enche — o limite
  // `maxBufferedBytes` do SSE não dispara e os bytes de um cliente lento
  // acumulam sem teto na memória do Node.
  let drained: (() => void) | null = null
  res.on('drain', () => { drained?.(); drained = null })
  res.on('close', () => {
    clientGone = true
    drained?.(); drained = null
    reader.cancel().catch(() => { /* já encerrado */ })
  })
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done || clientGone) break
      if (res.write(value) === false && !clientGone) {
        await new Promise<void>((resolve) => { drained = resolve })
      }
    }
  } catch {
    // stream cancelado pela desconexão do cliente
  } finally {
    if (!clientGone) res.end()
  }
}

/** Atalho: serve uma rota Fetch numa (req, res) do Node. */
export async function handleNodeWithFetch(
  req: NodeRequestLike,
  res: NodeResponseLike,
  handler: (request: Request) => Response | Promise<Response>,
): Promise<void> {
  const request = await nodeToFetchRequest(req)
  const response = await handler(request)
  await writeFetchResponse(res, response)
}
