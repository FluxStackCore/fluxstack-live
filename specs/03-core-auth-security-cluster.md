# 03 — Core: Auth, Segurança, Server, Cluster & Upload

**Pacote:** `packages/core`
**Cobre:** RBAC (`LiveAuthManager`), state signing (`StateSignature`), `LiveServer`, cluster, upload, rate limit.

A maioria das features de segurança está **bem implementada e testada**. As lacunas
remanescentes são: janela de race na eviction de nonce, e a permissividade do tipo
`LiveAuthContext` (provider pode retornar contexto não-freezado).

---

## 1. Conhecimento

### 1.1 Modelo de auth — `auth/types.ts`, `LiveAuthManager.ts`, `LiveAuthContext.ts`

Contexto imutável (`AuthenticatedContext`) disponível via `this.$auth`. Autorização
em camadas:

1. `required: boolean`
2. **roles** — matching OR
3. **permissions** — matching AND
4. `authorize(auth, payload?)` custom → `true | false | { allowed, reason? }`.
   `coerceAuthResult()` (`LiveAuthManager.ts:23-34`) estrita o retorno: só `true`
   ou `{allowed:true}` passam.

`$auth.session` é **deep-frozen** (`LiveAuthContext.ts:20-37`): copia e congela
`roles`/`permissions` e `Object.freeze(this)`. Shape da session é **genérico**
(`id` obrigatório; demais campos definidos pelo dev — user/bot/device/service).

Por-componente: `static auth = { required:true, roles:['admin'] }`.
Por-action: `static actionAuth = { delete: { authorize: (auth, p) => auth.session?.id === p.ownerId } }`.

### 1.2 State signing + nonce híbrido — `security/StateSignature.ts`

- **HMAC-SHA256** assina o state. Compressão (gzip) e cripto (AES-256-CBC) **opcionais**.
- **Nonce híbrido**: formato `timestamp:random:HMAC(timestamp:random, secret)`.
  Validável **stateless** (HMAC + TTL, default 5min) **e** stateful (Map `usedNonces`).
