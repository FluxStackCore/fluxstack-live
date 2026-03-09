import { test, expect } from '../../fixtures/cluster'
import { CLUSTER as S } from '../../helpers/selectors'

test.describe('SharedCounter - Basic Operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    // Wait for component mount
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).waitFor({ timeout: 10_000 })
  })

  test('displays initial count of 0', async ({ page }) => {
    await expect(page.locator(S.count)).toHaveText('0')
  })

  test('increments counter', async ({ page }) => {
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')
  })

  test('decrements counter', async ({ page }) => {
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')
    await page.click(S.btnDec)
    await expect(page.locator(S.count)).toHaveText('0')
  })

  test('resets counter', async ({ page }) => {
    await page.click(S.btnInc)
    await page.click(S.btnInc)
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('3')
    await page.click(S.btnReset)
    await expect(page.locator(S.count)).toHaveText('0')
  })

  test('shows last server label', async ({ page }) => {
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')
    await expect(page.locator(S.lastServer)).toContainText('Server 3001')
  })

  test('accumulates action history', async ({ page }) => {
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('2')
    await page.click(S.btnDec)
    await expect(page.locator(S.count)).toHaveText('1')

    const entries = page.locator(S.historyEntry)
    await expect(entries).toHaveCount(3)
  })
})
