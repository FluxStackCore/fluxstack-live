import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'spatial-room',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
})
