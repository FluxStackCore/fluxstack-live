import { defineConfig } from 'vitest/config'
import path from 'path'

const monorepoRoot = path.resolve(__dirname, '..')

export default defineConfig({
  resolve: {
    alias: {
      ioredis: path.join(monorepoRoot, 'packages', 'redis', 'node_modules', 'ioredis', 'built', 'index.js'),
    },
  },
  test: {
    name: 'integration',
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    // integração faz imports dinâmicos pesados e fala com Redis real:
    // 5s (padrão) estoura quando a suíte inteira roda em paralelo
    testTimeout: 20_000,
    server: {
      deps: {
        fallbackCJS: true,
      },
    },
  },
})
