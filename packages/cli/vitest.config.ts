import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      // testes de integração do inspector usam o LiveServer do source
      '@fluxstack/live': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    name: 'cli',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    passWithNoTests: true,
  },
})
