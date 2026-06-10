# 02 — Core: Rooms & Protocolo Binário

**Pacote:** `packages/core`
**Cobre:** `LiveRoom`, `LiveRoomManager`, `RoomCodec`/msgpack, frames binários, `RoomEventBus`, `WsSendBatcher`.

`LiveRoom` é um sistema tipado de salas multiplayer com broadcast de eventos e
estado. Opera em dois modos: **LiveRoom-backed** (hooks tipados de ciclo de vida)
e **untyped legacy**. O protocolo usa **msgpack binário por padrão** (frames
`0x02`/`0x03`) com fallback JSON. `WsSendBatcher` deduplica `STATE_DELTA` por microtask.

---

## 1. Conhecimento

### 1.1 `LiveRoom<TState, TMeta, TEvents>` — `LiveRoom.ts:98-209`

```ts
abstract class LiveRoom<TState, TMeta, TEvents> {
  static roomName: string
  static defaultState; static defaultMeta
  static $options?: { deepDiff, deepDiffDepth, maxMembers, codec }

  state: TState   // público — sincronizado com clients
  meta: TMeta     // PRIVADO — server-only, nunca enviado

  setState(updates)
  emit<K>(event: K, data: TEvents[K])
  emitWithState(event, data, updates)   // emite evento + atualiza state juntos
  get memberCount(): number
}
```

### 1.2 Contextos de lifecycle — `LiveRoom.ts:20-61`

`RoomJoinContext { componentId, session?, userId?, payload?, membership }`:
- **`session`** — sessão de auth completa, **frozen** (genérica: user/bot/device/service).
- **`membership`** — *bag* mutável server-only, **escopada a `(componentId, room)`**.
  Inicialize em `onJoin`; o **mesmo objeto** volta em `onLeave` → permite limpar
  entradas de `state` keyed por id de domínio em disconnect abrupto.
- `RoomLeaveContext` adiciona **`reason: 'leave' | 'disconnect' | 'cleanup'`**.

`ctx.userId` é alias deprecado de `ctx.session?.id`.

### 1.3 Hooks de lifecycle — **todos isolados (try/catch + await)** — `LiveRoomManager.ts`

| Hook | Quando | Notas |
|---|---|---|
| `onCreate()` | 1ª entrada na sala, **ANTES** de `onJoin` | seed de state; isolado `:217-225` |
| `onJoin(ctx)` | cada entrada | retornar `false` rejeita; `ctx.membership` mutável; `:242-256` |
| `onLeave(ctx)` | saída/cleanup | esperado async; isolado `:323-332`, `:413-448` |
| `onEvent(event, data, ctx)` | evento na sala | **observer, não interceptor**; fire-and-forget; isolado `:489-501` |
| `onDestroy()` | último membro sai | retornar `false` **mantém viva** (async respeitado via `await`); `:386-392` |

> **Importante:** a ordem `onCreate` → `onJoin` e o `await`/`try-catch` em todos
> esses hooks foram **correções de abril já aplicadas e testadas**. As notas antigas
> que dizem o contrário estão desatualizadas (ver `99`).

### 1.4 Frames binários — `RoomCodec.ts:6-12, 467-584`

```
0x02 = BINARY_ROOM_EVENT     0x03 = BINARY_ROOM_STATE     0x01 = component STATE_DELTA
```
Formato: `[frameType:u8][compIdLen:u8][compId:utf8][roomIdLen:u8][roomId:utf8][eventLen:u16BE][event:utf8][payload:msgpack]`

`buildRoomFrameTail` serializa `roomId+event+payload` **uma vez**; `prependMemberHeader`
adiciona `frameType+compId` por membro. → broadcast O(n) com O(1) por membro.

