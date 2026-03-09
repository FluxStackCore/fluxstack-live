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
    server: {
      deps: {
        fallbackCJS: true,
      },
    },
  },
})
