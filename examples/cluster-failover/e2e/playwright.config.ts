import { defineConfig, devices } from '@playwright/test'
import path from 'path'

const clusterDir = path.resolve(__dirname, '..')
const fluxstackDir = path.resolve(__dirname, '../../../../FluxStack')

// Determine which webServers to start based on --project flag.
// Playwright starts ALL webServers regardless of project, so we
// parse argv to conditionally include only the needed servers.
const args = process.argv.join(' ')
const hasProject = args.includes('--project')
const runCluster = !hasProject || args.includes('cluster-failover') || args.includes('client-edge')
const runReact = !hasProject || args.includes('react-app')

const webServers: any[] = []

if (runCluster) {
  webServers.push(
    {
      command: 'cross-env SERVER_PORT=3001 bun run server.ts',
      cwd: clusterDir,
      port: 3001,
      reuseExistingServer: true,
      timeout: 15_000,
    },
    {
      command: 'cross-env SERVER_PORT=3002 bun run server.ts',
      cwd: clusterDir,
      port: 3002,
      reuseExistingServer: true,
      timeout: 15_000,
    },
  )
}

if (runReact) {
  webServers.push({
    command: 'cross-env PORT=4000 bun run dev',
    cwd: fluxstackDir,
    port: 4000,
    reuseExistingServer: true,
    timeout: 30_000,
  })
}

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 1,
  workers: 1,
  reporter: [['html', { open: 'never' }]],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'cluster-failover',
      testDir: './tests/cluster',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3001',
      },
    },
    {
      name: 'react-app',
      testDir: './tests/react',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:4000',
      },
    },
    {
      name: 'client-edge',
      testDir: './tests/client-edge',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3001',
      },
    },
  ],

  webServer: webServers,
})
