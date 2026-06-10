import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'cli',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    passWithNoTests: true,
  },
})
