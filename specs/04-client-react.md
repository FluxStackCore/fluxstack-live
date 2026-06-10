# 04 — Client & React

**Pacotes:** `packages/client` (`@fluxstack/live-client`) + `packages/react` (`@fluxstack/live-react`), ambos 0.10.0.
**Cobre:** `LiveConnection`, reconexão resiliente, `Live.use()`, `Live.Boundary`/`Live.Status`, connection pool, upload adaptativo.

Separação limpa: `client` é transport-agnostic (connection/rooms/codec); `react`
adiciona os bindings (context + Zustand) e helpers de UI.

> **Desmentido importante (docs antigas):** **NÃO existe DOM patching** no client.
> A arquitetura é *state sync* puro: o server manda deltas, o client faz `deepMerge`
> no store Zustand / handle, e React/vanilla re-renderiza. É **inspirado** em
> LiveView, não uma reimplementação de DOM diffing. **Evidência:** todo `client/src`.

---

## 1. Conhecimento

### 1.1 `LiveConnection` — reconexão resiliente — `connection.ts:108-369`

- **Auto-reconnect infinito por padrão** (`maxReconnectAttempts = Infinity`,
  `:117`). Backoff exponencial (min 1s, **max 16s**). Listeners de `online` e
  `visibilitychange` resetam `reconnectAttempts=0` e disparam reconexão imediata.
  `disconnect()` manual seta `intentionalClose=true` (bloqueia auto-reconnect).
- Heartbeat a cada 30s (3 falhas → reconecta).
- Roteamento de **frames binários**: `0x01` state delta, `0x02`/`0x03` room event/state.
- **`$auth` deep-frozen no client** (`deepFreezeSession`, depth ≤ 8) para espelhar o
  server e impedir mutações acidentais. `:19-26, 394-420`.

> ⚠️ **Não passe `maxReconnectAttempts` nos Providers** — o default `Infinity` é
> intencional (apps realtime não devem "morrer" após N falhas). Ver `99` / mudança de contrato abaixo.

### 1.2 Request-response — `connection.ts:471-502`

`sendMessageAndWait(msg, timeout=10s)` gera `requestId`, guarda a promise em
`pendingRequests`, e dá timeout se não houver resposta. Usado em `COMPONENT_MOUNT`,
`CALL_ACTION`, operações de room.

### 1.3 `BinaryStateCodec` (decode client) — `BinaryStateCodec.ts:61-127`

Auto-infere tipos de campo a partir do `initialState` (`number→float64`, `boolean`,
`string`) ou schema explícito. `decodeDelta()` lê bitmask + campos tipados
(`u8/u16/u32/i8/i16/i32/f32/f64/bool/string`). **Deve casar exatamente** com o
encoder do server.

### 1.4 `deepMerge` no client — `component.ts:31-60`, `rooms.ts:21-50`, `useLiveComponent.ts:48-77`

Aplica `STATE_DELTA` com a **mesma semântica do server**: top-level `null` = valor
real; nested `null` = delete; `undefined` skip; guarda circular.

### 1.5 `Live.use()` (React) — proxy — `useLiveComponent.ts:777-865`

Retorna um Proxy que intercepta acesso:

```tsx
const counter = Live.use<Counter>('Counter', { initialState, room })
counter.$state.count     // valor atual (ou otimista pendente)
counter.increment()      // action → sendMessageAndWait
counter.$fire('act', p)  // fire-and-forget (sem pendingRequest)
counter.$field('name', { syncOn: 'blur', debounce: 500 })
counter.$connected       // WS aberto? (transport)
counter.$ready           // WS aberto + mount server concluído  ← gate de actions
counter.$status          // 'synced'|'mounting'|'connecting'|'reconnecting'|'loading'|'disconnected'|'error'
counter.$auth.session
```

> **`$connected` ≠ pronto.** Faça gate de actions em **`$ready`** (= `$status === 'synced'`).
> Chamar action entre WS-aberto e mount-concluído lança erro. `:777-865`.

### 1.6 `Live.Boundary` / `Live.Status` (NOVOS) — `components/LiveBoundary.tsx`

Helpers de UI: `<Live.Boundary>` com slots loading/error/offline; `<Live.Status>`
pílula de status de conexão. Lógica pura em `resolveBoundarySlot()`. **Não estão
documentados** fora desta spec (introduzidos em `feat(react): Live.Boundary e Live.Status`).

### 1.7 Connection pool (fix StrictMode) — `connectionPool.ts:28-107`

