# 07 — Transportes (WebSocket, SSE, HTTP, custom)

**Desde:** 0.11.0 (2026-09-26)
**Arquivos:** `packages/core/src/transport/{types,sse,node-bridge}.ts`,
`packages/client/src/transports.ts`, `packages/client/src/connection.ts`,
adapters `elysia`, `express`, `fastify`.

## Ideia

O core não sabe o que é um WebSocket. Ele conversa com um `GenericWebSocket`
(`send`, `close`, `data`, `readyState`). Qualquer meio físico que consiga
entregar frames nos dois sentidos vira um transporte. Auth, rate limit, posse
de componente, salas, uploads e cluster valem igual para todos.

```
                    ┌──────────── LiveServer (core) ────────────┐
 WebSocket ─ adapter ─► GenericWebSocket ─┐                      │
                                          ├─► handleMessage ...  │
 SSE+POST ── SseConnectionHub ─► GenericWebSocket (virtual) ─┘   │
                    └────────────────────────────────────────────┘
```

No cliente é o mesmo desenho ao contrário: o `LiveConnection` fala com um
`ClientTransport`. Reconexão com backoff, heartbeat, request/response,
roteamento por componente e auth ficam no `LiveConnection`.

## Modos

| Modo | Servidor→cliente | Cliente→servidor | Quando usar |
|---|---|---|---|
| `websocket` | frame WS | frame WS | latência mínima: jogos, cursor ao vivo, muitas actions/s |
| `sse` | `text/event-stream` (GET) | POST por frame | a maioria dos apps; passa em proxies, CDNs, HTTP/2 |
| `http` | long-poll (GET que o servidor segura) | POST por frame | último recurso: redes que bloqueiam WS **e** bufferizam stream, serverless |
| lista, ex. `['sse', 'http']` | começa no 1º; após 2 falhas **sem nunca abrir**, desce para o próximo | | padrão do app FluxStack |
| `auto` | = `['websocket', 'sse', 'http']` | | apps públicos |
| fábrica custom | o que você implementar | | testes, WebTransport, etc. |

O padrão do `LiveConnection` puro continua `websocket`. O **app FluxStack** usa
`['sse', 'http']` por padrão (`VITE_LIVE_TRANSPORT=sse`); `websocket` vira
`['websocket', 'sse', 'http']`.

**Por que WebSocket é mais rápido:** no SSE o servidor empurra em stream contínuo,
mas cada action do cliente é um POST. No HTTP puro, além disso, cada entrega do
servidor fecha um poll e o cliente abre outro. Mesma semântica, latência crescente.

A mesma ideia de "descer até passar" é a do Socket.IO/Engine.IO, que faz o
caminho inverso: começa em long-polling e tenta subir para WebSocket.

## Servidor

```ts
const live = new LiveServer({
  transport: new ElysiaTransport(app),
  sse: true,                      // ou { path, heartbeatMs, maxBufferedBytes, maxMessageSize }
  http: true,                     // ou { path, pollTimeoutMs, sessionTimeoutMs, maxBufferedBytes, maxMessageSize }
})
```

Rotas registradas (padrão):

| Método | Caminho | Função |
|---|---|---|
| GET | `/api/live/sse` | abre o stream |
| POST | `/api/live/sse/send` | envia 1 frame (JSON `application/json` ou binário `application/octet-stream`) |
| GET | `/api/live/http` | abre sessão HTTP → `{ token }` |
| GET | `/api/live/http/poll` | long-poll → `{ frames: [{t}|{b}], closed? }` (espera até `pollTimeoutMs`, padrão 25s) |
| POST | `/api/live/http/send` | envia 1 frame (igual ao SSE) |
| POST | `/api/live/http/close` | cliente encerra a sessão (abortar o poll não chega ao servidor) |

**HTTP long-polling:** um poll por vez por sessão (o novo substitui o anterior);
frames acumulam numa fila com teto de bytes (acima → fecha com 1008); sessão sem
poll nem envio por `sessionTimeoutMs` (padrão 45s) é encerrada. Hub em
`core/transport/http-polling.ts`; base comum com o SSE em `core/transport/http-common.ts`.

Requisito do adapter: implementar `LiveTransport.registerRawRoutes(routes)`, que
recebe rotas `Request → Response` (Fetch API).

- **Elysia:** nativo. POST usa `parse: 'none'` para o corpo chegar cru.
- **Express / Fastify:** via `handleNodeWithFetch` (`core/transport/node-bridge.ts`),
  que converte `IncomingMessage` → `Request` e faz streaming do `Response`.
  No Fastify as rotas vivem num escopo encapsulado com parser que não consome o corpo.
- **Outros (Hono, Deno, Workers):** `liveServer.sseHub.routes()` devolve os handlers
  Fetch; monte-os no roteador.

### Protocolo do stream

