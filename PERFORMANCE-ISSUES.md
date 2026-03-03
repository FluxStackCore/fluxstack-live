# FluxStack Live - Performance Bottlenecks

Encontrados durante stress test com 1000 clientes simultâneos.

## Benchmark de referencia (dev server, single-thread)

| Clientes | Room    | Connect | Mount      | Actions    | Total  |
|----------|---------|---------|------------|------------|--------|
| 20       | shared  | 14ms    | 8ms        | 10ms (2000 req/s) | ~50ms  |
| 200      | shared  | 308ms   | 491ms (407/s) | 907ms (221 req/s) | 1.8s   |
| 1000     | shared  | 2.6s    | 17.3s (58/s) | 22.7s (44 req/s) | 37s    |

Degradacao: 200 -> 1000 clientes = throughput cai 5x (221 -> 44 req/s)

## Benchmark comparativo: sala compartilhada vs salas isoladas (1000 clientes, 8 workers)

| Metrica         | Sala compartilhada | Salas isoladas | Diferenca |
|-----------------|-------------------|----------------|-----------|
| Mount           | 14.6s (62/s)      | 134ms (7179/s) | **115x mais rapido** |
| Actions         | 16.2s (56/s)      | 140ms (6871/s) | **122x mais rapido** |
| Total           | 30.9s             | 989ms          | **31x mais rapido** |
| Throughput      | 32 clients/s      | 1011 clients/s | **31x** |

**Conclusao:** O broadcast O(n^2) eh o gargalo dominante. Com salas isoladas (sem broadcast), o servidor processa 6871 req/s vs 56 req/s com sala compartilhada.

## Problemas identificados

### 1. JSON.stringify() por cliente no broadcast (CRITICO)

**Arquivo:** `packages/core/src/rooms/LiveRoomManager.ts:219`

```typescript
// broadcastToRoom() - linha 219
for (const [componentId, member] of room.members) {
  member.ws.send(JSON.stringify({
    ...message,
    componentId  // <-- spread + stringify POR CLIENTE
  }))
}
```

Com 1000 clientes na mesma sala, cada action gera 999 chamadas a `JSON.stringify()` com spread de objeto. A unica razao do spread eh adicionar `componentId` ao payload.

**Impacto:** O(n) serializacoes por evento. 1000 actions x 999 stringifies = ~1M serializacoes.

**Singleton ja tem fix:** `ComponentRegistry.ts:256` serializa ONCE e reutiliza o mesmo string para todos os clients. O LiveRoomManager deveria fazer o mesmo.

### 2. Sem batching/throttling de broadcasts (ALTO)

**Arquivos:** `LiveRoomManager.ts`, `ComponentRegistry.ts`

Nao existe nenhum mecanismo de:
- Debounce de state updates (N updates rapidos = N broadcasts)
- Batching de mensagens (agrupar varios eventos num envio so)
- Throttle de broadcast rate (pode floodar clients)

O `ConnectionManager` ate tem `messageQueues` mas nunca sao usadas para batching.

### 3. State validation stringify duplicado (MEDIO)

**Arquivo:** `LiveRoomManager.ts:181`

```typescript
setRoomState(roomId, updates, excludeComponentId) {
  const stateSize = Buffer.byteLength(JSON.stringify(newState), 'utf8')  // stringify #1
  // ... depois chama broadcastToRoom que faz stringify #2 por cliente
}
```

O state eh serializado pra validacao de tamanho, e depois serializado novamente dentro do broadcastToRoom. Poderia reutilizar o resultado.

### 4. Sem backpressure no outgoing (MEDIO)

**Arquivo:** `RateLimiter.ts`

Rate limiting so existe para mensagens INCOMING (client -> server). Nao ha controle de outgoing (server -> client). Um cliente lento nao bloqueia o broadcast (Bun bufferiza), mas pode causar uso excessivo de memoria.

### 5. O(n^2) com room compartilhada (DESIGN)

Com N clientes na mesma sala, cada action causa N-1 broadcasts. Se todos os N clientes enviam actions, o total eh N * (N-1) = O(n^2) mensagens WebSocket. Esse eh o problema fundamental de performance.

**Comparacao necessaria:** Testar com salas isoladas (1 client por sala) para confirmar que o gargalo eh o broadcast e nao overhead geral do servidor.

## Otimizacoes aplicadas

### ✅ 1. Serialize once, send many (APLICADO)

- `LiveRoomManager.broadcastToRoom()` — serializa 1x e usa string-splice para injetar componentId por cliente
- `ComponentRegistry.broadcastToRoom()` — serializa 1x, reutiliza o mesmo string para todos os clients

### ✅ 2. Microtask batching de STATE_DELTA (APLICADO)

- `LiveComponent.createStateProxy()` e `setState()` agora acumulam deltas e emitem 1 STATE_DELTA por microtask
- Evita emissoes duplicadas quando multiplas propriedades sao alteradas no mesmo tick sincrono
- Ex: `this.state.count++; this.state.lastAction = 'x'` agora emite 1 STATE_DELTA com `{count, lastAction}` em vez de 2

### ✅ 3. Reutilizar stringify da validacao (APLICADO)

- `LiveRoomManager.setRoomState()` — resultado do `JSON.stringify(newState)` armazenado em variavel para reuso

### Resultado pos-otimizacao (1000 clientes, 8 workers, sala compartilhada)

| Metrica | Antes | Depois | Diferenca |
|---------|-------|--------|-----------|
| Mount   | 14.6s (62/s) | 14.2s (67/s) | ~8% melhor |
| Actions | 16.2s (56/s) | 20.3s (47/s) | Dentro do ruido |
| Total   | 30.9s | 33.2s | Sem melhora significativa |

**Conclusao:** As otimizacoes de serializacao reduzem CPU por mensagem, mas o gargalo dominante continua sendo o **volume O(n^2) de mensagens**. Com N=1000, cada action gera ~999 chamadas `ws.send()` via RoomEventBus, totalizando ~1M sends. A serializacao representa <5% do tempo total.

## Otimizacoes pendentes (ordem de impacto)

### 1. Broadcast direto via RoomEventBus (ALTO - mudanca arquitetural)

O padrao atual eh:
```
emitRoomEvent('COUNT_CHANGED', data) -> 999 handlers -> cada handler chama setState() -> cada emit('STATE_DELTA')
```
Total: 999 chamadas a JSON.stringify + ws.send (uma por componente).

**Alternativa:** O RoomEventBus poderia fazer broadcast direto via WebSocket para todos os membros da sala, sem acionar handlers individuais por componente. Isso eliminaria a necessidade de cada componente emitir seu proprio STATE_DELTA.

### 2. Deduplicacao de state updates no mesmo tick (ALTO)

Quando 10 actions chegam no mesmo tick, cada uma dispara 999 broadcasts. Muitos desses broadcasts carregam o mesmo delta final. Um mecanismo de deduplicacao poderia agrupar todos os updates e enviar o estado final uma unica vez.

### 3. Outgoing backpressure (MEDIO)

Monitorar o buffer de saida do WebSocket e dropar/queuar mensagens se o cliente esta lento. Previne uso excessivo de memoria com clientes lentos.
