import { defineConfig } from 'vitest/config'

// Benchmarks comparativos (*.perf.test.ts) comparam tempos entre si e oscilam
// quando a suíte roda em paralelo. Ficam fora da rodada padrão (e da CI) e
// rodam isolados com `bun run test:perf` na raiz.
const PERF = process.env.LIVE_PERF === '1'

export default defineConfig({
  test: {
    name: 'core',
    globals: true,
    environment: 'node',
    include: PERF ? ['src/__tests__/**/*.perf.test.ts'] : ['src/__tests__/**/*.test.ts'],
    exclude: PERF ? [] : ['src/__tests__/**/*.perf.test.ts', '**/node_modules/**'],
  },
})
