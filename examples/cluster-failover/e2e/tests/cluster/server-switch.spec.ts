import { test, expect } from '../../fixtures/cluster'
import { CLUSTER as S } from '../../helpers/selectors'

test.describe('SharedCounter - Server Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).waitFor({ timeout: 10_000 })
  })

  test('starts connected to server A', async ({ page }) => {
    await expect(page.locator(S.btnA)).toHaveClass(/active/)
    await expect(page.locator(S.dot)).toHaveClass(/connected/)
    await expect(page.locator(S.status)).toContainText(':3001')
  })

  test('switches to server B', async ({ page }) => {
    await page.click(S.btnB)
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await expect(page.locator(S.btnB)).toHaveClass(/active/)
    await expect(page.locator(S.btnA)).not.toHaveClass(/active/)
    await expect(page.locator(S.status)).toContainText(':3002')
  })

  test('state persists across server switch', async ({ page }) => {
    // Increment 3 times on server A
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('2')
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('3')

    // Switch to server B
    await page.click(S.btnB)
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).nth(1).waitFor({ timeout: 10_000 })

    // Count should be 3 (recovered from Redis)
    await expect(page.locator(S.count)).toHaveText('3')
  })

  test('history shows actions from both servers', async ({ page }) => {
    // Increment on A
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')

    // Switch to B
    await page.click(S.btnB)
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).nth(1).waitFor({ timeout: 10_000 })

    // Increment on B
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('2')

    // History should contain entries from both servers
    const history = page.locator(S.history)
    await expect(history).toContainText('Server 3001')
    await expect(history).toContainText('Server 3002')
  })

  test('switch back to A preserves state', async ({ page }) => {
    // Increment on A
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')

    // Switch to B, increment
    await page.click(S.btnB)
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).nth(1).waitFor({ timeout: 10_000 })
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('2')

    // Switch back to A
    await page.click(S.btnA)
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).nth(2).waitFor({ timeout: 10_000 })

    // Count should be 2
    await expect(page.locator(S.count)).toHaveText('2')
  })
})
