import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@fluxstack/live': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    name: 'fastify',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
})
