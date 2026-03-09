import { test, expect } from '../../fixtures/cluster'
import { CLUSTER as S } from '../../helpers/selectors'

test.describe('SharedCounter - Connection Status', () => {
  test('shows connected status after page load', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await expect(page.locator(S.dot)).toHaveClass(/connected/)
    await expect(page.locator(S.status)).toContainText('Connected to :3001')
  })

  test('logs connection events', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    const connectedLogs = page.locator(S.logSuccess).filter({ hasText: 'Connected to :3001' })
    const count = await connectedLogs.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })
})