```
event: session   data: {"token":"<64 hex>"}      ← sempre o primeiro
event: message   data: <frame JSON>              ← mesmo JSON do WebSocket
event: binary    data: <frame binário em base64> ← deltas binários, salas msgpack
event: close     data: {"code":1000,"reason":"..."}
: ping                                           ← heartbeat (comentário)
```

Frames enviados durante o `onOpen` (ex.: `CONNECTION_ESTABLISHED`) ficam
pendentes até o evento `session`, então o cliente nunca recebe mensagem antes
de ter o token.

### Segurança

- O **token de sessão** (32 bytes aleatórios) autentica cada POST pelo header
  `X-Live-Session`. Ele só existe no corpo do stream; outra origem não consegue lê-lo.
- POST com `Origin` diferente do stream → **403**. Token desconhecido → **404**
  (o cliente fecha e reconecta).
- `allowedOrigins` do `LiveServer` vale no GET: origem rejeitada → **403** sem stream,
  e o cliente trata como 4003 (não reconecta).
- Corpo acima de `maxMessageSize` → **413** (checa `Content-Length` e o tamanho real).
- **Backpressure:** o stream usa `ByteLengthQueuingStrategy(maxBufferedBytes)`.
  Cliente que não consome passa do limite → conexão fechada com 1008; ele
  reconecta e re-hidrata.
  Na ponte Node (Express/Fastify) isso depende de respeitar `res.write() === false`
  (esperar o `drain`); a ponte faz isso.
- O corpo do POST é lido sob demanda e com teto: nada é lido antes de validar sessão
  e origem, e um corpo chunked sem `Content-Length` recebe 413 assim que estoura.
- Todo o resto (auth via mensagem `AUTH`, rate limit por conexão, posse de
  componente) é o pipeline normal do `LiveServer`.

## Cliente

```ts
new LiveConnection({ url: 'wss://app/api/live/ws', transport: 'sse' })
// React
<LiveComponentsProvider transport="auto">
// Vue
provideLiveConnection({ transport: 'sse' })
```

- `sseUrl` / `httpUrl` são derivadas de `url` (`ws(s)://h/api/live/ws` → `http(s)://h/api/live/sse` e
  `.../api/live/http`) ou passadas explicitamente.
- O SSE tem `openTimeoutMs` (padrão 10s): proxy que bufferiza o stream "abre" sem
  entregar o evento `session`; isso conta como falha e a cadeia desce para HTTP.
- O `SseClientTransport` usa `fetch` com stream (não `EventSource`): controla a
  reconexão, lê o status HTTP e roda em Bun/Node.
- POSTs saem **em ordem**, um por vez (fila interna).
- `LiveConnectionState.transport` e o `transport` do contexto React mostram o modo ativo.

### Transporte custom

```ts
const transport: ClientTransportFactory = (endpoints) => ({
  kind: 'meu',
  isOpen: false, isConnecting: false,
  open(handlers) { /* chame handlers.onOpen / onMessage / onClose / onError */ },
  send(data) { /* string = JSON, ArrayBuffer = binário */ },
  close() { /* dispare onClose uma vez */ },
})
new LiveConnection({ transport })
```

## Testes

- `__tests__/integration/sse-transport.test.ts` — LiveServer real ⇄ LiveConnection
  real por um `fetch` em memória: mount, action, delta, 404, 403, shutdown, parser.
- `packages/elysia/src/__tests__/ElysiaSse.bun.test.ts` e `ElysiaHttp.bun.test.ts` —
  Elysia em porta real, texto multi-linha/unicode, desconexão, token forjado. `bun test`.
- `__tests__/integration/http-transport.test.ts` — HTTP long-polling em memória, poll
  vazio, expiração de sessão, `/close`, e as cadeias `auto` e `['sse','http']` com
  WebSocket e SSE bloqueados.
- `__tests__/integration/transport-resilience.test.ts` — binário chega como ArrayBuffer
  idêntico, `openTimeoutMs` + queda para HTTP, reconexão após restart do servidor (SSE e
  HTTP), cliente SSE + cliente HTTP no mesmo servidor (singleton e LiveRoom).
- `packages/core/src/__tests__/transport/http-transport-edges.test.ts` — 413, 403 por
  origem, backpressure 1008, poll substituído, heartbeat, frames binários (hubs direto).
- `packages/core/src/__tests__/transport/node-bridge.test.ts` — ponte Node ⇄ Fetch.
- `packages/{express,fastify}/src/__tests__/*SseHttp.test.ts` — porta real + `fetch`
  global: ciclo completo SSE/HTTP, `express.json()` antes das rotas, POST binário cru,
  413, token forjado, desconexão, backpressure com cliente TCP que para de ler.

## Limitações conhecidas

- Cada frame cliente→servidor é um POST: latência de envio maior que WS.
  O fluxo servidor→cliente (a maior parte do tráfego) é contínuo.
- Frames binários vão em base64 no stream (+33% de tamanho).
- Em cluster, a conexão SSE é fixa numa instância (como WS): o balanceador
  precisa de sticky session **ou** de rotear o POST pelo token. O hub não
  compartilha sessões entre instâncias.