- **Eviction high-water mark** (fix #4): quando `usedNonces` passa de **100k**,
  remove 10% mais antigos; antes de descartar, extrai o maior timestamp evicted e
  **avança `evictionHighWaterMark`**; qualquer nonce com `ts <= mark` é rejeitado
  (**fail-closed**). `:75, 150-152, 386-410`.
- Key rotation + state backups suportados.

### 1.3 `LiveServer` — orquestrador — `server/LiveServer.ts`

```ts
const server = new LiveServer({
  transport: new ElysiaTransport(app),
  wsPath: '/api/live/ws',
  componentsPath: './live/',      // auto-discovery (dev) → gera auto-generated-components.ts
  components: liveComponentClasses,// registro estático (prod bundle)
  rooms: [ChatRoom, CounterRoom],
  cluster: redisClusterAdapter,    // opcional
  roomPubSub: redisPubSubAdapter,  // opcional
  allowedOrigins: [...], debug: true,
})
server.useAuth(myAuthProvider)
await server.start()
```

### 1.4 Cluster — `IClusterAdapter` — `cluster/types.ts:40-70`

Singletons (`static singleton=true`) pertencem a uma instância. Ownership via
`claimSingleton()` **atômico**. Não-owners criam `RemoteSingletonEntry` que forwarda
actions ao owner e relaya deltas de volta. Heartbeat verifica ownership antes de
renovar (proteção split-brain); na perda dispara `onOwnershipLost`. State salvo em
store compartilhado para failover. (Impl. Redis em `05`.)

### 1.5 Upload chunked — `upload/FileUploadManager.ts:15-120`

Valida: max size · whitelist de content-type · **magic bytes** (JPEG/PNG/GIF/WebP/
PDF/ZIP/GZIP) · extensões bloqueadas (`.exe .sh .dll .ps1 .vbs .js`) · **dupla
extensão** (`.bat.txt` bloqueado se `.bat` na lista) · **quota por usuário**
(default 500MB/dia). Montagem via hook `assembleFile` ou fs.

### 1.6 Rate limit — token bucket — `connection/RateLimiter.ts:20-44`

Por conexão: `refillRate` tokens/s, cap. `tryConsume(count)` rejeita inputs
patológicos (NaN/negativo/Infinity). `refill()` faz `Math.max(0, elapsed)` →
relógio andando pra trás não vira DoS.

---

## 2. Pontos de falha (confirmados)

### 🟠 FP-1 — Janela de race na eviction de nonce + clock-skew
O `evictionHighWaterMark` é fail-closed, mas existe **race entre a deleção do nonce
(`:401`) e o avanço do mark (`:407`)**: um atacante com `(SignedState, nonce)`
capturado do lote evicted pode dar replay nessa janela — `validateState()` (`:242`)
passa (nonce já não está no Map) antes do mark subir. Além disso, o mecanismo usa o
**timestamp embutido** (`:396`), não um "first-seen" rastreado pelo server →
vulnerável a **clock-skew**. Com cap 100k e eviction de 10%, o mark sobe em saltos
discretos, deixando janelas potenciais de minutos.
**Evidência:** `StateSignature.ts:386-409, 242, 150-152`.
**Severidade:** 🟠 (explorável, mas exige captura prévia de um SignedState válido).
**Fix:** advancar o mark **antes** de deletar; usar contador monotônico
(`counter:random:mac`) em vez de timestamp; ou rastrear first-seen no server.

### 🟡 FP-2 — `LiveAuthContext` permite provider não-freezado
O freeze está correto em `AuthenticatedContext`, mas a interface `LiveAuthProvider`
permite **retornar qualquer objeto** `LiveAuthContext`. Não há validação
`instanceof AuthenticatedContext` em `LiveAuthManager.authenticate()` nem em
`LiveServer.ts:358`. Um provider que devolve objeto literal **sem freeze** reabre o
bug #2 ($auth.session mutável). Todos os exemplos do repo usam corretamente.
**Evidência:** `LiveAuthManager.ts:112,139`, `LiveServer.ts:358`, `LiveAuthContext.ts:27-36`.
**Fix:** normalizar/wrappar o retorno do provider num `AuthenticatedContext` (freeze
forçado) dentro do `authenticate()`.

### ⚪ FP-3 — AES-256-CBC sem autenticação
A cripto opcional do state usa **CBC**, que não autentica → tampering do ciphertext
não é detectado (o HMAC assina o *plaintext*, mas a combinação não é AEAD).
**Fix:** AES-256-GCM ou `HMAC(ciphertext)`.

---

## 3. O que precisa mudar

| Prio | Item | Detalhe |
|---|---|---|
| 🟠 | Fechar a janela de race do nonce | FP-1: ordem delete↔mark, e considerar nonce monotônico anti clock-skew. |
| 🟠 | Forçar `AuthenticatedContext` no `authenticate()` | FP-2: wrappar o retorno do provider para garantir freeze. |
| 🟡 | Documentar footgun de referência em `setState` | Nested updates completos; não passar `room.state`/`component.state` por referência — usar spread. |
| 🟡 | Exportar stats do rate limiter | `getStats()` com drops por conexão e global (hoje drops são silenciosos). |
| ⚪ | `try/catch` no `structuredClone` do `deepAssign` | Fallback gracioso para tipos não-serializáveis. `deepDiff.ts:160-166` |

---

## 4. Ideias de melhoria

| Impacto | Ideia |
|---|---|
| 🟠 | **Proxy recursivo de state opt-in** — detectar mutações em qualquer profundidade (resolve FP-1 de `01`). Trade-off: perf; ativar via `$options`. |
| 🟡 | **Versão de protocolo binário** — byte de versão nos frames p/ evoluir formato sem quebrar clients. |
| 🟡 | **Nonce monotônico** (`counter:random:mac`) — simplifica eviction e mata clock-skew. |
| 🟡 | **Detecção de circular no msgpack do core** — já existe no `RoomCodec`; garantir paridade em todos os encoders. |
| ⚪ | **`onEventError(error, eventName)` em `LiveRoom`** — app loga/alerta falhas de broadcast. |

---

## 5. Arquivos-chave

`auth/{LiveAuthContext,LiveAuthManager,types}.ts` · `security/{StateSignature,sanitize}.ts` ·
`server/LiveServer.ts` · `cluster/{index,types}.ts` · `connection/{RateLimiter,WebSocketConnectionManager}.ts` ·
`upload/FileUploadManager.ts` · `monitoring/PerformanceMonitor.ts` · `debug/LiveLogger.ts` · `build/index.ts`.