Pool module-level evita que o ciclo mount→unmount→remount do StrictMode abra **dois
handshakes** WS simultâneos. Key = URL + hash(auth). `acquire()` incrementa refcount;
`release()` agenda descarte após **grace window (50ms)**; reaquisição dentro da janela
reusa o socket. (Issue #34.)

### 1.8 Guarda SSR + Zustand

`LiveComponentsProvider` é SSR-aware (import dinâmico; placeholder no server) — essencial
para conviver com RSC (ver `FluxStack/specs`). `useLiveComponent` usa Zustand +
`subscribeWithSelector` internamente.

### 1.9 Upload adaptativo — `upload.ts:36-123`

`AdaptiveChunkSizer` mede latência por chunk (janela de 3), ajusta tamanho ±1.5×
mirando 200ms (min 16KB, max 1MB).

---

## 2. Pontos de falha (confirmados)

### 🟠 FP-1 — `maxReconnectAttempts = Infinity` é breaking change de contrato
O default mudou de **5 → Infinity** (`connection.ts:117`). Apps que dependiam de
"desistir após 5 tentativas" mudam de comportamento sem aviso. É **intencional e
desejável** para realtime, mas **não está documentado** no CLAUDE.md/llms.txt.
**Fix:** documentar (novo default, como voltar ao antigo com `maxReconnectAttempts: 5`,
e o racional). Ver memória `project-live-reconnect`.

### 🟡 FP-2 — `LiveComponentHandle` (vanilla) ≠ `useLiveComponent` (React)
Interfaces **diferentes**: o handle vanilla expõe métodos explícitos (`mount()`,
`call()`, `fire()`, getter `state`); o React expõe um **Proxy** mágico. Docs antigas
sugerem que são a mesma coisa. **Fix:** documentar a diferença.

### ⚪ FP-3 — Decoder msgpack do client: underrun + sem depth guard  ✅ CORRIGIDO (2026-06-10)
> **Fix:** o decoder ganhou **depth guard** (`_MSGPACK_MAX_DEPTH=100`, throw `RangeError`
> em aninhamento patológico) e `handleBinaryFrame` agora **envolve o decode em
> try/catch** — frame corrompido/profundo é **dropado graciosamente** com `console.warn`
> (não quebra a UI). `client/src/rooms.ts`. **Teste:** `rooms.binary.test.ts` (frame de
> 5000 níveis → não lança, warn chamado). Postura "fail-loud em dev, gracioso em prod".
> _(underrun ainda retorna null silencioso em leitura parcial — baixo impacto; o depth
> guard + try/catch cobrem o caso de crash.)_

### ⚪ FP-3b (orig) — Decoder msgpack do client devolvia `null` em underrun
`rooms.ts _decodeAt()` retorna `null` silenciosamente quando `offset >= buf.length`
→ frame malformado indistinguível de `null` legítimo. (O **core** já corrige isso
com throw; o client ainda não.) **Fix:** throw/warn.

### ⚪ FP-4 — Sem bounds-check de `componentId` no encode do client
`handleBinaryMessage` (`connection.ts:~539`) não valida `idLen <= 255` antes de
decodificar (o server já valida no encode). Defesa em profundidade ausente.

---

## 3. O que precisa mudar

| Prio | Item |
|---|---|
| 🟠 | Documentar `maxReconnectAttempts=Infinity` (FP-1) em CLAUDE.md/llms.txt + como opt-out. |
| 🟡 | Documentar diferença handle-vanilla vs proxy-React (FP-2). |
| 🟡 | Esclarecer semântica de `null` em `setState` no client (depth-dependente) com exemplo. |
| ⚪ | Throw/warn no underrun do decoder (FP-3); deep-freeze recursivo dentro de arrays. |

---

## 4. Ideias de melhoria

| Impacto | Ideia |
|---|---|
| 🟠 | **Replay de pending requests pós-reconexão** — em vez de rejeitar na queda, enfileirar e reenviar após reconectar (requer idempotency key no server). |
| 🟠 | **Offline-first local sync** — fila de mudanças em localStorage/IndexedDB; replay no reconnect (par com a ideia de `01`). |
| 🟡 | **Cancelamento de request (AbortController)** — `request.abort()` para actions longas + metadados expostos aos hooks. |
| 🟡 | **Integração com React Suspense** — `useComponentSuspense()` que dá throw na promise durante loading. |
| ⚪ | **Métricas de frame** — telemetria por tipo/tamanho/latência (ajuda a flagrar O(n²) do server). |

---

## 5. Arquivos-chave

**client:** `connection.ts` · `component.ts` · `rooms.ts` · `BinaryStateCodec.ts` ·
`upload.ts` · `persistence.ts` · `state-validator.ts`.
**react:** `LiveComponentsProvider.tsx` · `connectionPool.ts` · `components/Live.tsx` ·
`components/LiveBoundary.tsx` · `hooks/useLiveComponent.ts` · `hooks/readiness.ts` ·
`hooks/use{Chunked,LiveChunked}Upload.ts`.
