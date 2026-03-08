# @fluxstack/live - Development Rules

## Build Rules

After modifying source code in any package under `packages/`, you MUST rebuild before testing with the FluxStack main application.

The FluxStack app (`../FluxStack`) resolves `@fluxstack/live-*` packages via `node_modules` which points to `dist/` (compiled output), NOT the TypeScript source. Only the Vite frontend uses source aliases for `core`, `client`, and `react` — the backend (Bun) always uses `dist/`.

### Build Commands

```bash
# Rebuild a single package
bun run build:core       # packages/core
bun run build:client     # packages/client
bun run build:react      # packages/react
bun run build:adapters   # packages/elysia, express, fastify (parallel)

# Rebuild everything
bun run build            # core -> adapters -> client -> react (sequential)
```

### When to Rebuild

- After ANY change to `packages/core/src/` — rebuild core: `bun run build:core`
- After ANY change to `packages/elysia/src/` — rebuild adapters: `bun run build:adapters`
- After ANY change to `packages/client/src/` — rebuild client: `bun run build:client`
- After ANY change to `packages/react/src/` — rebuild react: `bun run build:react`
- If unsure, rebuild everything: `bun run build`

### Package Resolution in FluxStack

| Package | Backend (Bun) | Frontend (Vite) |
|---|---|---|
| `@fluxstack/live` | `dist/` via node_modules | Source `.ts` via alias |
| `@fluxstack/live-elysia` | `dist/` via node_modules | N/A (backend only) |
| `@fluxstack/live-react` | N/A (frontend only) | Source `.ts` via alias |
| `@fluxstack/live-client` | N/A (frontend only) | Source `.ts` via alias |

## Architecture

- `packages/core` — Framework-agnostic core (LiveServer, ComponentRegistry, StateSignature, rooms, auth, cluster)
- `packages/elysia` — Elysia.js transport adapter (thin wrapper, no security logic)
- `packages/express` — Express transport adapter
- `packages/fastify` — Fastify transport adapter
- `packages/client` — Browser WebSocket client
- `packages/react` — React hooks and providers (LiveComponentsProvider, Live.use())
- `packages/redis` — Redis adapters (RedisRoomAdapter for room pub/sub, RedisClusterAdapter for singleton coordination)

### Security Architecture

All security logic lives in `packages/core`. Transport adapters (elysia, express, fastify) are pure pass-through wrappers — they delegate everything to core.

Security features in core:
- HMAC-SHA256 state signing (`StateSignature.ts`)
- Hybrid nonce system: stateless HMAC validation + Map-based replay detection
- Payload sanitization against prototype pollution (`sanitize.ts`)
- Rate limiting (token bucket)
- Authentication (LiveAuthManager)
- Message size limits, room limits

### Cluster Architecture

For horizontal scaling, the cluster adapter (`IClusterAdapter`) coordinates singleton components across server instances.

Key files:
- `packages/core/src/cluster/types.ts` — `IClusterAdapter` interface and all cluster types
- `packages/core/src/cluster/index.ts` — Re-exports
- `packages/redis/src/RedisClusterAdapter.ts` — Redis implementation
- `packages/core/src/component/ComponentRegistry.ts` — Cluster integration (remote singletons, action forwarding, delta handlers)
- `packages/core/src/server/LiveServer.ts` — Accepts `cluster` option, manages lifecycle

Flow:
1. Singleton ownership via atomic Redis `SET NX EX` with pre-generated componentId (no race window)
2. Non-owner servers create `RemoteSingletonEntry` proxies
3. Actions on proxies forwarded via Redis pub/sub → owner executes → result returned
4. State deltas published by owner → proxies relay to local WebSocket clients
5. Heartbeat renews claims every 10s; verifies ownership before renewing (split-brain protection)
6. On crash: claim TTL expires, new owner recovers state from `singleton-state:{name}` key

## Testing

```bash
# Run all tests
bunx vitest run

# Type check
bunx tsc -p packages/core/tsconfig.json --noEmit
```

### Cluster Integration Tests

Cluster tests require a running Redis instance. Start one via Docker:

```bash
docker run -d --name fluxstack-test-redis -p 16379:6379 redis:7-alpine
```

Tests are in `packages/core/src/__tests__/integration/cluster-sync.test.ts` and run automatically with the rest of the suite (they skip gracefully if Redis is unavailable).

## Conventions

- All packages use `tsup` for building (ESM output, ES2022 target)
- Tests use `vitest` and live in `packages/core/src/__tests__/`
- TypeScript strict mode enabled