**`assertU8Length()` (`:445-452`)** valida `length <= 255` em **todos** os campos com
length u8 — `buildRoomFrame` (`:478`), `buildRoomFrameTail` (`:511`),
`prependMemberHeader` (`:538`). Antes truncava silenciosamente (bug #10). **Corrigido.**

### 1.5 Codec msgpack — `RoomCodec.ts:37-406`

`msgpackCodec` (zero-deps, ~30% menor, 2-3× mais rápido) e `jsonCodec`. Escolha via
`LiveRoomOptions.codec = 'msgpack' | 'json' | RoomCodec`. Suporta null/bool/int/float64/
string/bin/array/map. **Detecta referência circular** (seen Set, throw). `Date`/`Map`/
`Set`/`RegExp`/`BigInt`/`Symbol`/`Function` → **throw `TypeError`** (não degradam mais
em silêncio). Decode valida `offset+need <= buf.length` → **throw em truncamento** (fix #7/#15).

### 1.6 `RoomEventBus` — `RoomEventBus.ts:166-294`

`Map<'roomType:roomId:event', Set<subscription>>`. `on()` retorna unsubscribe.
`emit()` isola cada handler em try/catch e retorna count. `unsubscribeAll(componentId)`
em O(subs da component) via reverse index. `clearRoom()` por prefixo.

### 1.7 `WsSendBatcher` — `WsSendBatcher.ts`

Acumula por-WS em `queueMicrotask`. `flushAll` envia JSON array `[msg1,...]` por WS.
**Dedup de `STATE_DELTA`** (`deduplicateDeltas`, `:285-335`): fast-path se nenhum
componentId repete; slow-path faz merge recursivo (deep-merge plain, last-write-wins).
`sendBinaryImmediate` faz `flushOne` inline **antes** do binary para preservar ordem
(fix #8/#14). Telemetria em `getBatcherStats()`: `droppedBackpressure`, `droppedClosed`,
`droppedSerializationError` + warning one-shot por conexão.

---

## 2. Pontos de falha (confirmados)

### 🟠 FP-1 — Backpressure FIFO-drop causava state drift silencioso  ✅ CORRIGIDO (2026-06-10)
> **Fix completo:** `recordBackpressureDrop` dispara um **resync handler**
> (`setResyncHandler`, exportado do core), e o **`LiveServer` registra um handler
> default** que, ao detectar drop numa conexão, chama `registry.resyncConnection(ws)` —
> reenvia um **`STATE_UPDATE` assinado completo** de cada componente montado naquela ws
> (coalescido por microtask). O cliente que perdeu deltas é recuperado automaticamente.
> O drop deixou de ser silencioso **e** de deixar o cliente permanentemente dessincronizado.
> `WsSendBatcher.ts:setResyncHandler`, `LiveServer.ts` (construtor), `ComponentRegistry.ts:resyncConnection`.
> **Testes:** `WsSendBatcher.test.ts` (3: resync no drop, não-resync sem drop, handler
> que lança não quebra o envio) + `integration/LiveServer.components.test.ts` (snapshot
> reenviado após drop). Sanity TDD: falha sem o handler.

Quando `queue.length >= MAX_QUEUE_SIZE` (1000), faz `queue.shift()` descartando a
mensagem **mais antiga**. Foi **observabilizado** (`recordBackpressureDrop`,
`:92-100`) mas **não resolvido**: o cliente perde delta e fica com estado divergente;
a telemetria só torna visível. **Evidência:** `WsSendBatcher.ts:121-123, 148-150`.
**Fix:** ao dropar, marcar a conexão como *needs full resync* e reenviar snapshot
assinado, em vez de só contar o drop.

### 🟠 FP-2 — Broadcast O(n²) em sala compartilhada
(Mesmo trade-off descrito em `01` FP-2 — o gargalo dominante.) Mitigações reais:
`spatial-room` (filtra por interesse) ou broadcast direto via `RoomEventBus` sem
acionar handler por componente. **Evidência:** `LiveRoomManager.ts:703-744`,
`PERFORMANCE-ISSUES.md:110-128`.

### 🟡 FP-3 — `onEvent` async: rejeição é fire-and-forget
`onEvent` pode ser `async`, mas a rejeição é **logada e não propagada**. Dev pode
esperar que a exceção interrompa o broadcast — não interrompe (e nem deve: é observer).
Falta deixar isso explícito na doc. **Evidência:** `LiveRoom.ts:195-197`.

### 🟡 FP-4 — Memória do broadcast JSON com payload grande × muitos membros
Payload de 100KB × 1000 membros → cada `JSON.stringify` carrega string grande.
**Evidência:** `LiveRoomManager.ts:729`. **Fix:** compressão única + envio por membro,
ou builder streaming acima de um threshold de membros.

---

## 3. O que precisa mudar

| Prio | Item | Detalhe |
|---|---|---|
| 🟠 | Resync no backpressure-drop | FP-1: drop silencioso → marcar conexão para full resync. `WsSendBatcher.ts:121-123` |
| 🟡 | Validar resultado de codec custom | Se um `RoomCodec` custom é passado, validar que `encode()` retorna `Uint8Array`. `RoomCodec.ts:37-189` |
| 🟡 | Versionar frames binários | Prepend de byte de versão → clients antigos detectam incompatibilidade quando o formato mudar (ex.: length u8→u16). Hoje não há versão. |
| ⚪ | Documentar `onEvent` fire-and-forget | FP-3 — deixar claro no JSDoc e no LLMD. |

---

## 4. Ideias de melhoria

| Impacto | Ideia |
|---|---|
| 🟠 | **Dedup de delta por-room** — manter `Map<roomId,{lastDelta,lastState}>` e reusar o último diff quando o mesmo room sofre múltiplos `setState` síncronos antes do flush (hoje cada `setState` re-difa). |
| 🟠 | **Binary codec para state de room** (não só evento) — aplicar `BinaryStateCodec` tipado ao state da sala (`{hp:u8, x:f32}`) → wire ~30% menor + decode mais rápido. |
| 🟡 | **Interest-based broadcast no core** — generalizar `emitToRoomMembers` com subscriptions tipo `interest{predicate(member,event)}`. Protótipo: `spatial-room`. |
| 🟡 | **Pub/sub tipado cross-instance** — se a sala tem `TEvents`, type-check no adapter de cluster e rejeitar eventos desconhecidos. |
| ⚪ | **Cleanup notifications em lote** — `cleanupComponent` chama `onLeave` N vezes e gera N broadcasts; agrupar num `{action:'cleanup', members:[...]}`. |

---

## 5. Arquivos-chave

`rooms/LiveRoom.ts` · `rooms/LiveRoomManager.ts` · `rooms/RoomCodec.ts` ·
`rooms/RoomEventBus.ts` · `rooms/RoomRegistry.ts` · `rooms/RoomStateManager.ts` ·
`protocol/BinaryStateCodec.ts` · `protocol/{binary,constants,messages}.ts` ·
`transport/WsSendBatcher.ts`.
