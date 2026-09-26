import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@fluxstack/live': resolve(__dirname, '../core/src/index.ts'),
      // testes SSE/HTTP usam o LiveConnection real a partir do fonte
      '@fluxstack/live-client': resolve(__dirname, '../client/src/index.ts'),
    },
  },
  test: {
    name: 'fastify',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 15000,
  },
})
