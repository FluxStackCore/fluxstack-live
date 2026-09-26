import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Sem DOM: os testes montam os composables com um renderer custom do Vue
// (createRenderer com nodeOps no-op), então basta o ambiente node.
// Core e client resolvem para o source (mesmo esquema do pacote client).
export default defineConfig({
  resolve: {
    alias: {
      '@fluxstack/live-client': resolve(__dirname, '../client/src/index.ts'),
      '@fluxstack/live': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    name: 'vue',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
})
